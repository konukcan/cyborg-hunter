// tools/convert/record-jspsych-v1.mjs
//
// Produces a REAL jsPsych `schema_version: 1` SessionRecording by running the
// vendored replay-test-suite timeline in a headless Chromium against the pinned
// upstream jsPsych build, then reading `jsPsych.getSessionRecording()` off the
// page. Its output is the input to `jspsych-v1-to-v2.mjs`; the pair is the
// regeneration path for the `jspsych-full` conformance fixture, which is why
// this script is committed rather than run once and thrown away.
//
// Run:
//   node tools/convert/record-jspsych-v1.mjs
//   node tools/convert/record-jspsych-v1.mjs --out /tmp/other.json
//   node tools/convert/record-jspsych-v1.mjs --headed        (watch it drive)
//
// Then:
//   node tools/convert/jspsych-v1-to-v2.mjs tests/tools/fixtures/jspsych-v1-full.json --out <v2.json>
//
// WHY A NEW PAGE INSTEAD OF bench/harness/index.html
// The bench harness cannot record: `initJsPsych` there is called without
// `record_session` (bench/harness/timeline.js), its `on_finish` saves a CSV,
// and the upstream demo's recording/download UI was deliberately not ported
// (bench/harness/trials/replay-test-suite.js:20-23). Wiring recording into the
// bench would change what the benchmark measures, so this script composes its
// own page from the two pieces it needs — the SAME pinned jsPsych build the
// bench loads, and the SAME vendored timeline module, served straight out of
// bench/ over http so the ES-module import resolves. bench/ is never modified
// or copied; a drift guard below fails loudly if the pin here and the pin in
// bench/harness/index.html ever disagree.
//
// WHAT THE RECORDING COVERS (and what it cannot)
// The vendored timeline is 14 trials: instructions (button nav), fullscreen
// enter/exit, keyboard responses, button response, slider drag, a canvas
// stimulus, a sketchpad the driver draws on, a 6-tile drag-and-drop free sort,
// a long scrolling survey, and typed text. That exercises mouse.*, key.*,
// input.*, scroll.*, dom.*, canvas.snapshot (full baselines AND region diffs)
// and the plugin-injected <style> elements that produce stylesheet.add events.
// It carries NO media.* events: the suite has no audio or video trial (the
// bench loads plugin-html-audio-response only for its own grafted trials, which
// are not part of the vendored suite). A recording that needs media.* coverage
// needs a different timeline, not a different driver.
//
// NETWORK: jsDelivr must be reachable. A preflight fetch fails fast with the
// fallback instruction rather than leaving Playwright to time out.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The PR-3661 preview SHA that adds `record_session`. Same pin as
// bench/harness/index.html:13 and bench/harness/trials/replay-test-suite.js:9;
// assertPin() below refuses to run if they drift apart, because a recording cut
// from a different build would silently be a different wire format.
const JSPSYCH_PIN = '4706a5e751c572c09a44a1b9a60d910e0c251d4a';
const CDN = `https://cdn.jsdelivr.net/gh/jspsych/jspsych@${JSPSYCH_PIN}`;

// Exactly the plugin globals the vendored timeline declares as required
// (replay-test-suite.js:28-39). Not the bench's list: the bench loads two more
// for trials this script does not run.
const PLUGINS = [
  'instructions', 'fullscreen', 'html-keyboard-response', 'html-button-response',
  'html-slider-response', 'canvas-keyboard-response', 'sketchpad', 'free-sort',
  'survey-multi-choice', 'survey-text',
];

const TIMELINE_MODULE = '/bench/harness/trials/replay-test-suite.js';
const PIN_WITNESSES = ['bench/harness/index.html', 'bench/harness/trials/replay-test-suite.js'];
const RECORD_ROUTE = '/__record-jspsych-v1__.html';
const DEFAULT_OUT = 'tests/tools/fixtures/jspsych-v1-full.json';

// The timeline's own documented order (replay-test-suite.js:57-69). Asserted
// after the run: if upstream is re-vendored and the shape moves, the driver
// stops rather than quietly recording a different experiment.
const EXPECTED_SEQUENCE = [
  'instructions', 'fullscreen',
  'html-keyboard-response', 'html-keyboard-response', 'html-keyboard-response', 'html-keyboard-response',
  'html-button-response', 'html-slider-response', 'canvas-keyboard-response',
  'sketchpad', 'free-sort', 'survey-multi-choice', 'survey-text', 'fullscreen',
];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const log = (msg) => process.stderr.write(msg + '\n');

// ── environment ─────────────────────────────────────────────────────────────

// playwright-core is not a CH dependency; it is resolved the way the existing
// browser batteries resolve it (tests/browser/replay/capture-fork-smoke.mjs).
// Unlike those, a miss here is fatal rather than a SKIP: this script has one
// job and no browser means it did not do it.
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

function assertPin() {
  for (const rel of PIN_WITNESSES) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    if (!text.includes(JSPSYCH_PIN)) {
      throw new Error(
        `pin drift: ${rel} no longer mentions ${JSPSYCH_PIN}. This script and the bench must ` +
        `load the same jsPsych build, or the recording it cuts is not the format the bench ` +
        `reproduces. Update JSPSYCH_PIN here and re-cut the fixture, deliberately.`
      );
    }
  }
}

async function preflightCdn() {
  const url = `${CDN}/packages/jspsych/dist/index.browser.min.js`;
  const res = await fetch(url, { redirect: 'follow' }).catch((e) => {
    throw new Error(
      `jsDelivr unreachable (${e.message}). This script cannot produce a real recording ` +
      `offline; the plan's fallback is a synthetic v1 recording.`
    );
  });
  if (!res.ok) throw new Error(`jsDelivr returned ${res.status} for ${url}`);
  const bytes = (await res.arrayBuffer()).byteLength;
  log(`  CDN preflight ok (${bytes} bytes of pinned jsPsych core)`);
}

// ── the page ────────────────────────────────────────────────────────────────

// One <script> per plugin, matching how the bench loads them: the vendored
// timeline reads plugin classes off globalThis, so they must be classic scripts
// and not module imports.
function buildPage() {
  const tags = [
    `<script src="${CDN}/packages/jspsych/dist/index.browser.min.js"></script>`,
    ...PLUGINS.map(p => `<script src="${CDN}/packages/plugin-${p}/dist/index.browser.min.js"></script>`),
  ].join('\n  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>record jsPsych v1 session</title>
  <link rel="stylesheet" href="${CDN}/packages/jspsych/css/jspsych.css">
  ${tags}
</head>
<body>
  <script type="module">
    import { buildReplayTestTrials } from '${TIMELINE_MODULE}';

    // No on_finish: jsPsych stops the recorder in run()'s finally block, AFTER
    // on_finish runs, so a recording read from there would carry
    // ended_at_perf: null and end_reason: null. Reading it when the run promise
    // resolves is the only way to capture a finished session.
    const jsPsych = initJsPsych({ record_session: true });
    window.jsPsych = jsPsych;

    window.__RECORD_ERROR__ = null;
    window.__RECORD_DONE__ = false;
    jsPsych.run(buildReplayTestTrials()).then(
      () => {
        window.__V1_RECORDING__ = jsPsych.getSessionRecording();
        window.__RECORD_DONE__ = true;
      },
      (err) => { window.__RECORD_ERROR__ = String(err && err.stack || err); }
    );
  </script>
</body>
</html>
`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

// A static server over the repo, plus one virtual route for the composed page.
// http rather than file:// for two reasons: jsPsych disables Web Audio and
// preloading under file:// (its "safe mode"), and ES-module imports of the
// vendored timeline need a real origin.
function startServer(pageHtml) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === RECORD_ROUTE) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(pageHtml);
      return;
    }
    const target = resolve(repoRoot, '.' + pathname);
    if (target !== repoRoot && !target.startsWith(repoRoot + sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    let body;
    try { body = readFileSync(target); } catch { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// ── per-plugin drivers ──────────────────────────────────────────────────────
//
// Keyed by the plugin's `info.name`, so the driver follows the timeline rather
// than a hard-coded click list: a trial the table does not cover stops the run
// instead of hanging on a page nobody is answering.

const HANDLERS = {
  // Forward, forward, BACK, forward, forward: the back click is deliberate —
  // it re-renders a page that was already recorded, which is the cheapest way
  // to get repeated dom.* churn against a stable subtree.
  async instructions(page) {
    const next = '#jspsych-instructions-next';
    const back = '#jspsych-instructions-back';
    await page.waitForSelector(next);
    for (const sel of [next, next, back, next, next]) {
      await page.click(sel);
      await page.waitForTimeout(150);
    }
  },

  // Enter shows a button; exit has no UI and self-advances after delay_after.
  // requestFullscreen may be refused in headless Chromium — the plugin does not
  // await it, so the trial ends either way and the recording simply may not
  // carry a fullscreen.enter event.
  async fullscreen(page) {
    const btn = page.locator('#jspsych-fullscreen-btn');
    try { await btn.waitFor({ state: 'visible', timeout: 1500 }); }
    catch { return; }
    await btn.click();
  },

  async 'html-keyboard-response'(page, cur) {
    await page.waitForSelector('#jspsych-html-keyboard-response-stimulus');
    await page.waitForTimeout(200);          // a plausible RT, and time for t_dom_ready
    await page.keyboard.press(playwrightKey(pickKey(cur)));
  },

  async 'html-button-response'(page) {
    const buttons = page.locator('#jspsych-html-button-response-btngroup button');
    await buttons.first().waitFor();
    await page.waitForTimeout(150);
    await buttons.nth(1).click();
  },

  // require_movement: true, and the plugin enables Continue on the slider's
  // mousedown. Dragging with the real mouse (rather than setting .value) is
  // what puts mouse.down/move/up plus input.value into the recording.
  async 'html-slider-response'(page) {
    const slider = page.locator('#jspsych-html-slider-response-response');
    await slider.waitFor();
    const box = await slider.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.78, box.y + box.height / 2, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    await page.click('#jspsych-html-slider-response-next');
  },

  async 'canvas-keyboard-response'(page, cur) {
    await page.waitForSelector('#jspsych-canvas-stimulus');
    await page.waitForTimeout(250);          // let the initial canvas snapshot land
    await page.keyboard.press(playwrightKey(pickKey(cur)));
  },

  // Three strokes, drawn slowly enough that the recorder's canvas frame tick
  // emits several region diffs rather than one end-of-trial baseline.
  async sketchpad(page) {
    const canvas = page.locator('#sketchpad-canvas');
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    const at = (fx, fy) => [box.x + fx * box.width, box.y + fy * box.height];
    const strokes = [
      [[0.15, 0.25], [0.40, 0.70], [0.65, 0.30]],
      [[0.20, 0.82], [0.80, 0.82]],
      [[0.55, 0.15], [0.60, 0.55]],
    ];
    for (const stroke of strokes) {
      await page.mouse.move(...at(...stroke[0]));
      await page.mouse.down();
      for (const point of stroke.slice(1)) {
        await page.mouse.move(...at(...point), { steps: 12 });
        await page.waitForTimeout(80);
      }
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(300);
    await page.click('#sketchpad-end');
  },

  // The Continue button is `visibility: hidden` until ALL SIX tiles are inside
  // the sort area, so every tile must actually be dragged. The plugin positions
  // a tile by writing `left/top` in arena coordinates, computed as the tile's
  // own offset plus the pointer delta (plus window.scrollY — hence the scroll
  // reset). Moving the mouse by (target - current bounding box) therefore lands
  // the tile exactly on `target` in arena space, which is where the plugin's
  // inside-the-square test is evaluated.
  async 'free-sort'(page) {
    await page.waitForSelector('#jspsych-free-sort-arena');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const arena = await page.locator('#jspsych-free-sort-arena').boundingBox();
    // Inside the 600x400 square with a comfortable margin (the plugin accepts
    // top-left coordinates in [40,560] x [40,360] for an 80px tile).
    const targets = [[100, 90], [250, 90], [400, 90], [100, 240], [250, 240], [400, 240]];
    for (let i = 0; i < targets.length; i++) {
      const tile = page.locator(`#jspsych-free-sort-draggable-${i}`);
      await tile.waitFor();
      const box = await tile.boundingBox();
      const dx = (arena.x + targets[i][0]) - box.x;
      const dy = (arena.y + targets[i][1]) - box.y;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(120);
    }
    const done = page.locator('#jspsych-free-sort-done-btn');
    await done.waitFor({ state: 'visible', timeout: 5000 });
    await done.click();
  },

  // 12 questions, none required. The scrolling is the point as much as the
  // answers: this is the only trial tall enough to produce scroll.window.
  async 'survey-multi-choice'(page) {
    await page.waitForSelector('#jspsych-survey-multi-choice-next');
    for (const y of [400, 900, 1400, 0]) {
      await page.evaluate((to) => window.scrollTo(0, to), y);
      await page.waitForTimeout(140);
    }
    for (const q of [0, 1, 2, 3, 6]) {
      const radios = page.locator(`#jspsych-survey-multi-choice-${q} input[type="radio"]`);
      await radios.first().waitFor();
      await radios.nth(q % 3).check();
      await page.waitForTimeout(80);
    }
    await page.click('#jspsych-survey-multi-choice-next');
  },

  // Typed character by character (not .fill) so the recording carries key.down/
  // key.up pairs alongside the input.value records.
  async 'survey-text'(page) {
    await page.waitForSelector('#input-0');
    const answers = ['Alex', '25', 'A thorough tour of every input type.'];
    for (let i = 0; i < answers.length; i++) {
      const field = page.locator(`#input-${i}`);
      await field.click();
      await field.pressSequentially(answers[i], { delay: 35 });
      await page.waitForTimeout(100);
    }
    await page.click('#jspsych-survey-text-next');
  },
};

// Answer the trial correctly when it says what correct is (the Stroop trials
// carry data.correct_response), otherwise take its first legal choice.
function pickKey(cur) {
  const choices = Array.isArray(cur.choices) ? cur.choices : [];
  if (cur.correct && choices.includes(cur.correct)) return cur.correct;
  if (choices.length) return choices[0];
  throw new Error(`trial ${cur.index} (${cur.plugin}) declares no key choices to press`);
}

function playwrightKey(key) {
  return key === ' ' ? 'Space' : key;
}

// ── driving ─────────────────────────────────────────────────────────────────

function currentTrial(page) {
  return page.evaluate(() => {
    const trial = window.jsPsych?.getCurrentTrial?.();
    if (!trial) return null;
    return {
      plugin: trial.type?.info?.name ?? null,
      index: window.jsPsych.getProgress().current_trial_global,
      choices: Array.isArray(trial.choices) ? trial.choices : null,
      correct: trial.data?.correct_response ?? null,
    };
  });
}

async function driveTimeline(page) {
  const sequence = [];
  // One guard turn per trial plus slack for the between-trial polls; the run
  // should take ~14 turns, so this only fires when something is stuck.
  for (let turn = 0; turn < 200; turn++) {
    const state = await page.evaluate(() => ({
      done: window.__RECORD_DONE__ === true,
      error: window.__RECORD_ERROR__,
    }));
    if (state.error) throw new Error(`jsPsych.run() rejected:\n${state.error}`);
    if (state.done) return sequence;

    const cur = await currentTrial(page);
    if (!cur) { await page.waitForTimeout(50); continue; }

    const handler = HANDLERS[cur.plugin];
    if (!handler) {
      throw new Error(
        `no driver for plugin "${cur.plugin}" at trial ${cur.index}. The vendored timeline ` +
        `grew a trial type this script cannot answer; add a handler to HANDLERS.`
      );
    }
    log(`  trial ${cur.index}: ${cur.plugin}`);
    sequence.push(cur.plugin);
    await handler(page, cur);

    await page.waitForFunction(
      (i) => window.__RECORD_DONE__ === true
        || window.__RECORD_ERROR__ !== null
        || window.jsPsych.getProgress().current_trial_global !== i,
      cur.index,
      { timeout: 30000 },
    ).catch(() => {
      throw new Error(
        `trial ${cur.index} (${cur.plugin}) did not advance after its driver ran. The plugin's ` +
        `completion condition was not met — check the handler against this jsPsych build.`
      );
    });
  }
  throw new Error('drive loop exhausted its turn budget without the timeline finishing');
}

// ── stats ───────────────────────────────────────────────────────────────────

function summarize(rec) {
  const types = {};
  let events = 0;
  let canvasFull = 0;
  let canvasRegion = 0;
  for (const trial of rec.trials) {
    for (const e of trial.events) {
      events++;
      types[e.type] = (types[e.type] ?? 0) + 1;
      if (e.type === 'canvas.snapshot') (e.region ? canvasRegion++ : canvasFull++);
    }
  }
  return {
    trials: rec.trials.length,
    events,
    types: Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1])),
    canvas_snapshots: { full: canvasFull, region: canvasRegion },
    stylesheets: rec.stylesheets.length,
    stylesheet_events: rec.stylesheet_events.length,
    viewport_changes: rec.viewport_changes.length,
    rng_calls: rec.rng_calls.length,
    math_random_patched: rec.rng?.math_random_patched ?? null,
    end_reason: rec.end_reason,
  };
}

// ── main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let out = join(repoRoot, DEFAULT_OUT);
  let headed = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      out = argv[++i];
      if (out === undefined) throw new Error('--out needs a path');
      out = resolve(process.cwd(), out);
    } else if (arg.startsWith('--out=')) {
      out = resolve(process.cwd(), arg.slice('--out='.length));
    } else if (arg === '--headed') {
      headed = true;
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }
  return { out, headed };
}

async function main() {
  const { out, headed } = parseArgs(process.argv.slice(2));

  assertPin();
  const pw = resolvePlaywright();
  if (!pw) {
    throw new Error(
      'playwright-core not found. Set PLAYWRIGHT_CORE_DIR to a checkout that has it, or ' +
      'npm i -D playwright-core.'
    );
  }
  await preflightCdn();

  const server = await startServer(buildPage());
  const url = `http://127.0.0.1:${server.address().port}${RECORD_ROUTE}`;
  log(`  serving ${repoRoot} at ${url}`);

  const browser = await pw.chromium.launch({ headless: !headed });
  // 1280x1000: the free-sort trial parks tiles up to 820px right of a centred
  // 600px arena, so a narrower window puts them off-screen and out of reach.
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));

  let recording;
  let sequence;
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.jsPsych !== 'undefined', null, { timeout: 30000 });
    log('▶ driving the vendored replay-test-suite timeline');
    sequence = await driveTimeline(page);
    recording = await page.evaluate(() => window.__V1_RECORDING__);
  } finally {
    await browser.close();
    server.close();
  }

  if (problems.length) {
    throw new Error(`the page reported problems, so the recording is not trustworthy:\n  ` +
      problems.join('\n  '));
  }
  if (!recording) throw new Error('getSessionRecording() returned nothing — is record_session wired?');

  const drift = sequence.length !== EXPECTED_SEQUENCE.length
    || sequence.some((p, i) => p !== EXPECTED_SEQUENCE[i]);
  if (drift) {
    throw new Error(
      `timeline drift: drove [${sequence.join(', ')}] but the vendored suite documents ` +
      `[${EXPECTED_SEQUENCE.join(', ')}]. Re-read replay-test-suite.js before re-cutting the fixture.`
    );
  }

  mkdirSync(dirname(out), { recursive: true });
  const text = JSON.stringify(recording, null, 2) + '\n';
  writeFileSync(out, text);

  const stats = summarize(recording);
  log('');
  log(`Wrote ${out} (${text.length} bytes)`);
  log(JSON.stringify(stats, null, 2));
  if (!stats.types['canvas.snapshot']) log('NOTE: no canvas.snapshot events — check the sketchpad/canvas handlers');
  log('');
  log('Next: node tools/convert/jspsych-v1-to-v2.mjs ' + out + ' --out <v2.json>');
}

main().catch((e) => {
  process.stderr.write(`record-jspsych-v1: ${e.message}\n`);
  process.exit(1);
});
