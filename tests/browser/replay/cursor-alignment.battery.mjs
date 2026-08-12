// tests/browser/replay/cursor-alignment.battery.mjs
// Cursor-alignment stress battery — the A1 condition in real browsers.
//
// THE ACCEPTANCE, and it is absolute: every anchored interaction is either
// ALIGNED within tolerance or FLAGGED. A silent misplacement anywhere fails the
// battery. "Flagged" means all four surfaces agree — `getChecks()` status,
// the header chip, the marker lane, and the cursor glyph — because a failure
// visible only to a test is not visible to an analyst.
//
// Parts:
//   A  — RETIRED by T5 (A2) Task 1. It drove the viewer over a v1 model and
//        asserted `model.legacy === true`, both of which the v2-only
//        `buildViewerModel` abolishes. Code and fixture are kept verbatim in
//        archive/ (see archive/README.md).
//   A′ — its "old artifacts still render" claim, re-homed: a REPORT generated
//        once from the `v0.7.1` tag, committed under archive/, opened here and
//        asserted to boot and reconstruct. That is what an analyst with an old
//        report actually does — and unlike a vendored frozen viewer, it is a
//        genuine artifact rather than a test that cannot fail.
//   P  — FROZEN v2 FIXTURE, LITERAL COORDINATES. Parts B–E record fresh every
//        run and assert self-consistency, and a self-checking battery cannot
//        catch a drift that moves the drawn dot and the target together. Part P
//        replays one committed recording and pins literal
//        `{segment, tRel, target}` coordinates plus literal stage positions
//        against it, so the battery keeps a non-self-referential anchor. This
//        is where part A's eight coordinates went.
//   B  — SYNTHETIC GRID: a real recording made with the dist recorder against a
//        hostile layout page, in the engine under test, and replayed in the same
//        run — the full capture→replay round trip, which is what the A1
//        condition is actually about. Scenarios: flick-scroll-then-click,
//        settled and same-task element scrollers, resize inside the coalescing
//        window, transformed and rotated containers, centred reflow,
//        parser-hostile shapes (table rows with no tbody, comment siblings,
//        duplicate ids, nested forms), redacted anchors, shadow hosts, iframe
//        placeholders + chips, plus a `viewport_changes` storm, browser zoom
//        (DPR) and pinch (`vv_scale`/`vv_offset_*` non-unity).
//   C  — CORRUPTION: deliberately corrupted recordings (tampered `anchor.rect`,
//        an `anchor.node` the span cannot hold, stripped stylesheets, a
//        corrupted camera seed) must make the self-check FIRE VISIBLY — never a
//        confident cursor. C4b pins the other direction: seed-only corruption
//        SELF-HEALS through the per-event camera, so it must NOT warn.
//   D  — TRACE TIER: cursor projection scales and letterboxes with no iframe.
//   E  — ADVISORIES: DPR mismatch, pinch/zoom state and CSS animations surface
//        visibly.
//
// ENGINES. Chromium by default, like `viewer-boot.battery.mjs` and
// `viewer-canvas.battery.mjs`; `--engines=chromium,firefox,webkit` runs the
// spread (needs `PLAYWRIGHT_CORE_DIR=/opt/homebrew/lib/node_modules/`, whose
// playwright-core has all three revisions installed). Every part records and
// replays inside the SAME engine, so a UA-stylesheet difference can never be
// read as a reconstruction difference — except part P, which deliberately
// replays a chromium-recorded fixture everywhere. The battery page's targets
// are `box-sizing: border-box` with explicit padding/border for that reason.
//
// CONSOLE ACCOUNTING. `pageerror` is a failure. Console errors are a failure
// too, with ONE declared whitelist: "Blocked autofocusing…" — a reconstruction
// carrying `autofocus` logs exactly one per mount on chromium and webkit (none
// on firefox), the sandbox refusing the focus steal is the CORRECT outcome, it
// is not a `pageerror`, and the attribute stays because it is recorded page
// state Task 7's `attr:autofocus` reads. (T5.4 finding (a).)
//
// Run:   npm run build && npm run test:browser:alignment
// Freeze: node tests/browser/replay/cursor-alignment.battery.mjs --freeze
//         (re-records fixtures/alignment-v2-frozen.json on chromium; the
//          literal pins in PINS below must then be re-read off it by hand)

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

import { buildViewerModel } from '../../../src/cli/renderers/replay-assets.js';
import { readReplayClientSrc } from '../../../src/cli/renderers/replay-client-source.js';
import { inlineSafeJson, inlineSafeSrc } from '../../../src/shared/inline-safe.js';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit === `--${n}` ? true : hit.slice(n.length + 3);
};
const ENGINES = String(opt('engines', 'chromium')).split(',').map((s) => s.trim()).filter(Boolean);
const HEADLESS = !opt('headed', false);
const FREEZE = !!opt('freeze', false);

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
if (!pw) { console.log('SKIP: playwright-core not found'); process.exit(0); }

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const artifactsDir = join(here, 'artifacts');
const fixturesDir = join(here, 'fixtures');
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(fixturesDir, { recursive: true });

const FROZEN_FIXTURE = join(fixturesDir, 'alignment-v2-frozen.json');
const FROZEN_REPORT = join(here, 'archive', 'v0.7.1-report', 'index.html');
const batteryPageUrl = 'file://' + join(here, 'battery-page.html');

let failures = 0;
let engineTag = '';
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + (engineTag ? '[' + engineTag + '] ' : '') + label); }
}

// The ONE declared console-error whitelist (see the header).
const CONSOLE_WHITELIST = [/Blocked autofocusing/i];
function watchPage(page, tag) {
  const seen = { pageErrors: [], consoleErrors: [], whitelisted: 0, requests: [] };
  page.on('pageerror', (e) => {
    seen.pageErrors.push(e.message);
    failures++;
    console.error('  ✖ [' + engineTag + '] ' + tag + ' pageerror: ' + e.message);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (CONSOLE_WHITELIST.some((re) => re.test(text))) { seen.whitelisted++; return; }
    seen.consoleErrors.push(text);
  });
  return seen;
}

// ── Viewer measurement harness ──
// Inlines the REAL viewer client (the ASSEMBLED script — the client alone calls
// `mountTree` out of a module the build concatenates ahead of it, so inlining
// the client file on its own would harness something the report never ships)
// plus a model, intercepts canvas arcs (the cursor dot is the last arc drawn
// per frame), and exposes the viewer's own debug surface.
const viewerSrc = readReplayClientSrc();

function harnessHtml(model) {
  const modelJson = inlineSafeJson(model);
  const safeViewer = inlineSafeSrc(viewerSrc);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    .replay-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
    .replay-stage { position: relative; overflow: hidden; background: #fff; border: 1px solid #ccc; }
    .replay-frame { position: absolute; top: 0; left: 0; border: 0; }
    .replay-overlay { position: absolute; top: 0; left: 0; pointer-events: none; }
    .replay-lane { display: block; margin-top: 6px; }
    .replay-scrub { display: block; margin: 2px 0 4px; }
    .replay-warn { color: #c62828; }
  </style></head><body>
  <div id="mount" style="width:720px"></div>
  <script>
    (function () {
      var origArc = CanvasRenderingContext2D.prototype.arc;
      var origClear = CanvasRenderingContext2D.prototype.clearRect;
      window.__arcs = [];
      // Only the OVERLAY canvas resets the arc log — the viewer also clears
      // the marker-lane canvas on every seek, after the overlay has drawn.
      CanvasRenderingContext2D.prototype.clearRect = function () {
        if (this.canvas && this.canvas.className === 'replay-overlay') window.__arcs = [];
        return origClear.apply(this, arguments);
      };
      CanvasRenderingContext2D.prototype.arc = function (x, y, r) {
        if (this.canvas && this.canvas.className === 'replay-overlay') {
          window.__arcs.push({ x: x, y: y, r: r });
        }
        return origArc.apply(this, arguments);
      };
    })();
  <\/script>
  <script>${safeViewer}<\/script>
  <script>
    window.__model = ${modelJson};
    initChReplayViewer(document.getElementById('mount'), window.__model);
    window.__dbg = function () { return document.getElementById('mount')._chReplayDebug; };
    // Measure at a segment-relative time: seek (exact, no scrub snapping),
    // read the drawn dot and the target's stage-space rect.
    window.__measure = function (tRel, targetId) {
      var dbg = window.__dbg();
      dbg.seek(tRel);
      var arcs = window.__arcs.slice();
      var dot = arcs.length ? arcs[arcs.length - 1] : null;
      var cam = dbg.getCamera();
      var f = document.querySelector('.replay-frame');
      var doc = f && f.contentDocument;
      var el = (targetId && doc) ? doc.getElementById(targetId) : null;
      var rect = el ? el.getBoundingClientRect() : null;
      var stageRect = null;
      if (rect) {
        stageRect = {
          x: cam.ox + rect.x * cam.k, y: cam.oy + rect.y * cam.k,
          w: rect.width * cam.k, h: rect.height * cam.k
        };
      }
      var stage = document.querySelector('.replay-stage');
      return {
        dot: dot, cam: cam, target: stageRect, glyph: window.__glyph(),
        stage: { w: parseFloat(stage.style.width), h: parseFloat(stage.style.height) }
      };
    };
    // The cursor GLYPH, read off the intercepted arcs. drawOverlay paints the
    // dot LAST: one r=5 filled arc when the latest interaction is confident,
    // and the uncertain pair (a dashed r=7 ring then an r=2 centre) when it is
    // not. This is the surface an analyst sees, so the battery reads it rather
    // than trusting getChecks() alone.
    window.__glyph = function () {
      var a = window.__arcs;
      if (!a.length) return 'none';
      var last = a[a.length - 1];
      if (last.r === 5) return 'confident';
      if (last.r === 2 && a.length > 1 && a[a.length - 2].r === 7) return 'uncertain';
      return 'other';
    };
    // Amber marker-lane columns (UNCERTAIN_COLOR #b26a00) — the "scrub to the
    // failing moment" surface. Counted as distinct columns, not pixels.
    window.__laneUncertain = function () {
      var lane = document.querySelector('.replay-lane');
      if (!lane) return -1;
      var c = lane.getContext('2d');
      var d = c.getImageData(0, 0, lane.width, lane.height).data;
      var cols = 0;
      for (var x = 0; x < lane.width; x++) {
        for (var y = 0; y < lane.height; y++) {
          var i = (y * lane.width + x) * 4;
          if (Math.abs(d[i] - 178) <= 2 && Math.abs(d[i + 1] - 106) <= 2 && d[i + 2] <= 2) { cols++; break; }
        }
      }
      return cols;
    };
    window.__chips = function () {
      var g = function (sel) {
        var n = document.querySelector(sel);
        return n && n.style.display !== 'none' ? n.textContent : null;
      };
      return {
        align: g('[data-ch-align]'),
        defect: g('[data-ch-defect]'),
        iframe: g('[data-ch-iframe-warn]'),
        shadow: g('[data-ch-shadow-warn]'),
        dpr: g('[data-ch-dpr-note]'),
        zoom: g('[data-ch-zoom-note]'),
        anim: g('[data-ch-anim-note]'),
        media: g('[data-ch-media-note]'),
        unknown: g('[data-ch-unknown-types]'),
        captureFailures: g('[data-ch-capture-failures]'),
        failures: g('[data-ch-apply-failures]')
      };
    };
  <\/script></body></html>`;
}

async function openHarness(browser, model, tag) {
  const path = join(artifactsDir, `battery-harness-${engineTag}-${tag}.html`);
  writeFileSync(path, harnessHtml(model));
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const watch = watchPage(page, 'harness ' + tag);
  await page.goto('file://' + path);
  await waitStable(page);
  page.__watch = watch;
  return page;
}

// Wait for the frame to be ready AND stay ready (the fonts.ready
// revalidation pass rebuilds once shortly after load).
async function waitStable(page) {
  await page.waitForFunction(() => window.__dbg() && window.__dbg().frameReady(), null, { timeout: 8000 });
  await page.waitForTimeout(250);
  await page.waitForFunction(() => window.__dbg().frameReady(), null, { timeout: 8000 });
}

async function selectSegment(page, i) {
  await page.evaluate((idx) => window.__dbg().selectSegment(idx), i);
  await waitStable(page);
}

// Drive a segment to its END before reading. The chip is PLAYHEAD-scoped, not
// merely segment-scoped: `checkSummary` counts `__chk`, which exists only for
// events the walk has passed, and every segment opens at playhead 0. A segment
// full of misaligned interactions shows a BLANK chip until it is played
// through. (T5.6 carry M-7.)
async function playToEnd(page, model, i) {
  await page.evaluate((d) => window.__dbg().seek(d), model.segments[i].durMs);
  await page.waitForTimeout(60);
}

async function readSegment(page) {
  return page.evaluate(() => ({
    checks: window.__dbg().getChecks(),
    counters: window.__dbg().getCounters(),
    stats: window.__dbg().getStats(),
    chips: window.__chips(),
    glyph: window.__glyph(),
    laneUncertain: window.__laneUncertain()
  }));
}

// Dot-in-target assertion, tolerance in STAGE px derived from CSS-px
// tolerance × scale (3 CSS px).
function dotInTarget(m) {
  if (!m.dot || !m.target) return false;
  const tol = 3 * m.cam.k;
  return m.dot.x >= m.target.x - tol && m.dot.x <= m.target.x + m.target.w + tol &&
         m.dot.y >= m.target.y - tol && m.dot.y <= m.target.y + m.target.h + tol;
}
function fmtMeasure(m) {
  return m.dot && m.target
    ? `(dot ${Math.round(m.dot.x)},${Math.round(m.dot.y)} target ${Math.round(m.target.x)},${Math.round(m.target.y)} ${Math.round(m.target.w)}×${Math.round(m.target.h)})`
    : '(missing)';
}

// ════════════════ the recording (driven in the engine under test) ════════════
//
// SEGMENT LIST — the A1 scenarios, one per segment, plus what each is FOR.
// `expect` is the acceptance for its anchored interactions:
//   'ok'      aligned within tolerance, every §8 comparison made
//   'flagged' the recording and the reconstruction genuinely disagree, and the
//             viewer must say so on all four surfaces
// A flagged entry also carries `reason`, and that is not decoration: without it
// the scenario asserts only that SOMETHING fired, so a future regression could
// flag for an unrelated cause and keep the battery green while the documented
// claim silently stops being tested. C1–C5 have carried a reason predicate
// since they were written (`expectUncertain`'s `reasonRe`); these two now match.
// `element-flick`'s Δ is a magnitude, deliberately: 200 px is the signature of
// this exact capture gap (the scroller moves 180 → 380 inside the click's own
// task), which is what distinguishes it from a generic geometry miss.
const GRID = [
  { id: 'baseline', expect: 'ok', why: 'plain click, nothing hostile' },
  { id: 'flick-scroll', expect: 'ok', why: 'three scrollTo calls and the click in ONE task: not one scroll event has dispatched, so only the synchronous per-event camera read can place it' },
  { id: 'scrolled', expect: 'ok', why: 'settled window scroll' },
  { id: 'fixed', expect: 'ok', why: 'position:fixed target under a scrolled page' },
  { id: 'element-scroll', expect: 'ok', why: 'settled inner scroller (scroll.element replayed)' },
  { id: 'element-flick', expect: 'flagged', reason: /rect moved \(Δ 200px\)/, why: 'inner scroll and the click in ONE task — capture has no synchronous element-scroll read, so the anchor rect describes a scroll state the stream places AFTER the click' },
  { id: 'transform', expect: 'ok', why: 'translated container' },
  { id: 'rotated', expect: 'ok', why: 'rotate(30deg) — the rect is the axis-aligned bounding box on both sides' },
  { id: 'resize-debounce', expect: 'ok', why: 'click dispatched immediately after a viewport change, inside the coalescing window' },
  { id: 'centred-reflow', expect: 'ok', why: 'margin:auto centring that moves with the viewport width' },
  { id: 'table-parser', expect: 'ok', why: '<tr> appended directly under <table>: v1 reparsed and got a <tbody>; v2 never parses' },
  { id: 'comments', expect: 'ok', why: 'comment siblings shift raw childNodes indices' },
  { id: 'dup-id', expect: 'ok', why: 'two elements sharing an id — resolution is by node id, not getElementById' },
  { id: 'nested-forms', expect: 'ok', why: '<form> inside <form>: impossible from markup, carried by a node tree' },
  { id: 'redacted', expect: 'ok', why: 'a redacted anchor keeps node+rect and is CHECKABLE (§8) — strictly more than v1' },
  { id: 'dup-input', expect: 'ok', why: 'duplicate-id inputs: the value must restore into the second' },
  { id: 'shadow', expect: 'flagged', reason: /shadow content not captured/, why: 'the interaction retargeted to a shadow host whose content no recording can hold (§13)' },
  { id: 'iframe-removed', expect: 'ok', why: 'iframe placeholder removed mid-span; the warning must stay LATCHED' },
];

async function recordGrid(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  watchPage(page, 'record');
  await page.goto(batteryPageUrl);
  await page.evaluate(() => window.BAT.start());

  const trial = async (id, fn) => {
    await page.evaluate((t) => window.BAT.trial(t), id);
    await fn();
    await page.waitForTimeout(120);
  };

  await trial('baseline', async () => { await page.click('#t-base'); });
  await trial('flick-scroll', async () => {
    await page.evaluate(() => window.BAT.flickThenClick('t-flick', [300, 900, 1500]));
  });
  await trial('scrolled', async () => {
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(150);
    await page.click('#t-scroll');
  });
  await trial('fixed', async () => { await page.click('#t-fixed'); });
  await trial('element-scroll', async () => {
    await page.evaluate(() => { window.scrollTo(0, 1200); document.getElementById('scrollbox').scrollTop = 180; });
    await page.waitForTimeout(180);
    await page.click('#t-inner');
  });
  await trial('element-flick', async () => {
    await page.evaluate(() => window.BAT.scrollElementThenClick('scrollbox', 380, 't-inner'));
  });
  await trial('transform', async () => {
    await page.evaluate(() => window.scrollTo(0, 1400));
    await page.waitForTimeout(150);
    await page.click('#t-trans');
  });
  await trial('rotated', async () => {
    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.waitForTimeout(150);
    await page.click('#t-rot');
  });
  await trial('resize-debounce', async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.evaluate(() => window.BAT.clickAt('t-center'));
  });
  await trial('centred-reflow', async () => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, 1950));
    await page.waitForTimeout(150);
    await page.click('#t-center');
  });
  await trial('table-parser', async () => {
    await page.evaluate(() => window.scrollTo(0, 2100));
    await page.evaluate(() => window.BAT.addTableRow());
    await page.waitForTimeout(150);
    await page.click('#t-row');
  });
  await trial('comments', async () => { await page.click('#t-comment'); });
  await trial('dup-id', async () => { await page.locator('#dup-zone button').nth(1).click(); });
  await trial('nested-forms', async () => {
    await page.evaluate(() => window.scrollTo(0, 2200));
    await page.waitForTimeout(150);
    await page.click('#t-nested');
  });
  await trial('redacted', async () => {
    await page.evaluate(() => window.scrollTo(0, 2260));
    await page.waitForTimeout(150);
    await page.click('#secret');
    await page.keyboard.type('hunter2');
  });
  await trial('dup-input', async () => {
    await page.locator('[id="dup-in"]').nth(1).click();
    await page.locator('[id="dup-in"]').nth(1).fill('typed into second');
  });
  await trial('shadow', async () => {
    await page.evaluate(() => window.scrollTo(0, 2380));
    await page.waitForTimeout(150);
    await page.click('#shadow-host');
  });
  await trial('iframe-removed', async () => {
    await page.evaluate(() => window.BAT.removeIframe());
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.click('#t-base');
  });

  const recording = await page.evaluate(() => window.BAT.finish());
  await page.close();
  return recording;
}

// ── zoom: a whole session recorded at devicePixelRatio 2 (a REAL context-level
// device scale factor, not a stub) ──
async function recordZoom(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  watchPage(page, 'record-zoom');
  await page.goto(batteryPageUrl);
  await page.evaluate(() => window.BAT.start());
  await page.evaluate(() => window.BAT.trial('zoomed'));
  await page.click('#t-base');
  await page.waitForTimeout(150);
  const rec = await page.evaluate(() => window.BAT.finish());
  await ctx.close();
  return rec;
}

// ── pinch, FOR REAL: Chromium's own visual viewport, driven over CDP ────────
// THE GEOMETRY WITNESS, and it has to be this rather than the stub below.
// `Emulation.setPageScaleFactor` is Chromium's genuine pinch: it moves the
// VISUAL viewport and nothing else. The stubbed scenario cannot evidence that,
// because it changes no layout by construction — its checks would pass
// identically in a world where real pinch DID move geometry, so it can neither
// confirm nor disconfirm the claim the design rests on. (T5.8 fix, review I-1.)
//
// Chromium only: CDP is Chromium's protocol, and one engine is a sufficient
// witness for a claim about what the CSSOM means by "client coordinates" — the
// layout-viewport rule is the specification's, not an engine's.
//
// Returns the recording plus the before/after geometry probes, so the claim is
// asserted from measurements taken IN THE PAGE while the pinch was live.
async function recordRealPinch(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  watchPage(page, 'record-real-pinch');
  await page.goto(batteryPageUrl);
  const cdp = await page.context().newCDPSession(page);
  const probe = () => page.evaluate(() => {
    const el = document.getElementById('t-base');
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      clientW: document.documentElement.clientWidth,
      innerW: window.innerWidth,
      vv: vv ? { scale: vv.scale, w: Math.round(vv.width), h: Math.round(vv.height) } : null
    };
  });
  await page.evaluate(() => window.BAT.start());
  await page.evaluate(() => window.BAT.trial('real-pinch'));
  const before = await probe();
  await page.evaluate(() => window.BAT.clickAt('t-base'));       // 1×
  await page.waitForTimeout(140);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 });
  await page.waitForTimeout(200);
  const during = await probe();
  await page.evaluate(() => window.BAT.clickAt('t-base'));       // mid-pinch, same element
  await page.waitForTimeout(140);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await page.waitForTimeout(200);
  const after = await probe();
  const rec = await page.evaluate(() => window.BAT.finish());
  await page.close();
  return { rec, before, during, after };
}

// ── pinch: `visualViewport` (and a mid-segment DPR change) shadowed on window ──
// DECLARED STUB, and it pins something narrower than the part above: that the
// ADVISORY is playhead-scoped, and that the wire values a pinched participant
// produces are consumed correctly. It is not evidence about geometry — its
// layout is untouched by construction — which is exactly why the real-pinch
// part exists beside it. What it buys that CDP cannot: a mid-segment DPR change
// and a non-zero `vv_offset_*`, neither of which
// `Emulation.setPageScaleFactor` produces on its own, and both of which the
// chip has to render. `cameraBlock()` reads `win.devicePixelRatio` and
// `win.visualViewport` live in each interaction's own handler, so shadowing
// those two globals produces exactly the wire values a pinched/zoomed
// participant produces.
async function recordPinch(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  watchPage(page, 'record-pinch');
  await page.goto(batteryPageUrl);
  await page.evaluate(() => window.BAT.start());
  await page.evaluate(() => window.BAT.trial('pinched'));
  await page.click('#t-base');                                     // 1× baseline
  await page.waitForTimeout(140);
  await page.evaluate(() => { window.BAT.pinch(2.5, 120, 64); window.BAT.setDpr(3); });
  await page.click('#t-fixed');                                    // mid-pinch
  await page.waitForTimeout(140);
  await page.evaluate(() => { window.BAT.unpinch(); window.BAT.resetDpr(); });
  await page.click('#t-base');                                     // back to 1×
  await page.waitForTimeout(140);
  const rec = await page.evaluate(() => window.BAT.finish());
  await page.close();
  return rec;
}

const clone = (r) => JSON.parse(JSON.stringify(r));
const segOf = (rec, label) => rec.segments.find((s) => s.label === label);
const idxOf = (model, label) => model.segments.findIndex((s) => s.label === label);
const spanKeyframeFor = (rec, model, label) => {
  const i = idxOf(model, label);
  return rec.segments[model.segments[i].spanStart];
};

// ════════════════════════════════ PART P pins ════════════════════════════════
//
// LITERAL COORDINATES over `fixtures/alignment-v2-frozen.json`, read off that
// file once and written here by hand. This is the non-self-referential anchor
// the archive README promises in place of part A's eight: `tRel` is a statement
// about the RECORDING (a time-base change moves what is on screen there),
// `target` is a statement about the id map, and `dot`/`rect` are absolute stage
// positions that a drift moving the dot and the target TOGETHER cannot satisfy.
//
// The literals hold on ALL THREE ENGINES (measured; the two rows that differ do
// so by one pixel, inside the ±2 tolerance). That is what the battery page's
// `box-sizing: border-box` targets buy: with UA-default buttons the boxes
// differ by several pixels between engines and these pins would be measuring
// the UA stylesheet. Both spans are represented (0–9 and 10–17), so a
// span-walk regression cannot hide in the second one.
// TWO ROWS ARE TIGHT, and the file should say which before a rounding change
// somewhere reads as a regression: firefox reports segment 1's rect y as 229
// against the pinned 230, and segment 4's as 107 against 106. Both are inside
// ±2 and both are marked below; every other row is byte-exact on all three
// engines. (T5.8 fix, review M-5.)
const PINS = [
  { segment: 0, tRel: 28.5, target: 't-base', label: 'segment 0 click #t-base (unscrolled, span 0 keyframe)',
    dot: [140, 97], rect: [117, 89, 45, 17] },
  // TIGHT: firefox reads rect y 229 here, 1 px off the chromium/webkit 230.
  { segment: 1, tRel: 11.8, target: 't-flick', label: 'segment 1 click #t-flick (three scrollTo and the click in ONE task)',
    dot: [207, 239], rect: [173, 230, 68, 19] },
  // TIGHT: firefox reads rect y 107 here, 1 px off the chromium/webkit 106.
  { segment: 4, tRel: 194.2, target: 't-inner', label: 'segment 4 click #t-inner (settled element scroller)',
    dot: [84, 115], rect: [61, 106, 45, 17] },
  { segment: 7, tRel: 160.7, target: 't-rot', label: 'segment 7 click #t-rot (rotate(30deg) container)',
    dot: [381, 72], rect: [351, 48, 60, 48] },
  { segment: 9, tRel: 362.1, target: 't-center', label: 'segment 9 click #t-center (centred reflow at 1100px, 9 segments into the span)',
    dot: [360, 88], rect: [334, 78, 52, 20] },
  { segment: 13, tRel: 169.9, target: 't-nested', label: 'segment 13 click #t-nested (form inside form, second span)',
    dot: [489, 266], rect: [463, 256, 52, 20] },
];

// ═══════════════════════════════ the engine run ══════════════════════════════

async function runEngine(name) {
  engineTag = name;
  const browser = await pw[name].launch({ headless: HEADLESS });
  console.log(`\n══════════════ ${name} ══════════════`);

  // ── A′ — the 0.7.x-era report still renders ────────────────────────────────
  console.log("▶ A′ — a 0.7.x report generated from the v0.7.1 tag still boots and reconstructs");
  if (!existsSync(FROZEN_REPORT)) {
    check(false, 'committed 0.7.x report present at ' + FROZEN_REPORT);
  } else {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const watch = watchPage(page, 'frozen report');
    await page.goto('file://' + FROZEN_REPORT);
    check(await page.locator('.replay-block').count() > 0, 'the old report still renders its replay section');
    await page.click('.replay-load-btn');
    await page.waitForSelector('.replay-stage', { timeout: 8000 });
    await page.waitForTimeout(1200);
    const st = await page.evaluate(() => {
      const f = document.querySelector('.replay-frame');
      const doc = f && f.contentDocument;
      return {
        bodyLen: doc && doc.body ? doc.body.innerHTML.length : 0,
        text: doc && doc.body ? doc.body.textContent : '',
        trials: document.querySelectorAll('.replay-trial-select option').length
      };
    });
    check(st.bodyLen > 200, `its own inlined 0.7.x viewer reconstructs (${st.bodyLen} chars in the frame)`);
    check(/cyborg-hunter smoke test/i.test(st.text), 'the reconstruction is the recorded page, not an empty shell');
    check(st.trials === 3, `all three trials are selectable (${st.trials})`);
    check(watch.consoleErrors.length === 0, 'no console errors in the old report (' + (watch.consoleErrors[0] || 'none') + ')');
    await page.close();
  }

  // ── W — the one declared console whitelist, exercised ──────────────────────
  console.log('▶ W — "Blocked autofocusing" is whitelisted, and the whitelist is REACHED');
  {
    // A whitelist nothing ever trips is a claim, not a guard. `jspsych-full`
    // carries `autofocus` once, so it produces the real specimen: the sandbox
    // refusing the focus steal (chromium and webkit log it; firefox is silent).
    // The attribute STAYS — it is recorded page state that Task 7's
    // `attr:autofocus` reads — so the right answer is to name the error, not to
    // strip the attribute. (T5.4 finding (a).)
    const rec2 = JSON.parse(readFileSync(
      join(repoRoot, 'tests', 'replay', 'schema-v2', 'fixtures', 'jspsych-full.json'), 'utf8'));
    const autofocusSeg = rec2.segments.findIndex((s) => /"autofocus"/.test(JSON.stringify(s.initial_dom || null)));
    check(autofocusSeg === 12,
      `the corpus fixture carries an autofocus attribute, in segment ${autofocusSeg}'s keyframe`);
    const page = await openHarness(browser, buildViewerModel(rec2), 'autofocus');
    await selectSegment(page, autofocusSeg);   // the boot only mounts segment 0
    await page.waitForTimeout(300);
    const w = page.__watch;
    check(w.consoleErrors.length === 0,
      'no console error survives the whitelist (' + (w.consoleErrors[0] || 'none') + ')');
    if (name === 'firefox') {
      check(w.whitelisted === 0, `firefox does not log it (${w.whitelisted}) — recorded, not required`);
    } else {
      check(w.whitelisted >= 1,
        `the whitelist is actually reached on ${name} (${w.whitelisted} blocked-autofocus errors)`);
    }
    await page.close();
  }

  // ── P — frozen v2 fixture, literal coordinates ─────────────────────────────
  console.log('▶ P — frozen v2 fixture: literal {segment, tRel, target} coordinates');
  if (FREEZE && !existsSync(FROZEN_FIXTURE)) {
    // Bootstrap only: the fixture is written by part B below, and the literal
    // PINS are read off it by hand afterwards. A normal run never takes this
    // branch, because the fixture is committed.
    console.log('  ⟲ SKIPPED — bootstrapping the fixture in this run (--freeze)');
  } else {
    const frozen = JSON.parse(readFileSync(FROZEN_FIXTURE, 'utf8'));
    const model = buildViewerModel(frozen);
    check(model.schemaVersion === 2 && model.tier === 'dom' && model.foreign === false,
      `the frozen fixture is a v2 CH dom recording (${model.segments.length} segments)`);
    const page = await openHarness(browser, model, 'frozen');
    let cur = -1;
    for (const p of PINS) {
      if (p.segment !== cur) { await selectSegment(page, p.segment); cur = p.segment; }
      const m = await page.evaluate(({ tRel, target }) => window.__measure(tRel, target), p);
      check(dotInTarget(m), `${p.label}: cursor inside target ${fmtMeasure(m)}`);
      const dOk = m.dot && Math.abs(m.dot.x - p.dot[0]) <= 2 && Math.abs(m.dot.y - p.dot[1]) <= 2;
      const rOk = m.target && Math.abs(m.target.x - p.rect[0]) <= 2 && Math.abs(m.target.y - p.rect[1]) <= 2 &&
        Math.abs(m.target.w - p.rect[2]) <= 2 && Math.abs(m.target.h - p.rect[3]) <= 2;
      check(dOk && rOk, `${p.label}: LITERAL stage position holds ` +
        `(dot ${m.dot ? Math.round(m.dot.x) + ',' + Math.round(m.dot.y) : 'none'} vs ${p.dot.join(',')}; ` +
        `rect ${m.target ? [m.target.x, m.target.y, m.target.w, m.target.h].map(Math.round).join(',') : 'none'} vs ${p.rect.join(',')})`);
    }
    // Part A's ninth assertion, re-homed in DOM tier (T5.8 fix, review M-4):
    // an interaction with NO element target still projects on-stage. Part A
    // made it with a background click during its squeeze storm; the closest
    // shape the frozen fixture carries is the un-anchored `mouse.move` in
    // segment 9, whose own segment is the one whose viewport width changed.
    // Part D makes the same claim in TRACE tier, which is where it lived until
    // now — and trace tier has no reconstruction, so it could not stand in.
    await selectSegment(page, 9);
    const noTarget = await page.evaluate(() => window.__measure(361.8, null));
    const expX = noTarget.cam.ox + 550 * noTarget.cam.k;
    const expY = noTarget.cam.oy + 117 * noTarget.cam.k;
    check(noTarget.dot && noTarget.dot.x >= 0 && noTarget.dot.x <= noTarget.stage.w &&
      noTarget.dot.y >= 0 && noTarget.dot.y <= noTarget.stage.h,
      `an interaction with no element target stays ON stage in DOM tier ` +
      `(dot ${noTarget.dot ? Math.round(noTarget.dot.x) + ',' + Math.round(noTarget.dot.y) : 'none'} ` +
      `in ${noTarget.stage.w}×${noTarget.stage.h})`);
    check(noTarget.dot && Math.abs(noTarget.dot.x - expX) <= 1 && Math.abs(noTarget.dot.y - expY) <= 1,
      `and lands at the letterboxed client point, with no re-projection ` +
      `(vs ${Math.round(expX)},${Math.round(expY)})`);

    check(page.__watch.consoleErrors.length === 0,
      'no unwhitelisted console errors over the frozen fixture (' + (page.__watch.consoleErrors[0] || 'none') + ')');
    await page.close();
  }

  // ── B — synthetic grid: record fresh in THIS engine, replay in this engine ──
  console.log('▶ B — synthetic grid: capture → replay round trip, ' + GRID.length + ' A1 scenarios');
  const rec = await recordGrid(browser);

  if (FREEZE && name === 'chromium') {
    writeFileSync(FROZEN_FIXTURE, JSON.stringify(rec));
    console.log('  ⟲ froze ' + FROZEN_FIXTURE + ' — re-read the PINS literals by hand');
  }

  // Wire-side claims first: what a battery over the MODEL can no longer see.
  check(rec.schema_version === 2, 'the dist recorder produced a v2 recording');
  check(rec.segments.length === GRID.length,
    `${rec.segments.length} segments recorded, one per scenario (${GRID.length} expected)`);
  check(rec.segments.every((s, i) => s.label === GRID[i].id),
    'segment labels are the scenario list in order');
  const anchored = rec.segments.flatMap((s) => s.events).filter((e) => e.anchor);
  check(anchored.length >= GRID.length * 3,
    `${anchored.length} anchored interactions on the wire (§6 blocks on down/up/click)`);
  check(anchored.every((e) => e.camera && typeof e.camera.dpr === 'number' &&
    typeof e.camera.vv_scale === 'number' && typeof e.camera.vv_offset_x === 'number' &&
    typeof e.camera.vv_offset_y === 'number'),
    'every anchored event carries a COMPLETE §6 camera block (all ten fields)');
  const redAnchors = segOf(rec, 'redacted').events.filter((e) => e.anchor).map((e) => e.anchor);
  check(redAnchors.length > 0 && redAnchors.every((a) => a.id === undefined && a.rect && a.node != null),
    `redacted anchors OMIT id but keep node+rect, so they stay checkable (${redAnchors.length})`);
  const redKeys = segOf(rec, 'redacted').events.filter((e) => e.type.indexOf('key.') === 0);
  check(redKeys.length > 0 && redKeys.every((e) => e.redacted === true && e.key === undefined),
    `redacted key events carry type+time and nothing else (${redKeys.length})`);
  const moveWithAnchor = rec.segments.flatMap((s) => s.events)
    .filter((e) => e.type === 'mouse.move' && e.anchor).length;
  check(moveWithAnchor === 0, 'mouse.move carries no anchor (payload discipline)');
  const flickCam = segOf(rec, 'flick-scroll').events.find((e) => e.type === 'mouse.down').camera;
  check(flickCam.scroll_y === 1500,
    `the flick click's camera read the LIVE scroll synchronously (scroll_y=${flickCam.scroll_y}, no scroll event had dispatched)`);
  const resizeCam = segOf(rec, 'resize-debounce').events.find((e) => e.type === 'mouse.down').camera;
  check(resizeCam.viewport_w === 900,
    `the in-debounce click's camera read the NEW viewport synchronously (viewport_w=${resizeCam.viewport_w})`);

  const model = buildViewerModel(rec);
  check(model.segments.filter((s) => s.keyframe).length >= 2 &&
    new Set(model.segments.map((s) => s.spanStart)).size >= 2,
    `the recording spans more than one keyframe (${model.segments.filter((s) => s.keyframe).length} keyframes, ` +
    `${new Set(model.segments.map((s) => s.spanStart)).size} spans) — deep-span restores are exercised`);

  {
    const page = await openHarness(browser, model, 'grid');
    // Mount accounting reads a DELTA, never an absolute: happy-dom's
    // synchronous srcdoc parse lets the boot restore run before selectSegment(0)
    // does its own, where a browser defers the first to `onload`, so
    // `getStats().mounts` differs by one between realms at boot. (T5.4 M-3.)
    const before = await page.evaluate(() => window.__dbg().getStats());
    await selectSegment(page, 1);
    const after = await page.evaluate(() => window.__dbg().getStats());
    check(after.mounts - before.mounts === 1,
      `a segment change is exactly one mount (delta ${after.mounts - before.mounts}, absolute ${after.mounts})`);
    check(after.shellWrites === before.shellWrites && after.shellWrites === 1,
      `the shell is written once and never again (${after.shellWrites})`);
    await playToEnd(page, model, 1);
    const inSpan = await page.evaluate(() => window.__dbg().getStats());
    check(inSpan.mounts === after.mounts,
      'a forward seek inside the applied span mounts nothing (incremental walk)');

    for (const spec of GRID) {
      const i = idxOf(model, spec.id);
      await selectSegment(page, i);
      await playToEnd(page, model, i);
      const s = await readSegment(page);
      const anchorChecks = s.checks.filter((c) => c.status !== 'redacted');
      const bad = anchorChecks.filter((c) => c.status === 'uncertain');

      if (spec.expect === 'ok') {
        // THE A1 ACCEPTANCE, positive half: aligned within tolerance AND every
        // §8 comparison actually made. `ok` with a non-empty `skipped` is a
        // partial verification, so it is reported — but not failed, because a
        // point outside the frame viewport makes `elementFromPoint` return null
        // and that is COMMON in real recordings (T5.6 confirmation carry).
        check(anchorChecks.length > 0 && bad.length === 0,
          `"${spec.id}": all ${anchorChecks.length} self-checks pass — ${spec.why}` +
          (bad.length ? ` — failing: ${JSON.stringify(bad[0])}` : ''));
        const partial = anchorChecks.filter((c) => c.skipped.length > 0);
        if (partial.length) {
          console.log(`      · ${spec.id}: ${partial.length} partial (skipped ` +
            JSON.stringify([...new Set(partial.flatMap((c) => c.skipped))]) + ')');
        }
      } else {
        // THE A1 ACCEPTANCE, negative half — and this is the half that matters.
        // A genuine disagreement must be visible on ALL FOUR surfaces, not just
        // in getChecks(): a failure only a test can see is a silent
        // misplacement as far as an analyst is concerned.
        check(bad.length > 0,
          `"${spec.id}": the self-check FIRED (${bad.length}/${anchorChecks.length}) — ${spec.why}` +
          (bad.length ? ` [${bad[0].reasons.join('; ')}]` : ''));
        check(bad.length > 0 && bad.every((c) => c.reasons.some((r) => spec.reason.test(r))),
          `"${spec.id}": and it fired for the DOCUMENTED reason /${spec.reason.source}/ ` +
          `(${JSON.stringify(bad.length ? bad[0].reasons : [])})`);
        check(s.chips.align != null && /⚠/.test(s.chips.align),
          `"${spec.id}": the header chip warns (${s.chips.align})`);
        check(s.glyph === 'uncertain',
          `"${spec.id}": the cursor is drawn as the UNCERTAIN glyph, not a confident dot (${s.glyph})`);
        check(s.laneUncertain > 0,
          `"${spec.id}": the marker lane paints the failing moment amber (${s.laneUncertain} columns)`);
      }

      check(s.counters.patchFailures === 0 && s.counters.skipped === 0,
        `"${spec.id}": no patch/instantiation failures (${JSON.stringify(s.counters)})`);
      check(s.counters.unknownTypes.length === 0,
        `"${spec.id}": every recorded type is understood (${JSON.stringify(s.counters.unknownTypes)})`);
      check(s.chips.defect == null, `"${spec.id}": no §3 defect chip`);

      // Per-scenario structural claims — the things a status alone cannot say.
      if (spec.id === 'table-parser') {
        const shape = await page.evaluate(() => {
          const doc = document.querySelector('.replay-frame').contentDocument;
          const t = doc.getElementById('the-table');
          return t ? Array.from(t.children).map((n) => n.tagName.toLowerCase()).join(',') : null;
        });
        check(shape === 'tr',
          `"${spec.id}": the <tr> is a DIRECT child of <table> — v2 never parses, so no <tbody> is invented (${shape})`);
      }
      if (spec.id === 'comments') {
        const kinds = await page.evaluate(() => {
          const doc = document.querySelector('.replay-frame').contentDocument;
          const z = doc.getElementById('dup-zone');
          return z ? Array.from(z.childNodes).filter((n) => n.nodeType === 8).length : -1;
        });
        check(kinds === 2, `"${spec.id}": both comment siblings survive the round trip (${kinds})`);
      }
      if (spec.id === 'nested-forms') {
        const nested = await page.evaluate(() => {
          const doc = document.querySelector('.replay-frame').contentDocument;
          const inner = doc.getElementById('inner-form');
          return !!(inner && inner.parentElement && inner.parentElement.id === 'outer-form');
        });
        check(nested, `"${spec.id}": <form> inside <form> is reconstructed (a parser would have dropped the inner one)`);
      }
      if (spec.id === 'dup-input') {
        const values = await page.evaluate(() => {
          const doc = document.querySelector('.replay-frame').contentDocument;
          return Array.from(doc.querySelectorAll('[id="dup-in"]')).map((n) => n.value);
        });
        check(values[0] === '' && values[1] === 'typed into second',
          `"${spec.id}": the typed value restored into the SECOND duplicate (${JSON.stringify(values)})`);
      }
      if (spec.id === 'redacted') {
        const value = await page.evaluate(() => {
          const doc = document.querySelector('.replay-frame').contentDocument;
          const n = doc.getElementById('secret');
          return n ? n.value : null;
        });
        check(/^•+$/.test(value),
          `"${spec.id}": the redacted field replays as bullets, never the text (${JSON.stringify(value)})`);
        check(s.checks.some((c) => c.status === 'redacted'),
          `"${spec.id}": redacted key events land in the redacted bucket, not the geometry one`);
        check(s.chips.align != null && /redacted/.test(s.chips.align),
          `"${spec.id}": the chip names the redacted bucket (${s.chips.align})`);
      }
      if (spec.id === 'shadow') {
        // The reason itself is asserted by the generic `spec.reason` predicate
        // above; what is left here is the §13 CHIP, which is a different
        // surface from the check's reason string.
        check(s.chips.shadow != null && /shadow/i.test(s.chips.shadow),
          `"${spec.id}": the shadow-content warning chip is shown`);
      }
      if (spec.id === 'iframe-removed') {
        const gone = await page.evaluate(() => {
          const doc = document.querySelector('.replay-frame').contentDocument;
          return {
            live: !!doc.querySelector('iframe, [data-ch-placeholder="iframe"]'),
            removeT: null
          };
        });
        check(!gone.live, `"${spec.id}": the placeholder really is gone from the reconstruction`);
        check(s.chips.iframe != null,
          `"${spec.id}": the iframe warning stays LATCHED after the placeholder is removed mid-span ` +
          `(chip ${JSON.stringify(s.chips.iframe)})`);
      }
    }

    // The verified branch of the chip, read at the end of a clean segment.
    await selectSegment(page, idxOf(model, 'baseline'));
    await playToEnd(page, model, idxOf(model, 'baseline'));
    const clean = await readSegment(page);
    check(clean.chips.align != null && /^alignment verified \(\d+ checks?\)$/.test(clean.chips.align),
      `the clean segment reports verified with no qualifier (${clean.chips.align})`);
    check(clean.glyph === 'confident', `the clean segment draws a confident dot (${clean.glyph})`);
    check(clean.laneUncertain === 0, 'the clean segment paints no amber in the lane');
    check(clean.chips.iframe != null && /iframe/i.test(clean.chips.iframe),
      'the iframe placeholder chip is shown (the page contains an uncaptured iframe)');

    check(page.__watch.consoleErrors.length === 0,
      'no unwhitelisted console errors across the whole grid (' + (page.__watch.consoleErrors[0] || 'none') + ')');
    if (page.__watch.whitelisted) {
      console.log(`      · ${page.__watch.whitelisted} whitelisted "Blocked autofocusing" console error(s)`);
    }
    await page.close();
  }

  // ── B-STORM — a viewport_changes storm folds to a handful of style writes ──
  console.log('▶ B-storm — 240 viewport changes must fold to ≤6 real iframe style writes');
  {
    // The bound is a VIEWER property (`pendingCamSize` + one flush per applied
    // batch), so the storm is injected into the real recording rather than
    // physically resized 240 times: the recorder COALESCES resizes by design,
    // which would make a physical storm test capture's coalescing instead of
    // the viewer's fold. Part A's bound, unchanged.
    const r = clone(rec);
    const target = segOf(r, 'centred-reflow');
    const span = spanKeyframeFor(r, model, 'centred-reflow');
    const t0 = span.t_load != null ? span.t_load : (span.t_dom_ready != null ? span.t_dom_ready : span.t_start);
    const t1 = target.t_end;
    r.viewport_changes = [];
    for (let i = 0; i < 240; i++) {
      // The LAST entry carries a width nothing else in the recording states, so
      // "the storm was consumed" is checkable directly rather than inferred
      // from the alignment check that follows. `writes <= 6` alone is satisfied
      // by a viewer that stopped sizing the iframe at all — and it measured 0
      // on firefox and webkit, so the bound had no lower guard. (T5.8 fix,
      // review M-6.) STORM_W also forces at least one real style write on every
      // engine, since it differs from the box the segment opens with.
      r.viewport_changes.push({
        w: i === 239 ? 1234 : 1000 + (i % 2 ? 100 : 0),
        h: 700, dpr: 1, scale: 1, offset_x: 0, offset_y: 0,
        t: Number((t0 + ((t1 - t0) * (i + 1)) / 242).toFixed(1))
      });
    }
    const lastEventT = Math.max(...target.events.map((e) => e.t));
    check(r.viewport_changes[239].t > lastEventT && r.viewport_changes[239].t < t1,
      `the storm's distinctive final entry lands after the segment's last event and inside its window ` +
      `(${r.viewport_changes[239].t} in (${lastEventT}, ${t1}))`);
    const m2 = buildViewerModel(r);
    check(m2.viewportChanges.length === 240, 'the storm recording carries 240 viewport changes');
    const page = await openHarness(browser, m2, 'storm');
    const i = idxOf(m2, 'centred-reflow');
    const writes = await page.evaluate(async (seg) => {
      const dbg = window.__dbg();
      dbg.selectSegment(seg);
      await new Promise((r2) => setTimeout(r2, 400));
      const f = document.querySelector('.replay-frame');
      let count = 0;
      const mo = new MutationObserver((muts) => {
        muts.forEach((mu) => { if (mu.attributeName === 'style') count++; });
      });
      mo.observe(f, { attributes: true });
      dbg.seek(1e9);                     // ONE forward seek across the whole storm
      await new Promise((r2) => setTimeout(r2, 150));
      mo.disconnect();
      return count;
    }, i);
    check(writes <= 6, `the storm folded (${writes} iframe style writes for 240 viewport changes)`);
    // The lower guard, explicit on every engine: the fold has to have HAPPENED.
    const cam = await page.evaluate(() => window.__dbg().getCamera());
    check(cam.cw === 1234 && cam.w === 1234,
      `and the storm was actually consumed — the applied camera ends at the last entry's own width ` +
      `(cw ${cam.cw}, w ${cam.w}, expected 1234)`);
    check(writes >= 1,
      `which means at least one real style write happened (${writes}) — a viewer that stopped ` +
      'sizing the iframe would satisfy the upper bound alone');
    await playToEnd(page, m2, i);
    const s = await readSegment(page);
    check(s.checks.length > 0 && s.checks.every((c) => c.status === 'ok'),
      `the interaction inside the storm is still aligned (${s.checks.length} checks)`);
    await page.close();
  }

  // ── B-latch — a placeholder removed at tRel 0 must still latch its chip ────
  console.log('▶ B-latch — the §13 placeholder warning cannot depend on sample timing');
  {
    // Reachable from a REAL recording, and this battery hit it: WebKit's timer
    // granularity is 1 ms, so a removal in the same millisecond as the segment
    // origin rounds to tRel 0 — applied inside the first `applyUpTo`, before a
    // latch that only samples at batch boundaries has looked. Pinned here as a
    // constructed tRel 0 so it bites on every engine rather than on WebKit's
    // scheduling luck.
    const r = clone(rec);
    const seg = segOf(r, 'iframe-removed');
    const origin = seg.t_load != null ? seg.t_load : (seg.t_dom_ready != null ? seg.t_dom_ready : seg.t_start);
    const rm = seg.events.find((e) => e.type === 'dom.remove');
    check(!!rm, 'the iframe placeholder is removed by a dom.remove patch');
    if (rm) rm.t = origin;                        // → tRel 0
    const m2 = buildViewerModel(r);
    const i = idxOf(m2, 'iframe-removed');
    check(m2.segments[i].events.find((e) => e.type === 'dom.remove').t === 0,
      'the removal now lands at tRel 0, inside the very first applied batch');
    const page = await openHarness(browser, m2, 'latch');
    await selectSegment(page, i);
    await playToEnd(page, m2, i);
    const s = await readSegment(page);
    check(s.chips.iframe != null,
      `the iframe warning still latches from the span keyframe (${JSON.stringify(s.chips.iframe)})`);
    await page.close();
  }

  // ── B-inversion — the debounce hazard, OBSERVED rather than constructed ────
  console.log('▶ B-inversion — a viewport_changes entry stamped AFTER the click it describes');
  {
    // The resize-debounce segment does not need a corrupted recording to make
    // this case: browsers dispatch the resize NOTIFICATION asynchronously, so
    // the session-stream entry describing the 900px viewport is genuinely
    // stamped after the click that happened under it. A viewer folding only
    // `viewport_changes` would replay that click under the PREVIOUS viewport
    // and land the cursor on a `margin:auto` element that has not re-centred.
    // §8 makes the per-event block authoritative for exactly this reason.
    const i = idxOf(model, 'resize-debounce');
    const clickT = segOf(rec, 'resize-debounce').events.find((e) => e.type === 'mouse.click').t;
    const natural = rec.viewport_changes.some((c) => c.w === 900 && c.t > clickT);
    // Whether the inversion happens on its own is up to the engine's own
    // scheduling (chromium dispatches the resize notification after the
    // synthetic click, firefox before it), so the ordering is IMPOSED here and
    // the observation is reported rather than asserted. Either way the shape
    // under test is the same one, and it is a shape a real recording produces.
    console.log('      · this engine ' + (natural ? 'produced the inversion on its own' :
      'dispatched the resize notification first, so the inversion is imposed below'));
    const inverted = clone(rec);
    inverted.viewport_changes = inverted.viewport_changes
      .filter((c) => c.w !== 900)
      .concat([{ w: 900, h: 600, dpr: 1, scale: 1, offset_x: 0, offset_y: 0, t: clickT + 5 }])
      .sort((a, b) => a.t - b.t);
    const mInv = buildViewerModel(inverted);
    const page = await openHarness(browser, mInv, 'inversion');
    await selectSegment(page, i);
    await playToEnd(page, mInv, i);
    const s = await readSegment(page);
    check(s.checks.length > 0 && s.checks.every((c) => c.status === 'ok'),
      `the click aligns with the session stream inverted (${s.checks.length} checks` +
      (s.checks.some((c) => c.status !== 'ok') ? '; ' + JSON.stringify(s.checks.find((c) => c.status !== 'ok').reasons) : '') + ')');
    await page.close();

    // ...and the biting half, so the pass above is not luck: with the per-event
    // camera removed the ONLY viewport statement left is the late session
    // entry, and the same interaction must FLAG rather than place a confident
    // cursor on a `margin:auto` element that has not re-centred.
    const bite = clone(inverted);
    segOf(bite, 'resize-debounce').events.forEach((e) => { if (e.camera) delete e.camera; });
    await expectUncertain(bite, 'inversion-bite',
      'B-inversion (per-event camera removed)', 'resize-debounce', /rect moved|cursor outside/);
  }

  // ── B-ZOOM / B-PINCH — the three §6 camera fields nothing used to read ──
  console.log('▶ B-zoom — a session recorded at devicePixelRatio 2');
  {
    const zrec = await recordZoom(browser);
    const zcam = segOf(zrec, 'zoomed').events.find((e) => e.anchor).camera;
    check(zcam.dpr === 2, `the wire carries the real device scale factor (camera.dpr=${zcam.dpr})`);
    check(zrec.viewport.dpr === 2, `the session viewport carries it too (viewport.dpr=${zrec.viewport.dpr})`);
    const m2 = buildViewerModel(zrec);
    const page = await openHarness(browser, m2, 'zoom');
    await playToEnd(page, m2, 0);
    const s = await readSegment(page);
    check(s.checks.length > 0 && s.checks.every((c) => c.status === 'ok'),
      `alignment holds at DPR 2 — CSS pixels are DPR-independent (${s.checks.length} checks)`);
    check(s.chips.dpr != null && /DPR 2/.test(s.chips.dpr),
      `the DPR advisory fires (${s.chips.dpr})`);
    await page.close();
  }

  // ── B-pinch-real — the geometry claim's actual witness ────────────────────
  console.log('▶ B-pinch-real — a REAL Chromium pinch (CDP Emulation.setPageScaleFactor)');
  if (name !== 'chromium') {
    console.log('      · SKIPPED on ' + name + ': CDP is Chromium\'s protocol. The claim is about ' +
      'the CSSOM\'s layout-viewport rule, so one engine is a sufficient witness.');
  } else {
    const { rec: prec, before, during, after } = await recordRealPinch(browser);
    const same = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

    // 1. the pinch really happened, in the page's own reading of itself
    check(before.vv.scale === 1 && during.vv.scale === 2.5 && after.vv.scale === 1,
      `visualViewport.scale went 1 → 2.5 → 1 for real (${before.vv.scale}/${during.vv.scale}/${after.vv.scale})`);
    check(Math.abs(during.vv.w - before.vv.w / 2.5) <= 2,
      `and the visual viewport shrank by the scale factor (${before.vv.w} → ${during.vv.w} css px)`);

    // 2. ...and moved NOTHING the five §8 predicates read. This is the claim.
    check(same(during.rect, before.rect) && same(after.rect, before.rect),
      `getBoundingClientRect is unmoved by a real 2.5× pinch ` +
      `(${JSON.stringify(before.rect)} vs ${JSON.stringify(during.rect)})`);
    check(during.clientW === before.clientW && during.innerW === before.innerW,
      `the LAYOUT viewport is unmoved too (clientWidth ${before.clientW} → ${during.clientW})`);

    // 3. and the recording says the same, from capture's own live reads
    const clicks = segOf(prec, 'real-pinch').events.filter((e) => e.type === 'mouse.click' && e.anchor);
    check(clicks.length === 2, `two anchored clicks on the same element, 1× and 2.5× (${clicks.length})`);
    check(clicks.length === 2 && clicks[0].camera.vv_scale === 1 && clicks[1].camera.vv_scale === 2.5,
      'the wire carries the REAL vv_scale — capture read the live API, no stub involved');
    check(clicks.length === 2 && clicks[0].x === clicks[1].x && clicks[0].y === clicks[1].y,
      `both clicks report the SAME client point across the pinch (${clicks[0] && clicks[0].x},${clicks[0] && clicks[0].y})`);
    check(clicks.length === 2 && same(clicks[0].anchor.rect, clicks[1].anchor.rect),
      `and the SAME anchor.rect (${JSON.stringify(clicks[0] && clicks[0].anchor.rect)})`);

    // 4. therefore the predicates are correct without reading the three fields,
    //    which is the design §8 amendment's whole content — now measured over a
    //    genuine pinch rather than over a stub that could not have failed.
    const m2 = buildViewerModel(prec);
    const page = await openHarness(browser, m2, 'pinch-real');
    await playToEnd(page, m2, 0);
    const s = await readSegment(page);
    check(s.checks.length === 6 && s.checks.every((c) => c.status === 'ok'),
      `every interaction aligns across a REAL pinch (${s.checks.length} checks` +
      (s.checks.some((c) => c.status !== 'ok') ? '; ' + JSON.stringify(s.checks.find((c) => c.status !== 'ok').reasons) : '') + ')');
    check(s.chips.zoom != null && /2\.5/.test(s.chips.zoom),
      `and the advisory still names the state the participant was in (${s.chips.zoom})`);
    await page.close();
  }

  console.log('▶ B-pinch — the advisory is playhead-scoped (stubbed vv_offset_* and a mid-segment DPR change)');
  {
    const prec = await recordPinch(browser);
    const evs = segOf(prec, 'pinched').events.filter((e) => e.anchor && e.type === 'mouse.down');
    check(evs.length === 3, `three anchored clicks recorded: 1×, mid-pinch, 1× again (${evs.length})`);
    check(evs[0].camera.vv_scale === 1 && evs[0].camera.dpr === 1,
      'the first click is recorded at scale 1 / DPR 1');
    check(evs[1].camera.vv_scale === 2.5 && evs[1].camera.vv_offset_x === 120 &&
      evs[1].camera.vv_offset_y === 64 && evs[1].camera.dpr === 3,
      `the mid-pinch click carries vv_scale/vv_offset_*/dpr on the wire ` +
      `(${evs[1].camera.vv_scale}, ${evs[1].camera.vv_offset_x},${evs[1].camera.vv_offset_y}, dpr ${evs[1].camera.dpr})`);
    check(evs[2].camera.vv_scale === 1 && evs[2].camera.dpr === 1,
      'the third click is recorded back at scale 1 / DPR 1');

    const m2 = buildViewerModel(prec);
    const page = await openHarness(browser, m2, 'pinch');
    // Nothing here is evidence about geometry — the stub touches no layout, so
    // these nine checks would pass whatever real pinch did. They pin the weaker
    // and still necessary thing: a recording carrying non-unity `vv_*`/`dpr` is
    // not itself a reason to doubt the reconstruction. B-pinch-real above is
    // where the geometry claim is measured. (T5.8 fix, review I-1.)
    await playToEnd(page, m2, 0);
    const end = await readSegment(page);
    check(end.checks.length === 9 && end.checks.every((c) => c.status === 'ok'),
      `non-unity vv_*/dpr on the wire does not by itself make a check uncertain (${end.checks.length} checks)`);

    // ...AND THEN THE ADVISORY, which is what they ARE for. The chip is
    // playhead-scoped: silent before the pinch, naming the state during it,
    // quiet again after. Read in an order that makes the state's LIFETIME
    // load-bearing: `during` and `atStart` are backward seeks, so each is a
    // full restore, and `atStart` sits before any camera block at all — which
    // is the only position that can tell "rebuilt by the walk" from "left over
    // from wherever the analyst last looked".
    const anch = m2.segments[0].events.filter((e) => e.anchor);
    const at = (t) => page.evaluate((tt) => { window.__dbg().seek(tt); return window.__chips(); }, t);
    const during = await at(anch[3].t + 1);
    const atStart = await at(0);
    const before = await at(anch[0].t + 1);
    const after = await at(anch[6].t + 1);
    check(during.zoom != null && /2\.5/.test(during.zoom) && /120/.test(during.zoom),
      `the pinch state is reported AT the interaction (${during.zoom})`);
    check(atStart.zoom == null,
      `a restore to before any camera block clears the note — the state belongs to the walk (${atStart.zoom})`);
    check(before.zoom == null, `no pinch note before the pinch (${before.zoom})`);
    check(after.zoom == null, `the note clears when the pinch ends (${after.zoom})`);
    check(during.dpr != null && /DPR 3/.test(during.dpr) && atStart.dpr == null &&
      before.dpr == null && after.dpr == null,
      `the DPR advisory follows the PLAYHEAD, not the segment seed (${during.dpr})`);
    await page.close();
  }

  // ════════════════ PART C — corruption: the check must FIRE ════════════════
  console.log('▶ C — corruption: the self-check must fire visibly, never a confident cursor');

  async function expectUncertain(recording, tag, label, segLabel, reasonRe) {
    const m2 = buildViewerModel(recording);
    const page = await openHarness(browser, m2, tag);
    const i = idxOf(m2, segLabel);
    await selectSegment(page, i);
    await playToEnd(page, m2, i);
    const s = await readSegment(page);
    const fired = s.checks.filter((c) => c.status === 'uncertain');
    check(fired.length > 0,
      `${label}: the self-check fired (${JSON.stringify((fired[0] || {}).reasons || [])})`);
    if (reasonRe) {
      check(fired.some((c) => c.reasons.some((r) => reasonRe.test(r))),
        `${label}: the reason names the real divergence (/${reasonRe.source}/)`);
    }
    check(s.chips.align != null && /⚠/.test(s.chips.align), `${label}: the chip warns (${s.chips.align})`);
    check(s.glyph === 'uncertain', `${label}: the cursor glyph is the uncertain one (${s.glyph})`);
    check(s.laneUncertain > 0, `${label}: the lane marks the moment (${s.laneUncertain} columns)`);
    await page.close();
  }

  { // C1 — a tampered anchor rect: the target "moved" 50px at record time
    const r = clone(rec);
    segOf(r, 'baseline').events.forEach((e) => { if (e.anchor && e.anchor.rect) e.anchor.rect.x += 50; });
    await expectUncertain(r, 'c1', 'C1 tampered anchor.rect', 'baseline', /rect moved/);
  }
  { // C2 — an anchor.node the span cannot hold (§7's third outcome: LOUD)
    const r = clone(rec);
    segOf(r, 'baseline').events.forEach((e) => { if (e.anchor) e.anchor.node = 999999; });
    await expectUncertain(r, 'c2', 'C2 unresolvable anchor.node', 'baseline', /not held by this span/);
  }
  { // C3 — stylesheets stripped: the layout diverges from record time
    const r = clone(rec);
    r.stylesheets = [];
    r.stylesheet_events = [];
    await expectUncertain(r, 'c3', 'C3 stripped stylesheets (layout divergence)', 'scrolled', /rect moved|cursor outside/);
  }
  { // C4 — corrupted camera: the seed AND every per-event block agree on a lie,
    //      so there is no camera truth left anywhere in the recording.
    const r = clone(rec);
    const kf = spanKeyframeFor(r, model, 'comments');
    kf.initial_state.scroll.y += 300;
    for (const s of r.segments) {
      s.events.forEach((e) => {
        if (e.camera && typeof e.camera.scroll_y === 'number') e.camera.scroll_y += 300;
      });
      s.events = s.events.filter((e) => e.type !== 'scroll.window');
    }
    // The reason it fires with is itself informative: the corrupted scroll
    // (2216) is past the document's own maximum, so the frame clamps at 1916
    // and check 1a catches the divergence before the rect check gets to. Both
    // are accepted — what must never happen is silence.
    await expectUncertain(r, 'c4', 'C4 corrupted camera (seed + every per-event block)', 'comments',
      /applied scroll diverges|rect moved|cursor outside/);
  }
  { // C4b — SEED-ONLY corruption self-heals through the per-event camera, and
    //       must NOT warn. The opposite direction from C4, and the reason C4
    //       has to lose the snapshots too.
    const r = clone(rec);
    const kf = spanKeyframeFor(r, model, 'comments');
    kf.initial_state.scroll.y += 300;
    for (const s of r.segments) s.events = s.events.filter((e) => e.type !== 'scroll.window');
    const m2 = buildViewerModel(r);
    const page = await openHarness(browser, m2, 'c4b');
    const i = idxOf(m2, 'comments');
    await selectSegment(page, i);
    await playToEnd(page, m2, i);
    const s = await readSegment(page);
    check(s.checks.length > 0 && s.checks.every((c) => c.status === 'ok'),
      'C4b seed-only corruption SELF-HEALS through the per-event camera snapshots' +
      (s.checks.some((c) => c.status !== 'ok') ? ' — ' + JSON.stringify(s.checks.find((c) => c.status !== 'ok').reasons) : ''));
    check(s.glyph === 'confident', 'C4b draws a confident cursor (a repaired camera is not an uncertain one)');
    check(s.laneUncertain === 0, 'C4b paints no amber (a false alarm is a failure too)');
    await page.close();
  }
  { // C5 — a camera block stating only scroll_y: folded nowhere, applied
    //      nowhere. The shape T5.6's I-1 found, reachable from a recording
    //      alone, and the one that used to read `ok` over a frame 300px away.
    const r = clone(rec);
    for (const s of r.segments) {
      s.events = s.events.filter((e) => e.type !== 'scroll.window');
      s.events.forEach((e) => { if (e.camera) e.camera.scroll_x = null; });
    }
    await expectUncertain(r, 'c5', 'C5 camera stating only scroll_y (never ordered, never applied)', 'scrolled', /applied scroll diverges|rect moved/);
  }

  // ════════════════ PART D — trace tier: projection with no reconstruction ═══
  console.log('▶ D — trace tier: the cursor scales and letterboxes without an iframe');
  {
    const r = clone(rec);
    r.extensions['cyborg-hunter'].tier = 'trace';
    const m2 = buildViewerModel(r);
    check(m2.tier === 'trace', 'the model reads the tier out of the CH extension');
    const page = await openHarness(browser, m2, 'trace');
    const i = idxOf(m2, 'scrolled');
    const clickEv = m2.segments[i].events.find((e) => e.type === 'mouse.click');
    await page.evaluate((idx) => window.__dbg().selectSegment(idx), i);
    await page.waitForTimeout(150);
    const m = await page.evaluate((t) => window.__measure(t, null), clickEv.t);
    const expX = m.cam.ox + clickEv.x * m.cam.k;
    const expY = m.cam.oy + clickEv.y * m.cam.k;
    check(m.cam.k > 0 && m.cam.k < 1, `the stage transform is initialised (k=${m.cam.k.toFixed(3)})`);
    check(m.dot && Math.abs(m.dot.x - expX) <= 1 && Math.abs(m.dot.y - expY) <= 1,
      `the dot is scaled and letterboxed from CLIENT coordinates, with no re-projection ` +
      `(${m.dot ? Math.round(m.dot.x) + ',' + Math.round(m.dot.y) : 'none'} vs ${Math.round(expX)},${Math.round(expY)})`);
    check(m.dot && m.dot.y >= 0 && m.dot.y <= m.stage.h,
      'a scrolled click stays ON stage with no DOM to scroll (the scroll is folded, not applied)');
    const chips = await page.evaluate(() => window.__chips());
    check(chips.align === '' || chips.align == null,
      `no alignment claim is made in trace tier — there is nothing to check against (${JSON.stringify(chips.align)})`);
    await page.close();
  }

  // ════════════════ PART E — declared-limitation advisories are loud ════════
  console.log('▶ E — advisories: DPR mismatch and CSS animations surface visibly');
  {
    const r = clone(rec);
    r.viewport.dpr = 2;
    r.viewport_changes.forEach((c) => { c.dpr = 2; });
    for (const s of r.segments) s.events.forEach((e) => { if (e.camera) e.camera.dpr = 2; });
    r.stylesheets = [{
      id: 1, kind: 'inline', media: null, href: null,
      css: '@keyframes spin { to { transform: rotate(1turn) } } .x { animation: spin 2s linear infinite }'
    }];
    const m2 = buildViewerModel(r);
    const page = await openHarness(browser, m2, 'advisories');
    await playToEnd(page, m2, 0);
    const chips = await page.evaluate(() => window.__chips());
    check(chips.dpr != null && /DPR 2/.test(chips.dpr), `the DPR-mismatch advisory is shown (${chips.dpr})`);
    check(chips.anim != null && /animation/i.test(chips.anim), `the CSS-animation advisory is shown (${chips.anim})`);
    await page.close();
  }

  await browser.close();
}

for (const name of ENGINES) {
  if (!pw[name]) { console.error(`unknown engine "${name}"`); failures++; continue; }
  await runEngine(name);
}
engineTag = '';

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nCursor-alignment battery passed: every anchored interaction aligned or flagged, on ' +
  ENGINES.join(', ') + '.');
process.exit(0);
