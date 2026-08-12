// tests/browser/replay/seek-budget.battery.mjs
// The seek-latency BUDGET GATE — design §11, T5 (A2) Task 9.
//
// Task 0 measured a MODEL of the restore and reported. This measures the REAL
// shipped viewer and GATES: a cell over its ceiling, or a ratio over its band,
// is a non-zero exit code. Nothing here is product code; nothing here reaches
// `src/`.
//
// ── WHAT IS GATED (design §11, as amended) ────────────────────────────────
//   case (i)   forward seek inside the applied span            median <= 100 ms
//   case (ii)  backward seek inside the span's KEYFRAME segment
//              (= mount + one segment's events)                median <= 100 ms
//   case (iii) backward seek in the 9th continuation of a span
//              (= mount + ten segments' events)                median <= 300 ms
//   ratio      case(iii)/case(ii) on canvas=off/checks=on/SYNC     <= 8.0x
//
// ── THE FIVE RULES THE GATE FOLLOWS (Task-0 amendment, plan Task 9) ───────
//   1. THE RATIO IS GATED ON ONE CELL, `canvas=off / checks=on / sync`, and is
//      RE-DERIVED here on this task's own fixtures. Task 0's 4.99x and Task
//      1's 4.84x are both inherited by NOTHING: the band is stated in the plan
//      (<= 8x) and the value is measured fresh, over --runs samples, on two
//      fixtures whose mount:events split is printed beside it. checks-off sits
//      at the mount-dominated pole and canvas-on settled cells are dominated
//      by a fixed presentation charge both cases pay, so a ratio there
//      measures the PNG encoder.
//   2. SETTLED TO SETTLED, OR SYNC TO SYNC — NEVER ACROSS, and each number
//      says whether it carries an animation frame. Three metrics per seek:
//        syncMs         the synchronous restore + walk + redraw (no frame)
//        settledMs      + await canvasSettled()  (a promise chain; NO frame)
//        settledFrameMs + one requestAnimationFrame (CARRIES the frame floor)
//      v1's control reports syncMs and settledFrameMs, because v1's backward
//      seek finishes in an `onload` handler. The v1-vs-v2 comparison uses
//      settledFrameMs on BOTH sides. The gate uses syncMs and settledMs.
//      settledMs's freedom from the frame is ASSERTED (the FRAME FREEDOM block
//      at the end of every engine, and `--inject=frame-in-settled` is its
//      biting test) — the first version of this file claimed the assertion in
//      this comment and never made it, which is T5.0's C-1 class exactly.
//   3. NO SETTLED-TIME GATE ON WEBKIT. Headless WebKit's animation frame is
//      ~32.4 ms, above most restores measured anywhere, so a gate over a
//      frame-carrying number passes nearly anything there. `settledFrameMs` is
//      therefore REPORT-ONLY on every engine — it is never a gate — and WebKit
//      is gated on `syncMs` and on the frame-free `settledMs`, whose freedom
//      from the frame floor is asserted, not assumed (FLOOR check below).
//   4. TIMING STAYS IN-PAGE. Every number comes from `performance.now()`
//      inside `page.evaluate`; a Node-side wrapper costs 0.2-0.4 ms, which is
//      a large fraction of a case-(ii) restore. The page is served over HTTP
//      with COOP+COEP so `performance.now()` loses its 100 us Spectre clamp.
//   5. THIS IS THE REAL-IMPLEMENTATION RE-BASELINE. Task 0's model did not
//      carry `input.*`, `scroll.*`, `stylesheet.*`, `fullscreen.*`,
//      `visibility.*`, `focus`/`blur`, `clipboard.*`, `initial_state` seeding,
//      `stylesheet_events` replay, §12 instantiation filters, the placeholder
//      latch, the §13 chips, the overlay/keycast/lane/ticker redraw or the
//      canvas §3.3 repair. All of them are inside every number below, because
//      the thing being timed is `_chReplayDebug.seek()` on the shipped client.
//
// ── FIXTURES ──────────────────────────────────────────────────────────────
//   REAL   `fixtures/alignment-v2-frozen.json` — a CH-recorded TWO-SPAN
//          session (18 segments, `keyframeEvery: 10`, 54 anchored events,
//          real `viewport_changes`), frozen by Task 8. This is the
//          keyframe-continuation session plan Task 9 asks for; Task 0 declined
//          to cut one and Task 8 cut it for other reasons.
//   CANVAS `jspsych-full` segments 9 (the sketchpad, ten real region
//          snapshots) and 8 (the 189,322-char full baseline). Every one of its
//          14 segments is a keyframe, so a canvas seek there restores ONE
//          segment: canvas depth and span depth cannot compose in the corpus.
//   WORST  the composite worst case, SYNTHESIZED — `deep-span-model.mjs`,
//          shared verbatim with Task 0's harness. jspsych-full segment 11's
//          real 535-node tree, 10 segments x 100 events at 20% anchored, real
//          `canvas.snapshot` payloads. Task 0 fed these segments to a model of
//          the restore; this feeds the same segments to the real one.
//
//   checks=off is produced by STRIPPING the §6 `camera`/`anchor` blocks, which
//   is what a recording that omits them looks like (§8's MAY-omit rule: no
//   blocks means no check). It is not a viewer switch — the viewer has none.
//
// ── THE V1 CONTROL, RE-HOMED (T5.1's declared casualty, routed here) ──────
//   Task 0's control drove the then-shipped v1 viewer over SMOKE-19NRQR.
//   `buildViewerModel` is v2-only since Task 1 and the client is v2-only since
//   Task 4, so that arm went dark. It is re-homed to the committed frozen
//   artifact `archive/v0.7.1-report/index.html`, which inlines its OWN 0.7.x
//   viewer and its OWN built model — the whole v1 stack as a unit, immune to
//   anything in the tree. It is INTERLEAVED with the v2 cells (one v1 sample
//   per v2 sample) so machine-load drift lands on both arms.
//
// ── COVERAGE ASSERTIONS ───────────────────────────────────────────────────
//   A seek that quietly did nothing is fast. Every cell asserts what it
//   applied, in two layers, because they catch different things:
//     PER SAMPLE  `mountsDelta` across each timed seek (a backward seek
//       restores exactly once, a forward seek inside the span exactly zero
//       times) and, for the forward cells, the WALK WITNESS
//       `ci.applied > mountOnly.applied` — `mountsDelta === 0` is satisfied by
//       a seek that did nothing, which is the hole `--inject=dead-forward`
//       reproduces and the T5.9 review found.
//     AFTER THE FACT  segments replayed (10 for case (iii), 1 for case (ii)),
//       entries applied, frame element count, alignment checks > 0 when checks
//       are on and EXACTLY 0 when they are off, composited canvas rules and
//       presented chars, zero unresolved patches.
//   Plus the FRAME FREEDOM assertion (rule 3) and, after the run, the CHANNEL
//   COVERAGE sweep, computed over the spans the gated cells actually replayed
//   and enumerated against the client's own `KNOWN_TYPES` so a vocabulary
//   addition cannot escape into neither list. Task 0's harness carries the same
//   discipline and it caught a real defect there; so did this one, twice.
//
// Run:  npm run build && npm run test:browser:seek
//       PLAYWRIGHT_CORE_DIR=/opt/homebrew/lib/node_modules/ \
//         node tests/browser/replay/seek-budget.battery.mjs \
//         --engines=chromium,firefox,webkit --runs=11
// Exit code is the signal: non-zero if a gate failed, a coverage assertion
// failed, an engine did not launch, or the page logged an error.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

import { buildViewerModel } from '../../../src/cli/renderers/replay-assets.js';
import { readReplayClientSrc } from '../../../src/cli/renderers/replay-client-source.js';
// The probe apparatus Task 0 committed: one reading of how these harnesses
// resolve a browser and serve an isolated origin. The COOP+COEP server is the
// reason `performance.now()` here has 0.005 ms granularity instead of 0.1 ms,
// which at case-(ii) magnitudes is the difference between a measurement and a
// quantisation grid.
import { serveFiles, median, p95, minOf, fixed } from '../../../tools/investigate/probe-support.mjs';
import { buildDeepSpanModel, realCanvasSnapshots, countNodes } from '../../../tools/investigate/deep-span-model.mjs';
import { inlineSafeJson, inlineSafeSrc } from '../../../src/shared/inline-safe.js';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit === `--${n}` ? true : hit.slice(n.length + 3);
};
const ENGINES = String(opt('engines', 'chromium')).split(',').map((s) => s.trim()).filter(Boolean);
const HEADLESS = !opt('headed', false);
const RUNS = Number(opt('runs', 11));
const ISOLATE = !opt('no-isolate', false);
const SPAN_SEGMENTS = Number(opt('span-segments', 10));
const EVENTS_PER_SEGMENT = Number(opt('events-per-segment', 100));
const ANCHORED_FRAC = Number(opt('anchored-frac', 0.20));

// ── FAULT INJECTION — the gate's own teeth ────────────────────────────────
// A gate whose failure path is never exercised is a claim. Task 0's canvas
// probe set the precedent (`--inject=…`, each fault exiting as documented) and
// this file follows it. Each injection must make the run exit non-zero, and
// the named assertion must be the one that fires.
//
//   tight-ceilings  ceilings and the ratio band scaled to 1/100. Proves the
//                   PASS/FAIL comparison is live on every cell, not decorative.
//   dead-seek       every measured sample seeks to the playhead it is already
//                   at. Fast, silent, and applies nothing — the failure mode
//                   the coverage assertions exist for. The depth witnesses
//                   ("case iii replayed 10 segments") must fire.
//   no-checks       the checks=ON arm gets its §6 blocks stripped. The
//                   "alignment checks ran" assertion must fire — a checks-on
//                   cell that runs no checks measures the wrong thing and
//                   deflates both the absolute number and the gated ratio.
//   no-canvas       the canvas=ON arm loses its canvas.snapshot events. The
//                   "presented a composite" assertion must fire.
//   dead-forward    ONLY the forward (expectMount: 0) samples seek to the
//                   playhead they are already at. This is the hole the T5.9
//                   review found: `mountsDelta === 0` is satisfied by a seek
//                   that did nothing, so the six cells measuring design §5's
//                   incremental walk — the ONE path no other cell exercises —
//                   had no witness at all, and the published mount:events split
//                   collapsed 4.465 -> 0.075 ms unnoticed. The forward-walk
//                   witness must fire.
//   frame-in-settled  `settledMs`'s clock stops AFTER a requestAnimationFrame,
//                   i.e. the metric grows the frame floor rule 3 forbids
//                   gating. The FRAME-FREEDOM assertion must fire — and it is
//                   what makes rule 3's "asserted, not assumed" true rather
//                   than a comment.
const INJECT = String(opt('inject', '') || '');
const injected = (name) => INJECT === name;
if (INJECT) console.log(`!! FAULT INJECTED: --inject=${INJECT} — this run is EXPECTED to fail`);

// Design §11's ceilings, and the plan's Task-0-derived ratio band.
const SCALE = injected('tight-ceilings') ? 0.01 : 1;
const CEILING = { i: 100 * SCALE, ii: 100 * SCALE, iii: 300 * SCALE };
const RATIO_BAND = 8.0 * SCALE;

// ── M-5: the composite worst case's defining parameters are asserted ──────
// `--span-segments`, `--events-per-segment` and `--anchored-frac` all reach the
// generator, and the scale-dependent coverage assertions scale WITH them, so
// they cannot notice: `--events-per-segment=1` returned 43/43 with the "worst
// case" reduced to ten events. A committed gate has to refuse to run
// under-parameterized, or "129/129" has no fixed meaning.
// The floors are the design's own worst case: `keyframeEvery: 10` (design §5),
// 100 events/segment and the 20% anchored density Task 0 chose (above
// SMOKE-19NRQR's busiest real trial, 16.0%). Larger is allowed — the reviewer's
// density sweep runs to 1.00 — smaller is not.
const PARAM_FLOOR = { spanSegments: 10, eventsPerSegment: 100, anchoredFrac: 0.20 };
if (SPAN_SEGMENTS < PARAM_FLOOR.spanSegments || EVENTS_PER_SEGMENT < PARAM_FLOOR.eventsPerSegment
    || ANCHORED_FRAC < PARAM_FLOOR.anchoredFrac) {
  console.error('REFUSING TO RUN: the composite worst case is under-parameterized.');
  console.error(`  --span-segments=${SPAN_SEGMENTS} (>= ${PARAM_FLOOR.spanSegments} required — design §5's keyframeEvery)`);
  console.error(`  --events-per-segment=${EVENTS_PER_SEGMENT} (>= ${PARAM_FLOOR.eventsPerSegment} required)`);
  console.error(`  --anchored-frac=${ANCHORED_FRAC} (>= ${PARAM_FLOOR.anchoredFrac} required — Task 0's density, above the busiest real trial)`);
  console.error('  A pass under smaller parameters is not the gate this file is named for.');
  process.exit(1);
}

function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    import.meta.url,
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/',
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      const pw = createRequire(base)('playwright-core');
      let version = 'unknown';
      try { version = createRequire(base)('playwright-core/package.json').version; } catch { /* best effort */ }
      return { pw, version, from: base };
    } catch { /* next */ }
  }
  return null;
}
const resolved = resolvePlaywright();
if (!resolved) { console.log('SKIP: playwright-core not found'); process.exit(0); }
const pw = resolved.pw;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const artifactsDir = join(here, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

const FROZEN_FIXTURE = join(here, 'fixtures', 'alignment-v2-frozen.json');
const V1_REPORT_PATH = '/tests/browser/replay/archive/v0.7.1-report/index.html';
const JSPSYCH_FULL = join(repoRoot, 'tests', 'replay', 'schema-v2', 'fixtures', 'jspsych-full.json');

let failures = 0;
let engineTag = '';
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + (engineTag ? '[' + engineTag + '] ' : '') + label); }
}
function note(label) { console.log('    · ' + label); }

// The alignment battery's one declared console whitelist applies here too:
// jspsych-full segment 12's keyframe carries `autofocus`, and a script-less
// sandbox refusing the focus steal is the CORRECT outcome (T5.4 finding (a)).
const CONSOLE_WHITELIST = [/Blocked autofocusing/i];
function watchPage(page, tag) {
  const seen = { __tag: tag, pageErrors: [], consoleErrors: [], whitelisted: 0 };
  page.on('pageerror', (e) => { seen.pageErrors.push(String(e.message || e)); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (CONSOLE_WHITELIST.some((re) => re.test(text))) { seen.whitelisted++; return; }
    seen.consoleErrors.push(text);
  });
  return seen;
}
function assertClean(watch) {
  check(watch.pageErrors.length === 0, `no page errors on "${watch.__tag}" (${watch.pageErrors[0] || 'none'})`);
  check(watch.consoleErrors.length === 0, `no console errors on "${watch.__tag}" (${watch.consoleErrors[0] || 'none'})`);
}

// ── statistics ─────────────────────────────────────────────────────────────
// median AND worst run: a median alone hides a cell that is fine four times in
// five, and the analyst feels the fifth.
function stat(xs) {
  return {
    n: xs.length, median: median(xs), p95: p95(xs), min: minOf(xs),
    max: xs.length ? Math.max(...xs) : NaN,
  };
}
const show = (s) => `median ${fixed(s.median)} (p95 ${fixed(s.p95)}, worst ${fixed(s.max)}, min ${fixed(s.min)}, n=${s.n})`;

// ── the harness page ───────────────────────────────────────────────────────
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
  <script>${safeViewer}<\/script>
  <script>
    window.__model = ${modelJson};
    window.__FRAME_IN_SETTLED = ${INJECT === 'frame-in-settled' ? 'true' : 'false'};
    initChReplayViewer(document.getElementById('mount'), window.__model);
    window.__dbg = function () { return document.getElementById('mount')._chReplayDebug; };

    // THE MEASURED PATH. Three metrics, and rule 2 above says which is which:
    //   syncMs          seek() returns — restore + span walk + redraw. No frame.
    //   settledMs       + canvasSettled(): the decode/composite/present chains.
    //                   A promise chain, so NO animation frame is inside it.
    //   settledFrameMs  + one rAF: carries the frame floor, and is the only
    //                   metric comparable with v1's settled number.
    // mountsDelta is the PER-SAMPLE witness that this seek did the work its
    // case is named for: a backward seek restores (exactly one mount), a
    // forward seek inside the applied span continues the walk (zero). Reading
    // the reconstruction afterwards cannot say this — the state the probe finds
    // was mostly put there by the untimed prep — so a sample that quietly
    // measured nothing would otherwise pass every after-the-fact assertion.
    window.__seekTimed = function (t) {
      var d = window.__dbg();
      var m0 = d.getStats().mounts;
      var t0 = performance.now();
      d.seek(t);
      var syncMs = performance.now() - t0;
      return d.canvasSettled().then(function () {
        // --inject=frame-in-settled puts an animation frame INSIDE settledMs,
        // which is precisely the metric rule 3 forbids gating. Nothing else in
        // this function changes.
        var pre = window.__FRAME_IN_SETTLED
          ? new Promise(function (r) { requestAnimationFrame(r); })
          : Promise.resolve();
        return pre.then(function () {
          var settledMs = performance.now() - t0;
          var mountsDelta = d.getStats().mounts - m0;
          return new Promise(function (res) {
            requestAnimationFrame(function () {
              res({
                syncMs: syncMs, settledMs: settledMs, settledFrameMs: performance.now() - t0,
                mountsDelta: mountsDelta
              });
            });
          });
        });
      });
    };

    // A SEGMENT CHANGE, timed. loadSegment() is what tick() calls at a segment
    // boundary during continuous playback; selectSegment() is loadSegment plus
    // a 'playing = false' reset, so this measures the playback boundary's cost
    // with one assignment of difference.
    window.__selectTimed = function (i) {
      var d = window.__dbg();
      var m0 = d.getStats().mounts;
      var t0 = performance.now();
      d.selectSegment(i);
      var syncMs = performance.now() - t0;
      return d.canvasSettled().then(function () {
        return {
          syncMs: syncMs, settledMs: performance.now() - t0,
          mountsDelta: d.getStats().mounts - m0,
          segment: d.getSegment(), spanStart: d.getSpanStart(), walk: d.getWalk().length
        };
      });
    };

    window.__select = function (i) { window.__dbg().selectSegment(i); };
    window.__seek = function (t) { window.__dbg().seek(t); };

    // COVERAGE. Everything a "fast because it did nothing" cell would fail.
    window.__probe = function () {
      var d = window.__dbg();
      var f = document.querySelector('.replay-frame');
      var doc = f && f.contentDocument;
      var rules = doc ? doc.head.querySelectorAll('[data-ch-canvas-rule]') : [];
      var presented = 0;
      for (var i = 0; i < rules.length; i++) presented += rules[i].textContent.length;
      // Alignment checks are memoised on the model's own event objects and
      // cleared span-wide by restore(), so counting them across the whole model
      // counts what THIS position evaluated.
      var checks = 0, segs = window.__model.segments;
      for (var s = 0; s < segs.length; s++) {
        var evs = segs[s].events;
        for (var e = 0; e < evs.length; e++) if (evs[e].__chk) checks++;
      }
      // THE DEPTH WITNESS. getWalk() is the whole SPAN and is the same length
      // whatever the target segment, so its length says nothing about how deep
      // this seek went. What does is how many of its entries the playhead is at
      // or past — the count applyUpTo actually applied. It is independent of
      // both the checks and the canvas arms, so it works in every cell.
      var w = d.getWalk(), ph = d.getPlayhead(), sg = d.getSegment(), applied = 0, segsTouched = {};
      for (var q = 0; q < w.length; q++) {
        if (w[q].seg < sg || (w[q].seg === sg && w[q].t <= ph)) { applied++; segsTouched[w[q].seg] = true; }
      }
      var nSegs = 0; for (var k in segsTouched) nSegs++;
      return {
        checks: checks,
        canvasRules: rules.length,
        presentedChars: presented,
        counters: d.getCounters(),
        stats: d.getStats(),
        walk: w.length,
        applied: applied,
        segmentsApplied: nSegs,
        playhead: ph,
        segment: sg,
        spanStart: d.getSpanStart(),
        frameElements: doc && doc.body ? doc.body.getElementsByTagName('*').length : -1,
        frameReady: d.frameReady()
      };
    };

    // FLOOR cells, in-page (rule 4).
    window.__clock = function (n) {
      var mins = Infinity, prev = performance.now();
      for (var i = 0; i < n; i++) {
        var x = performance.now();
        var dd = x - prev;
        if (dd > 0 && dd < mins) mins = dd;
        prev = x;
      }
      return { minDelta: mins, isolated: !!self.crossOriginIsolated };
    };
    window.__wrapperFloor = function () {
      var d = window.__dbg();
      var t0 = performance.now();
      void d;
      return performance.now() - t0;
    };
    window.__rafFloor = function () {
      var t0 = performance.now();
      return new Promise(function (r) { requestAnimationFrame(function () { r(performance.now() - t0); }); });
    };
  <\/script></body></html>`;
}

async function openViewer(browser, origin, model, tag) {
  const name = `seek-budget-${engineTag}-${tag}.html`;
  writeFileSync(join(artifactsDir, name), harnessHtml(model));
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const watch = watchPage(page, tag);
  await page.goto(`${origin}/tests/browser/replay/artifacts/${name}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__dbg() && window.__dbg().frameReady(), null, { timeout: 20000 });
  await page.waitForTimeout(200);
  await page.waitForFunction(() => window.__dbg().frameReady(), null, { timeout: 20000 });
  page.__watch = watch;
  return page;
}

// ── the v1 control (the frozen v0.7.1 report) ──────────────────────────────
const V1_TRIAL = 2;      // 368 events, 16.9 s — the busiest, as Task 0 used
const V1_LO = 2000;
const V1_HI = 14000;

async function openV1(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const watch = watchPage(page, 'v0.7.1 report');
  await page.goto(origin + V1_REPORT_PATH, { waitUntil: 'load' });
  await page.click('.replay-load-btn');
  await page.waitForSelector('.replay-stage', { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    var mount = document.querySelector('.replay-mount');
    var d = mount && mount._chReplayDebug;
    if (!d) throw new Error('the 0.7.x report exposes no _chReplayDebug');
    // v1's BACKWARD seek is ASYNCHRONOUS: seek() calls rebuildFrame(), which
    // rewrites iframe.srcdoc and finishes in an onload handler. Timing the
    // RETURN of seek() reports a full frame rebuild as ~0.3 ms — the 51x error
    // Task 0's baseline exists to expose. Both numbers come back, and
    // `wentAsync` says which one is the real answer.
    window.__v1 = {
      selectTrial: function (i) { d.selectTrial(i); },
      seek: function (t) {
        var t0 = performance.now();
        d.seek(t);
        var syncMs = performance.now() - t0;
        var readyAtReturn = d.frameReady();
        return new Promise(function (resolve) {
          function done() {
            resolve({ syncMs: syncMs, settledFrameMs: performance.now() - t0, wentAsync: !readyAtReturn });
          }
          if (readyAtReturn) { requestAnimationFrame(done); return; }
          (function poll() {
            if (d.frameReady()) requestAnimationFrame(done);
            else requestAnimationFrame(poll);
          })();
        });
      },
      frameChars: function () {
        var f = document.querySelector('.replay-frame');
        var doc = f && f.contentDocument;
        return doc && doc.body ? doc.body.innerHTML.length : 0;
      }
    };
  });
  await page.evaluate((i) => window.__v1.selectTrial(i), V1_TRIAL);
  await page.waitForTimeout(400);
  page.__watch = watch;
  return page;
}

/**
 * ONE v1 control sample, interleaved into a v2 cell's run loop. Forward, a
 * repeat of the same target (the cheapest real seek), then backward.
 */
async function v1Sample(v1page, acc) {
  await v1page.evaluate((t) => window.__v1.seek(t), V1_LO);
  acc.forward.push(await v1page.evaluate((t) => window.__v1.seek(t), V1_HI));
  acc.repeat.push(await v1page.evaluate((t) => window.__v1.seek(t), V1_HI));
  acc.backward.push(await v1page.evaluate((t) => window.__v1.seek(t), V1_LO));
}

/**
 * Run one measured cell: `RUNS + 1` iterations (the first discarded as
 * warm-up), one interleaved v1 control sample per iteration when a control
 * page is supplied.
 *
 * @param {object}   o.page        the v2 harness page
 * @param {function} o.prep        async () => void, run untimed before each sample
 * @param {function} o.sample      async () => {syncMs, settledMs, settledFrameMs, mountsDelta}
 * @param {number}   o.expectMount 1 for a restoring (backward) seek, 0 for an
 *                                 incremental (forward) one. Asserted on EVERY
 *                                 measured sample, not once at the end.
 * @param {string}   o.label       what the failure message names
 */
async function measure({ page, prep, sample, v1page, v1acc, expectMount, label }) {
  const sync = [], settled = [], settledFrame = [], mounts = [];
  let last = null;
  for (let r = 0; r <= RUNS; r++) {
    if (v1page) await v1Sample(v1page, v1acc);
    if (prep) await prep();
    // --inject=dead-seek: every measured sample seeks to where the playhead
    // already is. --inject=dead-forward: only the FORWARD ones do, which is the
    // narrower hole (`mountsDelta === 0` cannot tell a walk from a no-op).
    const dead = injected('dead-seek') || (injected('dead-forward') && expectMount === 0);
    const m = dead
      ? await page.evaluate(() => window.__seekTimed(window.__dbg().getPlayhead()))
      : await sample();
    if (r) { sync.push(m.syncMs); settled.push(m.settledMs); settledFrame.push(m.settledFrameMs); mounts.push(m.mountsDelta); }
    last = m;
  }
  const probe = await page.evaluate(() => window.__probe());
  if (expectMount !== undefined) {
    const bad = mounts.filter((d) => d !== expectMount).length;
    check(bad === 0,
      `${label}: every measured sample ${expectMount ? 'RESTORED' : 'walked forward without restoring'} ` +
      `(${mounts.length - bad}/${mounts.length} with mounts delta ${expectMount})`);
  }
  return { sync: stat(sync), settled: stat(settled), settledFrame: stat(settledFrame), mounts, probe, last };
}

// ── fixtures ───────────────────────────────────────────────────────────────
const frozenRec = JSON.parse(readFileSync(FROZEN_FIXTURE, 'utf8'));
const jspsychFull = JSON.parse(readFileSync(JSPSYCH_FULL, 'utf8'));

/**
 * checks=off: strip every §6 `camera`/`anchor` block. §8's MAY-omit rule makes
 * absence mean "no check", so this is the shape of a recording that omits the
 * alignment blocks — not a viewer switch, which the viewer does not have.
 */
function stripAlignment(rec) {
  return Object.assign({}, rec, {
    segments: rec.segments.map((s) => Object.assign({}, s, {
      events: (s.events || []).map((e) => {
        const out = Object.assign({}, e);
        delete out.camera; delete out.anchor;
        return out;
      }),
    })),
  });
}

/** Wrap the shared deep-span generator's segments as a loadable v2 recording. */
function worstCaseRecording(canvas) {
  const tree = jspsychFull.segments[11].initial_dom;
  const built = buildDeepSpanModel({
    tree, segments: SPAN_SEGMENTS, eventsPerSegment: EVENTS_PER_SEGMENT,
    anchoredFrac: ANCHORED_FRAC, canvas: canvas && !injected('no-canvas'),
    snapshots: realCanvasSnapshots(jspsychFull),
  });
  return {
    canvasId: built.canvasId,
    recording: {
      schema_version: 2,
      recorder: { name: 'cyborg-hunter-replay', version: '0.0.0-t5.9-synthetic' },
      participant_id: 'T5.9-WORST-CASE',
      recording_started_at: new Date(0).toISOString(),
      recording_started_at_perf: 0,
      end_reason: 'finished',
      user_agent: 'synthetic',
      viewport: { w: 1280, h: 1000, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
      // The recording's real 470 KB of jsPsych CSS goes into the shell: forced
      // layout over an un-styled tree is not the cost the viewer pays, and the
      // alignment check is the largest single term in a deep restore.
      stylesheets: jspsychFull.stylesheets || [],
      stylesheet_events: [],
      viewport_changes: [],
      extensions: { 'cyborg-hunter': { tier: 'dom', viewport_client: { w: 1280, h: 1000 } } },
      segments: built.segments,
    },
  };
}

// The last event of a segment, segment-relative. A backward seek can only
// replay events at or before its target, so this is the target that replays
// the whole segment; every fixture used here has `durMs > lastT`, asserted.
function lastT(model, i) {
  const evs = model.segments[i].events;
  return evs.length ? evs[evs.length - 1].t : 0;
}

// ── the run ────────────────────────────────────────────────────────────────
const out = {
  config: { engines: ENGINES, runs: RUNS, isolate: ISOLATE, spanSegments: SPAN_SEGMENTS,
    eventsPerSegment: EVENTS_PER_SEGMENT, anchoredFrac: ANCHORED_FRAC },
  playwright: { version: resolved.version, from: resolved.from },
  ceilings: CEILING, ratioBand: RATIO_BAND,
  engines: {},
};
const gateRows = [];

/**
 * THE SEGMENTS A GATED CELL ACTUALLY REPLAYS (T5.9 review I-3).
 * The first version unioned event types over WHOLE recordings and then called
 * the union "inside a gated number". Every `jspsych-full` segment is its own
 * keyframe and only segments 9 and 8 are gated, so three channels were credited
 * to cells that never touch them. Cells register their real span here instead,
 * so the accounting cannot drift from what the gate runs.
 */
const gatedSpans = [];
const gatedSpanKeys = new Set();
function recordGatedSpan(fixture, model, from, to) {
  const key = `${fixture}:${from}-${to}`;
  if (gatedSpanKeys.has(key)) return;
  gatedSpanKeys.add(key);
  gatedSpans.push({ fixture, model, from, to });
}

function gate({ cell, caseName, metric, value, limit, unit = 'ms' }) {
  const pass = Number.isFinite(value) && value <= limit;
  gateRows.push({ engine: engineTag, cell, case: caseName, metric, value, limit, unit, pass });
  const verdict = pass ? 'PASS' : 'FAIL';
  const line = `${verdict}  ${cell} | case ${caseName} | ${metric} ${fixed(value)} ${unit} <= ${limit} ${unit}`;
  if (pass) console.log('  ✔ ' + line); else { failures++; console.error('  ✖ [' + engineTag + '] ' + line); }
  return pass;
}

async function runEngine(name, browser, origin) {
  engineTag = name;
  console.log(`\n══════════════ ${name} ══════════════`);
  const res = { cells: {}, ratios: {}, v1: null, floor: null, onSquared: null };
  const v1acc = { forward: [], repeat: [], backward: [] };

  const frozenModel = buildViewerModel(injected('no-checks') ? stripAlignment(frozenRec) : frozenRec);
  // The O(n²) pass runs on the deep fixture too: the frozen CH session's span
  // carries 45 events, the composite worst case 1000, and the quadratic term is
  // in the events. canvas=off/checks=on is the configuration whose cost depends
  // on the span walk (the same reasoning that picks the gated ratio cell).
  const onSquaredWorstModel = buildViewerModel(
    injected('no-checks')
      ? stripAlignment(worstCaseRecording(false).recording)
      : worstCaseRecording(false).recording);
  const frozenNoAlign = buildViewerModel(stripAlignment(frozenRec));

  // ── FLOOR ────────────────────────────────────────────────────────────────
  console.log('\n▶ FLOOR — what the instrument costs before any gate is read');
  const floorPage = await openViewer(browser, origin, frozenModel, 'floor');
  {
    const clock = await floorPage.evaluate(() => window.__clock(200000));
    check(clock.isolated === ISOLATE,
      `crossOriginIsolated is ${clock.isolated} (COOP+COEP ${ISOLATE ? 'served' : 'off'}) — the clock is ${clock.isolated ? 'unclamped' : 'CLAMPED to 100 us'}`);
    const wrapper = [];
    for (let i = 0; i < 2000; i++) wrapper.push(await floorPage.evaluate(() => window.__wrapperFloor()));
    const rt = [];
    for (let i = 0; i < 200; i++) { const t0 = performance.now(); await floorPage.evaluate(() => 0); rt.push(performance.now() - t0); }
    const raf = [];
    for (let i = 0; i < 40; i++) raf.push(await floorPage.evaluate(() => window.__rafFloor()));
    res.floor = {
      clock, wrapper: stat(wrapper), playwrightRoundTrip: stat(rt), rafFrame: stat(raf),
    };
    note(`performance.now() min delta ${fixed(clock.minDelta, 4)} ms`);
    note(`in-page timing wrapper       ${show(res.floor.wrapper)} ms`);
    note(`Playwright evaluate round trip ${show(res.floor.playwrightRoundTrip)} ms  (NOT inside any gated number — rule 4)`);
    note(`ONE ANIMATION FRAME          ${show(res.floor.rafFrame)} ms  ← the floor under any settledFrame number`);
    check(res.floor.rafFrame.median > 0, 'the animation-frame floor is measurable');
  }
  await floorPage.close();

  // ── V1 CONTROL, opened once and interleaved from here on ────────────────
  console.log('\n▶ V1 CONTROL — the frozen v0.7.1 report (its own 0.7.x viewer + its own model)');
  const v1page = await openV1(browser, origin);
  {
    const chars = await v1page.evaluate(() => window.__v1.frameChars());
    check(chars > 200, `the 0.7.x viewer reconstructs (${chars} chars in its frame) — the control is a live viewer, not a shell`);
  }

  // ── REAL — the CH-recorded keyframe-continuation fixture ────────────────
  console.log('\n▶ REAL — CH-recorded two-span session (alignment-v2-frozen.json)');
  {
    const kf = 0;                       // the span's keyframe segment
    const deep = SPAN_SEGMENTS - 1;     // segment 9 = the 9th continuation
    check(frozenModel.segments[deep].spanStart === kf && frozenModel.segments[kf].keyframe,
      `segment ${deep} is the ${deep}th continuation of the span opening at segment ${kf} (keyframeEvery: ${SPAN_SEGMENTS})`);

    for (const [checksOn, model] of [[true, frozenModel], [false, frozenNoAlign]]) {
      const tag = `real-checks-${checksOn ? 'on' : 'off'}`;
      const page = await openViewer(browser, origin, model, tag);
      const kfLast = lastT(model, kf);
      const deepLast = lastT(model, deep);
      check(model.segments[kf].durMs > kfLast && model.segments[deep].durMs > deepLast,
        `[${tag}] both target segments end after their last event (${fixed(kfLast, 1)} < ${model.segments[kf].durMs}; ${fixed(deepLast, 1)} < ${model.segments[deep].durMs}) — a backward seek can replay every event`);

      // The v1 control is interleaved into the cells the v1 COMPARISON is made
      // from, one control sample per treatment sample — enough that drift in
      // machine load lands on both arms, without paying for a v1 backward seek
      // (an `srcdoc` rebuild) beside every cell in the matrix.
      const ctl = checksOn ? { v1page, v1acc } : {};

      // case (i): forward seek across one segment's events, no mount.
      await page.evaluate((i) => window.__select(i), kf);
      const ci = await measure({
        page, expectMount: 0, label: `[${tag}] case i`,
        prep: () => page.evaluate((t) => window.__seek(t), 0),
        sample: () => page.evaluate((t) => window.__seekTimed(t), kfLast),
      });
      // case (ii): backward seek inside the keyframe segment = mount + 1 segment.
      const cii = await measure({
        page, ...ctl, expectMount: 1, label: `[${tag}] case ii`,
        prep: () => page.evaluate((t) => window.__seek(t), model.segments[kf].durMs),
        sample: () => page.evaluate((t) => window.__seekTimed(t), kfLast),
      });
      // MOUNT:EVENTS SPLIT — the thing the ratio is a function of (rule 1).
      // A restore whose target is t=0 applies (almost) nothing, so it is the
      // mount; case (i) is the same segment's events with no mount.
      await page.evaluate((i) => window.__select(i), kf);
      const mountOnly = await measure({
        page, expectMount: 1, label: `[${tag}] mount-only`,
        prep: () => page.evaluate((t) => window.__seek(t), model.segments[kf].durMs),
        sample: () => page.evaluate(() => window.__seekTimed(0)),
      });
      // case (iii): backward seek in the 9th continuation = mount + 10 segments.
      await page.evaluate((i) => window.__select(i), deep);
      const ciii = await measure({
        page, ...ctl, expectMount: 1, label: `[${tag}] case iii`,
        prep: () => page.evaluate((t) => window.__seek(t), model.segments[deep].durMs),
        sample: () => page.evaluate((t) => window.__seekTimed(t), deepLast),
      });

      res.cells[`${tag} case i`] = ci;
      res.cells[`${tag} case ii`] = cii;
      res.cells[`${tag} case iii`] = ciii;
      res.cells[`${tag} mount-only`] = mountOnly;

      console.log(`  [${tag}]`);
      for (const [label, cell] of [['i (forward, no mount)', ci], ['ii (mount + 1 segment)', cii], ['iii (mount + 10 segments)', ciii]]) {
        console.log(`    case ${label}`);
        console.log(`      sync          ${show(cell.sync)} ms`);
        console.log(`      settled       ${show(cell.settled)} ms   (no frame)`);
        console.log(`      settledFrame  ${show(cell.settledFrame)} ms   (report only)`);
      }
      note(`mount:events split — mount ${fixed(mountOnly.sync.median)} ms : one segment's events ${fixed(ci.sync.median)} ms`);
      note(`case iii applied ${ciii.probe.applied} entries across ${ciii.probe.segmentsApplied} segments; ` +
           `case ii applied ${cii.probe.applied} across ${cii.probe.segmentsApplied}; ` +
           `checks ${ciii.probe.checks}; frame elements ${ciii.probe.frameElements}`);

      // COVERAGE
      check(ciii.probe.frameElements > 20, `[${tag}] case iii left a real reconstruction (${ciii.probe.frameElements} elements), not an empty body`);
      check(ciii.probe.segmentsApplied === SPAN_SEGMENTS && cii.probe.segmentsApplied === 1,
        `[${tag}] case iii replayed ${ciii.probe.segmentsApplied} segments and case ii replayed ${cii.probe.segmentsApplied} — the cases are what they are named`);
      check(ciii.probe.applied > cii.probe.applied, `[${tag}] case iii applies strictly more entries than case ii (${ciii.probe.applied} > ${cii.probe.applied})`);
      check(mountOnly.probe.applied === 0 || mountOnly.probe.applied < cii.probe.applied,
        `[${tag}] the mount-only cell applied ${mountOnly.probe.applied} entries — it measures the mount, not the walk`);
      // THE FORWARD-WALK WITNESS (T5.9 review I-1). `mountsDelta === 0` says a
      // forward seek did not restore; it cannot say it did anything. Case (i) is
      // the ONLY cell in this battery that exercises design §5's incremental
      // walk — every other gated cell restores — so without this the one path
      // the gate uniquely covers is the one path it cannot see, and
      // `--inject=dead-forward` collapses it to 0.03 ms in silence. The
      // comparand is the mount-only cell, which sits at the same playhead
      // case (i) STARTS from, so the difference is exactly the walk.
      check(ci.probe.applied > mountOnly.probe.applied,
        `[${tag}] case i actually walked forward: ${ci.probe.applied} entries applied at its target vs ${mountOnly.probe.applied} at its start`);
      check(ciii.probe.counters.patchFailures === 0, `[${tag}] case iii left 0 unresolved patches (${ciii.probe.counters.patchFailures})`);
      if (checksOn) {
        check(ciii.probe.checks > 0, `[${tag}] alignment checks ran (${ciii.probe.checks}) — the cost driver §11 names is inside this number`);
      } else {
        check(ciii.probe.checks === 0, `[${tag}] alignment checks are OFF (${ciii.probe.checks}) — §6 MAY-omit, the blocks are stripped`);
      }
      assertClean(page.__watch);

      // GATES
      gate({ cell: tag, caseName: 'i', metric: 'sync', value: ci.sync.median, limit: CEILING.i });
      gate({ cell: tag, caseName: 'i', metric: 'settled', value: ci.settled.median, limit: CEILING.i });
      gate({ cell: tag, caseName: 'ii', metric: 'sync', value: cii.sync.median, limit: CEILING.ii });
      gate({ cell: tag, caseName: 'ii', metric: 'settled', value: cii.settled.median, limit: CEILING.ii });
      gate({ cell: tag, caseName: 'iii', metric: 'sync', value: ciii.sync.median, limit: CEILING.iii });
      gate({ cell: tag, caseName: 'iii', metric: 'settled', value: ciii.settled.median, limit: CEILING.iii });

      recordGatedSpan('alignment-v2-frozen', model, kf, kf);      // cases (i), (ii), mount-only
      recordGatedSpan('alignment-v2-frozen', model, kf, deep);    // case (iii): the whole span
      res.ratios[`REAL ${tag} sync`] = ciii.sync.median / cii.sync.median;
      res.ratios[`REAL ${tag} settled`] = ciii.settled.median / cii.settled.median;

      // SPAN 2 — the only place `initial_state` SEEDING (design §6) is inside a
      // gated number. Span 1's keyframe carries none; segment 10's carries a
      // window scroll (0, 1916) AND an element scroll (node 12), so a restore
      // there replays both as synthetic t=0 events through the real handlers.
      // Task 0's model set `initial_state: null` on every segment and named the
      // omission; this is where it stops being an omission.
      if (checksOn) {
        const kf2 = 10, deep2 = model.segments.length - 1;   // span 2 = segments 10..17
        check(model.segments[kf2].keyframe && !!model.segments[kf2].initialState
          && model.segments[deep2].spanStart === kf2,
          `segment ${kf2} opens span 2 WITH an initial_state seed and segment ${deep2} is its ${deep2 - kf2}th continuation`);
        await page.evaluate((i) => window.__select(i), kf2);
        const s2ii = await measure({
          page, expectMount: 1, label: `[${tag}] span-2 case ii (seeded keyframe)`,
          prep: () => page.evaluate((t) => window.__seek(t), model.segments[kf2].durMs),
          sample: () => page.evaluate((t) => window.__seekTimed(t), lastT(model, kf2)),
        });
        await page.evaluate((i) => window.__select(i), deep2);
        const s2deep = await measure({
          page, expectMount: 1, label: `[${tag}] span-2 case iii (seeded span, deepest)`,
          prep: () => page.evaluate((t) => window.__seek(t), model.segments[deep2].durMs),
          sample: () => page.evaluate((t) => window.__seekTimed(t), lastT(model, deep2)),
        });
        recordGatedSpan('alignment-v2-frozen', model, kf2, kf2);
        recordGatedSpan('alignment-v2-frozen', model, kf2, deep2);
        res.cells['real span2 case ii'] = s2ii;
        res.cells['real span2 case iii'] = s2deep;
        console.log(`    span 2 (keyframe ${kf2} carries initial_state; deepest continuation ${deep2})`);
        console.log(`      case ii   sync ${show(s2ii.sync)} ms | settled ${show(s2ii.settled)} ms`);
        console.log(`      case iii  sync ${show(s2deep.sync)} ms | settled ${show(s2deep.settled)} ms`);
        check(s2deep.probe.segmentsApplied === deep2 - kf2 + 1,
          `span-2 case iii replayed ${s2deep.probe.segmentsApplied} segments (span 2 is ${deep2 - kf2 + 1} deep)`);
        gate({ cell: 'real span2 (seeded)', caseName: 'ii', metric: 'sync', value: s2ii.sync.median, limit: CEILING.ii });
        gate({ cell: 'real span2 (seeded)', caseName: 'ii', metric: 'settled', value: s2ii.settled.median, limit: CEILING.ii });
        gate({ cell: 'real span2 (seeded)', caseName: 'iii', metric: 'sync', value: s2deep.sync.median, limit: CEILING.iii });
        gate({ cell: 'real span2 (seeded)', caseName: 'iii', metric: 'settled', value: s2deep.settled.median, limit: CEILING.iii });
      }
      await page.close();
    }
  }

  // ── CANVAS — the corpus's only real canvas payloads ─────────────────────
  console.log('\n▶ CANVAS — jspsych-full sketchpad seeks (presentation inside the gate, not beside it)');
  {
    const model = buildViewerModel(jspsychFull);
    const page = await openViewer(browser, origin, model, 'canvas');
    // THE TARGET IS NOT THE SEGMENT'S LAST EVENT, and the reason is a recorded
    // property of the fixture rather than a convenience. Both sketchpad
    // segments TEAR DOWN their canvas before the segment ends: segment 9
    // removes node 8 at tRel 1505.1 (and then snapshots it — the
    // snapshot-after-remove specimen, T5.5 finding (a)), and segment 8 removes
    // the canvas's parent at 263.4. A seek past either point leaves the viewer
    // correctly presenting NOTHING, so a canvas cell aimed there would measure
    // a canvas-free restore while calling itself canvas-heavy. These targets
    // are the LAST playhead at which the canvas is still live, i.e. the most
    // composite work the fixture can be asked for.
    // The seg-9 cell also carries §5 step 2 for real, and the two session
    // `stylesheet_events` reach it by DIFFERENT routes (T5.9 review M-7):
    // `stylesheet.add` at t = 3592.0999 precedes segment 9's origin (3592.1999)
    // so `deriveSheets` replays it on every restore, while `stylesheet.remove`
    // at 5097.0999 falls inside the walked window (tRel 1504.9 <= the 1505.0
    // target) and arrives through the walk. Both are inside the gated number;
    // they are not the same mechanism.
    const CANVAS_CELLS = [
      { seg: 9, target: 1505.0, why: 'nine real region snapshots, all composited; node 8 is removed at 1505.1' },
      { seg: 8, target: 263.3, why: 'the 189,322-char full baseline; the canvas parent is removed at 263.4' },
    ];
    // M-8: the REAL and WORST blocks declare `durMs > lastT`; these cells
    // deliberately CANNOT, and the asymmetry is the point. `jspsych-full`
    // segment 9 has `durMs === lastT === 1506`, so its last event is
    // unreachable by any backward seek — which is why `--inject=no-canvas`,
    // aiming there, produces a mount-witness failure as well as the two
    // presentation ones. The targets below are hard-coded at the last LIVE
    // playhead instead, and the presented-chars assertion is what guards them
    // against a fixture refresh.
    check(model.segments[9].durMs === lastT(model, 9),
      `jspsych-full segment 9 ends ON its last event (durMs ${model.segments[9].durMs} === lastT ${lastT(model, 9)}) — ` +
      'the canvas cells use hard-coded live playheads for this reason, not the lastT rule the other blocks use');
    for (const cell0 of CANVAS_CELLS) {
      const segIdx = cell0.seg;
      const why = cell0.why;
      // --inject=no-canvas aims the canvas cells PAST the teardown instead, at
      // the segment's last event. That is the real defect this cell was written
      // with on the first pass: the seek is valid, the numbers are green, and
      // the viewer is correctly presenting nothing.
      const backTo = injected('no-canvas') ? lastT(model, segIdx) : cell0.target;
      const dur = model.segments[segIdx].durMs;
      // Every jspsych-full segment is its own keyframe, so this is a case-(ii)
      // shaped seek: mount one segment + replay its events, with the canvas
      // decode/composite/present chain inside `settled`.
      await page.evaluate((i) => window.__select(i), segIdx);
      const cell = await measure({
        page, v1page, v1acc, expectMount: 1, label: `canvas seg${segIdx}`,
        prep: () => page.evaluate((t) => window.__seek(t), dur),
        sample: () => page.evaluate((t) => window.__seekTimed(t), backTo),
      });
      recordGatedSpan('jspsych-full', model, segIdx, segIdx);
      res.cells[`canvas seg${segIdx}`] = cell;
      console.log(`  [jspsych-full segment ${segIdx}] backward ${fixed(dur, 1)} -> ${fixed(backTo, 1)} ms — ${why}`);
      console.log(`      sync          ${show(cell.sync)} ms`);
      console.log(`      settled       ${show(cell.settled)} ms   (decode + composite + toDataURL + present)`);
      console.log(`      settledFrame  ${show(cell.settledFrame)} ms   (report only)`);
      note(`canvas rules ${cell.probe.canvasRules}, presented ${cell.probe.presentedChars} chars, patchFailures ${cell.probe.counters.patchFailures}`);
      check(cell.probe.canvasRules >= 1 && cell.probe.presentedChars > 1000,
        `segment ${segIdx} actually presented a composite (${cell.probe.canvasRules} rule(s), ${cell.probe.presentedChars} chars) — a canvas cell that presents nothing measures nothing`);
      gate({ cell: `canvas seg${segIdx}`, caseName: 'ii', metric: 'sync', value: cell.sync.median, limit: CEILING.ii });
      gate({ cell: `canvas seg${segIdx}`, caseName: 'ii', metric: 'settled', value: cell.settled.median, limit: CEILING.ii });
    }
    assertClean(page.__watch);
    await page.close();
  }

  // ── WORST — the composite worst case, through the REAL restore ──────────
  console.log('\n▶ WORST — composite worst case (deep span + canvas), through the shipped viewer');
  {
    for (const canvas of [false, true]) {
      const { recording, canvasId } = worstCaseRecording(canvas);
      for (const checksOn of [true, false]) {
        const rec = (checksOn && !injected('no-checks')) ? recording : stripAlignment(recording);
        const model = buildViewerModel(rec);
        const tag = `worst canvas=${canvas ? 'on' : 'off'} checks=${checksOn ? 'on' : 'off'}`;
        const page = await openViewer(browser, origin, model, `worst-c${canvas ? 1 : 0}-k${checksOn ? 1 : 0}`);
        const kf = 0, deep = SPAN_SEGMENTS - 1;
        const kfLast = lastT(model, kf), deepLast = lastT(model, deep);
        check(model.segments[kf].durMs > kfLast && model.segments[deep].durMs > deepLast,
          `[${tag}] both target segments end after their last event — a backward seek replays every event`);

        // Interleave the control only on the composite worst case, which is
        // the configuration design §5's "faster than v1" claim is tested at.
        const ctl = (canvas && checksOn) ? { v1page, v1acc } : {};

        await page.evaluate((i) => window.__select(i), kf);
        const cii = await measure({
          page, ...ctl, expectMount: 1, label: `[${tag}] case ii`,
          prep: () => page.evaluate((t) => window.__seek(t), model.segments[kf].durMs),
          sample: () => page.evaluate((t) => window.__seekTimed(t), kfLast),
        });
        const mountOnly = await measure({
          page, expectMount: 1, label: `[${tag}] mount-only`,
          prep: () => page.evaluate((t) => window.__seek(t), model.segments[kf].durMs),
          sample: () => page.evaluate(() => window.__seekTimed(0)),
        });
        await page.evaluate((i) => window.__select(i), kf);
        const ci = await measure({
          page, expectMount: 0, label: `[${tag}] case i`,
          prep: () => page.evaluate((t) => window.__seek(t), 0),
          sample: () => page.evaluate((t) => window.__seekTimed(t), kfLast),
        });
        await page.evaluate((i) => window.__select(i), deep);
        const ciii = await measure({
          page, ...ctl, expectMount: 1, label: `[${tag}] case iii`,
          prep: () => page.evaluate((t) => window.__seek(t), model.segments[deep].durMs),
          sample: () => page.evaluate((t) => window.__seekTimed(t), deepLast),
        });

        recordGatedSpan('synthetic deep span', model, kf, kf);
        recordGatedSpan('synthetic deep span', model, kf, deep);
        res.cells[`${tag} case i`] = ci;
        res.cells[`${tag} case ii`] = cii;
        res.cells[`${tag} case iii`] = ciii;
        res.cells[`${tag} mount-only`] = mountOnly;

        console.log(`  [${tag}]`);
        for (const [label, cell] of [['i (forward, no mount)', ci], ['ii (mount + 1 segment)', cii], ['iii (mount + 10 segments)', ciii]]) {
          console.log(`    case ${label}`);
          console.log(`      sync          ${show(cell.sync)} ms`);
          console.log(`      settled       ${show(cell.settled)} ms`);
          console.log(`      settledFrame  ${show(cell.settledFrame)} ms   (report only)`);
        }
        note(`mount:events split — mount ${fixed(mountOnly.sync.median)} ms : one segment's events ${fixed(ci.sync.median)} ms`);
        note(`case iii: applied ${ciii.probe.applied} entries across ${ciii.probe.segmentsApplied} segments (case ii: ${cii.probe.applied}/${cii.probe.segmentsApplied}), ` +
             `checks ${ciii.probe.checks}, frame elements ${ciii.probe.frameElements}, ` +
             `canvas rules ${ciii.probe.canvasRules}, presented ${ciii.probe.presentedChars} chars, ` +
             `patchFailures ${ciii.probe.counters.patchFailures}, skipped ${ciii.probe.counters.skipped}`);

        // COVERAGE — every claim this cell makes about itself.
        check(ciii.probe.frameElements > 100, `[${tag}] case iii reconstructed the 535-node tree (${ciii.probe.frameElements} elements)`);
        check(ciii.probe.segmentsApplied === SPAN_SEGMENTS && cii.probe.segmentsApplied === 1,
          `[${tag}] case iii replayed ${ciii.probe.segmentsApplied} segments and case ii replayed ${cii.probe.segmentsApplied}`);
        check(ciii.probe.applied > cii.probe.applied * 5,
          `[${tag}] case iii applies ~10x case ii's entries (${ciii.probe.applied} vs ${cii.probe.applied})`);
        // The forward-walk witness (T5.9 review I-1) — see the REAL block.
        check(ci.probe.applied > mountOnly.probe.applied,
          `[${tag}] case i actually walked forward: ${ci.probe.applied} entries applied at its target vs ${mountOnly.probe.applied} at its start`);
        check(ciii.probe.counters.patchFailures === 0,
          `[${tag}] case iii left 0 unresolved patches (${ciii.probe.counters.patchFailures}) — a patch that resolves nothing costs nothing and deflates the deep case`);
        if (checksOn) check(ciii.probe.checks >= SPAN_SEGMENTS * EVENTS_PER_SEGMENT * ANCHORED_FRAC * 0.8,
          `[${tag}] case iii ran ${ciii.probe.checks} alignment checks (expected ~${Math.round(SPAN_SEGMENTS * EVENTS_PER_SEGMENT * ANCHORED_FRAC)})`);
        else check(ciii.probe.checks === 0, `[${tag}] alignment checks are OFF (${ciii.probe.checks})`);
        if (canvas) {
          check(ciii.probe.canvasRules >= 1 && ciii.probe.presentedChars > 1000,
            `[${tag}] case iii presented the composited canvas (${ciii.probe.presentedChars} chars for node ${canvasId})`);
          check(cii.probe.presentedChars > 1000, `[${tag}] case ii presented the baseline snapshot (${cii.probe.presentedChars} chars)`);
        } else {
          check(ciii.probe.canvasRules === 0, `[${tag}] canvas is OFF (${ciii.probe.canvasRules} rules)`);
        }
        assertClean(page.__watch);

        gate({ cell: tag, caseName: 'i', metric: 'sync', value: ci.sync.median, limit: CEILING.i });
        gate({ cell: tag, caseName: 'ii', metric: 'sync', value: cii.sync.median, limit: CEILING.ii });
        gate({ cell: tag, caseName: 'ii', metric: 'settled', value: cii.settled.median, limit: CEILING.ii });
        gate({ cell: tag, caseName: 'iii', metric: 'sync', value: ciii.sync.median, limit: CEILING.iii });
        gate({ cell: tag, caseName: 'iii', metric: 'settled', value: ciii.settled.median, limit: CEILING.iii });

        res.ratios[`WORST canvas=${canvas ? 'on' : 'off'}/checks=${checksOn ? 'on' : 'off'}/sync`] = ciii.sync.median / cii.sync.median;
        res.ratios[`WORST canvas=${canvas ? 'on' : 'off'}/checks=${checksOn ? 'on' : 'off'}/settled`] = ciii.settled.median / cii.settled.median;
        res.cells[`${tag} case iii`].worstRunRatio = ciii.sync.max / cii.sync.median;
        await page.close();
      }
    }
  }

  // ── FRAME FREEDOM — rule 3's "asserted, not assumed", made a check ──────
  // The load-bearing claim behind gating `settledMs` on WebKit is that the
  // metric does NOT contain an animation frame. The discriminator is the
  // canvas-free cells: for them `settledMs` is `syncMs` plus one microtask
  // (canvasSettled() resolves immediately with nothing to decode), so the
  // difference is ~0.01 ms. If the clock stopped after a requestAnimationFrame
  // instead, that difference would be a uniform draw from [0, one frame] and
  // its median would sit near half a frame — 4 ms on chromium, 16 on WebKit.
  // Two orders of magnitude apart, so the bound can be crude and still bite.
  console.log('\n▶ FRAME FREEDOM — settledMs carries no animation frame (rule 3, asserted)');
  {
    const frame = res.floor.rafFrame.median;
    const bound = Math.min(1.0, frame * 0.25);
    const canvasFree = Object.entries(res.cells)
      .filter(([k]) => !/canvas=on/.test(k) && !/^canvas seg/.test(k))
      .map(([k, c]) => ({ k, d: c.settled.median - c.sync.median }))
      .sort((a, b) => b.d - a.d);
    const worst = canvasFree[0];
    res.frameFreedom = { frameFloor: frame, bound, worstCell: worst.k, worstDelta: worst.d, n: canvasFree.length };
    note(`worst canvas-free (settled − sync) over ${canvasFree.length} cells: ${fixed(worst.d)} ms on "${worst.k}" ` +
         `— bound ${fixed(bound)} ms, one frame ${fixed(frame)} ms`);
    const free = worst.d < bound;
    check(free,
      `settledMs contains NO animation frame (worst canvas-free settled−sync ${fixed(worst.d)} ms < ${fixed(bound)} ms; ` +
      `a frame-carrying metric would sit near ${fixed(frame / 2)} ms) — this is what licenses gating settledMs on ${name}`);

    // The consequence rule 3 actually cares about: a gated settled median BELOW
    // this engine's frame floor is only meaningful because the metric excludes
    // the frame. Mark those cells, and if the assertion above ever fails,
    // downgrade every settled gate on this engine to REPORTED-ONLY so the table
    // cannot keep calling a frame clock a gate.
    const settledRows = gateRows.filter((r) => r.engine === name && r.metric === 'settled');
    const sub = settledRows.filter((r) => r.value < frame);
    settledRows.forEach((r) => { r.subFrame = r.value < frame; if (!free) r.reportedOnly = true; });
    note(`${sub.length}/${settledRows.length} gated settled cells sit below ${name}'s ${fixed(frame)} ms frame` +
         (free ? ' — sound, because the metric excludes it' : ' — REPORTED-ONLY: the metric does NOT exclude it'));
  }

  // ── THE RATIO, RE-DERIVED (rule 1) ──────────────────────────────────────
  console.log('\n▶ RATIO — case(iii)/case(ii), re-derived on this task\'s own fixtures');
  for (const [k, v] of Object.entries(res.ratios)) {
    console.log(`    ${k.padEnd(42)} ${fixed(v, 2)}x`);
  }
  {
    const gated = res.ratios['WORST canvas=off/checks=on/sync'];
    console.log('  the ONE gated cell (design §11 amendment 1, Task-0 rule 1): canvas=off / checks=on / sync');
    gate({ cell: 'WORST canvas=off/checks=on', caseName: 'iii/ii', metric: 'ratio', value: gated, limit: RATIO_BAND, unit: 'x' });
    note(`inherited nothing: Task 0 measured 4.99x and Task 1's reviewer 4.84x on a MODEL; this is ${fixed(gated, 2)}x on the real viewer over ${RUNS} samples`);
  }

  // ── O(n²) — continuous playback across a span (Task-4 amendment) ────────
  // Cases (i)-(iii) all measure SEEKS, so none of them sees this: `loadSegment`
  // resets the playhead and calls `restore`, so continuous playback across a
  // 10-segment span costs ten restores, the tenth replaying ten segments'
  // events. Measured on BOTH fixtures, because the real CH session's span
  // carries 45 events and the composite worst case carries 1000, and the whole
  // question is whether the wasted work is worth a line of state.
  console.log('\n▶ O(n²) — continuous playback across a span boundary');
  res.onSquared = {};
  for (const [tag, model] of [['REAL (45 events/span)', frozenModel], ['WORST (1000 events/span)', onSquaredWorstModel]]) {
    const page = await openViewer(browser, origin, model, 'onsquared-' + (tag.startsWith('REAL') ? 'real' : 'worst'));
    console.log(`  [${tag}]`);
    // (a) The structural claim: a SEGMENT CHANGE restores, even a forward one
    //     inside an already-applied span.
    await page.evaluate((i) => window.__select(i), 0);
    const forwardInSpan = await page.evaluate((i) => window.__selectTimed(i), 1);
    check(forwardInSpan.mountsDelta === 1 && forwardInSpan.spanStart === 0,
      `[${tag}] a forward segment change INSIDE the applied span still mounts (mounts delta ${forwardInSpan.mountsDelta}, spanStart ${forwardInSpan.spanStart}) — the O(n²) premise, measured`);

    // (b) The cost curve: what continuous playback pays at each boundary.
    const perSegment = [];
    for (let r = 0; r <= RUNS; r++) {
      await page.evaluate(() => window.__select(0));
      const row = [];
      for (let i = 0; i < SPAN_SEGMENTS; i++) {
        row.push(await page.evaluate((idx) => window.__selectTimed(idx), i));
      }
      if (r) perSegment.push(row);
    }
    const bySeg = [];
    for (let i = 0; i < SPAN_SEGMENTS; i++) bySeg.push(stat(perSegment.map((row) => row[i].syncMs)));
    const totals = stat(perSegment.map((row) => row.reduce((a, x) => a + x.syncMs, 0)));

    // (c) The counterfactual, modelled from the same viewer: ONE restore at the
    //     span keyframe plus a forward walk over every segment's events — which
    //     is what `applyUpTo(i, 0)` would do. It cannot be run end to end
    //     (crossing a segment boundary goes through loadSegment), so it is
    //     assembled from the same primitives and labelled as a model.
    const incremental = [];
    for (let r = 0; r <= RUNS; r++) {
      await page.evaluate(() => window.__select(0));
      const first = await page.evaluate((i) => window.__selectTimed(i), 0);
      let sum = first.syncMs;
      for (let i = 0; i < SPAN_SEGMENTS; i++) {
        if (i > 0) await page.evaluate((idx) => window.__select(idx), i);
        await page.evaluate(() => window.__seek(0));
        const m = await page.evaluate((t) => window.__seekTimed(t), lastT(model, i));
        sum += m.syncMs;
      }
      if (r) incremental.push(sum);
    }
    const incrementalStat = stat(incremental);

    recordGatedSpan(tag.startsWith('REAL') ? 'alignment-v2-frozen' : 'synthetic deep span',
      model, 0, SPAN_SEGMENTS - 1);
    res.onSquared[tag] = {
      forwardInSpanMountsDelta: forwardInSpan.mountsDelta,
      perSegmentSync: bySeg, totalSync: totals, incrementalModelSync: incrementalStat,
      worstBoundary: bySeg[SPAN_SEGMENTS - 1],
      wasteFactor: totals.median / incrementalStat.median,
    };
    console.log('    per-boundary restore cost (sync ms), segment 0 .. ' + (SPAN_SEGMENTS - 1) + ':');
    bySeg.forEach((s, i) => console.log(`      seg ${String(i).padStart(2)}  ${show(s)} ms`));
    console.log(`    TOTAL for one pass across the span      ${show(totals)} ms`);
    console.log(`    incremental-walk counterfactual (model) ${show(incrementalStat)} ms`);
    note(`the shipped path costs ${fixed(totals.median / incrementalStat.median, 2)}x the incremental one over this span; ` +
         `the analyst experiences the WORST BOUNDARY (${fixed(bySeg[SPAN_SEGMENTS - 1].median)} ms), not the total`);
    check(bySeg[SPAN_SEGMENTS - 1].median >= bySeg[0].median,
      `[${tag}] the per-boundary cost grows with depth (${fixed(bySeg[0].median)} -> ${fixed(bySeg[SPAN_SEGMENTS - 1].median)} ms) — the O(n²) shape, measured`);
    gate({ cell: `continuous playback ${tag}`, caseName: 'worst boundary', metric: 'sync', value: bySeg[SPAN_SEGMENTS - 1].median, limit: CEILING.iii });
    assertClean(page.__watch);
    await page.close();
  }

  // ── V1 CONTROL: the interleaved samples, and the faster-than-v1 verdict ──
  console.log('\n▶ V1 vs V2 — settled-to-settled, both carrying one animation frame (rule 2)');
  {
    const arm = (xs) => ({
      sync: stat(xs.map((x) => x.syncMs)),
      settledFrame: stat(xs.map((x) => x.settledFrameMs)),
      asyncCount: xs.filter((x) => x.wentAsync).length, n: xs.length,
    });
    res.v1 = { forward: arm(v1acc.forward), repeat: arm(v1acc.repeat), backward: arm(v1acc.backward) };
    for (const [label, a] of Object.entries(res.v1)) {
      console.log(`    v1 ${label.padEnd(9)} sync ${show(a.sync)} ms`);
      console.log(`    ${''.padEnd(12)} settledFrame ${show(a.settledFrame)} ms   [wentAsync ${a.asyncCount}/${a.n}]`);
    }
    check(res.v1.backward.asyncCount === res.v1.backward.n,
      `v1's backward seek is asynchronous on every sample (${res.v1.backward.asyncCount}/${res.v1.backward.n}) — timing its RETURN would report a frame rebuild as ${fixed(res.v1.backward.sync.median)} ms`);
    check(res.v1.forward.asyncCount === 0,
      `v1's forward seek is synchronous on every sample (${res.v1.forward.asyncCount}/${res.v1.forward.n} async)`);

    const v1back = res.v1.backward.settledFrame.median;
    const comparisons = [
      ['REAL case ii  (shallow)', res.cells['real-checks-on case ii'].settledFrame],
      ['REAL case iii (deep)', res.cells['real-checks-on case iii'].settledFrame],
      ['WORST case ii  (shallow, canvas+checks)', res.cells['worst canvas=on checks=on case ii'].settledFrame],
      ['WORST case iii (composite worst case)', res.cells['worst canvas=on checks=on case iii'].settledFrame],
    ];
    res.v1Comparison = { v1BackwardSettledFrame: v1back, frameFloor: res.floor.rafFrame.median, rows: {} };
    console.log(`    v1 backward settledFrame = ${fixed(v1back)} ms; v2 numbers below carry the SAME animation frame`);
    // M-3: `settledFrameMs` = settled + time-to-next-frame, and that addend is a
    // SESSION-LEVEL constant somewhere in [0, one frame] — tight within a run,
    // arbitrary between them. On a 32.7 ms frame that is most of the number, so
    // the min is printed beside the median and the rows are read as bounded, not
    // as two significant figures.
    for (const [label, st] of comparisons) {
      const ratio = st.median / v1back;
      res.v1Comparison.rows[label] = { v2: st.median, v2Min: st.min, ratio, ratioMin: st.min / v1back };
      console.log(`      ${label.padEnd(42)} ${fixed(st.median)} ms (min ${fixed(st.min)})  = ${fixed(ratio, 2)}x v1  (${ratio < 1 ? 'BELOW' : 'ABOVE'})`);
    }
    note(`the v2 rows carry a rAF-phase addend in [0, ${fixed(res.floor.rafFrame.median)} ms], constant within this session — ` +
         'read them as bounded, not as two significant figures (this is most of the number on WebKit)');
  }
  assertClean(v1page.__watch);
  await v1page.close();

  return res;
}

// ── main ───────────────────────────────────────────────────────────────────
console.log(`playwright-core ${resolved.version} (via ${resolved.from})`);
if (!existsSync(FROZEN_FIXTURE)) { console.error('missing frozen fixture ' + FROZEN_FIXTURE); process.exit(1); }
{
  const m = buildViewerModel(frozenRec);
  console.log(`REAL fixture: ${m.segments.length} segments, spans at ` +
    m.segments.map((s, i) => (s.keyframe ? i : null)).filter((x) => x !== null).join('/') +
    `, ${m.segments.reduce((a, s) => a + s.events.length, 0)} events, ` +
    `${m.segments.reduce((a, s) => a + s.events.filter((e) => e.camera || e.anchor).length, 0)} carrying §6 blocks`);
  console.log(`WORST fixture: ${SPAN_SEGMENTS} segments x ${EVENTS_PER_SEGMENT} events at ${Math.round(ANCHORED_FRAC * 100)}% anchored ` +
    `over jspsych-full segment 11 (${countNodes(jspsychFull.segments[11].initial_dom)} nodes) + real canvas payloads`);
}

// ── CHANNEL COVERAGE — computed AFTER the run, from the spans the gated cells
// actually replayed. See `recordGatedSpan`. (T5.9 review I-3/I-4.)
function reportChannelCoverage() {
  // The vocabulary is DERIVED from the shipped client, never hand-copied: the
  // first version anchored the sweep to Task 0's 20-entry omission list, so
  // `touch.start`/`touch.move`/`touch.end` fell out of BOTH the covered list
  // and the named-gap list — and `touch.start`/`touch.end` sit in capture's
  // `withAlignment` set, i.e. they fire the §8 check, which is this gate's own
  // headline cost driver. A vocabulary addition can no longer escape the
  // accounting; it lands in one list or the other by construction.
  const clientSrc = readFileSync(join(repoRoot, 'src', 'cli', 'renderers', 'replay-viewer.client.js'), 'utf8');
  const m = clientSrc.match(/var KNOWN_TYPES = \{\};\s*\(([\s\S]*?)\)\.split\(' '\)/);
  if (!m) {
    failures++;
    console.error('  ✖ could not extract KNOWN_TYPES from the client — the coverage sweep is anchored to it by design');
    return;
  }
  const known = m[1].replace(/'|\+|\s+/g, ' ').split(' ').map((t) => t.trim()).filter(Boolean);

  console.log('\n════════ CHANNEL COVERAGE (rule 5, per GATED CELL) ════════');
  const covered = new Set();
  let seededSpans = 0, derivedSheetEvents = 0, walkedSheetEvents = 0;
  for (const sp of gatedSpans) {
    const kf = sp.model.segments[sp.from];
    if (kf && kf.initialState) seededSpans++;
    for (let i = sp.from; i <= sp.to; i++) {
      for (const e of sp.model.segments[i].events) covered.add(e.type);
    }
    // §5 step 2: session `stylesheet_events` up to the SPAN KEYFRAME's origin
    // are replayed by `deriveSheets` on every restore; ones inside the walked
    // window arrive through the walk instead. Both are inside the cell; they
    // are not the same mechanism, and the first version's prose conflated them.
    const sheets = sp.model.stylesheetEvents || [];
    const endOrigin = sp.model.segments[sp.to].origin + sp.model.segments[sp.to].durMs;
    for (const ev of sheets) {
      if (ev.t <= kf.origin) derivedSheetEvents++;
      else if (ev.t <= endOrigin) walkedSheetEvents++;
    }
  }
  console.log(`  ${gatedSpans.length} distinct gated spans:`);
  for (const sp of gatedSpans) {
    console.log(`    ${sp.fixture} segments ${sp.from}..${sp.to}` +
      (sp.model.segments[sp.from].initialState ? '  [keyframe carries initial_state]' : ''));
  }
  const gaps = known.filter((t) => !covered.has(t));
  const inside = known.filter((t) => covered.has(t));
  console.log(`  INSIDE a gated number (${inside.length}/${known.length} of the client's own vocabulary):`);
  console.log(`    ${inside.sort().join(' ')}`);
  console.log(`  …plus initial_state seeding (${seededSpans} gated span(s) whose keyframe carries one) and ` +
    `stylesheet_events (${derivedSheetEvents} replayed by deriveSheets to the keyframe origin, ` +
    `${walkedSheetEvents} arriving through the walk).`);
  console.log(`  NOT reachable by any gated cell — ${gaps.length}, NAMED rather than implied:`);
  console.log(`    ${gaps.sort().join(' ')}`);
  console.log('  §12 instantiation filters run on every mount by construction (the real mountTree).');

  // Cross-reference against Task 0's own list of omissions, because rule 5 is
  // phrased against it. This list is a HISTORICAL reference only — the sweep
  // above is derived from the client — and it is printed so the two counts
  // cannot be confused: 21 of the client's 35 types are ungated, while of Task
  // 0's 20 named omissions only three are inside a gated cell.
  const T0_OMISSIONS = [
    'input.value', 'input.checked', 'input.select', 'scroll.window', 'scroll.element',
    'clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'clipboard.drop',
    'media.play', 'media.pause', 'media.ended', 'media.seeked', 'media.time',
    'focus', 'blur', 'visibility.hidden', 'visibility.visible',
    'fullscreen.enter', 'fullscreen.exit',
  ];
  const t0In = T0_OMISSIONS.filter((t) => covered.has(t));
  console.log(`  cross-reference — of Task 0's ${T0_OMISSIONS.length} named omissions, ${t0In.length} are inside a gated cell ` +
    `(${t0In.join(' ')}); the rest are in the gap list above, together with touch.* which was in NEITHER list before this fix round.`);
  check(T0_OMISSIONS.every((t) => known.includes(t)),
    `Task 0's omission list is a subset of the client's vocabulary — the cross-reference cannot drift into naming a type the viewer does not have`);

  // Mechanical completeness: every type the viewer knows is in exactly one list.
  const accounted = new Set([...inside, ...gaps]);
  check(accounted.size === known.length && known.every((t) => accounted.has(t)),
    `every one of the client's ${known.length} known types lands in exactly one list — the enumeration is derived, not copied`);
  check(seededSpans >= 1, `initial_state seeding is inside a gated number (${seededSpans} gated span(s))`);
  check(derivedSheetEvents + walkedSheetEvents >= 1,
    `stylesheet_events replay is inside a gated number (${derivedSheetEvents} derived + ${walkedSheetEvents} walked)`);
  check(inside.length >= 12,
    `${inside.length} of the client's ${known.length} event types are inside a gated number`);
  out.channelCoverage = {
    knownTypes: known.length, inside: inside.sort(), gaps: gaps.sort(),
    seededSpans, derivedSheetEvents, walkedSheetEvents,
    spans: gatedSpans.map((sp) => ({ fixture: sp.fixture, from: sp.from, to: sp.to })),
  };
}

const server = await serveFiles(new Map(), { isolate: ISOLATE });
for (const name of ENGINES) {
  if (!pw[name]) { failures++; console.error(`✖ unknown engine ${name}`); continue; }
  let browser = null;
  try {
    browser = await pw[name].launch({ headless: HEADLESS });
  } catch (e) {
    failures++;
    console.error(`✖ ${name} NOT LAUNCHED: ${e.message}`);
    continue;
  }
  try { out.engines[name] = await runEngine(name, browser, server.origin); }
  catch (err) { failures++; console.error(`✖ ${name} threw: ${err.stack || err.message}`); }
  finally { await browser.close(); }
}
await server.close();

engineTag = '';
reportChannelCoverage();

// ── the gate table ─────────────────────────────────────────────────────────
console.log('\n════════════ GATE VERDICTS ════════════');
const failing = gateRows.filter((r) => !r.pass);
for (const r of gateRows) {
  const mark = r.reportedOnly ? '  [REPORTED-ONLY: settledMs carries a frame on this engine]'
    : (r.subFrame ? '  [sub-frame]' : '');
  console.log(`  ${r.reportedOnly ? 'RPT!' : (r.pass ? 'PASS' : 'FAIL')}  ${r.engine.padEnd(9)} ${r.cell.padEnd(34)} case ${String(r.case).padEnd(14)} ${r.metric.padEnd(8)} ${fixed(r.value)}${r.unit} / ${r.limit}${r.unit}${mark}`);
}
console.log(`  ${gateRows.length - failing.length}/${gateRows.length} gates pass`);
out.gates = gateRows;

const file = join(artifactsDir, `seek-budget-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nartifact: ${file}`);
console.log(failures ? `FAIL — ${failures} problem(s)` : 'OK — every gate met, every coverage assertion held');
process.exit(failures ? 1 : 0);
