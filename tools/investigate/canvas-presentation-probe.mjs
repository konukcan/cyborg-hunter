#!/usr/bin/env node
// tools/investigate/canvas-presentation-probe.mjs
//
// T5 (A2) Task 0(a) — the canvas-presentation spike, committed as falsifiable
// code. Design: docs/plans/2026-08-11-t5-a2-viewer-migration-design.md §3.
//
// THE QUESTION
//   CH's replay viewer reconstructs a recorded page inside an iframe with
//   sandbox="allow-same-origin" (no allow-scripts — see design §3.1) under the
//   production srcdocCsp() string. `canvas.snapshot` events must become
//   visible pixels there. Which mechanism actually PAINTS?
//
// THE TRAP, AND WHY THIS PROBE LEADS WITH IT
//   A script-less sandboxed frame accepts getContext('2d'), accepts the draw
//   calls, and holds correct pixels in the backing store — and never paints
//   them. So `getImageData` on the in-frame canvas returns the right answer
//   over a blank screen. Every canvas assertion in T5 is written around that
//   trap, and a probe that cannot REPRODUCE it cannot defend against it.
//   Case NEG below therefore asserts the trap as a required negative: correct
//   getImageData AND a blank screenshot. If NEG ever stops reproducing, this
//   probe fails, because the plan's test contracts would then be defending
//   against a hazard that no longer exists and nobody would notice.
//
// WHAT IS ASSERTED (design §3.2 GO criteria, verbatim, plus two additions)
//   NEG  the trap reproduces (correct backing store, blank presented pixel)
//   GO1  a full-baseline snapshot composited in a PARENT-OWNED offscreen
//        canvas and presented via background-image is visible in a screenshot
//        (centre pixel within 8/255 per channel)
//   GO2  a subsequent region patch at a non-zero offset changes only its
//        rectangle; the baseline colour survives outside it
//   GO3  presentation survives a dom.attr patch on the same canvas node
//        (3a: a non-style attribute leaves it alone; 3b: a `style` attribute
//        write CLOBBERS it — measured, not assumed — and re-presenting
//        restores it, which is a Task-5 implementation duty this probe pins)
//   GO4  a canvas added mid-span by dom.add composites and presents
//   GO5  zero console errors and zero off-page network requests
//   CTRL the same direct-draw route with allow-scripts added DOES paint, so
//        NEG is a property of the sandbox rather than of this probe
//   SIZE design §3.3's collapse scope: the used-size-0 repair must fire in the
//        fully-intrinsic case and NEVER over responsive CSS
//
// HOW PIXELS ARE READ (plan-review M-4, non-negotiable)
//   ELEMENT-CLIPPED screenshots — locator(sel).screenshot() — decoded in
//   Node. During plan review a full-page screenshot sampled by page-coordinate
//   arithmetic produced a FALSE WebKit reading (the control pixel came back as
//   a neighbouring cell's colour). A probe whose whole job is asserting
//   presented pixels must not sample by arithmetic.
//
// USAGE (plan-review M-3 — the override is required for a tri-engine run)
//   PLAYWRIGHT_CORE_DIR=/opt/homebrew/lib/node_modules/ \
//     node tools/investigate/canvas-presentation-probe.mjs
//   ... --engines=chromium            # subset
//   ... --headed                      # watch it
//
// PROVING THE PROBE HAS TEETH (T3 Task-0 precedent: a probe that cannot fail
// is not evidence). Each --inject breaks one step; the named criteria MUST
// then fail and the exit code MUST be 1:
//   --inject=no-present            -> GO1, GO2, GO3a, GO3b, GO4 fail
//   --inject=unsandbox-neg         -> NEG fails (the trap stops reproducing)
//   --inject=style-attr-no-repair  -> GO3b fails (the re-present duty)
//   --inject=backing-store-oracle  -> GO1 PASSES while the screen is blank.
//        This is the trap itself, wired up: it reads the in-frame backing
//        store instead of the screenshot. Run it to see the green test over
//        the blank screen the plan's global constraint 4 exists to forbid.
//   Without PLAYWRIGHT_CORE_DIR, CH's own resolution order lands on
//   playwright-core 1.58.1, whose firefox/webkit revisions are not installed,
//   and "every engine playwright-core provides" silently means Chromium only.
//
// EXIT CODE  0 = every launched engine passed every criterion.
//            1 = a criterion failed (the failing ones are printed), OR fewer
//                than the requested engines launched (a skipped engine is not
//                a passing engine).
//            0 with SKIP = playwright-core itself is absent.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  repoRoot, resolvePlaywright, launchEngines, decodePng, pixelAt, rgbNear, rgb,
  productionSrcdocCsp, productionShellHead, serveFiles,
} from './probe-support.mjs';

// ── options ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit === `--${n}` ? true : hit.slice(n.length + 3);
};
const CFG = {
  engines: opt('engines', null),
  headless: !opt('headed', false),
  tol: Number(opt('tol', 8)),          // design §3.2 criterion 1: 8/255 per channel
  inject: opt('inject', null),         // fault injection — see the header
};
const INJECTS = ['no-present', 'unsandbox-neg', 'style-attr-no-repair', 'backing-store-oracle'];
if (CFG.inject && !INJECTS.includes(CFG.inject)) {
  console.error(`unknown --inject=${CFG.inject}; expected one of ${INJECTS.join(', ')}`);
  process.exit(2);
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 170, 0];   // #0a0
const CW = 160, CH_ = 80;              // canvas CSS + bitmap size used everywhere
const REGION = { x: 100, y: 50, w: 40, h: 20 };

const results = [];   // { engine, id, ok, detail }
let hardFailures = 0;

function record(engine, id, ok, detail) {
  results.push({ engine, id, ok: !!ok, detail });
  if (!ok) hardFailures++;
  console.log(`  ${ok ? '✔' : '✖'} [${engine}] ${id} — ${detail}`);
}

// ── the harness page ───────────────────────────────────────────────────────
// The parent document is the report document: offscreen compositing happens
// here, where painting is unrestricted. Everything it does to the frame goes
// through contentDocument, exactly as the viewer does.

function harnessHtml() {
  const shellHead = productionShellHead(false);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T5 canvas presentation probe</title>
<style>
  html,body { margin:0; padding:0; background:#fff; }
  .wrap { margin:0; padding:0; }
  iframe { display:block; border:0; background:#fff; }
</style></head><body>
<div class="wrap"><iframe id="f-neg"    width="${CW}" height="${CH_}" sandbox="allow-same-origin"></iframe></div>
<div class="wrap"><iframe id="f-go"     width="${CW}" height="${CH_}" sandbox="allow-same-origin"></iframe></div>
<div class="wrap"><iframe id="f-add"    width="${CW}" height="${CH_}" sandbox="allow-same-origin"></iframe></div>
<div class="wrap"><iframe id="f-ctrl"   width="${CW}" height="${CH_}" sandbox="allow-same-origin allow-scripts"></iframe></div>
<div class="wrap"><iframe id="f-size"   width="320" height="400" sandbox="allow-same-origin"></iframe></div>
<div class="wrap"><iframe id="f-size-s" width="320" height="400" sandbox="allow-same-origin allow-scripts"></iframe></div>
<script>
(function () {
  var SHELL_HEAD = ${JSON.stringify(shellHead)};
  var CW = ${CW}, CH = ${CH_};

  // The frame body a canvas case uses. NOTE the explicit CSS size: a canvas
  // with no CSS size collapses to 0x0 in this sandbox (design §3.3, case SIZE
  // below), which would make every pixel assertion vacuous.
  function canvasBody(id) {
    return '<canvas id="' + id + '" width="' + CW + '" height="' + CH +
           '" style="display:block;width:' + CW + 'px;height:' + CH + 'px"></canvas>';
  }

  // §3.3 cases, in a 300px-wide box, canvas bitmap 200x100 (aspect 2:1).
  var SIZE_BODY =
    '<div style="width:300px">' +
    '<canvas id="s0" width="200" height="100"></canvas>' +
    '<canvas id="s1" width="200" height="100" style="display:block;width:50%;height:40px"></canvas>' +
    '<canvas id="s2" width="200" height="100" style="display:block;width:50%"></canvas>' +
    '<canvas id="s3" width="200" height="100" style="display:block;width:120px;height:40px"></canvas>' +
    '</div>';

  window.__mount = function (frameId, body) {
    var f = document.getElementById(frameId);
    return new Promise(function (resolve) {
      f.addEventListener('load', function () { resolve(true); }, { once: true });
      f.srcdoc = '<!DOCTYPE html><html><head>' + SHELL_HEAD +
        '<style>html,body{margin:0;padding:0;background:#fff}</style>' +
        '</head><body>' + body + '</body></html>';
    });
  };
  window.__mountCanvas = function (frameId) { return window.__mount(frameId, canvasBody('c')); };
  window.__mountEmpty  = function (frameId) { return window.__mount(frameId, ''); };
  window.__mountSizes  = function (frameId) { return window.__mount(frameId, SIZE_BODY); };

  function fdoc(frameId) { return document.getElementById(frameId).contentDocument; }

  // ── recording-side stand-in: a canvas.snapshot payload ──
  // A solid-colour PNG data URL, produced in the PARENT (unrestricted) exactly
  // as a recorder would have produced it at capture time.
  window.__snapshotData = function (w, h, css) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d');
    x.fillStyle = css; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  };

  // ── the mechanism under test (design §3.1) ──
  // One parent-owned offscreen canvas per recorded canvas node id, composited
  // per event, PRESENTED once per batch as a background image. Decoding rides
  // a per-canvas promise chain so region patches cannot composite out of order.
  var offscreens = Object.create(null);
  var chains = Object.create(null);

  window.__offscreenFor = function (key, w, h) {
    if (!offscreens[key]) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      offscreens[key] = c;
      chains[key] = Promise.resolve();
    }
    return offscreens[key];
  };

  // region === null  -> full baseline: clear, draw at (0,0)
  // region !== null  -> draw at (region.x, region.y), preserving surroundings
  window.__composite = function (key, dataUrl, region, w, h) {
    var off = window.__offscreenFor(key, w, h);
    chains[key] = chains[key].then(function () {
      var img = new Image();
      img.src = dataUrl;
      var ready = img.decode ? img.decode() : new Promise(function (res, rej) {
        img.onload = res; img.onerror = rej;
      });
      return ready.then(function () {
        var ctx = off.getContext('2d');
        if (!region) { ctx.clearRect(0, 0, off.width, off.height); ctx.drawImage(img, 0, 0); }
        else { ctx.drawImage(img, region.x, region.y); }
      });
    });
    return chains[key];
  };

  window.__present = function (key, frameId, sel) {
    var el = fdoc(frameId).querySelector(sel);
    var url = offscreens[key].toDataURL('image/png');
    el.style.backgroundImage = 'url(' + url + ')';
    el.style.backgroundSize = '100% 100%';
    el.style.backgroundRepeat = 'no-repeat';
    return url.length;
  };

  window.__settled = function (key) { return chains[key] || Promise.resolve(); };

  // ── the NEGATIVE: the direct in-frame drawImage route ──
  window.__directDraw = function (frameId, sel, css) {
    var el = fdoc(frameId).querySelector(sel);
    var ctx = el.getContext('2d');
    if (!ctx) return { context: false };
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, el.width, el.height);
    var px = ctx.getImageData(Math.floor(el.width / 2), Math.floor(el.height / 2), 1, 1).data;
    return { context: true, backingStore: [px[0], px[1], px[2], px[3]] };
  };

  window.__setAttr = function (frameId, sel, name, value) {
    fdoc(frameId).querySelector(sel).setAttribute(name, value);
  };

  // dom.add mid-span: instantiated with the FRAME's document, never the
  // report's — cross-realm nodes must not enter the reconstruction (design §4).
  window.__addCanvas = function (frameId, id, w, h) {
    var d = fdoc(frameId);
    var el = d.createElement('canvas');
    el.setAttribute('id', id);
    el.width = w; el.height = h;
    el.style.display = 'block';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    d.body.appendChild(el);
    return true;
  };

  window.__usedSize = function (frameId, sel) {
    var r = fdoc(frameId).querySelector(sel).getBoundingClientRect();
    return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  };
})();
<\/script></body></html>`;
}

// ── per-engine run ─────────────────────────────────────────────────────────

async function shot(page, sel) {
  const buf = await page.locator(sel).screenshot();
  const img = decodePng(buf);
  // Element-clipped shots are in device pixels; at deviceScaleFactor 1 that is
  // CSS px. Assert rather than assume, so a DPR surprise is loud.
  if (img.width !== CW || img.height !== CH_) {
    throw new Error(`screenshot of ${sel} is ${img.width}x${img.height}, expected ${CW}x${CH_} — DPR assumption broken`);
  }
  return img;
}

async function runEngine(name, browser, origin) {
  console.log(`\n── ${name} ──`);
  const page = await browser.newPage({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => requests.push('FAILED ' + r.url()));
  page.on('request', (r) => requests.push(r.url()));

  await page.goto(`${origin}/probe.html`, { waitUntil: 'load' });

  if (CFG.inject === 'no-present') {
    await page.evaluate(() => { window.__present = function () { return 0; }; });
  }
  if (CFG.inject === 'unsandbox-neg') {
    await page.evaluate(() => document.getElementById('f-neg')
      .setAttribute('sandbox', 'allow-same-origin allow-scripts'));
  }

  // ── NEG: the trap, asserted as a required negative ──
  await page.evaluate(() => window.__mountCanvas('f-neg'));
  const neg = await page.evaluate(() => window.__directDraw('f-neg', '#c', '#f00'));
  const negShot = await shot(page, '#f-neg');
  const negCentre = pixelAt(negShot, CW / 2, CH_ / 2);
  const backingOk = neg.context && rgbNear(neg.backingStore, RED, 0);
  const notPainted = !rgbNear(negCentre, RED, 64);
  record(name, 'NEG trap reproduces',
    backingOk && notPainted,
    `context=${neg.context} backingStore=${neg.context ? rgb(neg.backingStore) : 'n/a'} ` +
    `presented=${rgb(negCentre)} (correct-but-not-painted ${backingOk && notPainted ? 'CONFIRMED' : 'NOT reproduced'})`);

  // ── CTRL: same route, allow-scripts — proves NEG is the sandbox ──
  await page.evaluate(() => window.__mountCanvas('f-ctrl'));
  const ctrl = await page.evaluate(() => window.__directDraw('f-ctrl', '#c', '#f00'));
  const ctrlShot = await shot(page, '#f-ctrl');
  const ctrlCentre = pixelAt(ctrlShot, CW / 2, CH_ / 2);
  record(name, 'CTRL allow-scripts direct draw paints',
    ctrl.context && rgbNear(ctrlCentre, RED, CFG.tol),
    `presented=${rgb(ctrlCentre)}`);

  // ── GO1: baseline composite + presentation ──
  await page.evaluate(() => window.__mountCanvas('f-go'));
  if (CFG.inject === 'backing-store-oracle') {
    // The trap, wired up: take the DIRECT in-frame route (no presentation at
    // all) and assert on what the frame thinks it holds. It passes. The screen
    // is blank. This is precisely what plan global constraint 4 forbids.
    const direct = await page.evaluate(() => window.__directDraw('f-go', '#c', '#f00'));
    const blank = pixelAt(await shot(page, '#f-go'), CW / 2, CH_ / 2);
    record(name, 'GO1 baseline presented (BACKING-STORE ORACLE — deliberately wrong)',
      rgbNear(direct.backingStore, RED, CFG.tol),
      `backingStore=${rgb(direct.backingStore)} while the SCREEN shows ${rgb(blank)} — green test, blank screen`);
  }
  await page.evaluate(async ({ w, h }) => {
    const data = window.__snapshotData(w, h, '#f00');
    await window.__composite('go', data, null, w, h);
    window.__present('go', 'f-go', '#c');
  }, { w: CW, h: CH_ });
  let goShot = await shot(page, '#f-go');
  const goCentre = pixelAt(goShot, CW / 2, CH_ / 2);
  if (CFG.inject !== 'backing-store-oracle') {
    record(name, 'GO1 baseline presented', rgbNear(goCentre, RED, CFG.tol), `centre=${rgb(goCentre)} want ${rgb(RED)} tol ${CFG.tol}`);
  }

  // ── GO2: region patch at a non-zero offset ──
  await page.evaluate(async ({ region, w, h }) => {
    const data = window.__snapshotData(region.w, region.h, '#00f');
    await window.__composite('go', data, region, w, h);
    window.__present('go', 'f-go', '#c');
  }, { region: REGION, w: CW, h: CH_ });
  goShot = await shot(page, '#f-go');
  const inRegion = pixelAt(goShot, REGION.x + REGION.w / 2, REGION.y + REGION.h / 2);
  const outRegion = pixelAt(goShot, 20, 20);
  record(name, 'GO2 region patch presented, baseline survives outside',
    rgbNear(inRegion, BLUE, CFG.tol) && rgbNear(outRegion, RED, CFG.tol),
    `inside=${rgb(inRegion)} outside=${rgb(outRegion)}`);

  // ── GO3a: presentation survives a NON-style dom.attr patch ──
  await page.evaluate(() => window.__setAttr('f-go', '#c', 'class', 'jspsych-canvas'));
  goShot = await shot(page, '#f-go');
  const afterClass = pixelAt(goShot, 20, 20);
  record(name, 'GO3a survives dom.attr class', rgbNear(afterClass, RED, CFG.tol), `outside-region=${rgb(afterClass)}`);

  // ── GO3b: a `style` dom.attr patch CLOBBERS it — measured, and the repair pinned ──
  await page.evaluate(() => window.__setAttr('f-go', '#c', 'style',
    'display:block;width:' + 160 + 'px;height:' + 80 + 'px'));
  goShot = await shot(page, '#f-go');
  const afterStyle = pixelAt(goShot, 20, 20);
  const clobbered = !rgbNear(afterStyle, RED, CFG.tol);
  if (CFG.inject !== 'style-attr-no-repair') {
    await page.evaluate(() => window.__present('go', 'f-go', '#c'));
  }
  goShot = await shot(page, '#f-go');
  const afterRepresent = pixelAt(goShot, 20, 20);
  const inRegion2 = pixelAt(goShot, REGION.x + REGION.w / 2, REGION.y + REGION.h / 2);
  record(name, 'GO3b style dom.attr — clobber measured, re-present restores',
    rgbNear(afterRepresent, RED, CFG.tol) && rgbNear(inRegion2, BLUE, CFG.tol),
    `after style attr=${rgb(afterStyle)} (${clobbered ? 'CLOBBERED — Task 5 must re-present' : 'survived'}), ` +
    `after re-present=${rgb(afterRepresent)}/${rgb(inRegion2)}`);

  // ── GO4: canvas added mid-span by dom.add ──
  await page.evaluate(() => window.__mountEmpty('f-add'));
  await page.evaluate(async ({ w, h }) => {
    window.__addCanvas('f-add', 'later', w, h);
    const data = window.__snapshotData(w, h, '#0a0');
    await window.__composite('add', data, null, w, h);
    window.__present('add', 'f-add', '#later');
  }, { w: CW, h: CH_ });
  const addShot = await shot(page, '#f-add');
  const addCentre = pixelAt(addShot, CW / 2, CH_ / 2);
  record(name, 'GO4 mid-span dom.add canvas presents', rgbNear(addCentre, GREEN, CFG.tol), `centre=${rgb(addCentre)} want ${rgb(GREEN)}`);

  // ── SIZE: design §3.3 collapse scope ──
  await page.evaluate(() => window.__mountSizes('f-size'));
  await page.evaluate(() => window.__mountSizes('f-size-s'));
  const sizes = await page.evaluate(() => ({
    sandboxed: ['s0', 's1', 's2', 's3'].map((id) => window.__usedSize('f-size', '#' + id)),
    scripted: ['s0', 's1', 's2', 's3'].map((id) => window.__usedSize('f-size-s', '#' + id)),
  }));
  const [z, half, auto, px] = sizes.sandboxed;
  const collapseOnlyIntrinsic =
    z.w === 0 && z.h === 0 &&
    half.w > 0 && half.h > 0 && auto.w > 0 && auto.h > 0 && px.w > 0 && px.h > 0;
  record(name, 'SIZE collapse hits ONLY the fully-intrinsic case',
    collapseOnlyIntrinsic,
    `sandboxed no-CSS=${z.w}x${z.h} width50%+h40=${half.w}x${half.h} ` +
    `width50%+auto=${auto.w}x${auto.h} px=${px.w}x${px.h} | ` +
    `allow-scripts no-CSS=${sizes.scripted[0].w}x${sizes.scripted[0].h}`);

  // ── GO5: console + network ──
  const offPage = requests.filter((u) => !u.startsWith(origin) && !/^(about:|data:|blob:)/.test(u));
  record(name, 'GO5 zero console errors, zero off-page requests',
    consoleErrors.length === 0 && offPage.length === 0,
    `consoleErrors=${consoleErrors.length}${consoleErrors.length ? ' ' + JSON.stringify(consoleErrors.slice(0, 3)) : ''} ` +
    `requests=${requests.length} offPage=${offPage.length}${offPage.length ? ' ' + JSON.stringify(offPage.slice(0, 3)) : ''}`);

  await page.close();
  return { sizes, consoleErrors: consoleErrors.length, requests: requests.length, offPage: offPage.length };
}

// ── main ───────────────────────────────────────────────────────────────────

const resolved = resolvePlaywright();
if (!resolved) { console.log('SKIP: playwright-core not found'); process.exit(0); }
console.log(`playwright-core ${resolved.version} (via ${resolved.from})`);
console.log(`production srcdocCsp(false): ${productionSrcdocCsp(false)}`);

const files = new Map([['/probe.html', harnessHtml()]]);
// isolate:false — this probe needs no fine clock, and COEP is one more thing
// that could plausibly interact with data:-URL image decoding.
const server = await serveFiles(files, { isolate: false });

const engines = await launchEngines(resolved.pw, { only: CFG.engines, headless: CFG.headless });
const perEngine = {};
for (const e of engines) {
  if (!e.ok) {
    console.log(`\n── ${e.name} ── NOT LAUNCHED: ${e.reason}`);
    hardFailures++;
    results.push({ engine: e.name, id: 'launch', ok: false, detail: e.reason });
    continue;
  }
  try {
    perEngine[e.name] = await runEngine(e.name, e.browser, server.origin);
  } catch (err) {
    record(e.name, 'run', false, `threw: ${err.message}`);
  } finally {
    await e.browser.close();
  }
}
await server.close();

// ── report ─────────────────────────────────────────────────────────────────
const launched = engines.filter((e) => e.ok).map((e) => e.name);
console.log('\n── verdict ──');
console.log(`engines launched: ${launched.join(', ') || '(none)'}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`FAIL — ${failed.length} criterion/engine pair(s):`);
  for (const f of failed) console.log(`  [${f.engine}] ${f.id}: ${f.detail}`);
} else {
  console.log('GO — every §3.2 criterion holds on every launched engine, and the trap reproduces.');
}

const artifactsDir = join(repoRoot, 'tools', 'investigate', 'artifacts');
mkdirSync(artifactsDir, { recursive: true });
const out = join(artifactsDir, `canvas-presentation-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({
  playwrightCore: resolved.version, playwrightFrom: resolved.from,
  csp: productionSrcdocCsp(false), engines: launched, perEngine, results,
}, null, 2));
console.log(`artifact: ${out}`);

process.exit(hardFailures ? 1 : 0);
