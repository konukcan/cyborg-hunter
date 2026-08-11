// tests/browser/replay/viewer-boot.battery.mjs
// The viewer's SHELL BOOT, in a realm where `srcdoc` navigation is
// asynchronous. (T5 Task 4 fix round, review I-2.)
//
// WHY THIS FILE EXISTS. `tests/replay/viewer-client.test.js` drives the same
// client under happy-dom, which parses `srcdoc` SYNCHRONOUSLY. That makes the
// browser leg of the boot unreachable from the node suite by construction:
// deleting `iframe.onload = onShellLoad` outright leaves all 28 node tests
// green while every real browser freezes at boot (the review's B7 inversion),
// and the same blind spot is how C-1 shipped — a second `srcdoc` write booting
// into the document the browser was about to discard, blanking the
// reconstruction behind a `frameReady()` that still said true.
//
// So the two claims below are asserted where they live, not in a session
// artifact:
//   1. BOOT COMES FROM `onload`. `frameReady()` is false in the same tick as
//      `initChReplayViewer` and true after the frame loads.
//   2. A SECOND SHELL WRITE LANDS IN THE NEW DOCUMENT. The analyst's "Load
//      external CSS" button is the last remaining `srcdoc` path (the CSP
//      string itself changes, so it genuinely needs a new document). After it,
//      the reconstruction must still be mounted in the LIVE `contentDocument`
//      and the opted-in `<link>` must be in that document's head — not in the
//      discarded one.
//
// Chromium only, like `capture-chromium.battery.mjs`: every browser navigates
// `srcdoc` asynchronously, so one engine is a sufficient witness for a claim
// about the async leg. The tri-engine spread lives in the Task-4 report.
//
// Run: npm run test:browser:boot

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

import { buildViewerModel } from '../../../src/cli/renderers/replay-assets.js';
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
const artifactsDir = join(here, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + label); }
}

const viewerSrc = readReplayClientSrc();

// canonical-core with its inline stylesheet swapped for an external one, so
// the viewer renders the "Load external CSS" opt-in. Everything else about the
// fixture is untouched: segment 0's keyframe is what must survive the rewrite.
function externalSheetModel() {
  const rec = JSON.parse(readFileSync(
    join(repoRoot, 'tests', 'replay', 'schema-v2', 'fixtures', 'canonical-core.json'), 'utf8'));
  rec.stylesheets = [{ id: 1, kind: 'link', href: 'https://example.test/a.css', css: null, media: null }];
  return buildViewerModel(rec);
}

function harnessHtml(model, name) {
  const modelJson = JSON.stringify(model).replace(/</g, '\\u003c');
  const safeViewer = viewerSrc.replace(/<\/script/gi, '<\\/script');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    .replay-stage { position: relative; overflow: hidden; background: #fff; border: 1px solid #ccc; }
    .replay-frame { position: absolute; top: 0; left: 0; border: 0; }
    .replay-overlay { position: absolute; top: 0; left: 0; pointer-events: none; }
  </style></head><body>
  <div id="mount" style="width:720px"></div>
  <script>${safeViewer}<\/script>
  <script>
    window.__model = ${modelJson};
    initChReplayViewer(document.getElementById('mount'), window.__model);
    window.__dbg = function () { return document.getElementById('mount')._chReplayDebug; };
    // Read IN THE SAME TICK as the init call: this is the measurement, and it
    // cannot be taken from Node, where the page has already loaded.
    window.__readyInInitTick = window.__dbg().frameReady();
    window.__frame = function () { return document.querySelector('.replay-frame'); };
  <\/script>
  </body></html>`;
  const file = join(artifactsDir, 'boot-harness-' + name + '.html');
  writeFileSync(file, html);
  return 'file://' + file;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

console.log('▶ boot comes from onload, not from the synchronous probe');
await page.goto(harnessHtml(externalSheetModel(), 'csp-toggle'));

check(await page.evaluate(() => window.__readyInInitTick) === false,
  'frameReady() is FALSE in the init tick (a browser navigates srcdoc asynchronously)');

// Bounded, so a boot that never happens FAILS instead of hanging. This is the
// assertion B7 (deleting the onload install) has to trip.
let booted = true;
try {
  await page.waitForFunction(() => window.__dbg().frameReady(), null, { timeout: 5000 });
} catch { booted = false; }
check(booted, 'frameReady() becomes true once the frame loads');

const afterBoot = await page.evaluate(() => {
  const dbg = window.__dbg();
  const doc = window.__frame().contentDocument;
  return {
    stats: dbg.getStats(),
    bodyKids: doc.body.childNodes.length,
    node1Live: doc.contains(dbg.getNode(1)),
  };
});
check(afterBoot.stats.shellWrites === 1 && afterBoot.stats.mounts >= 1,
  'one shell write, at least one mount (' + JSON.stringify(afterBoot.stats) + ')');
check(afterBoot.bodyKids > 0, 'the reconstruction is mounted in the live document');
check(afterBoot.node1Live, 'the span id map points into the live document');

console.log('▶ C-1: the external-CSS rewrite must land in the NEW document');
// Seek somewhere real first, so the post-rewrite restore has a position to
// reproduce rather than a fresh segment start.
await page.evaluate(() => window.__dbg().seek(600));
await page.click('.replay-css-btn');
// srcdoc navigation is a task, not a microtask; wait for the document to be
// replaced rather than for a viewer flag, which is the flag under test.
await page.waitForTimeout(600);

const afterToggle = await page.evaluate(() => {
  const dbg = window.__dbg();
  const doc = window.__frame().contentDocument;
  const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const link = doc.head.querySelector('link[data-ch-sheet]');
  return {
    stats: dbg.getStats(),
    ready: dbg.frameReady(),
    bodyKids: doc.body.childNodes.length,
    node1Live: doc.contains(dbg.getNode(1)),
    cspAllowsHttps: !!meta && /style-src [^;]*https:/.test(meta.getAttribute('content')),
    linkInLiveDoc: !!link,
    linkHref: link ? link.getAttribute('href') : null,
    playhead: Math.round(dbg.getPlayhead()),
  };
});
check(afterToggle.stats.shellWrites === 2, 'the button wrote a second shell');
check(afterToggle.ready, 'frameReady() is true after the rewrite');
check(afterToggle.cspAllowsHttps,
  'the live document carries the RELAXED CSP (so it is the new document, not the old one)');
check(afterToggle.bodyKids > 0,
  'the reconstruction survived the rewrite (C-1: booting into the discarded document blanks it)');
check(afterToggle.node1Live,
  'the span id map points into the LIVE document, not a detached one');
check(afterToggle.linkInLiveDoc && afterToggle.linkHref === 'https://example.test/a.css',
  'the opted-in stylesheet link landed in the new document');
check(afterToggle.playhead === 600, 'the playhead survived the rewrite');

// A blanked reconstruction behind a truthy frameReady() is the exact shape
// C-1 had, so assert the pair rather than either half.
check(afterToggle.ready && afterToggle.bodyKids > 0,
  'frameReady() does not report true over a blank frame');

console.log('▶ page errors');
check(pageErrors.length === 0, 'no page errors (' + (pageErrors[0] || 'none') + ')');

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nViewer boot battery: shell boots from onload and rewrites into the live document.');
process.exit(0);
