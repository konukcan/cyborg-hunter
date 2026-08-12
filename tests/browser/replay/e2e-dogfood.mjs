// tests/browser/replay/e2e-dogfood.mjs
// Full-pipeline dogfood: record a scripted participant in a real browser →
// save the artifact exactly as autosave would name it → run the actual CLI
// report over it → open the generated report → load the replay viewer →
// scrub mid-segment → screenshot → assert the reconstruction is really there
// (iframe DOM populated, mutation and input value replayed, overlay pixels
// drawn, ticker moved).
//
// This is the only suite that drives capture → ingest → report → viewer as
// ONE chain: every other suite tests a link. It is also the only place the
// index's tier badge is checked against a recording that was captured rather
// than hand-written (T5 done-when 4).
//
// Run: npm run build && npm run test:browser:e2e
//
// (T5 Task 10(c)) Revived from the T3-T5 red window, rewritten against the v2
// wire: `participant_id`/`recording_started_at` at the top level, `segments`
// in place of `trials`, and the viewer's `.replay-segment-select`. The skip
// note said the middle of the chain was still v1 — it is not any more.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import { replayFilename } from '../../../src/replay/persistence.js';
import { buildViewerModel } from '../../../src/replay/viewer-model.js';
import { buildReplayHostHtml } from '../../../demo/replay-host.js';
import { readReplayClientSrc } from '../../../src/cli/renderers/replay-client-source.js';

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
const demoUrl = 'file://' + join(here, 'demo-standalone.html');
const artifactsDir = join(here, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + label); }
}

const browser = await chromium.launch({ headless: true });

// ── 1. Record a session ───────────────────────────────────────────────────
console.log('▶ 1/5 recording a participant session');
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => { failures++; console.error('  ✖ capture pageerror: ' + e.message); });
await page.goto(demoUrl);
await page.evaluate(() => window.CH_E2E.start());
await page.mouse.move(120, 140);
await page.mouse.move(420, 260, { steps: 15 });
await page.click('#card-b');
await page.fill('#answer', 'king of hearts');
await page.evaluate(() => window.CH_E2E.respond());
await page.evaluate(() => new Promise(r => setTimeout(r, 150)));
await page.evaluate(() => window.CH_E2E.nextTrial());
await page.mouse.move(240, 420, { steps: 10 });
await page.click('#card-a');
await page.evaluate(() => new Promise(r => setTimeout(r, 150)));
const recording = await page.evaluate(() => window.CH_E2E.finish());
await page.close();

check(recording.schema_version === 2, 'the built dist produced a v2 recording');
const pid = recording.participant_id;                       // E2E-P1
check(pid === 'E2E-P1', 'participant_id on the recording');
const chExt = (recording.extensions || {})['cyborg-hunter'] || {};
check(chExt.tier === 'dom', 'captured at dom tier');
const firstSegment = recording.segments.findIndex(s => s.label === 'trial-1');
check(firstSegment >= 0, 'the bracketed trial-1 segment exists');

// ── 2. Write the data dir exactly as a study would deliver it ─────────────
console.log('▶ 2/5 writing data dir + running the CLI report');
const dataDir = mkdtempSync(join(tmpdir(), 'ch-e2e-'));
// The artifact filename comes from the library's OWN autosave naming, not a
// hand-rolled template: if replayFilename() ever changes, the CLI's discovery
// pattern has to change with it and this suite is where that breaks.
const artifactName = replayFilename(recording);
const epoch = Date.parse(recording.recording_started_at);
check(artifactName === `${pid}-replay-${epoch}.json`,
  'autosave names the artifact <pid>-replay-<epoch>.json (' + artifactName + ')');

// Minimal Shape-1 participant file (the CSV/JSON the study saves). The
// integrity blocks carry startTime anchors so ingest takes the fast path.
const participantFile = {
  participantId: pid,
  trials: recording.segments
    .filter(s => s.label !== '__session__')
    .map((s, i) => ({
      trialId: s.label,
      integrity: {
        trialId: s.label, participantId: pid, libraryVersion: '0.7.5',
        startTime: 1000 + i * 7000, duration_ms: 5000,
        trialStart_perfNow: 1000 + i * 7000,
        pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [],
        trialSoftScore: 0, trialSignals: {},
        integrityReplayMeta: {
          schema_version: 2, tier: chExt.tier,
          saved_to: `datapipe:E2E/${artifactName}`,
          bytes_uncompressed: JSON.stringify(recording).length,
          capture_failures: [], capture_stopped: false,
        },
      },
    })),
};
writeFileSync(join(dataDir, `${pid}.json`), JSON.stringify(participantFile));
writeFileSync(join(dataDir, artifactName), JSON.stringify(recording));

const reportDir = join(dataDir, 'report');
const cliOut = execFileSync('node', [
  join(repoRoot, 'bin', 'cyborg-hunter.js'), 'report',
  '--data', dataDir, '--output', reportDir, '--no-visuals',
], { encoding: 'utf8', cwd: dataDir });
check(/replay\/ — 1 session replays/.test(cliOut), 'CLI reports the replay asset line');
check(!/skipped/.test(cliOut), 'no participant was skipped as unloadable');
check(existsSync(join(reportDir, 'index.html')), 'index.html generated');
check(existsSync(join(reportDir, 'replay', 'E2E-P1.replay.js')), 'replay asset emitted');
// done-when 4: the badge the analyst sees in the index, from a captured file.
const indexHtml = readFileSync(join(reportDir, 'index.html'), 'utf8');
check(/Session replay <span class="replay-note">\(dom tier\)/.test(indexHtml),
  'the index badges the recording dom tier (not the v1 metadata read: "trace")');

// ── 3. Open the report and drive the viewer ───────────────────────────────
console.log('▶ 3/5 loading the replay viewer in the report');
const report = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
report.on('pageerror', (e) => { failures++; console.error('  ✖ report pageerror: ' + e.message); });
await report.goto('file://' + join(reportDir, 'index.html'));
check(await report.locator('.replay-block').count() > 0, 'Replay section present');
await report.click('.replay-load-btn');
await report.waitForSelector('.replay-stage', { timeout: 5000 });
check(true, 'viewer mounted after lazy load');
check(await report.locator('.replay-badge').innerText() === 'DOM replay',
  'the viewer itself badges the model dom tier');

// Select the bracketed trial-1 segment and scrub near its end. v1 numbered
// from an implicit __session__ trial at index 0; v2 has no implicit segment
// here (§5.8 moved guard violations out of the event stream), so the index is
// read off the recording rather than assumed.
await report.locator('.replay-segment-select').selectOption(String(firstSegment));
await report.evaluate(() => new Promise(r => setTimeout(r, 300)));
const scrub = report.locator('.replay-scrub');
const maxT = await scrub.evaluate(el => Number(el.max));
// Headless interactions are fast; the point is a finite, non-degenerate
// duration (a NaN/0 would mean the time-base conversion broke).
check(Number.isFinite(maxT) && maxT > 100, `segment duration on the scrub bar (${Math.round(maxT)}ms)`);
await scrub.evaluate((el) => {
  el.value = String(Number(el.max) * 0.95);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await report.evaluate(() => new Promise(r => setTimeout(r, 400)));

const state = await report.evaluate(() => {
  const iframe = document.querySelector('.replay-frame');
  const overlay = document.querySelector('.replay-overlay');
  const doc = iframe && iframe.contentDocument;
  const body = doc && doc.body;
  const ctx = overlay && overlay.getContext('2d');
  let drawn = 0;
  if (ctx) {
    const px = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) drawn++;
  }
  return {
    bodyLen: body ? body.innerHTML.length : 0,
    bodyHasStim: body ? /card|answer|Which/i.test(body.innerHTML) : false,
    feedback: body && body.querySelector('#feedback') ? body.querySelector('#feedback').textContent : null,
    answerValue: body && body.querySelector('#answer') ? body.querySelector('#answer').value : null,
    // The reconstruction must be BUILT, not parsed: the viewer instantiates
    // DomNodes, so a stray innerHTML path would be the regression to catch.
    stageNodes: body ? body.querySelectorAll('*').length : 0,
    drawnPixels: drawn,
    ticker: (document.querySelector('.replay-ticker') || {}).textContent || '',
    // The debug surface hangs off the MOUNT, not the window (the report can
    // host one viewer per participant).
    counters: (() => {
      const mount = document.querySelector('.replay-mount');
      const dbg = mount && mount._chReplayDebug;
      return dbg ? dbg.getCounters() : null;
    })(),
  };
});
check(state.bodyLen > 200, `iframe DOM reconstructed (${state.bodyLen} chars)`);
check(state.stageNodes > 10, `reconstruction instantiated ${state.stageNodes} elements`);
check(state.bodyHasStim, 'reconstructed DOM contains the stimulus');
check(state.feedback === 'Correct!', `mutation replayed into the DOM (feedback="${state.feedback}")`);
check(state.answerValue === 'king of hearts', `input value replayed into the form ("${state.answerValue}")`);
check(state.drawnPixels > 50, `overlay has drawn pixels (${state.drawnPixels})`);
check(state.ticker.length > 1, 'event ticker shows recent events');
// A tolerant viewer counts what it could not honour instead of throwing; on a
// recording the recorder itself produced, that count must be zero.
check(state.counters && state.counters.patchFailures === 0 && state.counters.skipped === 0,
  'the viewer honoured every node reference in a CH-recorded session ('
    + JSON.stringify(state.counters) + ')');

// ── 4. The demo's own consumer, over the same fresh capture ───────────────
// (T5 done-when 4 / design §13's "fresh-capture demo path" row.) The demo
// does not use the CLI report's replay section: it renders the visitor's
// recording in a sibling host document (demo/replay-host.js), built from the
// same buildViewerModel output. Readiness only — regenerating the demo's
// committed assets is A6's. What this asserts is that the path A6 will run
// is not broken: a v2 capture reaches that host and reconstructs there too.
console.log('▶ 4/5 demo replay-host readiness (A6 path)');
const hostHtml = buildReplayHostHtml(buildViewerModel(recording), readReplayClientSrc());
const hostFile = join(dataDir, 'replay-host.html');
writeFileSync(hostFile, hostHtml);
const host = await browser.newPage({ viewport: { width: 1280, height: 900 } });
host.on('pageerror', (e) => { failures++; console.error('  ✖ replay-host pageerror: ' + e.message); });
await host.goto('file://' + hostFile);
await host.waitForSelector('.replay-stage', { timeout: 5000 });
check(true, 'the demo host boots the viewer from a v2 capture');
const hostState = await host.evaluate(() => new Promise((resolve) => {
  const mount = document.getElementById('ch-replay-mount');
  const dbg = mount && mount._chReplayDebug;
  const read = () => {
    const doc = document.querySelector('.replay-frame').contentDocument;
    return { nodes: doc && doc.body ? doc.body.querySelectorAll('*').length : 0,
      counters: dbg ? dbg.getCounters() : null };
  };
  // The shell boots from the iframe's onload in a real browser (Task 4).
  setTimeout(() => resolve(read()), 500);
}));
check(hostState.nodes > 10, `the host's reconstruction instantiated ${hostState.nodes} elements`);
check(hostState.counters && hostState.counters.patchFailures === 0,
  'no unresolved references in the demo host either');
await host.close();

// The same page, with one visitor-controlled text node carrying the sequence
// that opens script-data-escaped state (T5 Task 10 review I-2). With the
// end-tag rule this page stayed double-escaped to EOF: its own </script> never
// closed the element, the bootstrap call never ran, the replay card silently
// never appeared, and NO error was raised — which is why this asserts a boot
// rather than an absent pageerror. The model now takes the every-`<` rule.
const hostileModel = JSON.parse(JSON.stringify(buildViewerModel(recording)));
(function poison(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'text') { node.text = 'note: <!-- and then a <script> element'; return true; }
  return (node.children || []).some(poison);
})(hostileModel.segments[firstSegment].initialDom);
const hostileFile = join(dataDir, 'replay-host-hostile.html');
writeFileSync(hostileFile, buildReplayHostHtml(hostileModel, readReplayClientSrc()));
const hostile = await browser.newPage({ viewport: { width: 1280, height: 900 } });
hostile.on('pageerror', (e) => { failures++; console.error('  ✖ hostile-host pageerror: ' + e.message); });
await hostile.goto('file://' + hostileFile);
const booted = await hostile.waitForSelector('.replay-stage', { timeout: 5000 }).then(() => true, () => false);
check(booted, 'a model whose text opens script-data-escaped state still boots the host');
await hostile.close();

// ── 5. Screenshot for the human reviewer ──────────────────────────────────
console.log('▶ 5/5 screenshot');
const shot = join(artifactsDir, 'e2e-replay-viewer.png');
await report.screenshot({ path: shot, fullPage: false });
check(existsSync(shot), 'screenshot saved: ' + shot);

await browser.close();
if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nE2E dogfood passed end-to-end.');
