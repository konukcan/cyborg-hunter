// tools/gen-example-fixtures.mjs
//
// Hand-authored-by-construction example participants for the demo's results
// screen (spec §7.2 / plan Task C1): "example-1" (HARD-leaning) and
// "example-2" (CLEAN) sit beside the visitor's own session so the report
// never looks empty. Deterministic: a seeded mulberry32 PRNG plus a fixed
// EPOCH decide every value — no Date.now(), no Math.random() — so
// regenerating this file is byte-identical. Every field name/shape below is
// copied from the real signal modules (src/core/signals/{clipboard,focus,
// mouse,typing}.js) and the real trial-report writer (src/core/monitor.js
// endTrial()), and every scoring constant is read from the library's actual
// 'standard' preset (src/shared/constants.js) — nothing here is derived
// from, sampled from, or modeled on any real participant's data. Every
// individual number (durations, paste counts, typing speeds) is chosen by
// hand to tell one deliberate story per example.
//
// Usage:
//   node tools/gen-example-fixtures.mjs             # writes demo/assets/example-participants.json
//   node tools/gen-example-fixtures.mjs --stdout    # prints to stdout (determinism test uses this)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRESETS, DEFAULT_THRESHOLDS, VERSION } from '../src/shared/constants.js';

// Read the real screening parameters from the 'standard' preset (same one
// demo/demo.js initializes with) instead of hand-typing thresholds that
// could silently drift from the library. Merge order matches monitor.js.
const SCORING = PRESETS.standard.scoring;
const THRESHOLDS = { ...DEFAULT_THRESHOLDS, ...PRESETS.standard.thresholds };

// Fixed epoch — perfNow=0 maps to this wall-clock instant. Arbitrary but
// fixed, so isoAt() below is deterministic across runs.
const EPOCH = 1767225600000; // 2026-01-01T00:00:00.000Z

// perfNow (session-relative ms — the same clock trial.startTime and
// tabAwayEvents[].start use) -> wall-clock ISO string, anchored at EPOCH.
function isoAt(perfNowMs) {
  return new Date(EPOCH + perfNowMs).toISOString();
}

// mulberry32: a tiny deterministic PRNG. Same seed -> same sequence forever,
// which is what makes regenerating this file byte-identical (the plan's
// determinism gate).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// windowPositions sample shape polled by core/signals/browser.js and read by
// extract-core / trajectories-core's pickWindowGeometryForTrial: x/y/w/h are
// the outer window rect, iw/ih the inner viewport, sw/sh the screen, dpr and
// vvScale the zoom diagnostics. One consistent geometry for both examples,
// chosen so there is no window/screen paradox (y + h <= sh) — the
// trajectories renderer then draws both the window AND screen outlines.
const WINDOW_GEOM = { x: 40, y: 60, w: 1280, h: 800, iw: 1264, ih: 700, sw: 1440, sh: 900, dpr: 1, vvScale: 1 };

// A plausible per-trial mouse path: a wandering curve with seeded jitter and
// occasional mousedown/mouseup pairs, bounded well inside WINDOW_GEOM's
// 1264x700 viewport so the trajectories renderer's window/screen outlines
// honestly contain the drawn path. `t` is TRIAL-relative ms, matching
// src/core/signals/mouse.js's `performance.now() - trialStartTime`.
function mousePath(rnd, durationMs, n) {
  const events = [];
  let x = 80 + rnd() * 400;
  let y = 80 + rnd() * 260;
  events.push({ x: Math.round(x), y: Math.round(y), t: 1, type: 'click' });
  for (let i = 0; i < n; i++) {
    const t = 1 + Math.round((i / Math.max(1, n - 1)) * durationMs);
    x = Math.min(1180, Math.max(20, x + (rnd() - 0.5) * 36));
    y = Math.min(660, Math.max(20, y + (rnd() - 0.5) * 24));
    events.push({ x: Math.round(x), y: Math.round(y), t, type: 'move' });
    // A mousedown/mouseup pair every ~55 moves — occasional clicks along the
    // path, matching the trajectories renderer's down/up marker legend.
    if (i > 0 && i % 55 === 0) {
      events.push({ x: Math.round(x), y: Math.round(y), t: t + 1, type: 'down' });
      events.push({ x: Math.round(x), y: Math.round(y), t: t + 90, type: 'up' });
    }
  }
  return events;
}

// Builds one trial's { trialId, integrity } record and advances `state` (the
// running session clock plus cumulative hard-signal counters) in place.
// Mirrors monitor.js's endTrial(): trialSignals.hard.*.sessionTotal is the
// CUMULATIVE session count at the moment each trial ends (sessionData.
// pasteCount/dropCount increment live as each event fires, before
// computeTrialScores reads them) — so state must thread trial-to-trial in
// order, not be computed independently per trial.
//
// spec: { durationMs, cps?, mousePoints, pastes?: [str,...], copies?: [str,...],
//         tabAways?: [{offsetMs, durationMs}], synthetic?: bool }
function buildTrial(rnd, state, trialId, spec) {
  const start = state.cursor; // session-relative perfNow at trial start
  const duration_ms = spec.durationMs;
  const end = start + duration_ms;

  // Field shapes copied from src/core/signals/clipboard.js: `t` on
  // paste/copy/synthetic events is the RAW (session-relative) performance.now()
  // — unlike mouseEvents' trial-relative `t`, these are never rebased.
  const pasteEvents = (spec.pastes || []).map((text, i) => ({
    type: 'paste', t: start + 900 + i * 500, pastedLength: text.length,
    isKnownInput: null, text
  }));
  const copyEvents = (spec.copies || []).map(text => ({
    type: 'copy', t: start + 300, selectedLength: text.length
  }));
  const tabAwayEvents = (spec.tabAways || []).map(ta => ({
    start: start + ta.offsetMs, duration_ms: ta.durationMs, type: 'windowBlur',
    timestamp: isoAt(start + ta.offsetMs)
  }));
  const syntheticInsertions = spec.synthetic
    ? [{ type: 'synthetic_insertion', t: start + Math.round(duration_ms * 0.4), dataLength: 42 }]
    : [];

  state.pasteTotal += pasteEvents.length;
  // No drop narrative in either example — dropTotal stays 0, but the field
  // still threads through so hardScore.drop matches the real shape (present,
  // untriggered) rather than being silently omitted.
  state.dropTotal += 0;

  const hardPaste = {
    trialHits: pasteEvents.length, sessionTotal: state.pasteTotal,
    countThreshold: SCORING.hard.paste.countThreshold
  };
  const hardDrop = {
    trialHits: 0, sessionTotal: state.dropTotal,
    countThreshold: SCORING.hard.drop.countThreshold
  };

  const copyHits = copyEvents.length;
  const copyCapped = Math.min(copyHits, SCORING.soft.copy.maxPerTrial);
  const softCopy = { hits: copyHits, capped: copyCapped, score: copyCapped * SCORING.soft.copy.weight };

  const tabHits = tabAwayEvents.filter(e => e.duration_ms > THRESHOLDS.tabAwayDurationMs).length;
  const tabCapped = Math.min(tabHits, SCORING.soft.tabAway.maxPerTrial);
  const softTabAway = { hits: tabHits, capped: tabCapped, score: tabCapped * SCORING.soft.tabAway.weight };

  const soft = { copy: softCopy, tabAway: softTabAway };
  let trialSoftScore = softCopy.score + softTabAway.score;
  // typingSpeed is only scored (and only present in trialSignals.soft) when
  // charsPerSec was actually computed for the trial — matches
  // src/core/scoring.js's `report.charsPerSec != null` gate, and the fixture
  // source-of-truth DEMO-FIXT.json, where the paste-only trial carries no
  // charsPerSec/typingSpeed key at all.
  if (typeof spec.cps === 'number') {
    const hit = spec.cps > THRESHOLDS.typingSpeedCps ? 1 : 0;
    soft.typingSpeed = {
      charsPerSec: spec.cps, threshold: THRESHOLDS.typingSpeedCps,
      hit, score: hit * SCORING.soft.typingSpeed.weight
    };
    trialSoftScore += soft.typingSpeed.score;
    state.charsPerSec.push(spec.cps);
  }

  state.cursor = end;
  state.tabAwaySums.push(...tabAwayEvents.map(e => e.duration_ms));
  state.tabAwayEventsAll.push(...tabAwayEvents);

  const integrity = {
    trialId, phase: 'default', startTime: start,
    pasteEvents, copyEvents, dropEvents: [],
    editTimestamps: [], // wiped by the keystroke-dynamics privacy gate (off by default)
    // Raw mouse track, under the field name monitor.js's rawMouseTrack
    // passthrough writes (A8) — extract-core's FIELD_MAP maps this to
    // mouseEvents and derives mouseDataAvailable.
    mouseTrack: mousePath(rnd, duration_ms, spec.mousePoints),
    tabAwayEvents, idleGaps: [], foreignInputEvents: [], syntheticInsertions,
    mouseTrackingCapped: false, mouseTrackingCappedAtMs: null,
    duration_ms, libraryVersion: VERSION, participantId: state.participantId,
    timestamp: isoAt(end),
    trialSoftScore,
    trialSignals: { hard: { paste: hardPaste, drop: hardDrop }, soft }
  };
  if (typeof spec.cps === 'number') integrity.charsPerSec = spec.cps;
  return { trialId, integrity };
}

// Builds one full participant payload: trials plus the session-level
// metadata.integritySession / integrityScore blocks extract-core reads for
// the authoritative hard/soft tier (summary.js prefers
// participant.score.anyHardTriggered / .softScore over any per-trial
// recount — see summary.js:123-140).
function buildParticipant(participantId, seed, trialSpecs, opts = {}) {
  const rnd = mulberry32(seed);
  const state = {
    participantId, cursor: trialSpecs[0].startAt ?? 80,
    pasteTotal: 0, dropTotal: 0, charsPerSec: [], tabAwaySums: [], tabAwayEventsAll: []
  };
  const trials = trialSpecs.map(spec => buildTrial(rnd, state, spec.id, spec));

  const hardScore = {
    paste: {
      count: state.pasteTotal, threshold: SCORING.hard.paste.countThreshold,
      triggered: state.pasteTotal >= SCORING.hard.paste.countThreshold
    },
    drop: {
      count: state.dropTotal, threshold: SCORING.hard.drop.countThreshold,
      triggered: state.dropTotal >= SCORING.hard.drop.countThreshold
    }
  };
  const softScore = trials.reduce((s, t) => s + t.integrity.trialSoftScore, 0);
  const anyHardTriggered = hardScore.paste.triggered || hardScore.drop.triggered;

  // Three window-position polls spanning the session (start, midpoint, end)
  // — enough for pickWindowGeometryForTrial to find an in-range sample for
  // every trial, all sharing the one consistent WINDOW_GEOM.
  const windowPositions = [0, 0.5, 1].map(f => ({ ...WINDOW_GEOM, t: Math.round(state.cursor * f) }));

  const integritySession = {
    pasteCount: state.pasteTotal, copyCount: opts.copyCount ?? 0, dropCount: state.dropTotal,
    tabAwaySums: state.tabAwaySums, tabAwayEvents: state.tabAwayEventsAll,
    charsPerSec: state.charsPerSec,
    sidebarEvents: [], devToolsEvents: [], aiExtensionsFound: [], keyboardShortcuts: [],
    windowPositions, idleGaps: [], extensionInjections: [], viewportWidthShifts: [],
    layoutShifts: [], zoomChanges: [],
    hardScore, softScore, trialsCompleted: trials.length,
    softScoreThreshold: SCORING.softScoreThreshold, anyHardTriggered,
    config: {
      preset: 'standard', participantId,
      thresholds: { tabAwayDurationMs: THRESHOLDS.tabAwayDurationMs, typingSpeedCps: THRESHOLDS.typingSpeedCps }
    },
    libraryVersion: VERSION
  };
  // Mirrors the smaller getSessionScore()-shaped object real payloads save
  // alongside the full getSessionReport() (see DEMO-FIXT.json's
  // metadata.integrityScore) — findSessionData() prefers this when present.
  const integrityScore = {
    hardScore, softScore, anyHardTriggered,
    trialsCompleted: trials.length, softScoreThreshold: SCORING.softScoreThreshold
  };

  const participant = { participantId, trials, metadata: { integritySession, integrityScore } };
  if (opts.guardFriction) participant.guardFriction = opts.guardFriction;
  return participant;
}

// ── example-1: HARD-leaning ──────────────────────────────────────────────
// Trial 1 ("q1"): an ordinary typed answer — nothing flagged. Trial 2
// ("q2"): copies the question, then pastes the same short answer twice —
// 2 pastes crosses the standard preset's paste hard-trigger (countThreshold
// 2) — plus a long (14.2s) and a medium (4.1s) tab-away. Trial 3 ("q3"):
// fast, synthetic-flavored typing (22.4 cps, over the 10 cps soft
// threshold) plus one more medium tab-away. A short guard-friction
// violation trail closes the session, as if the participant briefly left
// fullscreen twice during the guarded act.
function makeExample1() {
  return buildParticipant('example-1', 101, [
    { id: 'q1', startAt: 100, durationMs: 41000, cps: 5.1, mousePoints: 220 },
    {
      id: 'q2', durationMs: 62000, mousePoints: 260,
      copies: ['What is the capital of Australia?'], pastes: ['Canberra', 'Canberra'],
      tabAways: [{ offsetMs: 12000, durationMs: 14200 }, { offsetMs: 45000, durationMs: 4100 }]
    },
    {
      id: 'q3', durationMs: 38000, cps: 22.4, mousePoints: 90, synthetic: true,
      tabAways: [{ offsetMs: 9000, durationMs: 6500 }]
    },
  ], {
    copyCount: 1,
    guardFriction: {
      violations: [
        { t: 132000, reason: 'fullscreen_exit', phase: 'guard' },
        { t: 137500, reason: 'window_blurred', phase: 'guard' },
      ]
    }
  });
}

// ── example-2: CLEAN ─────────────────────────────────────────────────────
// Three ordinary typed answers at a human pace (4.6-5.3 cps, well under the
// 10 cps soft threshold). One brief tab-away (1.4s) — a flicker at or below
// the 3s soft-scoring cutoff, so it never contributes to the soft score.
// Nothing hard, nothing soft: clean.
function makeExample2() {
  return buildParticipant('example-2', 202, [
    { id: 'q1', startAt: 80, durationMs: 36000, cps: 4.6, mousePoints: 240 },
    {
      id: 'q2', durationMs: 52000, cps: 5.3, mousePoints: 280,
      tabAways: [{ offsetMs: 20000, durationMs: 1400 }]
    },
    { id: 'q3', durationMs: 33000, cps: 4.9, mousePoints: 210 },
  ]);
}

const out = JSON.stringify([makeExample1(), makeExample2()], null, 2) + '\n';

if (process.argv.includes('--stdout')) {
  process.stdout.write(out);
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', 'demo', 'assets', 'example-participants.json');
  writeFileSync(outPath, out);
  console.log(`Wrote ${outPath}`);
}
