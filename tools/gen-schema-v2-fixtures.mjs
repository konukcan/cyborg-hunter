// tools/gen-schema-v2-fixtures.mjs
//
// Cuts the GENERATED half of the schema-v2 conformance corpus by driving CH's
// shipped recorder in a real Chromium page and writing what `serialize()`
// produced. Five fixtures, one page each:
//
//   redacted.json               spec Appendix + T7 brief items 1, 9, 10
//   length-only-clipboard.json  brief item 2 (CH adapter's default mode)
//   aborted.json                brief item 3 (end_reason "aborted")
//   truncated.json              brief item 4 (buffer cap → capture_stopped)
//   touch-lifecycle.json        brief item 12 (touch.* + focus/blur channels)
//
// WHY A BROWSER AND NOT A CONSTRUCTED OBJECT. The whole point of the generated
// half is that it is a PRODUCER'S ANSWER to the spec, not a second reading of
// it. A hand-built `redacted.json` would prove that the author knows what §8
// says; this one proves that the recorder does. The distinction is not
// academic — the file-input floor (item 10) survived every unit test in the
// repo because happy-dom never synthesizes `C:\fakepath\…`, and only a real
// Chromium capture put a real filename in front of the capture path.
//
// DETERMINISM: THERE IS NONE, AND THAT IS THE COST OF THE ABOVE. Timestamps,
// RAF coalescing and Chromium's own MutationRecord batching all move between
// runs, so re-running this script produces a DIFFERENT file with different
// event counts. Re-cut deliberately, exactly like jspsych-full: regenerate,
// then re-author the `counts` block with tools/gen-expectations-counts.mjs and
// re-check the spot checks. The corpus runner recomputes every count it is
// given, so a stale expectations file fails loudly rather than drifting.
//
// Run: node build.js && node tools/gen-schema-v2-fixtures.mjs
// Re-cut ONE: node tools/gen-schema-v2-fixtures.mjs redacted.json

import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tests', 'replay', 'schema-v2', 'fixtures');
const DIST = join(ROOT, 'dist', 'cyborg-hunter-replay.js');

function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    import.meta.url,
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/',
  ].filter(Boolean);
  for (const base of candidates) {
    try { return createRequire(base)('playwright-core'); } catch { /* next */ }
  }
  return null;
}
const pw = resolvePlaywright();
if (!pw) {
  console.error('playwright-core not found (set PLAYWRIGHT_CORE_DIR or npm i -D playwright-core)');
  process.exit(1);
}

// ── the sentinels ──────────────────────────────────────────────────────────
// THREE, not one, and the split IS the fixture's claim (T3 Task-2 review).
// §8 makes redaction a property of the FILE, and the leak scan proves that for
// TYPED CONTENT. It does not, and must not pretend to, cover the pin-8
// residual surface: an attribute NAME, a `data-*` VALUE and an inline `style`
// inside a redacted subtree all survive by design (snapshot.js strips exactly
// two things — `srcdoc` on an iframe, and `value` under redaction). Scanning
// for those as leaks would make the fixture assert a floor CH does not claim;
// carrying them under their own sentinel, and asserting they are PRESENT,
// documents the boundary where the next reader will look for it.
export const SENTINELS = {
  // Typed by the participant. Must appear NOWHERE in the file, and neither may
  // the per-character key identities that spell it.
  typed: 'Zq7VkTYPED',
  // A filename chosen by the participant. §13 puts file selection outside the
  // format entirely: not the name, not the value, not even a length.
  file: 'FILESENTINEL-3XQ.txt',
  // The documented residual. Lowercase and dash-free so it can also BE an
  // attribute name, which is the surface the review asked for.
  residual: 'zqxresidual42',
  // Inlined document content. Stripped unconditionally, redacted or not.
  srcdoc: 'srcdocsentinel99',
};

const S = SENTINELS;

// ── the redacted page ──────────────────────────────────────────────────────
// Every element here is owed to a specific review carry; nothing is scenery.
const REDACTED_PAGE = `
<div id="stage">
  <h1 id="title">Screening</h1>

  <!-- The §8 redaction subtree. Two typed channels (a password field, which is
       the unconfigurable floor, and a selector-designated text field), plus the
       three pin-8 residuals on one element so a single spot check can find
       them. -->
  <div id="private" class="secret" data-ch-redact>
    <label for="pw">Passphrase</label>
    <input id="pw" type="password" autocomplete="off">
    <input id="rd" type="text" value=""
           data-note="${S.residual}"
           style="outline:1px solid #ccc; background-image:url(${S.residual}.png)"
           data-${S.residual}="1">
    <p id="typed">placeholder</p>
  </div>

  <!-- Where the I2 vector points: a node typed into INSIDE the redacted
       subtree is moved OUT of it mid-span. Without taint tracking the dom.add
       that re-parents it carries the content the keyframe withheld. -->
  <div id="open"></div>

  <!-- Item 10: a file input with a real file set on it. -->
  <input id="picker" type="file">

  <!-- srcdoc inlines a whole document, scripts included; snapshot.js drops it
       for every iframe, not only redacted ones. -->
  <iframe id="frame" src="about:blank" width="120" height="60"
          srcdoc="&lt;b&gt;${S.srcdoc}&lt;/b&gt;"></iframe>

  <!-- Item 9: a §4 exclusion placeholder. canonical-core has none, which is
       why the fork player's instantiateDom crash on placeholders survived
       until a real capture hit it. -->
  <div id="bait" data-record-exclude>
    <span>free money</span><input type="text" value="bait">
  </div>
</div>`;

const CLIPBOARD_PAGE = `
<div id="stage">
  <h2 id="prompt">Paste your answer</h2>
  <textarea id="answer" rows="3" cols="40"></textarea>
  <p id="note">length-only is CH's documented default</p>
</div>`;

const PLAIN_PAGE = `
<div id="stage">
  <h2 id="prompt">Question 1</h2>
  <p id="body">Pick one.</p>
  <button id="a" type="button">Alpha</button>
  <button id="b" type="button">Beta</button>
  <ul id="log"></ul>
</div>`;

// ── harness ────────────────────────────────────────────────────────────────

const { chromium } = pw;
const browser = await chromium.launch({ headless: true });

/** A page with the recorder bundle loaded and `window.CH` bound to the API. */
async function withPage(html, attachConfig, body, contextOpts) {
  const page = await browser.newPage(Object.assign(
    { viewport: { width: 1000, height: 700 } }, contextOpts));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('about:blank');
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>fixture</title>${html}`);
  await page.addScriptTag({ path: DIST });
  await page.evaluate((cfg) => {
    window.CH = window.CyborgHunterReplay.attach(Object.assign({
      participantId: 'P-FIXTURE', tier: 'dom',
      autoSave: { mode: 'none' }, root: document.getElementById('stage'),
    }, cfg));
    window.CH.startSession();
  }, attachConfig);
  let recording;
  try {
    recording = await body(page);
  } finally {
    await page.close();
  }
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  return recording;
}

// Two animation frames. MutationObserver callbacks are microtasks but several
// capture channels coalesce into a RAF flush, so one frame is not reliably
// enough to see everything a task produced (the capture battery's `settle`).
const settle = (page) => page.evaluate(() => new Promise((r) =>
  requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const startTrial = (page, id, plugin) =>
  page.evaluate(({ id, plugin }) => window.CH.startTrial({ trialId: id, plugin }), { id, plugin });

async function finish(page, { stop = true } = {}) {
  await settle(page);
  return page.evaluate((stop) => {
    if (stop) { window.CH.endTrial(); window.CH.stopSession('finished'); }
    // No endTrial and no stopSession is exactly how an aborted recording
    // looks: the segment is still open and serialize() defaults end_reason.
    return window.CH.getRecording();
  }, stop);
}

// Re-cut ONE entry: `node tools/gen-schema-v2-fixtures.mjs touch-lifecycle.json`.
// Without this, adding a fifth fixture re-cuts the other four with fresh
// timestamps and different RAF-coalesced counts, invalidating four expectations
// files that had nothing wrong with them.
const ONLY = process.argv.slice(2);
const want = (name) => ONLY.length === 0 || ONLY.includes(name);

function write(name, recording) {
  const path = join(OUT, name);
  writeFileSync(path, JSON.stringify(recording, null, 2) + '\n');
  const events = recording.segments.reduce((n, s) => n + s.events.length, 0);
  console.log(`  wrote ${name}  ${recording.segments.length} segment(s), ${events} event(s)`);
  return recording;
}

// ── 1. redacted ────────────────────────────────────────────────────────────

if (want('redacted.json')) {
console.log('redacted.json');
const tmp = mkdtempSync(join(tmpdir(), 'ch-fixture-'));
const uploadPath = join(tmp, S.file);
writeFileSync(uploadPath, 'the contents are not recorded either\n');

const redacted = await withPage(REDACTED_PAGE, { redactSelector: '[data-ch-redact]' }, async (page) => {
  await startTrial(page, 'screening', 'ch:fixture');
  await settle(page);

  // Channel 1: the §8 floor. Real keystrokes, so key.down/key.up ride the
  // redacted path alongside input.value.
  await page.click('#pw');
  await page.keyboard.type(S.typed, { delay: 20 });
  await settle(page);

  // Channel 2: the selector-designated field, same sentinel.
  await page.click('#rd');
  await page.keyboard.type(S.typed, { delay: 20 });
  await settle(page);

  // Item 10: a real filename reaches the control. Chromium synthesizes
  // `C:\fakepath\<name>` for `.value`, which is the leak happy-dom cannot
  // reproduce.
  await page.setInputFiles('#picker', uploadPath);
  await settle(page);

  // The I2 vector: content written INSIDE the redacted subtree, then the node
  // carrying it moved OUT of that subtree mid-span.
  await page.evaluate((typed) => {
    document.getElementById('typed').textContent = typed;
  }, S.typed);
  await settle(page);
  await page.evaluate(() => {
    document.getElementById('open').appendChild(document.getElementById('typed'));
  });
  await settle(page);

  // One ordinary interaction outside the redacted subtree, so the fixture also
  // shows what an UNREDACTED event looks like in the same file.
  await page.click('#title');
  return finish(page);
});
write('redacted.json', redacted);
}

// ── 2. length-only clipboard ───────────────────────────────────────────────

if (want('length-only-clipboard.json')) {
console.log('length-only-clipboard.json');
const clipboard = await withPage(CLIPBOARD_PAGE, { clipboardContent: false }, async (page) => {
  await startTrial(page, 'paste-task', 'ch:fixture');
  await settle(page);
  await page.click('#answer');
  await page.keyboard.type('typed by hand', { delay: 20 });
  await settle(page);
  // A synthetic ClipboardEvent carrying a real DataTransfer: the capture path
  // reads `e.clipboardData.getData('text')` and cannot tell this from a system
  // paste. Headless Chromium has no system clipboard to paste from.
  await page.evaluate(() => {
    const target = document.getElementById('answer');
    const send = (type, text) => {
      const dt = new DataTransfer();
      if (text != null) dt.setData('text/plain', text);
      if (text != null) dt.setData('text/html', '<p>' + text + '</p>');
      target.dispatchEvent(new ClipboardEvent(type, {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    };
    send('paste', 'pasted from somewhere else entirely, 51 characters');
    send('copy', null);
    send('cut', null);
  });
  await settle(page);
  await page.evaluate(() => {
    document.getElementById('answer').value = 'typed by handpasted';
    document.getElementById('answer').dispatchEvent(new Event('input', { bubbles: true }));
  });
  return finish(page);
});
write('length-only-clipboard.json', clipboard);
}

// ── 3. aborted ─────────────────────────────────────────────────────────────

if (want('aborted.json')) {
console.log('aborted.json');
const aborted = await withPage(PLAIN_PAGE, {}, async (page) => {
  await startTrial(page, 'q1', 'ch:fixture');
  await settle(page);
  await page.click('#a');
  await settle(page);
  await page.evaluate(() => {
    const li = document.createElement('li');
    li.textContent = 'chose Alpha';
    document.getElementById('log').appendChild(li);
  });
  await settle(page);
  // Neither endTrial() nor stopSession(): the participant closed the tab.
  return finish(page, { stop: false });
});
write('aborted.json', aborted);
}

// ── 4. truncated ───────────────────────────────────────────────────────────

if (want('truncated.json')) {
console.log('truncated.json');
const truncated = await withPage(PLAIN_PAGE, { maxEventsPerTrial: 12 }, async (page) => {
  await startTrial(page, 'q1', 'ch:fixture');
  await settle(page);
  // Comfortably past the cap, so the stop lands mid-segment rather than at the
  // boundary where "the recording just ended" would look the same.
  for (let i = 0; i < 24; i++) {
    await page.evaluate((n) => {
      const li = document.createElement('li');
      li.textContent = 'row ' + n;
      document.getElementById('log').appendChild(li);
    }, i);
    await settle(page);
  }
  await page.click('#b');
  return finish(page);
});
write('truncated.json', truncated);
}

// ── 5. touch and lifecycle ─────────────────────────────────────────────────
// T7 brief item 12. T5.9's seek-budget gate enumerates its channel coverage
// against the shipped client's own KNOWN_TYPES and NAMES the types no fixture
// carries rather than letting their absence read as coverage. Twenty-one were
// named, and the brief is explicit that the list is not flat: touch.start and
// touch.end sit in capture's withAlignment set, so they carry §6 camera/anchor
// blocks and fire the §8 alignment self-check — the largest single term in a
// deep-span restore, and the only way an alignment claim about TOUCH input
// stops being an extrapolation from mouse input. One mobile-emulation
// recording covers touch.* and focus/blur at once; the gate needs no change to
// consume it, since it enumerates whatever the fixtures carry.

if (want('touch-lifecycle.json')) {
console.log('touch-lifecycle.json');
const touch = await withPage(PLAIN_PAGE, {}, async (page) => {
  await startTrial(page, 'tap-task', 'ch:fixture');
  await settle(page);
  // A real tap: touchstart + touchend through Chromium's input pipeline, not a
  // synthesized TouchEvent, so the touch lists are the browser's own.
  await page.touchscreen.tap(60, 90);
  await settle(page);
  // A drag, for touch.move — which is RAF-coalesced, so the count is one per
  // frame rather than one per step.
  await page.evaluate(() => new Promise((resolve) => {
    const el = document.getElementById('b');
    const pt = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    const fire = (type, touches) => el.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches,
    }));
    fire('touchstart', [pt(200, 200)]);
    let i = 0;
    const step = () => {
      if (i++ < 6) { fire('touchmove', [pt(200 + i * 12, 200 + i * 5)]); requestAnimationFrame(step); }
      else { fire('touchend', []); resolve(); }
    };
    requestAnimationFrame(step);
  }));
  await settle(page);
  // focus/blur are WINDOW-level in capture-trace, and headless Chromium will
  // not deliver a real window blur to a page it is driving, so they are
  // dispatched. The event objects carry nothing (§5.5: {type, t}), which is
  // exactly why dispatching them is faithful — there is no state to fake.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
  await settle(page);
  return finish(page);
}, { hasTouch: true, isMobile: false, viewport: { width: 390, height: 844 } });
write('touch-lifecycle.json', touch);
}

await browser.close();
console.log('\nNext: re-author each expectations twin. `node tools/gen-expectations-counts.mjs ' +
  '<fixture>` prints the counts block and an authoring inventory.');
