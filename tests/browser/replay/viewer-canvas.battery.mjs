// tests/browser/replay/viewer-canvas.battery.mjs
// `canvas.snapshot` rendering, asserted on PRESENTED PIXELS. (T5 Task 5.)
//
// WHY THIS FILE EXISTS, AND WHY IT READS SCREENSHOTS
//
// A canvas inside a frame sandboxed WITHOUT allow-scripts accepts
// `getContext('2d')`, accepts the draw calls, holds correct pixels — and never
// paints them (Task 0, reproduced on chromium, firefox and webkit). So an
// assertion that reads `getImageData` on the in-frame canvas is a GREEN TEST
// OVER A BLANK SCREEN, and the plan makes that a global constraint rather than
// advice. Every pixel below therefore comes out of an element-clipped
// screenshot decoded in Node.
//
// The same trap has a second storey, which the plan review named: the data URL
// the viewer presents comes from the parent-owned OFFSCREEN canvas, where
// painting is unrestricted, so it can be perfectly correct while the
// PRESENTATION step never happened. A data-URL check is therefore used here
// only as a cheap composite pre-check, never as the acceptance.
//
// WHAT IS ASSERTED
//   BASE   jspsych-full segment 8's real 189,322-char full baseline (node 3) is
//          visible in the frame, at named coordinates, in the recorded colours
//   BLANK  the same coordinates before the snapshot are NOT those colours —
//          so BASE cannot pass over a lucky background
//   REGION segment 9's baseline + eight region patches (node 8) land where the
//          fixture says: the ink's bounding box in the screenshot matches the
//          union of the recorded region rectangles
//   STYLE  presentation survives a `dom.attr` naming `style`, AND its removal
//          (`value: null`) — the CSSOM clobber design §3.1 makes an invariant
//   SIZE   §3.3's repair fires (a canvas with no CSS size collapses to 0×0 in
//          this sandbox, so without it every pixel assertion above is vacuous)
//   CLEAN  no page errors, no console errors beyond the declared autofocus
//          whitelist, and no request leaves the page
//
// REGISTRATION IS GUARDED, NOT ASSUMED. The frame is letterboxed by `scale(k)`,
// so a frame-local point maps to a shot pixel through k. Both k and the
// screenshot's own dimensions are asserted before any pixel is read (the
// plan-review lesson: a probe that samples by unchecked arithmetic produced a
// false WebKit reading). The canvas's frame-local box is MEASURED through
// `contentDocument` rather than computed.
//
// Chromium by default, like `viewer-boot.battery.mjs` and
// `capture-chromium.battery.mjs`; `--engines=chromium,firefox,webkit` runs the
// spread (recorded in the Task-5 report).
//
// Run: npm run test:browser:canvas

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import zlib from 'node:zlib';

import { buildViewerModel } from '../../../src/cli/renderers/replay-assets.js';
import { readReplayClientSrc } from '../../../src/cli/renderers/replay-client-source.js';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit === `--${n}` ? true : hit.slice(n.length + 3);
};
const ENGINES = String(opt('engines', 'chromium')).split(',').map((s) => s.trim()).filter(Boolean);
const HEADLESS = !opt('headed', false);

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
mkdirSync(artifactsDir, { recursive: true });

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + label); }
}

// ── PNG decode (8-bit, non-interlaced — what Playwright emits) ─────────────
// A local copy rather than an import from tools/investigate/probe-support.mjs:
// the batteries are self-contained by convention (own `resolvePlaywright`, own
// `check`), and a test suite must not depend on an investigation harness.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG buffer');
  let off = 8; let ihdr = null; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) throw new Error('unsupported PNG (8-bit non-interlaced only)');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error('unsupported PNG colour type ' + ihdr.colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xff;
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels; const d = (y * width + x) * 4;
      if (channels >= 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = channels === 4 ? line[s + 3] : 255; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = channels === 2 ? line[s + 1] : 255; }
    }
    prev = line;
  }
  return { width, height, data: out };
}
const pixelAt = (img, x, y) => {
  const xi = Math.round(x); const yi = Math.round(y);
  const i = (yi * img.width + xi) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};
const rgb = (p) => `rgb(${p[0]},${p[1]},${p[2]})`;
const near = (p, want, tol) => Math.abs(p[0] - want[0]) <= tol && Math.abs(p[1] - want[1]) <= tol && Math.abs(p[2] - want[2]) <= tol;

// ── the recording ──────────────────────────────────────────────────────────

const RECORDING = JSON.parse(readFileSync(
  join(repoRoot, 'tests', 'replay', 'schema-v2', 'fixtures', 'jspsych-full.json'), 'utf8'));

// Both canvas segments tear down inside their own span (segment 8 removes the
// canvas's parent at tRel 263.4; segment 9 removes the canvas at 1505.1, and
// then carries one more snapshot for it — see the node suite), so these are the
// last playheads at which each canvas is still mounted.
const SEG8_LIVE = 100;
const SEG9_LIVE = 1000;

// Ink from the composite of segment 9's first nine snapshots, computed here
// from the fixture's own payloads: the union of the recorded region rectangles
// is x 59..323, y 45..251, and a source-over composite of the real PNGs puts
// every non-white pixel inside x 59..322, y 45..250. That box is what the
// screenshot's ink must reproduce — a check that fails if the regions were
// composited at the origin, if presentation never happened, or if the frame is
// mis-registered, none of which a single sampled pixel would catch.
const SEG9_INK = { minX: 59, minY: 45, maxX: 322, maxY: 250 };

// Segment 8's baseline, sampled where the image is FLAT (max neighbour delta
// ≤2 within 4px, measured off the payload), so a 0.75 letterbox scale cannot
// move the answer.
const SEG8_POINTS = [
  { x: 60, y: 60, want: [104, 118, 223] },
  { x: 340, y: 240, want: [115, 82, 172] },
];
const INK = [44, 62, 80];         // the sketchpad stroke colour
const PAPER = [254, 254, 254];    // its canvas background

function styleClobberModel() {
  // The corpus carries no `dom.attr` naming `style` on a canvas node (216 style
  // writes, none on nodes 3 or 8), so the invariant gets a constructed pair on
  // top of REAL data: the fixture's own segment 9, its own payloads, with two
  // style writes appended after the last live snapshot.
  const rec = JSON.parse(JSON.stringify(RECORDING));
  const seg = rec.segments[9];
  const base = seg.t_start;
  seg.events.push(
    // The write is HOSTILE on purpose: it names `background` as well, so it
    // clobbers by replacing the inline block (route 1's hazard) AND competes
    // with the head rule (route 2's). Both halves have to lose to the viewer.
    { type: 'dom.attr', t: base + 1100, node: 8, name: 'style', value: 'display: block; background: none;' },
    { type: 'dom.attr', t: base + 1200, node: 8, name: 'style', value: null });
  seg.events.sort((a, b) => a.t - b.t);
  return buildViewerModel(rec);
}

function harnessHtml(model, name) {
  const modelJson = JSON.stringify(model).replace(/</g, '\\u003c');
  const safeViewer = readReplayClientSrc().replace(/<\/script/gi, '<\\/script');
  // The cursor OVERLAY is suppressed here and only here. It is a sibling of the
  // iframe in the same stage box, so an element-clipped shot of the frame
  // captures the trail and the ripples painted over it — and segment 9 is a
  // drawing task, so the trail sits exactly on top of the pixels under test.
  // The overlay has its own coverage; this battery measures the reconstruction
  // beneath it.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #fff; }
    .replay-stage { position: relative; overflow: hidden; background: #fff; }
    .replay-frame { position: absolute; top: 0; left: 0; border: 0; background: #fff; }
    .replay-overlay { display: none; }
    .replay-keycast, .replay-media { display: none; }
  </style></head><body>
  <div id="mount" style="width:960px"></div>
  <script>${safeViewer}<\/script>
  <script>
    window.__model = ${modelJson};
    initChReplayViewer(document.getElementById('mount'), window.__model);
    window.__dbg = function () { return document.getElementById('mount')._chReplayDebug; };
    window.__frame = function () { return document.querySelector('.replay-frame'); };
    // Measured through contentDocument (same-origin by sandbox design), never
    // guessed: the canvas's PADDING box inside the frame, in frame CSS pixels,
    // plus its bitmap size. The padding box is what the presentation is sized
    // against (background-origin defaults to padding-box), so it is the frame a
    // recorded bitmap coordinate maps through.
    window.__canvasBox = function (id) {
      var el = window.__dbg().getNode(id);
      if (!el) return null;
      var doc = window.__frame().contentDocument;
      var r = el.getBoundingClientRect();
      var cs = doc.defaultView.getComputedStyle(el);
      return {
        x: r.left + (parseFloat(cs.borderLeftWidth) || 0),
        y: r.top + (parseFloat(cs.borderTopWidth) || 0),
        w: el.clientWidth, h: el.clientHeight,
        bw: el.width, bh: el.height,
        borderW: r.width, borderH: r.height,
      };
    };
    window.__ruleFor = function (id) {
      var doc = window.__frame().contentDocument;
      var s = doc.head.querySelector('[data-ch-canvas-rule="' + id + '"]');
      return s ? s.textContent.length : 0;
    };
    window.__settle = function (seg, t) {
      var dbg = window.__dbg();
      dbg.selectSegment(seg);
      dbg.seek(t);
      return dbg.canvasSettled();
    };
    // A forward seek INSIDE the applied span — an incremental walk, not a
    // restore. This is where a style write can arrive in a batch that carries
    // no snapshot, which is the case a re-present-after-the-clobber repair does
    // not cover once presentation is skipped for untouched canvases.
    window.__forward = function (t) {
      var dbg = window.__dbg();
      dbg.seek(t);
      return dbg.canvasSettled();
    };
    // The SHIPPED path: nothing in a report awaits canvasSettled(). The
    // analyst seeks and the pixels arrive when the decode does.
    window.__seekOnly = function (seg, t) {
      var dbg = window.__dbg();
      dbg.selectSegment(seg);
      dbg.seek(t);
    };
  <\/script>
  </body></html>`;
  const file = join(artifactsDir, 'canvas-harness-' + name + '.html');
  writeFileSync(file, html);
  return 'file://' + file;
}

// An element-clipped shot of the frame, with the letterbox scale and the shot's
// own dimensions asserted so the frame-local → shot-pixel mapping cannot drift
// silently.
async function frameShot(page, label) {
  const cam = await page.evaluate(() => window.__dbg().getCamera());
  const buf = await page.locator('.replay-frame').screenshot();
  const img = decodePng(buf);
  const wantW = Math.round(cam.cw * cam.k);
  const wantH = Math.round(cam.ch * cam.k);
  if (Math.abs(img.width - wantW) > 1 || Math.abs(img.height - wantH) > 1) {
    throw new Error(`${label}: shot is ${img.width}x${img.height}, expected ${wantW}x${wantH} ` +
      `(cam ${cam.cw}x${cam.ch} @ k=${cam.k}) — the registration assumption is broken`);
  }
  return { img, k: cam.k };
}

// A RECORDED BITMAP coordinate, in shot pixels. Two mappings, both measured
// rather than assumed: the composite is stretched over the canvas's padding box
// (`background-size: 100% 100%`), and the frame is letterboxed by `scale(k)`.
const at = (shot, box, bx, by) => pixelAt(shot.img,
  (box.x + bx * (box.w / box.bw)) * shot.k,
  (box.y + by * (box.h / box.bh)) * shot.k);

// The ink's bounding box, back in RECORDED BITMAP coordinates, recovered from
// the screenshot — so it can be compared against the region rectangles the
// fixture states.
function inkBox(shot, box) {
  let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1; let n = 0;
  const x0 = Math.round(box.x * shot.k); const y0 = Math.round(box.y * shot.k);
  const w = Math.round(box.w * shot.k); const h = Math.round(box.h * shot.k);
  const toBx = (sx) => (sx / shot.k) * (box.bw / box.w);
  const toBy = (sy) => (sy / shot.k) * (box.bh / box.h);
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const p = pixelAt(shot.img, x0 + sx, y0 + sy);
      // Anything clearly darker than the paper counts as ink; the strokes are
      // rgb(44,62,80) and the paper rgb(254,254,254), so the midpoint is safe
      // against letterbox antialiasing at either end.
      if (p[0] < 150 && p[1] < 160 && p[2] < 180) {
        n++;
        if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
      }
    }
  }
  if (n === 0) return { n: 0 };
  return { n, minX: toBx(minX), minY: toBy(minY), maxX: toBx(maxX), maxY: toBy(maxY) };
}

// ── per-engine run ─────────────────────────────────────────────────────────

// Task-4 finding (a), routed to Task 8 and inherited here: a reconstruction
// carrying `autofocus` logs one console error per mount on chromium and webkit
// ("Blocked autofocusing…"), because the frame is sandboxed without
// allow-scripts. The behaviour is correct and jspsych-full triggers it.
const CONSOLE_WHITELIST = [/Blocked autofocusing/i];

async function runEngine(name, browser) {
  console.log(`\n── ${name} ──`);
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' && !CONSOLE_WHITELIST.some((re) => re.test(m.text()))) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));

  // ── segment 8: a real full baseline, in its recorded colours ──
  await page.goto(harnessHtml(buildViewerModel(RECORDING), 'seg8-' + name));
  await page.waitForFunction(() => window.__dbg().frameReady(), null, { timeout: 8000 });

  await page.evaluate(() => window.__settle(8, 0));
  const box8 = await page.evaluate(() => window.__canvasBox(3));
  // §3.3's OTHER half: this canvas carries `display:block` and no CSS size, so
  // the page's own layout gives it a box (436×327 on chromium — the container
  // width plus the attribute aspect ratio) and the repair must NOT fire. The
  // composite is stretched over whatever box the page produced, which is the
  // design's "page CSS stays authoritative" rule doing its job.
  check(!!box8 && box8.w > 0 && box8.h > 0 && !(await page.evaluate(() => /width:\d/.test(
    (window.__frame().contentDocument.head.querySelector('[data-ch-canvas-rule="3"]') || { textContent: '' }).textContent))),
  `SIZE a laid-out canvas keeps the page's box, unrepaired (${box8 ? box8.w + 'x' + box8.h : 'null'}, bitmap ${box8 && box8.bw}x${box8 && box8.bh})`);
  const before = await frameShot(page, 'seg8 before');
  const blankHits = box8 ? SEG8_POINTS.filter((p) => near(at(before, box8, p.x, p.y), p.want, 24)).length : 0;
  check(blankHits === 0,
    'BLANK before the snapshot, the sampled points are NOT the recorded colours');

  await page.evaluate((t) => window.__settle(8, t), SEG8_LIVE);
  const after8 = await frameShot(page, 'seg8 after');
  const box8b = await page.evaluate(() => window.__canvasBox(3));
  let ok8 = true;
  const detail8 = [];
  for (const p of SEG8_POINTS) {
    const got = at(after8, box8b, p.x, p.y);
    const hit = near(got, p.want, 12);
    if (!hit) ok8 = false;
    detail8.push(`(${p.x},${p.y}) ${rgb(got)}${hit ? '' : ' want ' + rgb(p.want)}`);
  }
  check(ok8, 'BASE the 189,322-char full baseline is PRESENTED in its recorded colours — ' + detail8.join(' '));
  check(await page.evaluate(() => window.__ruleFor(3)) > 1000,
    'the presentation rule carries the encoded composite (cheap pre-check, not the acceptance)');

  // The SHIPPED path, with nothing awaited: a report has no `canvasSettled()`
  // caller, so a viewer that only presents when someone asks it to shows the
  // analyst a blank canvas forever while every awaited assertion above passes.
  await page.evaluate((t) => window.__seekOnly(8, t), SEG8_LIVE);
  await page.waitForTimeout(500);
  const unawaited = await frameShot(page, 'seg8 unawaited');
  const boxU = await page.evaluate(() => window.__canvasBox(3));
  const gotU = at(unawaited, boxU, SEG8_POINTS[0].x, SEG8_POINTS[0].y);
  check(near(gotU, SEG8_POINTS[0].want, 12),
    `BASE the composite appears with NOTHING awaited — the report's own path (${rgb(gotU)})`);

  // ── segment 9: baseline + eight region patches, placed ──
  await page.evaluate((t) => window.__settle(9, t), SEG9_LIVE);
  const box9 = await page.evaluate(() => window.__canvasBox(8));
  // The corpus's own collapse case: a bordered canvas whose CONTENT box is 0×0
  // while its border box measures 4×28. Without the repair the composite is
  // presented into four pixels, and a rect-based guard never notices.
  check(box9 && box9.w === box9.bw && box9.h === box9.bh,
    `SIZE §3.3 repairs the collapsed sketchpad canvas to its bitmap size ` +
    `(${box9 ? box9.w + 'x' + box9.h : 'null'}, border box ${box9 ? Math.round(box9.borderW) + 'x' + Math.round(box9.borderH) : '?'})`);
  const after9 = await frameShot(page, 'seg9 after');
  const ink = inkBox(after9, box9);
  const tol = 3;
  const placed = ink.n > 0 &&
    Math.abs(ink.minX - SEG9_INK.minX) <= tol && Math.abs(ink.minY - SEG9_INK.minY) <= tol &&
    Math.abs(ink.maxX - SEG9_INK.maxX) <= tol && Math.abs(ink.maxY - SEG9_INK.maxY) <= tol;
  check(placed, 'REGION the composited ink lands on the recorded region rectangles ' +
    `(ink ${ink.n} px, box ${Math.round(ink.minX)},${Math.round(ink.minY)}..${Math.round(ink.maxX)},${Math.round(ink.maxY)} ` +
    `want ${SEG9_INK.minX},${SEG9_INK.minY}..${SEG9_INK.maxX},${SEG9_INK.maxY})`);
  const outside = at(after9, box9, 20, 20);
  check(near(outside, PAPER, 12),
    `REGION the baseline survives outside every patch (20,20 = ${rgb(outside)})`);
  const insideStroke = at(after9, box9, 192, 249);
  check(near(insideStroke, INK, 24),
    `REGION the last live region patch is on screen (192,249 = ${rgb(insideStroke)} want ${rgb(INK)})`);

  // A backward seek RE-DERIVES the composite from the keyframe (design §5;
  // caching the offscreen canvases across restores is optimisation (a), NOT
  // taken). Without that, the analyst scrubs back and still sees strokes the
  // participant had not drawn yet — the canvas equivalent of a patch that does
  // not undo. At tRel 100 only three of the nine snapshots have happened.
  await page.evaluate(() => window.__dbg().seek(100));
  await page.evaluate(() => window.__dbg().canvasSettled());
  const back = inkBox(await frameShot(page, 'seg9 back'), await page.evaluate(() => window.__canvasBox(8)));
  check(back.n > 0 && back.n < ink.n * 0.6 && back.maxY < 200,
    `BACK a backward seek re-derives the composite (${ink.n} → ${back.n} ink px, ` +
    `max y ${back.n ? Math.round(back.maxY) : '-'} vs ${Math.round(ink.maxY)})`);

  // ── the style clobber, on the same real payloads ──
  await page.goto(harnessHtml(styleClobberModel(), 'style-' + name));
  await page.waitForFunction(() => window.__dbg().frameReady(), null, { timeout: 8000 });
  await page.evaluate((t) => window.__settle(9, t), SEG9_LIVE);
  const boxS = await page.evaluate(() => window.__canvasBox(8));
  const inkBefore = inkBox(await frameShot(page, 'style before'), boxS);

  // FORWARD, not a re-select: the style write then lands in a batch of its own,
  // with no snapshot in it. A viewer that presented into the inline style and
  // repaired the clobber by re-presenting would pass this only if it
  // re-encoded a canvas nothing touched — which is the cost design §3.1 exists
  // to avoid, and which this viewer deliberately skips.
  await page.evaluate(() => window.__forward(1150));     // after the style WRITE
  const afterWrite = await frameShot(page, 'style write');
  const boxW = await page.evaluate(() => window.__canvasBox(8));
  const inkWrite = inkBox(afterWrite, boxW);
  check(inkWrite.n > 0 && Math.abs(inkWrite.n - inkBefore.n) <= inkBefore.n * 0.02,
    `STYLE presentation survives a dom.attr on style (${inkBefore.n} → ${inkWrite.n} ink px)`);

  await page.evaluate(() => window.__forward(1250));     // after the style REMOVAL
  const afterNull = await frameShot(page, 'style null');
  const boxN = await page.evaluate(() => window.__canvasBox(8));
  const inkNull = inkBox(afterNull, boxN);
  check(inkNull.n > 0 && Math.abs(inkNull.n - inkBefore.n) <= inkBefore.n * 0.02,
    `STYLE presentation survives value: null on style (${inkBefore.n} → ${inkNull.n} ink px)`);
  check(boxN && boxN.w > 0 && boxN.h > 0,
    `STYLE the §3.3 size repair survives the same two writes (${boxN ? boxN.w + 'x' + boxN.h : 'null'})`);

  const offPage = requests.filter((u) => !/^(file:|about:|data:|blob:)/.test(u));
  check(pageErrors.length === 0, 'CLEAN no page errors (' + (pageErrors[0] || 'none') + ')');
  check(consoleErrors.length === 0,
    'CLEAN no console errors beyond the autofocus whitelist (' + (consoleErrors[0] || 'none') + ')');
  check(offPage.length === 0, 'CLEAN nothing left the page (' + (offPage[0] || 'none') + ')');

  await page.close();
}

for (const name of ENGINES) {
  const launcher = pw[name];
  if (!launcher) { console.error(`\n── ${name} ── NOT EXPOSED by playwright-core`); failures++; continue; }
  let browser = null;
  try {
    browser = await launcher.launch({ headless: HEADLESS });
  } catch (e) {
    // A skipped engine is not a passing engine (probe-support's rule).
    console.error(`\n── ${name} ── NOT LAUNCHED: ${String(e.message || e).split('\n')[0]}`);
    failures++;
    continue;
  }
  try { await runEngine(name, browser); } finally { await browser.close(); }
}

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nViewer canvas battery: composites are PRESENTED, placed, and survive a style write.');
process.exit(0);
