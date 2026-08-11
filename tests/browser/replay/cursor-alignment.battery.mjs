// tests/browser/replay/cursor-alignment.battery.mjs
// Cursor-alignment robustness battery.
//
// Three parts:
//   A — ACCEPTANCE: a captured failing recording (SMOKE-19NRQR, committed
//       under fixtures/) replays with the cursor ON every known target across
//       scroll, sidebar squeeze, mid-session resize storm — via the LEGACY
//       path (no anchors), with the legacy banner present.
//   B — SYNTHETIC GRID: a real recording made with the dist recorder against
//       a hostile layout page (scroll, fixed, inner scroll, transforms,
//       rotation, centered reflow + resize, parser-normalized tables,
//       comment siblings, duplicate ids, redaction, iframes); every anchored
//       interaction must pass the viewer's own self-check AND the drawn dot
//       must land inside the target.
//   C — CORRUPTION: deliberately corrupted recordings (tampered anchor rect,
//       stripped markers, stripped CSS, corrupted camera seed) must make the
//       self-check FIRE VISIBLY — never a confident cursor.
//
// Run: npm run build && node tests/browser/replay/cursor-alignment.battery.mjs

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

import { buildViewerModel } from '../../../src/cli/renderers/replay-assets.js';

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
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const artifactsDir = join(here, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + label); }
}

// ── Viewer measurement harness ──
// Inlines the REAL viewer client + a model, intercepts canvas arcs (the
// cursor dot is the last arc drawn per frame), and exposes the viewer's own
// debug surface for camera/check readout.
const viewerSrc = readFileSync(
  join(repoRoot, 'src', 'cli', 'renderers', 'replay-viewer.client.js'), 'utf8');

function harnessHtml(model) {
  const modelJson = JSON.stringify(model).replace(/</g, '\\u003c');
  const safeViewer = viewerSrc.replace(/<\/script/gi, '<\\/script');
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
    // Measure at a trial-relative time: seek (exact, no scrub snapping),
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
        dot: dot, cam: cam, target: stageRect,
        stage: { w: parseFloat(stage.style.width), h: parseFloat(stage.style.height) }
      };
    };
    window.__chips = function () {
      var g = function (sel) {
        var n = document.querySelector(sel);
        return n && n.style.display !== 'none' ? n.textContent : null;
      };
      return {
        align: g('[data-ch-align]'),
        legacy: g('[data-ch-legacy]'),
        iframe: g('[data-ch-iframe-warn]'),
        shadow: g('[data-ch-shadow-warn]'),
        dpr: g('[data-ch-dpr-note]'),
        anim: g('[data-ch-anim-note]'),
        failures: g('[data-ch-apply-failures]')
      };
    };
  <\/script></body></html>`;
}

async function openHarness(browser, model, tag) {
  const path = join(artifactsDir, `battery-harness-${tag}.html`);
  writeFileSync(path, harnessHtml(model));
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on('pageerror', (e) => { failures++; console.error('  ✖ harness pageerror: ' + e.message); });
  await page.goto('file://' + path);
  await waitStable(page);
  return page;
}

// Wait for the frame to be ready AND stay ready (the fonts.ready
// revalidation pass rebuilds once shortly after load).
async function waitStable(page) {
  await page.waitForFunction(() => window.__dbg() && window.__dbg().frameReady(), null, { timeout: 5000 });
  await page.waitForTimeout(250);
  await page.waitForFunction(() => window.__dbg().frameReady(), null, { timeout: 5000 });
}

async function selectTrial(page, i) {
  await page.evaluate((idx) => window.__dbg().selectTrial(idx), i);
  await waitStable(page);
}

// Dot-in-target assertion, tolerance in STAGE px derived from CSS-px
// tolerance × scale (3 CSS px).
function dotInTarget(m) {
  if (!m.dot || !m.target) return false;
  const tol = 3 * m.cam.k;
  return m.dot.x >= m.target.x - tol && m.dot.x <= m.target.x + m.target.w + tol &&
         m.dot.y >= m.target.y - tol && m.dot.y <= m.target.y + m.target.h + tol;
}

const browser = await chromium.launch({ headless: true });

// ════════════════ PART A — acceptance fixture (legacy path) ════════════════
console.log('▶ A — acceptance: the user\'s own failing recording (legacy path)');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'SMOKE-19NRQR-replay.json'), 'utf8'));
const fixtureModel = buildViewerModel(fixture);
check(fixtureModel.legacy === true, 'fixture is a legacy recording (no view_state)');
const t2cam = fixtureModel.trials[2].camera;
check(t2cam.y === 176 && t2cam.w === 1424,
  `trial-2 camera seed folded across trials (y=${t2cam.y}, w=${t2cam.w})`);

{
  const page = await openHarness(browser, fixtureModel, 'fixture');
  const chips = await page.evaluate(() => window.__chips());
  check(!!chips.legacy && /legacy/i.test(chips.legacy), 'legacy banner is shown unconditionally');

  // Every interaction the user KNOWS they made (smoke-test script), incl.
  // the trial-boundary click artifacts and the Finish mousedown that the old
  // bubble-phase capture used to lose.
  const SPECS = [
    { trial: 0, tRel: 1,     target: 'btn-start',   label: 'trial0 click #btn-start' },
    { trial: 0, tRel: 4165,  target: 'copy-source', label: 'trial0 selection end #copy-source' },
    { trial: 0, tRel: 5426,  target: 'answer-1',    label: 'trial0 click #answer-1' },
    { trial: 0, tRel: 7616,  target: 'btn-next-1',  label: 'trial0 mousedown #btn-next-1' },
    { trial: 1, tRel: 1,     target: 'btn-next-1',  label: 'trial1 boundary click #btn-next-1' },
    { trial: 1, tRel: 13485, target: 'btn-next-2',  label: 'trial1 mousedown #btn-next-2 (scrolled 176)' },
    { trial: 2, tRel: 1,     target: 'btn-next-2',  label: 'trial2 boundary click #btn-next-2 (seeded scroll)' },
    { trial: 2, tRel: 16806, target: 'btn-finish',  label: 'trial2 mousedown #btn-finish (post-squeeze, scrolled)' },
  ];
  let curTrial = -1;
  for (const s of SPECS) {
    if (s.trial !== curTrial) { await selectTrial(page, s.trial); curTrial = s.trial; }
    const m = await page.evaluate(({ tRel, target }) => window.__measure(tRel, target), s);
    check(dotInTarget(m), `${s.label}: cursor inside target ` +
      (m.dot && m.target ? `(dot ${Math.round(m.dot.x)},${Math.round(m.dot.y)} target ${Math.round(m.target.x)},${Math.round(m.target.y)} ${Math.round(m.target.w)}×${Math.round(m.target.h)})` : '(missing)'));
  }
  // The background click during the squeeze storm: no element target, but it
  // must land ON-stage now (it used to project off-stage entirely).
  if (curTrial !== 2) { await selectTrial(page, 2); curTrial = 2; }
  const bg = await page.evaluate(() => window.__measure(6771, null));
  check(bg.dot && bg.dot.x >= 0 && bg.dot.x <= bg.stage.w && bg.dot.y >= 0 && bg.dot.y <= bg.stage.h,
    `trial2 background click stays on-stage (dot ${bg.dot ? Math.round(bg.dot.x) + ',' + Math.round(bg.dot.y) : 'none'} in ${bg.stage.w}×${bg.stage.h})`);

  // Resize-storm thrash bound: replaying across 240 resize events must fold
  // to a handful of REAL iframe style writes, not hundreds.
  const styleWrites = await page.evaluate(async () => {
    const dbg = window.__dbg();
    dbg.selectTrial(2);
    await new Promise(r => setTimeout(r, 400));
    const f = document.querySelector('.replay-frame');
    let count = 0;
    const mo = new MutationObserver(muts => {
      muts.forEach(m => { if (m.attributeName === 'style') count++; });
    });
    mo.observe(f, { attributes: true });
    dbg.seek(30000);   // one forward seek across the whole storm
    await new Promise(r => setTimeout(r, 100));
    mo.disconnect();
    return count;
  });
  check(styleWrites <= 6, `resize storm folded (${styleWrites} iframe style writes for 240 resize events)`);
  await page.close();
}

// ── T3-T5 red window: revived by A2 ────────────────────────────────────────
// PART A above stays LIVE: it replays a committed v1-era recording through the
// viewer, and old files still render — that is the half of the contract T3 did
// not touch, and it is worth keeping green precisely because the other half is
// moving.
//
// PARTS B–E are skipped. B RECORDS FRESH with the dist recorder and feeds the
// result to `buildViewerModel`; T3 moved the recorder to SessionRecording v2
// while the viewer stays v1 by plan (T5 owns it), so a fresh recording arrives
// with no `view_state`, no `marker_attr`, dotted event types the viewer's
// kind-switch matches nowhere, and node ids where marker refs used to be. C, D
// and E are not independent: each one CLONES part B's recording and corrupts
// one field, so they cannot outlive the recording that feeds them.
//
// Reviving all four is part of T5/A2's done-when. Until then, the anchors,
// camera and privacy variants these parts covered on the CAPTURE side are
// pinned in tests/replay/capture-trace.test.js and
// tests/replay/alignment-capture.test.js, and the whole-capture path in
// tests/browser/replay/capture-fork-smoke.mjs.
console.log('▶ B–E — SKIPPED (T3-T5 red window: revived by A2)');
for (const item of [
  'B synthetic grid: record 14 trial shapes with the dist recorder, verify anchors + self-checks',
  'B redacted anchors carry no id/rect/marker on the wire',
  'B iframe placeholders and the iframe/shadow warning chips',
  'B dup-id / dup-input resolution through the viewer',
  'C corruption: tampered rects, unresolvable anchors, stripped stylesheets, corrupted camera',
  'C4b seed-only corruption self-heals via interaction camera snapshots',
  'D trace tier: cursor projection scales and letterboxes without an iframe',
  'E advisories: DPR mismatch and CSS-animation warnings surface visibly',
]) console.log('  ⊘ ' + item);
await browser.close();
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nCursor-alignment battery: part A passed; parts B–E skipped (red window).');
process.exit(0);

// ════════════════ PART B — synthetic grid (new recordings) ════════════════
console.log('▶ B — synthetic grid: record with the dist recorder, verify anchors + checks');
const batteryPageUrl = 'file://' + join(here, 'battery-page.html');
const rec = await (async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => { failures++; console.error('  ✖ record pageerror: ' + e.message); });
  await page.goto(batteryPageUrl);
  await page.evaluate(() => window.BAT.start());

  const trial = async (id, fn) => {
    await page.evaluate((tid) => window.BAT.trial(tid), id);
    await fn();
    await page.waitForTimeout(120);
  };

  await trial('baseline', async () => { await page.click('#t-base'); });
  await trial('scrolled', async () => {
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(120);
    await page.click('#t-scroll');
  });
  await trial('fixed', async () => { await page.click('#t-fixed'); });
  await trial('inner-scroll', async () => {
    await page.evaluate(() => { document.getElementById('scrollbox').scrollTop = 180; });
    await page.waitForTimeout(120);
    await page.click('#t-inner');
  });
  await trial('transform', async () => { await page.click('#t-trans'); });
  await trial('rotated', async () => { await page.click('#t-rot'); });
  await trial('resize-reflow', async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.waitForTimeout(200);
    await page.click('#t-center');
  });
  await trial('table-parser', async () => {
    // Appends <tr> directly under <table> — the HTML parser will insert
    // <tbody> on reconstruction; marker resolution must survive it.
    await page.evaluate(() => window.BAT.addTableRow());
    await page.waitForTimeout(120);
    await page.click('#t-row');
  });
  await trial('comments', async () => { await page.click('#t-comment'); });
  await trial('dup-id', async () => { await page.locator('#dup-zone button').nth(1).click(); });
  await trial('redacted', async () => { await page.click('#secret'); });
  await trial('dup-input', async () => {
    await page.locator('[id="dup-in"]').nth(1).click();
    await page.locator('[id="dup-in"]').nth(1).fill('typed into second');
  });
  await trial('shadow', async () => { await page.click('#shadow-host'); });
  await trial('iframe-removed', async () => {
    await page.evaluate(() => window.BAT.removeIframe());
    await page.waitForTimeout(120);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.click('#t-base');
  });

  const recording = await page.evaluate(() => window.BAT.finish());
  await page.close();
  return recording;
})();

check(rec.trials.every(t => t.view_state), 'every trial carries a view_state seed');
check(rec.ch_extensions.marker_attr && /^data-chn-/.test(rec.ch_extensions.marker_attr),
  'marker attribute recorded (' + rec.ch_extensions.marker_attr + ')');
const redTrial = rec.trials.find(t => t.trial_id === 'redacted');
const redTargets = redTrial.events.filter(e => e.target).map(e => e.target);
check(redTargets.length > 0 && redTargets.every(a => a.redacted === true && !a.id && !a.rect && a.n == null),
  'redacted anchors carry no id/rect/marker on the wire');
const moveWithTarget = rec.trials.flatMap(t => t.events)
  .filter(e => e.kind === 'mousemove' && e.target).length;
check(moveWithTarget === 0, 'mousemoves carry no anchors (payload discipline)');
const iframeTrialDom = rec.trials[0].initial_dom;
check(iframeTrialDom.includes('data-ch-iframe'), 'iframe serialized as placeholder in snapshots');
check(!iframeTrialDom.includes('<iframe'), 'no live iframe in any snapshot');

{
  const model = buildViewerModel(rec);
  check(model.legacy === false, 'synthetic recording is NOT legacy');
  const page = await openHarness(browser, model, 'synthetic');
  const chips0 = await page.evaluate(() => window.__chips());
  check(chips0.legacy == null, 'no legacy banner for new recordings');
  check(chips0.iframe != null && /iframe/i.test(chips0.iframe),
    'iframe warning chip shown (page contains an uncaptured iframe)');

  for (let i = 0; i < model.trials.length; i++) {
    const t = model.trials[i];
    await selectTrial(page, i);
    await page.evaluate((dur) => window.__dbg().seek(dur), t.durMs);
    await page.waitForTimeout(50);
    const checks = await page.evaluate(() => window.__dbg().getChecks());
    if (t.id === 'redacted') {
      check(checks.length > 0 && checks.every(c => c.status === 'redacted'),
        `trial "${t.id}": interactions marked redacted/unverified (${checks.length})`);
    } else if (t.id === 'shadow') {
      check(checks.length > 0 && checks.every(c =>
        c.status === 'uncertain' && c.reasons.some(r => /shadow/.test(r))),
        `trial "${t.id}": shadow-host interactions refuse to verify (${JSON.stringify(checks[0] && checks[0].reasons)})`);
      const chips = await page.evaluate(() => window.__chips());
      check(chips.shadow != null && /shadow/i.test(chips.shadow),
        `trial "${t.id}": shadow warning chip shown`);
    } else {
      const bad = checks.filter(c => c.status !== 'ok');
      check(checks.length > 0 && bad.length === 0,
        `trial "${t.id}": all ${checks.length} self-checks pass` +
        (bad.length ? ` — failing: ${JSON.stringify(bad[0])}` : ''));
    }
    const counters = await page.evaluate(() => window.__dbg().getCounters());
    check(counters.patchFailures === 0 && counters.scrollFailures === 0,
      `trial "${t.id}": no patch/scroll application failures`);
    if (t.id === 'dup-input') {
      const values = await page.evaluate(() => {
        const doc = document.querySelector('.replay-frame').contentDocument;
        return Array.from(doc.querySelectorAll('[id="dup-in"]')).map(n => n.value);
      });
      check(values[0] === '' && values[1] === 'typed into second',
        `trial "${t.id}": typed value restored into the SECOND duplicate (${JSON.stringify(values)})`);
    }
    if (t.id === 'iframe-removed') {
      const chips = await page.evaluate(() => window.__chips());
      check(chips.iframe != null,
        `trial "${t.id}": iframe warning stays LATCHED after mid-trial removal`);
    }
  }
  const chipsEnd = await page.evaluate(() => window.__chips());
  check(chipsEnd.align != null && /verified/.test(chipsEnd.align || ''),
    'alignment chip reports verified for the last clean trial (' + chipsEnd.align + ')');
  await page.close();
}

// ════════════════ PART C — corrupted recordings: checks must FIRE ════════════════
console.log('▶ C — corruption: the self-check must fire visibly, never a confident cursor');

async function expectUncertain(recording, tag, corruptLabel, trialId) {
  const model = buildViewerModel(recording);
  const page = await openHarness(browser, model, tag);
  const idx = model.trials.findIndex(t => t.id === trialId);
  await selectTrial(page, idx);
  const t = model.trials[idx];
  await page.evaluate((dur) => window.__dbg().seek(dur), t.durMs);
  await page.waitForTimeout(50);
  const checks = await page.evaluate(() => window.__dbg().getChecks());
  const chips = await page.evaluate(() => window.__chips());
  const anyUncertain = checks.some(c => c.status === 'uncertain');
  check(anyUncertain, `${corruptLabel}: self-check fired (${JSON.stringify((checks.find(c => c.status === 'uncertain') || {}).reasons || [])})`);
  check(chips.align != null && /⚠|failed/.test(chips.align || ''),
    `${corruptLabel}: alignment chip warns (${chips.align})`);
  await page.close();
}

const clone = () => JSON.parse(JSON.stringify(rec));

{ // C1: tampered anchor rect (target "moved" 50px at record time)
  const r = clone();
  const t = r.trials.find(x => x.trial_id === 'baseline');
  t.events.forEach(e => { if (e.target && e.target.rect) e.target.rect[0] += 50; });
  await expectUncertain(r, 'c1', 'C1 tampered anchor rect', 'baseline');
}
{ // C2: markers stripped from the snapshot but anchors still reference them
  const r = clone();
  const attr = r.ch_extensions.marker_attr;
  const t = r.trials.find(x => x.trial_id === 'baseline');
  t.initial_dom = t.initial_dom.replace(new RegExp(' ' + attr + '="\\d+"', 'g'), '');
  // also make id-fallback impossible for the check to genuinely fail
  t.events.forEach(e => { if (e.target) delete e.target.id; });
  await expectUncertain(r, 'c2', 'C2 unresolvable anchors', 'baseline');
}
{ // C3: stylesheets stripped → layout diverges from record time
  const r = clone();
  r.stylesheets = { initial: [], events: [] };
  await expectUncertain(r, 'c3', 'C3 stripped stylesheets (layout divergence)', 'scrolled');
}
{ // C4: corrupted camera state. The seed alone is self-healing (interaction
  // snapshots are authoritative), so a REAL corruption must lose the
  // snapshots too — a tampered/degraded recording with no camera truth left.
  const r = clone();
  const t = r.trials.find(x => x.trial_id === 'scrolled');
  t.view_state.y += 300;
  t.events = t.events.filter(e => !(e.kind === 'scroll' && e.el == null));
  t.events.forEach(e => { delete e.sx; delete e.sy; delete e.vw; delete e.vh;
                          delete e.cw; delete e.ch; });
  await expectUncertain(r, 'c4', 'C4 corrupted camera state (seed + snapshots)', 'scrolled');
}
{ // C4b: seed-only corruption is REPAIRED by interaction snapshots — the
  // checks must pass (self-healing, not a false alarm).
  const r = clone();
  const t = r.trials.find(x => x.trial_id === 'scrolled');
  t.view_state.y += 300;
  t.events = t.events.filter(e => !(e.kind === 'scroll' && e.el == null));
  const model = buildViewerModel(r);
  const page = await openHarness(browser, model, 'c4b');
  const idx = model.trials.findIndex(x => x.id === 'scrolled');
  await selectTrial(page, idx);
  await page.evaluate((dur) => window.__dbg().seek(dur), model.trials[idx].durMs);
  await page.waitForTimeout(50);
  const checks = await page.evaluate(() => window.__dbg().getChecks());
  check(checks.length > 0 && checks.every(c => c.status === 'ok'),
    'C4b seed-only corruption self-heals via interaction camera snapshots');
  await page.close();
}

// ════════════════ PART D — trace tier: projection without a reconstruction ════════════════
console.log('▶ D — trace tier: cursor projection scales/letterboxes without an iframe');
{
  const r = clone();
  r.metadata.tier = 'trace';
  const model = buildViewerModel(r);
  const page = await openHarness(browser, model, 'trace');
  // trial 'scrolled': the click happened at client ~ (290,215) under window
  // scroll 700. Trace tier has no iframe, but the dot must still land at
  // ox + cx·k (scaled), NOT at page-coord 915·k (old bug) or unscaled cx.
  const idx = model.trials.findIndex(t => t.id === 'scrolled');
  const clickEv = model.trials[idx].events.find(e => e.kind === 'click');
  await page.evaluate((i) => window.__dbg().selectTrial(i), idx);
  await page.waitForTimeout(100);
  const m = await page.evaluate((t) => window.__measure(t, null), clickEv.t);
  const expX = m.cam.ox + clickEv.cx * m.cam.k;
  const expY = m.cam.oy + clickEv.cy * m.cam.k;
  check(m.cam.k > 0 && m.cam.k < 1, `trace stage transform initialized (k=${m.cam.k.toFixed(3)})`);
  check(m.dot && Math.abs(m.dot.x - expX) <= 1 && Math.abs(m.dot.y - expY) <= 1,
    `trace-tier dot scaled+letterboxed (dot ${m.dot ? Math.round(m.dot.x) + ',' + Math.round(m.dot.y) : 'none'} vs expected ${Math.round(expX)},${Math.round(expY)})`);
  check(m.dot && m.dot.y >= 0 && m.dot.y <= m.stage.h,
    'trace-tier scrolled click stays on-stage (scroll folded without a DOM)');
  await page.close();
}

// ════════════════ PART E — declared-limitation advisories are loud ════════════════
console.log('▶ E — advisories: DPR mismatch and CSS animations surface visibly');
{
  const r = clone();
  r.viewport.dpr = 2;
  r.trials.forEach(t => { if (t.view_state) t.view_state.dpr = 2; });
  r.stylesheets = { initial: [{ css: '@keyframes spin { to { transform: rotate(1turn) } } .x { animation: spin 2s linear infinite }' }], events: [] };
  const model = buildViewerModel(r);
  const page = await openHarness(browser, model, 'advisories');
  const chips = await page.evaluate(() => window.__chips());
  check(chips.dpr != null && /DPR 2/.test(chips.dpr),
    `DPR-mismatch advisory shown (${chips.dpr})`);
  check(chips.anim != null && /animation/i.test(chips.anim),
    `CSS-animation advisory shown (${chips.anim})`);
  await page.close();
}

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nCursor-alignment battery passed.');
