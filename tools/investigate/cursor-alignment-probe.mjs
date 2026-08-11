// tools/investigate/cursor-alignment-probe.mjs
// Diagnostic for the replay cursor-misalignment bug.
//
// Experiment A — record-time fidelity: click at known coordinates under
//   scroll / fixed / inner-scroll / transform / resize / DPR conditions and
//   compare the recorder's captured coordinates against an independent
//   ground-truth listener. Decides whether the bug lives at capture time.
//
// Experiment B — playback projection error (synthetic): feed the Exp-A
//   recording through buildViewerModel + the REAL viewer client, intercept
//   the actual canvas draw calls, and measure drawn-cursor vs target-element
//   positions per click.
//
// Experiment C — same measurement on the user's own failing recording
//   (SMOKE-19NRQR), with targets known from the smoke-test script semantics.
//
// Run: npm run build && node tools/investigate/cursor-alignment-probe.mjs
//
// SUPERSEDED — this probe is the record of a closed investigation (the 0.7.3
// cursor-alignment fix) and does not run in this repo state: experiment C
// reads a v1 recording from a `.worktrees/` path outside the repo, and both
// B and C feed `buildViewerModel`, which is v2-only as of T5 (A2) Task 1.
// Kept for its method (arc interception, drawn-dot vs target measurement),
// which the alignment battery and the T5 seek harness both inherit.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

import { buildViewerModel } from '../../src/cli/renderers/replay-assets.js';

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
const repoRoot = join(here, '..', '..');
const artifactsDir = join(here, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

const probeUrl = 'file://' + join(here, 'probe-page.html');
const FIXTURE = join(repoRoot, '..', '..', '.worktrees', 'smoke-replay', 'smoke',
  'inbox', 'SMOKE-19NRQR-replay-1783953578415.json');

const results = { expA: [], expB: [], expC: [], notes: [] };

// ───────────────────────── Experiment A ─────────────────────────
console.log('▶ Experiment A — record-time capture fidelity');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('  pageerror: ' + e.message));
await page.goto(probeUrl);
await page.evaluate(() => window.PROBE.start());

// 1. baseline: exact-coordinate click, no scroll (t-base is at 200..280 × 150..180)
await page.mouse.click(225, 165);
// 2. explicit window scroll, exact-coordinate click on t-scroll (page 250..330 × 900..930)
await page.evaluate(() => window.scrollTo(0, 700));
await page.waitForTimeout(120);
await page.mouse.click(290, 215);       // → page (290, 915)
await page.waitForTimeout(150);
// 3. fixed element while scrolled (client 500..590 × 60..88)
await page.mouse.click(545, 74);        // → page (545, 774)
await page.waitForTimeout(150);
// 4. inner scroll container (scrollbox at page 40,1300; inner target at y 260)
await page.evaluate(() => { document.getElementById('scrollbox').scrollTop = 180; });
await page.waitForTimeout(120);
await page.click('#t-inner');
await page.waitForTimeout(150);
// 5. transformed ancestor
await page.click('#t-trans');
await page.waitForTimeout(150);
// 6. mid-session viewport resize, then baseline again
await page.setViewportSize({ width: 900, height: 600 });
await page.waitForTimeout(200);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(120);
await page.mouse.click(225, 165);
await page.waitForTimeout(150);
// 7. centered container post-resize: reflow-sensitive click.
//    At width 900 the wrap starts at x=250; at record start (1280) it was 440.
await page.click('#t-center');
// Let time pass so the last click is comfortably inside the trial (the
// scrub clamps to durMs; a click AT durMs is unreachable after step-snapping).
await page.waitForTimeout(250);

const bundle = await page.evaluate(() => window.PROBE.finish());
await page.close();

// DPR = 2 context: coordinates must still be CSS px
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page2 = await ctx2.newPage();
await page2.goto(probeUrl);
await page2.evaluate(() => window.PROBE.start());
await page2.mouse.click(225, 165);
const bundle2 = await page2.evaluate(() => window.PROBE.finish());
await ctx2.close();

function clicksOf(recording) {
  const evs = [];
  for (const t of recording.trials) {
    for (const e of t.events) if (e.kind === 'click') evs.push(e);
  }
  return evs;
}

const recClicks = clicksOf(bundle.recording);
const truth = bundle.truth;
console.log(`  recorded clicks: ${recClicks.length}, truth clicks: ${truth.length}`);
const labels = ['base(noscroll)', 'scrolled(700)', 'fixed@scroll', 'inner-scroll', 'transform', 'post-resize', 'centered-postresize'];
for (let i = 0; i < truth.length; i++) {
  const r = recClicks[i] || {};
  const t = truth[i];
  const row = {
    label: labels[i] || `click${i}`, target: t.target,
    truthPage: [t.pageX, t.pageY], truthClient: [t.clientX, t.clientY],
    truthScroll: [t.scrollX, t.scrollY], innerW: t.innerWidth,
    recorded: [r.x, r.y],
    dPage: [Math.abs((r.x ?? 1e9) - t.pageX), Math.abs((r.y ?? 1e9) - t.pageY)],
    pageEqClientPlusScroll: [t.pageX - (t.clientX + t.scrollX), t.pageY - (t.clientY + t.scrollY)],
  };
  results.expA.push(row);
  const ok = row.dPage[0] <= 1 && row.dPage[1] <= 1;
  console.log(`  ${ok ? '✔' : '✖'} ${row.label} [${t.target}] truth page (${t.pageX},${t.pageY}) recorded (${r.x},${r.y}) scroll (${t.scrollX},${t.scrollY})`);
}
const dprClick = clicksOf(bundle2.recording)[0] || {};
const dprTruth = bundle2.truth[0];
const dprOk = Math.abs(dprClick.x - dprTruth.pageX) <= 1 && Math.abs(dprClick.y - dprTruth.pageY) <= 1;
console.log(`  ${dprOk ? '✔' : '✖'} dpr=2 click truth (${dprTruth.pageX},${dprTruth.pageY}) recorded (${dprClick.x},${dprClick.y})`);
results.expA.push({ label: 'dpr2-base', truthPage: [dprTruth.pageX, dprTruth.pageY], recorded: [dprClick.x, dprClick.y] });

const resizeEvents = bundle.recording.trials.flatMap(t => t.events).filter(e => e.kind === 'resize');
console.log(`  resize events recorded: ${resizeEvents.length} (last: ${JSON.stringify(resizeEvents[resizeEvents.length - 1] || null)})`);
const scrollEvents = bundle.recording.trials.flatMap(t => t.events).filter(e => e.kind === 'scroll');
console.log(`  scroll events recorded: ${scrollEvents.length}`);

// ───────────────────────── Viewer harness ─────────────────────────
const viewerSrc = readFileSync(join(repoRoot, 'src', 'cli', 'renderers', 'replay-viewer.client.js'), 'utf8');

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
  </style></head><body>
  <div id="mount" style="width:720px"></div>
  <script>
    // Intercept the viewer's REAL canvas draw calls. drawOverlay() clears the
    // canvas first, then draws trail lines, ripple arcs, and LAST the cursor
    // dot arc — so after a seek, the last recorded arc is the cursor dot.
    (function () {
      var origArc = CanvasRenderingContext2D.prototype.arc;
      var origClear = CanvasRenderingContext2D.prototype.clearRect;
      window.__arcs = [];
      CanvasRenderingContext2D.prototype.clearRect = function () {
        window.__arcs = []; return origClear.apply(this, arguments);
      };
      CanvasRenderingContext2D.prototype.arc = function (x, y, r) {
        window.__arcs.push({ x: x, y: y, r: r, fillStyle: String(this.fillStyle) });
        return origArc.apply(this, arguments);
      };
    })();
  <\/script>
  <script>${safeViewer}<\/script>
  <script>
    window.__model = ${modelJson};
    initChReplayViewer(document.getElementById('mount'), window.__model);
    window.__setTrial = function (i) {
      var sel = document.querySelector('.replay-trial-select');
      sel.value = String(i);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.__frameReady = function (id) {
      var f = document.querySelector('.replay-frame');
      try {
        return !!(f && f.contentDocument && f.contentDocument.body &&
          (!id || f.contentDocument.getElementById(id)));
      } catch (e) { return false; }
    };
    // Layout parity: what the reconstructed document actually computed for
    // body margins and layout width, vs what the recording metadata implies.
    window.__layoutParity = function () {
      var f = document.querySelector('.replay-frame');
      var doc = f && f.contentDocument;
      if (!doc || !doc.body) return null;
      var cs = doc.defaultView.getComputedStyle(doc.body);
      var rect = doc.body.getBoundingClientRect();
      return {
        bodyMargin: { top: cs.marginTop, left: cs.marginLeft, right: cs.marginRight },
        bodyRect: { x: rect.x, y: rect.y, w: rect.width },
        docClientWidth: doc.documentElement.clientWidth,
        iframeCssWidth: parseFloat(f.style.width)
      };
    };
    // Seek to tRel+6 (range snaps to step=10; +6 guarantees the snapped value
    // is past the event) and measure the drawn cursor vs the target element.
    window.__measure = function (tRel, targetId) {
      var scrub = document.querySelector('.replay-scrub');
      scrub.value = String(tRel + 6);
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
      var arcs = window.__arcs.slice();
      var dot = arcs.length ? arcs[arcs.length - 1] : null;
      var f = document.querySelector('.replay-frame');
      var stage = document.querySelector('.replay-stage');
      var scale = parseFloat(stage.style.width) / parseFloat(f.style.width);
      var doc = f.contentDocument;
      var el = (targetId && doc) ? doc.getElementById(targetId) : null;
      var rect = el ? el.getBoundingClientRect() : null;
      var under = null;
      if (doc && dot) {
        var u = doc.elementFromPoint(dot.x / scale, dot.y / scale);
        under = u ? (u.id ? u.tagName.toLowerCase() + '#' + u.id : u.tagName.toLowerCase()) : '(none)';
      }
      return {
        seekTo: Number(scrub.value),
        dot: dot, scale: scale,
        stage: { w: parseFloat(stage.style.width), h: parseFloat(stage.style.height) },
        target: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
        under: under,
        frameScroll: doc && doc.defaultView ? { x: doc.defaultView.scrollX || 0, y: doc.defaultView.scrollY || 0 } : null
      };
    };
  <\/script></body></html>`;
}

async function measureModel(model, specs, tag) {
  const html = harnessHtml(model);
  const harnessPath = join(artifactsDir, `harness-${tag}.html`);
  writeFileSync(harnessPath, html);
  const hp = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  hp.on('pageerror', (e) => console.error('  harness pageerror: ' + e.message));
  await hp.goto('file://' + harnessPath);
  const out = [];
  let curTrial = -1;
  for (const spec of specs) {
    if (spec.trial !== curTrial) {
      await hp.evaluate((i) => window.__setTrial(i), spec.trial);
      curTrial = spec.trial;
      await hp.waitForFunction((id) => window.__frameReady(id), spec.targetId || null, { timeout: 4000 })
        .catch(() => console.error(`  ✖ frame not ready for trial ${spec.trial} / #${spec.targetId}`));
      const parity = await hp.evaluate(() => window.__layoutParity());
      console.log(`  layout parity trial ${spec.trial}: ${JSON.stringify(parity)}`);
      out.push({ trial: spec.trial, layoutParity: parity, tag });
    }
    const m = await hp.evaluate(({ tRel, targetId }) => window.__measure(tRel, targetId), spec);
    const s = m.scale;
    let row = { ...spec, tag };
    if (!m.dot) {
      row.result = 'NO CURSOR DRAWN';
    } else {
      const cursorPagePx = { x: m.dot.x / s, y: m.dot.y / s };   // iframe-viewport CSS px
      row.cursorViewportPx = [Math.round(cursorPagePx.x), Math.round(cursorPagePx.y)];
      row.offStage = m.dot.x < 0 || m.dot.y < 0 || m.dot.x > m.stage.w || m.dot.y > m.stage.h;
      row.frameScroll = m.frameScroll;
      row.under = m.under;
      if (m.target) {
        const cx = m.target.x + m.target.w / 2, cy = m.target.y + m.target.h / 2;
        row.targetCenterPx = [Math.round(cx), Math.round(cy)];
        row.deltaPx = [Math.round(cursorPagePx.x - cx), Math.round(cursorPagePx.y - cy)];
        row.insideTarget = cursorPagePx.x >= m.target.x && cursorPagePx.x <= m.target.x + m.target.w &&
          cursorPagePx.y >= m.target.y && cursorPagePx.y <= m.target.y + m.target.h;
      }
    }
    out.push(row);
    const d = row.deltaPx ? `Δ(${row.deltaPx[0]},${row.deltaPx[1]})px` : (row.result || '');
    console.log(`  ${row.insideTarget ? '✔ ALIGNED' : '✖ MISALIGNED'} trial ${spec.trial} t=${spec.tRel} #${spec.targetId || '(none)'}: cursor@(${(row.cursorViewportPx || []).join(',')}) target@(${(row.targetCenterPx || []).join(',')}) ${d} ${row.offStage ? 'OFF-STAGE' : ''} under=${row.under}`);
  }
  await hp.close();
  return out;
}

// ───────────────────────── Experiment B ─────────────────────────
console.log('▶ Experiment B — playback projection error (synthetic probe recording)');
const probeModel = buildViewerModel(bundle.recording);
// One trial; pair recorded clicks (in order) with the click sequence targets.
const probeTrial = probeModel.trials.findIndex(t => t.id === 'probe-trial');
const probeClicks = probeModel.trials[probeTrial].events.filter(e => e.kind === 'click');
const probeTargets = ['t-base', 't-scroll', 't-fixed', 't-inner', 't-trans', 't-base', 't-center'];
const specsB = probeClicks.map((e, i) => ({
  trial: probeTrial, tRel: e.t, targetId: probeTargets[i] || null, recordedXY: [e.x, e.y],
}));
results.expB = await measureModel(probeModel, specsB, 'probe');

// ───────────────────────── Experiment C ─────────────────────────
console.log('▶ Experiment C — playback projection error (user fixture SMOKE-19NRQR)');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const fixtureModel = buildViewerModel(fixture);
// Targets known from the smoke-demo script; times trial-relative (t_load
// anchors: 1 / 7735 / 21318). The 28089 background click has no element.
const specsC = [
  { trial: 0, tRel: 1,     targetId: 'btn-start' },
  { trial: 0, tRel: 4165,  targetId: 'copy-source' },
  { trial: 0, tRel: 5426,  targetId: 'answer-1' },
  { trial: 0, tRel: 7616,  targetId: 'btn-next-1' },
  { trial: 1, tRel: 1,     targetId: 'btn-next-1' },
  { trial: 1, tRel: 13485, targetId: 'btn-next-2' },
  { trial: 2, tRel: 1,     targetId: 'btn-next-2' },
  { trial: 2, tRel: 6771,  targetId: null },          // background click during squeeze
  { trial: 2, tRel: 16806, targetId: 'btn-finish' },
];
results.expC = await measureModel(fixtureModel, specsC, 'fixture');

await browser.close();

writeFileSync(join(artifactsDir, 'probe-results.json'), JSON.stringify(results, null, 2));
console.log('\nResults written to ' + join(artifactsDir, 'probe-results.json'));
