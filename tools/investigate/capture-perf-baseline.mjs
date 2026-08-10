#!/usr/bin/env node
// tools/investigate/capture-perf-baseline.mjs
//
// Capture-side performance baseline for the replay recorder (T3 Task 0 / Task 9).
//
// WHAT IT MEASURES
//   (a) typing burst        — per-keystroke capture overhead over a scripted
//                             N-keystroke burst into a text input
//   (b) mousemove storm     — per-move capture overhead over a scripted
//                             N-point mouse path
//   (c) segment boundary    — wall time of endTrial()+startTrial() (the
//                             initial-DOM snapshot pause), on the page's own
//                             DOM and again on a ~10x-inflated DOM
//
// HOW IT MEASURES (must stay identical pre/post rewrite — this is the whole
// point of committing the script)
//   An init script installed BEFORE any page script wraps three browser
//   primitives: EventTarget.prototype.addEventListener, requestAnimationFrame
//   and MutationObserver. Wrapping is ARMED only while the driver is calling
//   CyborgHunterReplay.attach()/startSession(), so ONLY the recorder's own
//   listeners/observers/rAF callbacks are timed — page code and any other
//   library registered outside the armed window is invisible to the numbers.
//   rAF callbacks scheduled from inside a timed handler inherit its
//   attribution, so the recorder's rAF-coalesced flushes (input, scroll,
//   resize, visualViewport, touchmove) are counted too.
//
//   Each timed invocation records {source, channel, type, dur, t0, gid}
//   (gid = per-Event id, so several listeners on one event can be summed).
//   Scenario (c) is timed directly around the public startTrial/endTrial
//   calls — no wrapper involved.
//
//   The page is served over http with COOP+COEP so the renderer is
//   crossOriginIsolated: that lifts performance.now()'s Spectre clamp from
//   100 us to 5 us, which is the difference between usable and useless at
//   the scale of a single event handler. The harness measures and reports
//   the clock granularity it actually got, plus an instrument floor (an
//   empty wrapped listener dispatched thousands of times) so the recorder's
//   numbers can be read net of the wrapper's own cost.
//
// USAGE
//   node build.js                       # numbers describe dist/, so build first
//   node tools/investigate/capture-perf-baseline.mjs
//   node tools/investigate/capture-perf-baseline.mjs --runs=5 --keys=200 \
//        --moves=2000 --boundaries=25 --page=tests/browser/replay/battery-page.html
//
// Exit code is 0 unless the browser is missing (skip, also 0) or a scenario
// blew up (1). Run-to-run p95 spread is reported; > --noise-max (default 3x)
// is flagged NOISY in the output so nobody records junk numbers.

import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, relative, sep } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// ── options ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, dflt) {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  if (hit === '--' + name) return true;
  const raw = hit.slice(name.length + 3);
  return typeof dflt === 'number' ? Number(raw) : raw;
}
const CFG = {
  page: String(opt('page', 'tests/browser/replay/demo-standalone.html')),
  tier: String(opt('tier', 'dom')),            // asserted back off rec.config
  runs: Number(opt('runs', 3)),
  keys: Number(opt('keys', 200)),
  keyDelay: Number(opt('key-delay', 10)),      // ms between keystrokes
  input: String(opt('input', 'input[type=text], input:not([type]), textarea')),
  moves: Number(opt('moves', 2000)),
  moveSegments: Number(opt('move-segments', 20)),
  boundaries: Number(opt('boundaries', 25)),
  inflate: Number(opt('inflate', 10)),         // target node-count multiple
  headed: !!opt('headed', false),
  noiseMax: Number(opt('noise-max', 3)),
  out: String(opt('out', '')),
};

// ── playwright-core resolution (same ladder as run-replay-tests.mjs) ────────
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
  console.log('SKIP: playwright-core not found (set PLAYWRIGHT_CORE_DIR or npm i -D playwright-core)');
  process.exit(0);
}
const { chromium } = pw;

// ── static server: COOP+COEP so the renderer is crossOriginIsolated ─────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};
async function startServer() {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const abs = resolve(repoRoot, '.' + urlPath);
    const rel = relative(repoRoot, abs);
    if (rel.startsWith('..' + sep) || rel === '..') { res.writeHead(403).end('no'); return; }
    try {
      const body = await readFile(abs);
      res.writeHead(200, {
        'content-type': MIME[extname(abs)] || 'application/octet-stream',
        'cache-control': 'no-store',
        // crossOriginIsolated ⇒ performance.now() granularity 5us, not 100us.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

// ═══════════════════════════════════════════════════════════════════════════
// IN-PAGE INSTRUMENTATION (serialized into the page before any page script)
// ═══════════════════════════════════════════════════════════════════════════
function installInstrumentation() {
  if (window.__CHPERF) return;

  var records = [];          // {src, ch, type, dur, t0, gid}
  var currentSource = null;  // dynamic attribution for nested rAF scheduling
  var gidSeq = 0;
  var eventGid = new WeakMap();
  var wrapMap = new WeakMap();

  var P = {
    armLabel: null,          // set by the driver around recorder setup
    reset: function () { records = []; },
    take: function () { return records; },
    count: function () { return records.length; },
  };
  function push(src, ch, type, t0, t1, gid) {
    records.push({ src: src, ch: ch, type: type, dur: t1 - t0, t0: t0, gid: gid });
  }

  // 1. listeners ------------------------------------------------------------
  var nativeAdd = EventTarget.prototype.addEventListener;
  var nativeRemove = EventTarget.prototype.removeEventListener;
  function keyOf(type, opts) {
    var capture = opts === true || (opts && opts.capture) ? 'c' : 'b';
    return type + '|' + capture;
  }
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (!P.armLabel || typeof fn !== 'function') {
      return nativeAdd.call(this, type, fn, opts);
    }
    var src = P.armLabel;
    var m = wrapMap.get(fn);
    if (!m) { m = new Map(); wrapMap.set(fn, m); }
    var k = keyOf(type, opts);
    var wrapped = m.get(k);
    if (!wrapped) {
      wrapped = function (ev) {
        var gid = null;
        if (ev && typeof ev === 'object') {
          gid = eventGid.get(ev);
          if (gid === undefined) { gid = ++gidSeq; eventGid.set(ev, gid); }
        }
        var prev = currentSource; currentSource = src;
        var t0 = performance.now();
        try { return fn.apply(this, arguments); }
        finally {
          var t1 = performance.now();
          currentSource = prev;
          push(src, 'listener', type, t0, t1, gid);
        }
      };
      m.set(k, wrapped);
    }
    return nativeAdd.call(this, type, wrapped, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (typeof fn === 'function') {
      var m = wrapMap.get(fn);
      var wrapped = m && m.get(keyOf(type, opts));
      if (wrapped) nativeRemove.call(this, type, wrapped, opts);
    }
    return nativeRemove.call(this, type, fn, opts);
  };

  // 2. requestAnimationFrame (the recorder's coalesced flushes) --------------
  var nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    var src = currentSource || P.armLabel;
    if (!src || typeof cb !== 'function') return nativeRaf(cb);
    return nativeRaf(function (ts) {
      var prev = currentSource; currentSource = src;
      var t0 = performance.now();
      try { return cb(ts); }
      finally {
        var t1 = performance.now();
        currentSource = prev;
        push(src, 'raf', 'raf-flush', t0, t1, null);
      }
    });
  };

  // 3. MutationObserver (DOM capture callback) ------------------------------
  var NativeMO = window.MutationObserver;
  function WrappedMO(cb) {
    var src = P.armLabel;
    if (!src || typeof cb !== 'function') return new NativeMO(cb);
    return new NativeMO(function (recs, obs) {
      var prev = currentSource; currentSource = src;
      var t0 = performance.now();
      try { return cb(recs, obs); }
      finally {
        var t1 = performance.now();
        currentSource = prev;
        push(src, 'observer', 'mutation', t0, t1, null);
      }
    });
  }
  WrappedMO.prototype = NativeMO.prototype;
  window.MutationObserver = WrappedMO;

  // 4. controls -------------------------------------------------------------
  // Effective clock granularity: smallest non-zero performance.now() delta.
  P.clockGranularity = function (n) {
    var min = Infinity, last = performance.now();
    for (var i = 0; i < (n || 200000); i++) {
      var t = performance.now();
      var d = t - last;
      if (d > 0 && d < min) min = d;
      last = t;
    }
    return min === Infinity ? null : min;
  };
  // Instrument floor: an EMPTY wrapped listener, dispatched n times. Whatever
  // this costs is wrapper overhead present in every other number below.
  P.instrumentFloor = function (n) {
    var host = document.createElement('div');
    var before = records.length;
    P.armLabel = '__floor__';
    host.addEventListener('chfloor', function () {});
    P.armLabel = null;
    for (var i = 0; i < (n || 2000); i++) host.dispatchEvent(new Event('chfloor'));
    var out = records.slice(before).map(function (r) { return r.dur; });
    records.length = before;
    return out;
  };
  P.crossOriginIsolated = !!window.crossOriginIsolated;

  // 5. schema-agnostic segment index ---------------------------------------
  // Finds every segment-ish object in a serialized recording and reports
  // whether it carries a DOM snapshot. Deliberately keyed on the ONE field
  // name the v1 and v2 wire formats share (`initial_dom`): v1 puts an HTML
  // string there, v2 a DomNode tree, and v2 continuation segments put null.
  // Segment identity is read from whichever of trial_id/label/segment_id/id
  // holds a string, which covers v1's trial_id and v2's label.
  P.segmentIndex = function (recording) {
    var out = [];
    var seen = new Set();
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(node, 'initial_dom')) {
        var id = null;
        var idKeys = ['trial_id', 'label', 'segment_id', 'id'];
        for (var k = 0; k < idKeys.length; k++) {
          if (typeof node[idKeys[k]] === 'string') { id = node[idKeys[k]]; break; }
        }
        var d = node.initial_dom;
        var bytes = 0, has = false;
        if (typeof d === 'string') { bytes = d.length; has = bytes > 0; }
        else if (d && typeof d === 'object') {
          try { bytes = JSON.stringify(d).length; } catch (e) { bytes = -1; }
          has = Object.keys(d).length > 0;
        }
        out.push({ id: id, hasSnapshot: has, bytes: bytes });
      }
      for (var key in node) {
        // never descend INTO a snapshot: v2's node tree is deep and it holds
        // no segments of its own.
        if (key !== 'initial_dom' && Object.prototype.hasOwnProperty.call(node, key)) {
          walk(node[key], depth + 1);
        }
      }
    })(recording, 0);
    return out;
  };

  window.__CHPERF = P;
}

// ═══════════════════════════════════════════════════════════════════════════
// IN-PAGE DRIVER HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// Attach the recorder under test with the wrapper ARMED, so exactly its own
// listeners/observer/rAF work is attributed. Public API only — survives the
// v1→v2 rewrite untouched.
function pageSetupRecorder(wantTier) {
  window.__CHPERF.armLabel = 'replay';
  var rec = window.CyborgHunterReplay.attach({
    participantId: 'PERF-BASELINE',
    tier: wantTier,
    autoSave: { mode: 'none' },
    root: document.body,
  });
  rec.startSession();
  rec.startTrial({ trialId: 'perf-trial-1', plugin: 'ch:perf' });
  window.__CHPERF.armLabel = null;
  window.__REC = rec;

  // COVERAGE ASSERTIONS. attach() validates none of its config, so a renamed
  // tier token silently downgrades capture and every number below collapses
  // toward zero while the harness still exits 0. Both checks below turn that
  // class of failure into a hard error.
  var gotTier = rec.config && rec.config.tier;
  if (gotTier !== wantTier) {
    throw new Error('tier not honoured: asked ' + wantTier + ', rec.config.tier is ' + gotTier
      + ' — DOM capture is probably not attached, so the numbers would be meaningless');
  }
  var segs = window.__CHPERF.segmentIndex(rec.getRecording())
    .filter(function (s) { return s.id === 'perf-trial-1'; });
  if (!segs.length) {
    throw new Error('no segment named perf-trial-1 in the recording — segment identity field changed?');
  }
  if (!segs[0].hasSnapshot) {
    throw new Error('first segment carries no initial DOM snapshot (bytes=' + segs[0].bytes
      + ') — DOM capture is not running, scenario (c) would measure nothing');
  }

  return {
    nodes: countNodes(),
    bodyBytes: document.body.innerHTML.length,
    snapshotBytes: segs[0].bytes,
    tier: gotTier,
  };
  function countNodes() {
    var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ALL);
    var c = 1;
    while (w.nextNode()) c++;
    return c;
  }
}

// Scenario (c): time the public segment boundary directly, then classify each
// iteration by whether its segment actually emitted a snapshot.
//
// This classification is what makes the row comparable across the rewrite. v1
// snapshots every trial start, so all N iterations are keyframes. v2's cadence
// (Task 8) keyframes only some of them on the standalone path these pages
// drive, and a continuation boundary skips the serializer entirely. Pooling
// the two populations would put p95 on whichever kind happens to sit at rank
// ceil(0.95N), so keyframe and continuation are reported apart and the budget
// gates the keyframe subset.
function pageBoundaryLoop(args) {
  var rec = window.__REC;
  var n = args.n, prefix = args.prefix;
  var timings = [];
  for (var i = 0; i < n; i++) {
    var t0 = performance.now();
    rec.endTrial();
    var t1 = performance.now();
    rec.startTrial({ trialId: prefix + i, plugin: 'ch:perf' });
    var t2 = performance.now();
    timings.push({ end: t1 - t0, start: t2 - t1, total: t2 - t0 });
  }
  var byId = new Map();
  window.__CHPERF.segmentIndex(rec.getRecording()).forEach(function (s) {
    if (s.id != null) byId.set(s.id, s);
  });
  for (var j = 0; j < n; j++) {
    var seg = byId.get(prefix + j);
    timings[j].keyframe = seg ? !!seg.hasSnapshot : null;
    timings[j].snapshotBytes = seg ? seg.bytes : null;
  }
  return timings;
}

// Inflate the DOM to ~mult x its node count with structurally ordinary
// content (nested divs + spans + text), appended in one shot so the
// inflation itself is a single mutation batch outside any measured window.
function pageInflateDom(mult) {
  function countNodes() {
    var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ALL);
    var c = 1;
    while (w.nextNode()) c++;
    return c;
  }
  var before = countNodes();
  var beforeBytes = document.body.innerHTML.length;
  var target = before * mult;
  var host = document.createElement('div');
  host.id = 'perf-inflate';
  var perBlock = 6; // div + span + text + span + text + text
  var blocks = Math.ceil((target - before) / perBlock);
  for (var i = 0; i < blocks; i++) {
    var row = document.createElement('div');
    row.className = 'perf-row';
    row.setAttribute('data-idx', String(i));
    var k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'field ' + i;
    var v = document.createElement('span');
    v.className = 'v';
    v.textContent = 'value ' + (i * 7919 % 1000);
    row.appendChild(k);
    row.appendChild(v);
    row.appendChild(document.createTextNode(' row ' + i));
    host.appendChild(row);
  }
  document.body.appendChild(host);
  return {
    before: before, after: countNodes(),
    beforeBytes: beforeBytes, afterBytes: document.body.innerHTML.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════
function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}
function stats(vals) {
  const s = vals.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    mean: s.length ? sum / s.length : null,
    p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99),
    max: s.length ? s[s.length - 1] : null,
    total: sum,
  };
}
const ms = (v) => (v == null ? '—' : v.toFixed(3));

// Per-unit overhead: sum every timed invocation that falls in the window
// opened by one boundary-type handler call and closed by the next, so
// coalesced rAF work lands in the unit that caused it. Used for BOTH input
// scenarios: filtering on a single event type instead would silently drop
// whatever a future recorder moves into a flush.
//
// `expect` is a coverage assertion, not decoration: if the recorder stops
// registering the boundary listener, `starts` empties, every downstream stat
// becomes an empty array, and p95 arrives as -Infinity through Math.max.
// Failing here converts that into an exit-1.
function windowSums(records, boundaryType, expect) {
  const byT0 = records.slice().sort((a, b) => a.t0 - b.t0);
  const starts = [];
  for (const r of byT0) if (r.ch === 'listener' && r.type === boundaryType) starts.push(r.t0);
  if (expect && !expect.check(starts.length)) {
    throw new Error('coverage assertion failed for ' + boundaryType + ': saw ' + starts.length
      + ' handler calls, ' + expect.describe + ' — the recorder is not capturing this channel');
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const lo = starts[i];
    const hi = i + 1 < starts.length ? starts[i + 1] : Infinity;
    let sum = 0;
    for (const r of byT0) if (r.t0 >= lo && r.t0 < hi) sum += r.dur;
    out.push(sum);
  }
  return out;
}
function byType(records) {
  const m = new Map();
  for (const r of records) {
    const k = r.ch + '/' + r.type;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r.dur);
  }
  const out = {};
  for (const [k, v] of m) out[k] = stats(v);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE RUN
// ═══════════════════════════════════════════════════════════════════════════
async function runOnce(browser, baseUrl, runIdx) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.addInitScript(installInstrumentation);
  await page.goto(baseUrl + '/' + CFG.page, { waitUntil: 'load' });

  const env = await page.evaluate(() => ({
    isolated: window.__CHPERF.crossOriginIsolated,
    granularity: window.__CHPERF.clockGranularity(200000),
    ua: navigator.userAgent,
  }));
  // Measuring the clock and then ignoring what it says would be theatre: at
  // the 100us Spectre clamp these handlers are sub-tick and every row reads 0.
  if (!env.isolated) {
    throw new Error('renderer is not crossOriginIsolated — performance.now() is clamped to 100us '
      + 'and the handler timings would be meaningless. Check the COOP/COEP headers.');
  }
  if (!(env.granularity > 0) || env.granularity > 0.01) {
    throw new Error('clock granularity ' + env.granularity + ' ms is too coarse (need <= 0.01 ms)');
  }
  const floor = stats(await page.evaluate(() => window.__CHPERF.instrumentFloor(3000)));

  const dom0 = await page.evaluate(pageSetupRecorder, CFG.tier);

  // ── (a) typing burst ─────────────────────────────────────────────────────
  // The focus target must be on the FULL capture path. Both v1 and v2 record
  // redacted fields through a shorter branch (no value, no marker ref), so a
  // selector that lands on one reads low and flatters the recorder.
  await page.evaluate((sel) => {
    var el = document.querySelector(sel);
    if (!el) throw new Error('no text input matching ' + sel);
    if (el.type === 'password') {
      throw new Error('focus target ' + sel + ' is a password field — always redacted, '
        + 'so it measures the cheap path. Pass --input pointing at an ordinary field.');
    }
    if (el.closest('[data-ch-redact]')) {
      throw new Error('focus target ' + sel + ' sits inside a [data-ch-redact] subtree — '
        + 'measures the redacted path. Pass --input pointing at an ordinary field.');
    }
    el.focus();
    if (document.activeElement !== el) throw new Error('focus target did not take focus');
    window.__CHPERF.reset();
  }, CFG.input);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ';
  const t0Type = Date.now();
  for (let i = 0; i < CFG.keys; i++) {
    await page.keyboard.press(alphabet[i % alphabet.length] === ' ' ? 'Space' : alphabet[i % alphabet.length]);
    if (CFG.keyDelay) await page.waitForTimeout(CFG.keyDelay);
  }
  const typeWall = Date.now() - t0Type;
  await page.waitForTimeout(50); // let the last rAF flush land
  const typeRecords = await page.evaluate(() => window.__CHPERF.take().slice());
  const perKeystroke = windowSums(typeRecords, 'keydown', {
    check: (n) => n === CFG.keys,
    describe: 'expected exactly ' + CFG.keys,
  });
  const typing = {
    perKeystroke: stats(perKeystroke),
    byType: byType(typeRecords),
    invocations: typeRecords.length,
    keystrokes: perKeystroke.length,
    wallMs: typeWall,
  };

  // ── (b) mousemove storm ──────────────────────────────────────────────────
  // Prime the pointer BEFORE resetting, so the priming move is not counted.
  const stepsPerSeg = Math.max(1, Math.round(CFG.moves / CFG.moveSegments));
  await page.mouse.move(60, 60);
  await page.evaluate(() => window.__CHPERF.reset());
  const t0Move = Date.now();
  for (let i = 0; i < CFG.moveSegments; i++) {
    const x = i % 2 === 0 ? 1180 : 80;
    const y = 80 + ((i * 37) % 620);
    await page.mouse.move(x, y, { steps: stepsPerSeg });
  }
  const moveWall = Date.now() - t0Move;
  await page.waitForTimeout(50);
  const moveRecords = await page.evaluate(() => window.__CHPERF.take().slice());
  const dispatched = CFG.moveSegments * stepsPerSeg;
  // Same window treatment as typing: whatever the recorder does per move,
  // including anything it defers to a rAF flush, is charged to that move.
  const perMove = windowSums(moveRecords, 'mousemove', {
    check: (n) => n >= 0.9 * dispatched,
    describe: 'expected at least ' + Math.round(0.9 * dispatched) + ' of ' + dispatched + ' dispatched',
  });
  // How many of those handler calls actually EMITTED an event (the recorder
  // throttles moves to mouseHz)? Counted schema-agnostically off the serialized
  // recording so the same probe works for v1 "mousemove" and v2 "mouse.move".
  const emittedMoves = await page.evaluate(() => {
    try {
      const json = JSON.stringify(window.__REC.getRecording());
      const m = json.match(/mouse\.?move/g);
      return m ? m.length : 0;
    } catch { return null; }
  });
  const stormTotal = perMove.reduce((a, b) => a + b, 0);
  const storm = {
    perMove: stats(perMove),
    byType: byType(moveRecords),
    dispatched,
    handlerCalls: perMove.length,
    emittedMoves,
    emittedFraction: emittedMoves != null && perMove.length ? emittedMoves / perMove.length : null,
    wallMs: moveWall,
    movesPerSec: perMove.length / (moveWall / 1000),
    // Aggregate normalised PER EMITTED EVENT. The raw total is bounded by wall
    // clock (the 30 Hz throttle emits ~wall/33ms events however many moves the
    // driver manages), so a slow run under load would fail a raw-total gate
    // for reasons that have nothing to do with the recorder.
    totalMs: stormTotal,
    perEmittedMove: emittedMoves ? stormTotal / emittedMoves : null,
  };

  // ── (c) segment boundary, natural DOM then inflated DOM ──────────────────
  await page.evaluate(() => window.__CHPERF.reset());
  const bNatural = await page.evaluate(pageBoundaryLoop,
    { n: CFG.boundaries, prefix: 'perf-boundary-nat-' });
  const inflation = await page.evaluate(pageInflateDom, CFG.inflate);
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__CHPERF.reset());
  const bInflated = await page.evaluate(pageBoundaryLoop,
    { n: CFG.boundaries, prefix: 'perf-boundary-inf-' });

  const split = (rows) => {
    const kf = rows.filter((r) => r.keyframe === true);
    const cont = rows.filter((r) => r.keyframe === false);
    const unknown = rows.filter((r) => r.keyframe == null).length;
    return {
      keyframe: {
        total: stats(kf.map((r) => r.total)),
        startTrial: stats(kf.map((r) => r.start)),
        endTrial: stats(kf.map((r) => r.end)),
      },
      continuation: {
        total: stats(cont.map((r) => r.total)),
        startTrial: stats(cont.map((r) => r.start)),
        endTrial: stats(cont.map((r) => r.end)),
      },
      counts: { keyframe: kf.length, continuation: cont.length, unclassified: unknown },
      snapshotBytes: kf.length ? kf[kf.length - 1].snapshotBytes : null,
    };
  };
  const boundary = {
    natural: split(bNatural),
    inflated: split(bInflated),
    dom: { ...dom0, ...inflation },
  };
  // A boundary the segment index could not classify means the identity field
  // moved; the split would then be silently wrong rather than absent.
  for (const [where, s] of [['natural', boundary.natural], ['inflated', boundary.inflated]]) {
    if (s.counts.unclassified) {
      throw new Error(s.counts.unclassified + ' of ' + CFG.boundaries + ' ' + where
        + ' boundaries could not be matched to a segment — segment identity field changed?');
    }
  }

  await page.close();
  return {
    runIdx, env, floor, typing, storm, boundary, pageErrors,
    loadavg: os.loadavg().map((v) => +v.toFixed(2)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
const { server, port } = await startServer();
const baseUrl = 'http://127.0.0.1:' + port;
const browser = await chromium.launch({
  headless: !CFG.headed,
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const browserVersion = browser.version();

const runs = [];
let failed = false;
try {
  for (let i = 0; i < CFG.runs; i++) {
    process.stdout.write('▶ run ' + (i + 1) + '/' + CFG.runs + ' … ');
    const r = await runOnce(browser, baseUrl, i);
    if (r.pageErrors.length) console.log('\n  ! pageerror: ' + r.pageErrors.join(' | '));
    console.log('done');
    runs.push(r);
  }
} catch (e) {
  failed = true;
  console.error('FAILED: ' + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);

// pooled + spread -----------------------------------------------------------
// `gated` scenarios carry a budget and must have samples in every run.
// `agg` is the per-unit aggregate: quantization-proof, because it sums
// thousands of clock ticks instead of asking p95 to resolve three of them.
const scenarios = {
  'typing-burst (per keystroke)': {
    gated: true, perRun: runs.map((r) => r.typing.perKeystroke),
    agg: runs.map((r) => r.typing.perKeystroke.total / r.typing.keystrokes),
    aggUnit: 'ms/keystroke (' + CFG.keys + '-key burst)',
  },
  'mousemove-storm (per move)': {
    gated: true, perRun: runs.map((r) => r.storm.perMove),
    agg: runs.map((r) => r.storm.perEmittedMove),
    aggUnit: 'ms/emitted move (' + CFG.moves + '-move storm)',
  },
  'boundary natural, keyframe': {
    gated: true, perRun: runs.map((r) => r.boundary.natural.keyframe.total),
  },
  'boundary natural, continuation': {
    gated: false, perRun: runs.map((r) => r.boundary.natural.continuation.total),
  },
  'boundary inflated, keyframe': {
    gated: true, perRun: runs.map((r) => r.boundary.inflated.keyframe.total),
  },
  'boundary inflated, continuation': {
    gated: false, perRun: runs.map((r) => r.boundary.inflated.continuation.total),
  },
};
const summary = {};
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
for (const [name, def] of Object.entries(scenarios)) {
  const perRun = def.perRun;
  const p95s = perRun.map((s) => s.p95).filter((v) => v != null && Number.isFinite(v));
  const p50s = perRun.map((s) => s.p50).filter((v) => v != null && Number.isFinite(v));
  const samplesPerRun = perRun.map((s) => s.n);
  const empty = samplesPerRun.some((n) => !n);
  const lo = p95s.length ? Math.min(...p95s) : null;
  const hi = p95s.length ? Math.max(...p95s) : null;
  const spread = lo > 0 ? hi / lo : null;
  // Enough samples for a p99 to mean anything? At n=25 (the boundary rows)
  // p99 and max are the same single cold-start observation.
  const p99able = samplesPerRun.every((n) => n >= 100);
  const aggs = (def.agg || []).filter((v) => v != null && Number.isFinite(v));
  summary[name] = {
    gated: def.gated, empty,
    perRunP50: p50s, perRunP95: p95s, samplesPerRun,
    p50: med(p50s),
    p95: hi,                       // conservative: worst run's p95
    p95Median: med(p95s), p95Min: lo,
    p99: p99able ? Math.max(...perRun.map((s) => s.p99 ?? 0)) : null,
    max: Math.max(...perRun.map((s) => s.max ?? 0)),
    spread,
    noisy: spread != null && spread > CFG.noiseMax,
    budget: hi == null ? null : hi * 1.25,
    aggUnit: def.aggUnit || null,
    aggPerRun: aggs.length ? aggs : null,
    agg: aggs.length ? Math.max(...aggs) : null,
    aggBudget: aggs.length ? Math.max(...aggs) * 1.25 : null,
  };
}

// HARD VALIDATION. A gated scenario with no samples, or a p95 that is not a
// finite number, means the harness measured nothing — which used to sail
// through as a -Infinity budget and exit 0.
const problems = [];
for (const [name, s] of Object.entries(summary)) {
  if (!s.gated) continue;
  if (s.empty) problems.push(name + ': a run produced 0 samples (n per run: ' + s.samplesPerRun.join(', ') + ')');
  else if (!Number.isFinite(s.p95)) problems.push(name + ': p95 is not finite (' + s.p95 + ')');
  else if (!Number.isFinite(s.budget)) problems.push(name + ': budget is not finite');
}

// report --------------------------------------------------------------------
const machine = {
  platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0] && os.cpus()[0].model,
  cores: os.cpus().length, memGB: +(os.totalmem() / 1e9).toFixed(1),
  node: process.version, loadavg: os.loadavg().map((v) => +v.toFixed(2)),
  chromium: browserVersion, headless: !CFG.headed,
};
console.log('\n══ capture perf baseline ══');
console.log('page              : ' + CFG.page);
console.log('runs              : ' + CFG.runs + '  keys=' + CFG.keys + ' (delay ' + CFG.keyDelay
  + 'ms)  moves=' + CFG.moves + '  boundaries=' + CFG.boundaries + '  inflate=' + CFG.inflate + 'x');
console.log('headless          : ' + (!CFG.headed));
console.log('crossOriginIsolated: ' + runs[0].env.isolated + '   clock granularity: '
  + ms(runs[0].env.granularity) + ' ms');
console.log('instrument floor  : mean ' + ms(runs[0].floor.mean) + '  p50 ' + ms(runs[0].floor.p50)
  + '  p95 ' + ms(runs[0].floor.p95) + ' ms (empty wrapped listener, n=' + runs[0].floor.n + ')');
console.log('DOM               : ' + runs[0].boundary.dom.before + ' nodes natural → '
  + runs[0].boundary.dom.after + ' inflated ('
  + (runs[0].boundary.dom.after / runs[0].boundary.dom.before).toFixed(1) + 'x); body html '
  + runs[0].boundary.dom.beforeBytes + ' → ' + runs[0].boundary.dom.afterBytes + ' bytes');
console.log('machine           : ' + machine.cpu + ' / ' + machine.cores + ' cores / chromium '
  + machine.chromium + ' / load ' + runs.map((r) => r.loadavg[0]).join(', '));
console.log('mouse throttle    : ' + runs[0].storm.handlerCalls + ' handler calls, '
  + runs[0].storm.emittedMoves + ' emitted events ('
  + (runs[0].storm.emittedFraction * 100).toFixed(0) + '%), '
  + Math.round(runs[0].storm.movesPerSec) + ' moves/s wall');
console.log('boundary mix      : natural ' + runs[0].boundary.natural.counts.keyframe + ' keyframe / '
  + runs[0].boundary.natural.counts.continuation + ' continuation;  inflated '
  + runs[0].boundary.inflated.counts.keyframe + ' keyframe / '
  + runs[0].boundary.inflated.counts.continuation + ' continuation  (of ' + CFG.boundaries + ' each)');
console.log('');
console.log('scenario                          n/run  p50(ms)  p95(ms)  p99(ms)  max(ms)  spread  BUDGET p95x1.25');
for (const [name, s] of Object.entries(summary)) {
  const label = name + (s.gated ? '' : ' [info]');
  console.log(
    label.padEnd(32) + '  ' + String(s.samplesPerRun[0] ?? 0).padStart(5) + '  '
    + ms(s.p50).padStart(7) + '  ' + ms(s.p95).padStart(7) + '  '
    + ms(s.p99).padStart(7) + '  ' + ms(s.max).padStart(7) + '  '
    + (s.spread == null ? '—' : s.spread.toFixed(2) + 'x').padStart(6) + '  '
    + (s.gated ? ms(s.budget).padStart(8) : '     n/a')
    + (s.noisy ? '   ⚠ NOISY' : ''));
}
console.log('\naggregate gate (quantization-proof; p95 of the input rows spans ~3 clock ticks):');
for (const [name, s] of Object.entries(summary)) {
  if (s.agg == null) continue;
  console.log('  ' + name.padEnd(32) + ' worst ' + ms(s.agg) + '  BUDGET ' + ms(s.aggBudget)
    + '  ' + s.aggUnit);
}
console.log('\nper-run p95: ');
for (const [name, s] of Object.entries(summary)) {
  console.log('  ' + name.padEnd(32) + ' ' + (s.perRunP95.length ? s.perRunP95.map((v) => ms(v)).join('  ') : '—'));
}
console.log('\nchannel breakdown (run 1):');
for (const [label, bt] of [['typing', runs[0].typing.byType], ['mousemove', runs[0].storm.byType]]) {
  for (const [k, s] of Object.entries(bt)) {
    console.log('  ' + (label + ' ' + k).padEnd(30) + ' n=' + String(s.n).padStart(5)
      + '  p50 ' + ms(s.p50) + '  p95 ' + ms(s.p95) + '  total ' + ms(s.total));
  }
}
console.log('\nkeyframe boundary is all startTrial (worst run): startTrial p95 '
  + ms(Math.max(...runs.map((r) => r.boundary.natural.keyframe.startTrial.p95 ?? 0))) + ' ms natural / '
  + ms(Math.max(...runs.map((r) => r.boundary.inflated.keyframe.startTrial.p95 ?? 0))) + ' ms inflated;'
  + ' endTrial p95 ' + ms(Math.max(...runs.map((r) => r.boundary.inflated.keyframe.endTrial.p95 ?? 0))) + ' ms');

const anyNoisy = Object.values(summary).some((s) => s.noisy);
if (anyNoisy) console.log('\n⚠ run-to-run p95 spread exceeds ' + CFG.noiseMax + 'x — treat as NOISY, do not record as budget.');
if (problems.length) {
  console.error('\n✖ COVERAGE FAILURE — these gated scenarios measured nothing:');
  for (const p of problems) console.error('    ' + p);
  console.error('  Numbers above are not a baseline. Fix the harness or the recorder first.');
}

// artifact ------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = CFG.out || join(repoRoot, 'tools', 'investigate', 'artifacts',
  'capture-perf-baseline-' + stamp + '.json');
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ config: CFG, machine, summary, runs, problems }, null, 2));
console.log('\nartifact: ' + outPath);

if (problems.length) process.exit(1);
