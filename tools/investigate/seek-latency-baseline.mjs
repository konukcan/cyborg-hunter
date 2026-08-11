#!/usr/bin/env node
// tools/investigate/seek-latency-baseline.mjs
//
// T5 (A2) Task 0(b) — the seek-latency baseline, the alignment-check
// forced-layout measurement, the measurement floor, and the composite
// worst case. Design §11 (as amended by the plan review); plan Task 0(c);
// plan-review "what execution's Task 0 must nail down first" items 2-5.
//
// WHY THIS EXISTS
//   Design §11 sets 100/100/300 ms ceilings on three seek cases and (before
//   the plan review) a <=4x ratio between two of them. The review measured the
//   cost primitives and found the ceilings sit ~100x over the modelled work,
//   which means §11 named the wrong cost driver: what can actually reach 300 ms
//   is the §8 alignment self-check's forced synchronous layout per anchored
//   event. Nothing measured it. This harness does, and it derives the ratio
//   from a measured mount:events split instead of asserting one.
//
// WHAT IT MEASURES
//   FLOOR   the harness's own noise, before any median is gated:
//           crossOriginIsolated + performance.now() granularity, the timing
//           wrapper's own cost, a Playwright evaluate round trip, and the
//           cheapest real v1 seek. Gates in Task 9 must sit above this.
//   V1      the CURRENT v1 viewer's seek latency over the committed
//           SMOKE-19NRQR recording — forward and backward within a trial.
//           This is the same-session CONTROL Task 9 interleaves against
//           (T3's method correction: interleave, gate on the median, never on
//           a stored absolute from another session).
//   PRIM    restore cost primitives inside a script-less same-origin iframe
//           under the production CSP: keyframe mount at three tree sizes,
//           dom.attr/dom.text patch application, canvas composite + present.
//   ALIGN   the §8 alignment bundle per anchored event, split five ways
//           (clientWidth / getBoundingClientRect / elementFromPoint / the
//           parent-side stage rect / all five checks), each measured with
//           layout DIRTY (a patch between events, which is what a real seek
//           does) and CLEAN (the optimistic case). Dirty-vs-clean is the whole
//           finding: a clean-layout measurement understates by ~an order of
//           magnitude and would set a gate nothing can trip.
//   SPAN    case (ii) = mount + 1 segment's events, case (iii) = mount + 10
//           segments' events, each with checks ON and OFF, over a SYNTHETIC
//           deep-span-plus-canvas model. Yields the case(iii)/case(ii) ratio
//           and the composite worst case in one artifact.
//
// THE MODEL IS A MODEL
//   Tasks 2-5 build the real instantiator, patch applier, span walk and canvas
//   presenter. None of them exist at Task 0. The page script below is a
//   MEASUREMENT MODEL of that work — the same operations in the same realm
//   under the same CSP, deliberately with no tolerance handling, no id-map
//   lifetime rules and no redaction. Its numbers are a FLOOR on what the real
//   implementation costs, not a prediction of it. Do not mistake it for a
//   prototype: nothing here should be copied into src/.
//
// WHY A SYNTHETIC DEEP-SPAN MODEL (plan-review item 5)
//   The composite worst case is unrecordable from the committed corpus.
//   jspsych-full's 14 segments are ALL keyframes, so a canvas seek there
//   restores one segment; CH's recorder emits no canvas.snapshot at all, so a
//   CH-recorded keyframe-continuation session cannot carry canvas. The two
//   drivers never compose in anything that exists. So this harness assembles
//   one: a 10-segment span over jspsych-full's largest real keyframe tree
//   (535 nodes, segment 11), carrying jspsych-full's REAL canvas.snapshot
//   payloads (the 189,322-char baseline and the nine sketchpad regions) spread
//   across the continuations. Real trees, real PNG payloads, synthetic
//   composition.
//
// USAGE
//   PLAYWRIGHT_CORE_DIR=/opt/homebrew/lib/node_modules/ \
//     node tools/investigate/seek-latency-baseline.mjs
//   ... --engines=chromium,firefox,webkit   (default: chromium)
//   ... --runs=7 --events-per-segment=100 --anchored-frac=0.20
//   ... --no-isolate                        (drop COOP+COEP; coarser clock)
//
// Exit code 0 unless a scenario threw or a coverage assertion failed. This
// probe REPORTS numbers; it does not gate. Task 9 gates.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  repoRoot, resolvePlaywright, launchEngines, productionShellHead,
  serveFiles, median, p95, minOf, fixed,
} from './probe-support.mjs';
import { buildViewerModel } from '../../src/cli/renderers/replay-assets.js';

// ── options ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit === `--${n}` ? true : hit.slice(n.length + 3);
};
const CFG = {
  engines: String(opt('engines', 'chromium')),
  headless: !opt('headed', false),
  runs: Number(opt('runs', 7)),
  seekSamples: Number(opt('seek-samples', 25)),
  eventsPerSegment: Number(opt('events-per-segment', 100)),
  anchoredFrac: Number(opt('anchored-frac', 0.20)),
  spanSegments: Number(opt('span-segments', 10)),
  isolate: !opt('no-isolate', false),
};

const FIX = join(repoRoot, 'tests', 'replay', 'schema-v2', 'fixtures');
const jspsychFull = JSON.parse(readFileSync(join(FIX, 'jspsych-full.json'), 'utf8'));
const smokeV1 = JSON.parse(readFileSync(
  join(repoRoot, 'tests', 'browser', 'replay', 'fixtures', 'SMOKE-19NRQR-replay.json'), 'utf8'));

// ── fixture-derived inputs ─────────────────────────────────────────────────

const countNodes = (d) => (d ? 1 + (d.children || []).reduce((a, c) => a + countNodes(c), 0) : 0);

function collectElementIds(dom, out = []) {
  if (!dom) return out;
  if (dom.kind === 'element') out.push(dom.id);
  (dom.children || []).forEach((c) => collectElementIds(c, out));
  return out;
}

/** Real canvas.snapshot payloads from jspsych-full: 1 full baseline + 9 regions. */
function realCanvasSnapshots() {
  const all = [];
  jspsychFull.segments.forEach((s) => (s.events || []).forEach((e) => {
    if (e.type === 'canvas.snapshot') all.push({ region: e.region || null, data_url: e.data_url });
  }));
  const baseline = all.find((e) => !e.region && e.data_url.length > 100000) || all.find((e) => !e.region);
  const regions = all.filter((e) => e.region);
  return { baseline, regions };
}

/** A synthetic tree of roughly `target` nodes, for the mount-size sweep. */
function syntheticTree(target, startId = 100000) {
  let id = startId;
  const node = (tag, attrs, children) => ({ id: id++, kind: 'element', tag, attrs, children });
  const root = node('body', {}, []);
  let made = 1;
  let row = 0;
  while (made < target) {
    const div = node('div', { class: 'r' + row, 'data-row': String(row) }, []);
    made++;
    for (let i = 0; i < 9 && made < target; i++) {
      const span = node('span', { class: 'c' + i }, [{ id: id++, kind: 'text', text: `cell ${row}-${i}` }]);
      made += 2;
      div.children.push(span);
    }
    root.children.push(div);
    row++;
  }
  return root;
}

/**
 * The synthetic deep-span-plus-canvas model (plan-review item 5).
 * Segment 0 is the keyframe; 1..N-1 are continuations. Every segment carries
 * `eventsPerSegment` events at the requested anchored fraction, plus one
 * canvas.snapshot (seg 0 = the real full baseline, the rest = real regions).
 */
function buildDeepSpanModel({ tree, segments, eventsPerSegment, anchoredFrac, canvas }) {
  const elementIds = collectElementIds(tree).filter((i) => i !== tree.id);
  const snaps = realCanvasSnapshots();
  const canvasId = 900001;
  const withCanvas = JSON.parse(JSON.stringify(tree));
  withCanvas.children.push({
    id: canvasId, kind: 'element', tag: 'canvas',
    attrs: { id: 'span-canvas', width: '400', height: '300', style: 'display:block;width:400px;height:300px' },
    children: [], canvas_size: { w: 400, h: 300 },
  });

  const out = [];
  let t = 0;
  for (let s = 0; s < segments; s++) {
    const events = [];
    // INTERLEAVED, not blocked: a real seek alternates patches and anchored
    // events, so layout is dirty at most checks. Blocking them would measure
    // one forced layout followed by 19 free reads.
    const anchoredEvery = Math.max(1, Math.round(1 / anchoredFrac));
    for (let i = 0; i < eventsPerSegment; i++) {
      t += 5;
      const target = elementIds[(s * 7 + i * 13) % elementIds.length];
      if (i % anchoredEvery === 0) {
        // A discrete interaction: CH's capture puts both alignment blocks on
        // these (capture-trace.js withAlignment) and on nothing else.
        events.push({
          type: i % 3 === 0 ? 'mouse.click' : (i % 3 === 1 ? 'mouse.down' : 'key.down'),
          t, x: 40 + (i % 300), y: 40 + (i % 200), button: 0,
          camera: { scroll_x: 0, scroll_y: 0, client_w: 800, client_h: 600, w: 800, h: 600, dpr: 1, vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0 },
          anchor: { tag: 'div', id: null, node: target, rect: { x: 10, y: 10, w: 50, h: 20 } },
        });
      } else if (i % 4 === 1) {
        events.push(i % 8 === 1
          ? { type: 'dom.attr', t, node: target, name: 'class', value: 'c' + (i % 5) }
          : { type: 'dom.text', t, node: target, text: 'v' + i });
      } else {
        events.push({ type: 'mouse.move', t, x: 10 + (i % 700), y: 10 + (i % 500) });
      }
    }
    if (canvas) {
      const snap = s === 0 ? snaps.baseline : snaps.regions[(s - 1) % snaps.regions.length];
      events.push({ type: 'canvas.snapshot', t: t + 1, node: canvasId, data_url: snap.data_url, ...(snap.region ? { region: snap.region } : {}) });
    }
    out.push({
      index: s, t_start: s * eventsPerSegment * 5, t_end: (s + 1) * eventsPerSegment * 5,
      initial_dom: s === 0 ? (canvas ? withCanvas : tree) : null,
      initial_state: null, events,
    });
  }
  return { canvasId, segments: out };
}

// ── the two harness pages ──────────────────────────────────────────────────

/** Page A: the REAL v1 viewer over the committed SMOKE-19NRQR model. */
function v1PageHtml(model) {
  const viewerSrc = readFileSync(join(repoRoot, 'src', 'cli', 'renderers', 'replay-viewer.client.js'), 'utf8')
    .replace(/<\/script/gi, '<\\/script');
  const modelJson = JSON.stringify(model).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  .replay-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0}
  .replay-stage{position:relative;overflow:hidden;background:#fff;border:1px solid #ccc}
  .replay-frame{position:absolute;top:0;left:0;border:0}
  .replay-overlay{position:absolute;top:0;left:0;pointer-events:none}
  .replay-lane{display:block;margin-top:6px}.replay-scrub{display:block;margin:2px 0 4px}
  .replay-warn{color:#c62828}
</style></head><body><div id="mount" style="width:900px"></div>
<script>${viewerSrc}<\/script>
<script>
  window.__model = ${modelJson};
  initChReplayViewer(document.getElementById('mount'), window.__model);
  var dbg = function () { return document.getElementById('mount')._chReplayDebug; };
  window.__selectTrial = function (i) { dbg().selectTrial(i); };

  // v1's BACKWARD seek is asynchronous: seek() calls rebuildFrame(), which
  // rewrites iframe.srcdoc and finishes in an onload handler
  // (replay-viewer.client.js:776-791 -> :504-542). Timing the return of
  // seek() therefore measures the dispatch, not the seek, and would report a
  // rebuild as free. Both numbers are returned: syncMs (what blocks the main
  // thread) and settledMs (through frameReady() + one rAF, i.e. what the
  // analyst waits for). wentAsync says which one is the real answer.
  window.__seekSettled = function (t) {
    var d = dbg();
    var t0 = performance.now();
    d.seek(t);
    var syncMs = performance.now() - t0;
    var readyAtReturn = d.frameReady();
    return new Promise(function (resolve) {
      function done() {
        resolve({ syncMs: syncMs, settledMs: performance.now() - t0, wentAsync: !readyAtReturn });
      }
      if (readyAtReturn) { requestAnimationFrame(done); return; }
      (function poll() {
        if (d.frameReady()) requestAnimationFrame(done);
        else requestAnimationFrame(poll);
      })();
    });
  };
  // The instrument floor: everything the measured path does EXCEPT the seek.
  window.__seekNoop = function () {
    var d = dbg();
    var t0 = performance.now();
    void d;
    return performance.now() - t0;
  };
  // settledMs can never be below one animation frame; that is its floor.
  window.__rafFloor = function () {
    var t0 = performance.now();
    return new Promise(function (r) { requestAnimationFrame(function () { r(performance.now() - t0); }); });
  };
  window.__clockGranularity = function (n) {
    var mins = Infinity, prev = performance.now();
    for (var i = 0; i < n; i++) {
      var x = performance.now();
      var dd = x - prev;
      if (dd > 0 && dd < mins) mins = dd;
      prev = x;
    }
    return { minDelta: mins, isolated: !!self.crossOriginIsolated };
  };
<\/script></body></html>`;
}

/**
 * Page B: the restore MEASUREMENT MODEL (see the header — not product code).
 * A script-less same-origin iframe under the production CSP; every operation
 * is driven from the parent through contentDocument, as the viewer does.
 */
function modelPageHtml() {
  const shellHead = productionShellHead(false);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  #stage{position:relative;width:1280px;height:1000px;overflow:hidden;border:1px solid #ccc}
  #F{position:absolute;top:0;left:0;border:0}
</style></head><body>
<div id="stage"><iframe id="F" width="1280" height="1000" sandbox="allow-same-origin"></iframe></div>
<script>
(function () {
  var SHELL_HEAD = ${JSON.stringify(shellHead)};
  var frame = document.getElementById('F');
  var idMap = null;
  var offscreens = Object.create(null);
  var chains = Object.create(null);
  var touched = Object.create(null);

  function fdoc() { return frame.contentDocument; }

  // The shell carries the RECORDING's stylesheets, as buildSrcdoc() does. This
  // is load-bearing for the alignment measurement: forced layout on a tree
  // with no CSS is not the cost the viewer will pay. jspsych-full ships 470 KB
  // of real jsPsych CSS, so selector matching and style recalc are in the
  // numbers.
  window.__shell = function (css) {
    return new Promise(function (resolve) {
      frame.addEventListener('load', function () { resolve(true); }, { once: true });
      frame.srcdoc = '<!DOCTYPE html><html><head>' + SHELL_HEAD +
        '<style>html,body{margin:0;padding:0;font:14px system-ui}</style>' +
        '<style>' + String(css || '').replace(/<\\//g, '<\\\\/') + '</style>' +
        '</head><body></body></html>';
    });
  };

  // ── instantiate + mount (models design §4) ──
  function instantiate(n, doc, map) {
    var el;
    if (n.kind === 'text') { el = doc.createTextNode(n.text || ''); }
    else if (n.kind === 'comment') { el = doc.createComment(n.text || ''); }
    else {
      el = doc.createElement(n.tag || 'div');
      var attrs = n.attrs || {};
      for (var k in attrs) { if (!/^on/i.test(k)) el.setAttribute(k, attrs[k]); }
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) el.appendChild(instantiate(kids[i], doc, map));
    }
    map.set(n.id, el);
    return el;
  }

  window.__mountTree = function (dom) {
    var doc = fdoc();
    var body = doc.body;
    idMap = new Map();
    while (body.firstChild) body.removeChild(body.firstChild);
    for (var i = body.attributes.length - 1; i >= 0; i--) body.removeAttribute(body.attributes[i].name);
    if ((dom.tag || '').toLowerCase() === 'body') {
      var a = dom.attrs || {};
      for (var k in a) { if (!/^on/i.test(k)) body.setAttribute(k, a[k]); }
      var kids = dom.children || [];
      for (var j = 0; j < kids.length; j++) body.appendChild(instantiate(kids[j], doc, idMap));
      idMap.set(dom.id, body);
    } else {
      body.appendChild(instantiate(dom, doc, idMap));
    }
    return idMap.size;
  };

  // ── patches (models design §5.1) ──
  function applyPatch(p) {
    var node = idMap.get(p.node);
    if (!node) return false;
    if (p.type === 'dom.attr') {
      if (p.value === null) node.removeAttribute(p.name); else node.setAttribute(p.name, p.value);
    } else if (p.type === 'dom.text') {
      // §5.1 dom.text addresses TEXT and COMMENT nodes. Writing textContent on
      // an element instead would delete its subtree — which silently makes the
      // deep-span case CHEAPER than the shallow one, because half the tree is
      // gone by segment 9. (Found by exactly that inversion in the numbers.)
      if (node.nodeType === 3 || node.nodeType === 8) node.nodeValue = p.text;
      else if (node.firstChild && node.firstChild.nodeType === 3) node.firstChild.nodeValue = p.text;
    }
    return true;
  }

  // ── the §8 alignment bundle, and each forced-layout primitive alone ──
  function alignPrimitive(which, ev) {
    var doc = fdoc();
    var node = idMap.get(ev.anchor.node);
    var sink = 0;
    if (which === 'clientWidth' || which === 'all') sink += doc.documentElement.clientWidth + (frame.contentWindow.scrollY || 0);
    if (which === 'gbcr' || which === 'all') { var r = node ? node.getBoundingClientRect() : null; sink += r ? r.width : 0; }
    if (which === 'efp' || which === 'all') {
      var hit = doc.elementFromPoint(ev.x, ev.y);
      var walk = 0;
      while (hit && walk < 6) { if (hit === node) break; hit = hit.parentElement; walk++; }
      sink += walk;
    }
    if (which === 'stage' || which === 'all') { var sr = frame.getBoundingClientRect(); sink += sr.width; }
    return sink;
  }

  /**
   * Per-anchored-event alignment cost. In DIRTY mode an attribute is written
   * before each check, which is what a real seek does (patches interleave with
   * events), so every check forces a fresh style+layout pass. CLEAN mode
   * leaves layout valid and measures only the read.
   */
  window.__alignCost = function (which, events, dirty) {
    var sink = 0;
    var t0 = performance.now();
    for (var i = 0; i < events.length; i++) {
      if (dirty) {
        // A REAL patch, not a no-op marker: dom.attr on class (CSS may match
        // it) plus dom.text (which always dirties layout). This is the
        // interleaving a seek actually produces.
        var n = idMap.get(events[i].anchor.node);
        if (n && n.setAttribute) {
          n.setAttribute('class', 'probe-' + (i % 5));
          if (n.firstChild && n.firstChild.nodeType === 3) n.firstChild.nodeValue = 'probe ' + i;
        }
      }
      sink += alignPrimitive(which, events[i]);
    }
    var ms = performance.now() - t0;
    window.__sink = sink;
    return ms;
  };

  window.__patchCost = function (patches) {
    var t0 = performance.now();
    for (var i = 0; i < patches.length; i++) applyPatch(patches[i]);
    return performance.now() - t0;
  };

  window.__mountCost = function (dom) {
    var t0 = performance.now();
    var n = window.__mountTree(dom);
    // Force layout so the mount cost includes what the very next read pays.
    void fdoc().documentElement.clientHeight;
    return { ms: performance.now() - t0, nodes: n };
  };

  // ── canvas: parent-owned offscreen composite + background-image present ──
  function offscreenFor(key, w, h) {
    if (!offscreens[key]) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      offscreens[key] = c; chains[key] = Promise.resolve();
    }
    return offscreens[key];
  }
  function composite(key, dataUrl, region, w, h) {
    var off = offscreenFor(key, w, h);
    chains[key] = chains[key].then(function () {
      var img = new Image();
      img.src = dataUrl;
      var ready = img.decode ? img.decode() : new Promise(function (res, rej) { img.onload = res; img.onerror = rej; });
      return ready.then(function () {
        var ctx = off.getContext('2d');
        if (!region) { ctx.clearRect(0, 0, off.width, off.height); ctx.drawImage(img, 0, 0); }
        else { ctx.drawImage(img, region.x, region.y); }
      });
    });
    touched[key] = true;
  }
  function presentTouched() {
    var urls = 0;
    for (var key in touched) {
      var el = idMap.get(Number(key));
      if (!el) continue;
      var url = offscreens[key].toDataURL('image/png');
      urls += url.length;
      el.style.backgroundImage = 'url(' + url + ')';
      el.style.backgroundSize = '100% 100%';
      el.style.backgroundRepeat = 'no-repeat';
    }
    touched = Object.create(null);
    return urls;
  }
  function settled() {
    var ps = [];
    for (var k in chains) ps.push(chains[k]);
    return Promise.all(ps);
  }
  window.__resetCanvas = function () { offscreens = Object.create(null); chains = Object.create(null); touched = Object.create(null); };

  /**
   * The restore under measurement (design §5 step order, modelled):
   *   mount the span keyframe -> apply segments spanStart..i in order.
   * Returns syncMs (the synchronous walk, which is what blocks the main
   * thread) and settledMs (through canvas decode + presentation, which is what
   * a caller awaiting canvasSettled() waits for).
   */
  window.__restore = function (segments, toSegment, opts) {
    window.__resetCanvas();
    var t0 = performance.now();
    window.__mountTree(segments[0].initial_dom);
    var checks = 0, patches = 0, canvases = 0, sink = 0;
    for (var s = 0; s <= toSegment; s++) {
      var evs = segments[s].events;
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        if (e.type === 'dom.attr' || e.type === 'dom.text') { applyPatch(e); patches++; }
        else if (e.type === 'canvas.snapshot') {
          if (opts.canvas) { composite(e.node, e.data_url, e.region || null, 400, 300); canvases++; }
        } else if (e.anchor && opts.checks) { sink += alignPrimitive('all', e); checks++; }
      }
    }
    var syncMs = performance.now() - t0;
    window.__sink = sink;
    return settled().then(function () {
      var presented = opts.canvas ? presentTouched() : 0;
      void fdoc().documentElement.clientHeight;   // force the present to lay out
      return { syncMs: syncMs, settledMs: performance.now() - t0, checks: checks, patches: patches, canvases: canvases, presentedUrlChars: presented };
    });
  };
})();
<\/script></body></html>`;
}

// ── driver ─────────────────────────────────────────────────────────────────

const out = { config: CFG, engines: {} };
let failures = 0;
const fail = (msg) => { failures++; console.error('  ✖ ' + msg); };

function stat(xs) { return { n: xs.length, median: median(xs), p95: p95(xs), min: minOf(xs) }; }
const show = (s, unit = 'ms') => `median ${fixed(s.median)} ${unit} (p95 ${fixed(s.p95)}, min ${fixed(s.min)}, n=${s.n})`;

async function runEngine(name, browser, origin) {
  console.log(`\n════ ${name} ════`);
  const res = {};
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => fail(`[${name}] pageerror: ${e.message}`));

  // ── FLOOR + V1 ──────────────────────────────────────────────────────────
  await page.goto(`${origin}/v1.html`, { waitUntil: 'load' });
  const clock = await page.evaluate(() => window.__clockGranularity(200000));
  console.log(`\n── FLOOR ──`);
  console.log(`  crossOriginIsolated: ${clock.isolated}; performance.now() min delta ${fixed(clock.minDelta, 4)} ms`);
  res.clock = clock;

  const wrapper = [];
  for (let i = 0; i < 2000; i++) wrapper.push(await page.evaluate(() => window.__seekNoop()));
  res.instrumentFloor = stat(wrapper);
  console.log(`  timing-wrapper floor (in-page):      ${show(res.instrumentFloor)}`);

  const rt = [];
  for (let i = 0; i < 200; i++) { const t0 = performance.now(); await page.evaluate(() => 0); rt.push(performance.now() - t0); }
  res.playwrightRoundTrip = stat(rt);
  console.log(`  Playwright evaluate round trip:      ${show(res.playwrightRoundTrip)}`);

  const raf = [];
  for (let i = 0; i < 40; i++) raf.push(await page.evaluate(() => window.__rafFloor()));
  res.rafFloor = stat(raf);
  console.log(`  one animation frame (settled floor): ${show(res.rafFloor)}`);

  // v1 seek baseline over SMOKE-19NRQR. Trial 2 is the busiest (368 events,
  // 16.9 s). Forward and backward are INTERLEAVED so a drift in machine load
  // hits both arms equally (T3's method correction).
  await page.evaluate(() => window.__selectTrial(2));
  await page.waitForTimeout(300);
  const fwd = [], bwd = [], noop = [];
  const T_LO = 2000, T_HI = 14000;
  for (let i = 0; i < CFG.seekSamples; i++) {
    await page.evaluate((t) => window.__seekSettled(t), T_LO);
    fwd.push(await page.evaluate((t) => window.__seekSettled(t), T_HI));
    noop.push(await page.evaluate((t) => window.__seekSettled(t), T_HI));   // same target: cheapest real seek
    bwd.push(await page.evaluate((t) => window.__seekSettled(t), T_LO));
  }
  const arm = (xs) => ({
    sync: stat(xs.map((x) => x.syncMs)), settled: stat(xs.map((x) => x.settledMs)),
    asyncCount: xs.filter((x) => x.wentAsync).length, n: xs.length,
  });
  res.v1 = { forward: arm(fwd), backward: arm(bwd), repeatSameTarget: arm(noop) };
  console.log(`\n── V1 CONTROL (SMOKE-19NRQR trial 2, 368 events, v1 viewer) ──`);
  for (const [label, a] of Object.entries(res.v1)) {
    console.log(`  ${label.padEnd(20)} sync ${show(a.sync)}`);
    console.log(`  ${''.padEnd(20)} settled ${show(a.settled)}  [async ${a.asyncCount}/${a.n}]`);
  }
  console.log(`  (forward ${T_LO}->${T_HI} ms; backward ${T_HI}->${T_LO} ms; repeat = second seek to ${T_HI})`);

  // ── PRIM / ALIGN / SPAN ─────────────────────────────────────────────────
  await page.goto(`${origin}/model.html`, { waitUntil: 'load' });
  const recordingCss = (jspsychFull.stylesheets || []).map((s) => s.css || '').join('\n');
  await page.evaluate((css) => window.__shell(css), recordingCss);

  const trees = {
    'jspsych-full seg11 (535 nodes, real)': jspsychFull.segments[11].initial_dom,
    'synthetic 200': syntheticTree(200),
    'synthetic 2000': syntheticTree(2000),
  };

  console.log(`\n── PRIM: keyframe mount (script-less same-origin iframe, production CSP,`);
  console.log(`         ${recordingCss.length} chars of the recording's real stylesheet in the shell) ──`);
  res.mount = {};
  for (const [label, tree] of Object.entries(trees)) {
    const xs = [];
    let nodes = 0;
    for (let r = 0; r <= CFG.runs; r++) {
      const m = await page.evaluate((t) => window.__mountCost(t), tree);
      if (r) xs.push(m.ms);
      nodes = m.nodes;
    }
    res.mount[label] = { ...stat(xs), nodes, treeNodes: countNodes(tree) };
    console.log(`  ${label.padEnd(38)} ${show(res.mount[label])}  [${nodes} mapped]`);
  }

  // Patch application, on the 535-node real tree.
  const realTree = trees['jspsych-full seg11 (535 nodes, real)'];
  const realIds = collectElementIds(realTree).filter((i) => i !== realTree.id);
  const mkPatches = (k) => Array.from({ length: k }, (_, i) => (i % 2
    ? { type: 'dom.attr', node: realIds[i % realIds.length], name: 'class', value: 'p' + (i % 7) }
    : { type: 'dom.text', node: realIds[i % realIds.length], text: 'x' + i }));
  console.log(`\n── PRIM: dom.attr/dom.text application (535-node tree) ──`);
  res.patches = {};
  for (const k of [1000, 4000]) {
    const patches = mkPatches(k);
    const xs = [];
    for (let r = 0; r <= CFG.runs; r++) {
      await page.evaluate((t) => window.__mountTree(t), realTree);
      const ms = await page.evaluate((p) => window.__patchCost(p), patches);
      if (r) xs.push(ms);
    }
    res.patches[k] = stat(xs);
    console.log(`  ${String(k).padStart(4)} patches:                        ${show(res.patches[k])}   (${fixed(res.patches[k].median / k, 5)} ms each)`);
  }

  // ── ALIGN: the driver §11 named wrongly ────────────────────────────────
  console.log(`\n── ALIGN: §8 check cost per anchored event (the §11 amendment's driver) ──`);
  res.align = {};
  const N_ALIGN = 500;
  for (const [treeLabel, tree] of Object.entries(trees)) {
    const ids = collectElementIds(tree).filter((i) => i !== tree.id);
    const alignEvents = Array.from({ length: N_ALIGN }, (_, i) => ({
      x: 40 + (i % 1200), y: 40 + (i % 900),
      anchor: { node: ids[(i * 13) % ids.length] },
    }));
    console.log(`  [${treeLabel}]`);
    for (const which of ['clientWidth', 'gbcr', 'efp', 'stage', 'all']) {
      for (const dirty of [true, false]) {
        const xs = [];
        for (let r = 0; r <= CFG.runs; r++) {
          await page.evaluate((t) => window.__mountTree(t), tree);
          const ms = await page.evaluate(([w, evs, d]) => window.__alignCost(w, evs, d), [which, alignEvents, dirty]);
          if (r) xs.push(ms / N_ALIGN);
        }
        const key = `${treeLabel} | ${which}/${dirty ? 'dirty' : 'clean'}`;
        res.align[key] = stat(xs);
        console.log(`    ${(which + '/' + (dirty ? 'dirty' : 'clean')).padEnd(22)} ${show(res.align[key])} per event`);
      }
    }
    const d = res.align[`${treeLabel} | all/dirty`].median;
    const c = res.align[`${treeLabel} | all/clean`].median;
    console.log(`    => dirty/clean ${fixed(d / c, 1)}x; 300 ms reached at ${Math.round(300 / d)} anchored events (dirty), ${Math.round(300 / c)} (clean)`);
  }

  // ── SPAN: case (ii) vs case (iii), checks on/off, canvas on/off ─────────
  console.log(`\n── SPAN: synthetic deep-span model (${CFG.spanSegments} segments x ${CFG.eventsPerSegment} events, ` +
              `${Math.round(CFG.anchoredFrac * 100)}% anchored, real jspsych-full canvas payloads) ──`);
  res.span = {};
  for (const canvas of [false, true]) {
    const model = buildDeepSpanModel({
      tree: realTree, segments: CFG.spanSegments, eventsPerSegment: CFG.eventsPerSegment,
      anchoredFrac: CFG.anchoredFrac, canvas,
    });
    for (const checks of [false, true]) {
      // Cases (ii) and (iii) are INTERLEAVED, not blocked, so a drift in
      // machine load lands on both arms of the ratio equally (T3 Task 4/9's
      // method correction, which this ratio is the whole reason for).
      const cases = [['ii (mount + 1 segment)', 0], ['iii (mount + 10 segments)', CFG.spanSegments - 1]];
      const acc = cases.map(() => ({ sync: [], settled: [], meta: null }));
      for (let r = 0; r <= CFG.runs; r++) {
        for (let c = 0; c < cases.length; c++) {
          const m = await page.evaluate(([segs, to, o]) => window.__restore(segs, to, o),
            [model.segments, cases[c][1], { checks, canvas }]);
          if (r) { acc[c].sync.push(m.syncMs); acc[c].settled.push(m.settledMs); }
          acc[c].meta = m;
        }
      }
      cases.forEach(([caseName], c) => {
        const key = `canvas=${canvas ? 'on' : 'off'} checks=${checks ? 'on' : 'off'} case ${caseName}`;
        const meta = acc[c].meta;
        res.span[key] = { sync: stat(acc[c].sync), settled: stat(acc[c].settled), meta };
        console.log(`  ${key}`);
        console.log(`      sync    ${show(res.span[key].sync)}`);
        console.log(`      settled ${show(res.span[key].settled)}   [checks ${meta.checks}, patches ${meta.patches}, canvas ${meta.canvases}, presented ${meta.presentedUrlChars} chars]`);
      });
    }
  }

  // Derived ratio (plan-review item 3, replacing the withdrawn plan-stated 4x)
  console.log(`\n── DERIVED case(iii)/case(ii) ratio ──`);
  res.ratio = {};
  for (const canvas of ['off', 'on']) {
    for (const checks of ['off', 'on']) {
      for (const metric of ['sync', 'settled']) {
        const ii = res.span[`canvas=${canvas} checks=${checks} case ii (mount + 1 segment)`][metric].median;
        const iii = res.span[`canvas=${canvas} checks=${checks} case iii (mount + 10 segments)`][metric].median;
        const key = `canvas=${canvas}/checks=${checks}/${metric}`;
        res.ratio[key] = iii / ii;
        console.log(`  ${key.padEnd(30)} ${fixed(iii / ii, 2)}x   (${fixed(ii)} -> ${fixed(iii)} ms)`);
      }
    }
  }

  // Coverage assertions: a scenario that silently measured nothing must fail.
  const mountKeys = Object.keys(res.mount);
  if (!mountKeys.every((k) => res.mount[k].nodes > 0)) fail(`[${name}] a mount measured 0 nodes`);
  if (!(res.span['canvas=on checks=on case iii (mount + 10 segments)'].meta.canvases === CFG.spanSegments)) {
    fail(`[${name}] deep-span case iii composited ${res.span['canvas=on checks=on case iii (mount + 10 segments)'].meta.canvases} canvases, expected ${CFG.spanSegments}`);
  }
  if (!(res.span['canvas=on checks=on case iii (mount + 10 segments)'].meta.presentedUrlChars > 1000)) {
    fail(`[${name}] deep-span case iii presented nothing`);
  }
  if (!(res.span['canvas=off checks=on case iii (mount + 10 segments)'].meta.checks > 0)) {
    fail(`[${name}] checks=on ran zero alignment checks`);
  }
  if (!(res.span['canvas=off checks=off case iii (mount + 10 segments)'].meta.checks === 0)) {
    fail(`[${name}] checks=off ran alignment checks anyway`);
  }

  await page.close();
  return res;
}

// ── main ───────────────────────────────────────────────────────────────────

const resolved = resolvePlaywright();
if (!resolved) { console.log('SKIP: playwright-core not found'); process.exit(0); }
console.log(`playwright-core ${resolved.version} (via ${resolved.from})`);

const v1Model = buildViewerModel(smokeV1);
console.log(`v1 control model: SMOKE-19NRQR, ${v1Model.trials.length} trials, ` +
  `${v1Model.trials.map((t) => t.events.length).join('/')} events, legacy=${v1Model.legacy}`);
console.log(`deep-span keyframe tree: jspsych-full segment 11, ${countNodes(jspsychFull.segments[11].initial_dom)} nodes`);
const snaps = realCanvasSnapshots();
console.log(`canvas payloads: baseline ${snaps.baseline.data_url.length} chars + ${snaps.regions.length} regions ` +
  `(${snaps.regions.map((r) => r.data_url.length).join(',')})`);

const files = new Map([
  ['/v1.html', v1PageHtml(v1Model)],
  ['/model.html', modelPageHtml()],
]);
const server = await serveFiles(files, { isolate: CFG.isolate });

const engines = await launchEngines(resolved.pw, { only: CFG.engines, headless: CFG.headless });
for (const e of engines) {
  if (!e.ok) { fail(`${e.name} NOT LAUNCHED: ${e.reason}`); continue; }
  try { out.engines[e.name] = await runEngine(e.name, e.browser, server.origin); }
  catch (err) { fail(`${e.name} threw: ${err.stack || err.message}`); }
  finally { await e.browser.close(); }
}
await server.close();

const artifactsDir = join(repoRoot, 'tools', 'investigate', 'artifacts');
mkdirSync(artifactsDir, { recursive: true });
const file = join(artifactsDir, `seek-latency-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nartifact: ${file}`);
console.log(failures ? `FAIL — ${failures} problem(s)` : 'OK — all scenarios measured');
process.exit(failures ? 1 : 0);
