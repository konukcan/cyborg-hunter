// tests/demo/playground.test.js
// DOM-free unit tests for the C3 config playground's two pure pieces:
// makeDebounced (generic coalescing timer) and recomputeSignals (the
// pre-pass that rewrites raw session/trial data as if the participant had
// been screened under different settings — see playground.js's docblock for
// why config overrides alone can't move EITHER tier boundary).
//
// Scoring weights come from the committed demo/signal-manifest.json's
// presets block — the same data path the browser playground uses — which
// tests/tools/signal-manifest.test.js pins against src/shared/constants.js.
// The tier-flip tests run the RECOMPUTED payloads through the REAL pipeline
// (extract → summary → triage) so a recompute that writes the right-looking
// fields in the wrong place can't pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeDebounced, recomputeSignals } from '../../demo/playground.js';
import { extractIntegrityData } from '../../src/cli/extract-core.js';
import { computeSummary } from '../../src/cli/analyzers/summary.js';
import { detectEdgeExits } from '../../src/cli/analyzers/edge-exit.js';
import { rankTriage } from '../../src/cli/analyzers/triage.js';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(here, '..', '..', 'demo', 'signal-manifest.json'), 'utf8'));
const STD = MANIFEST.presets.standard.scoring;
const STRICT = MANIFEST.presets.strict.scoring;
const FIXTURE_PATH = join(here, '..', '..', 'demo', 'assets', 'example-participants.json');

function loadExample(id) {
  const examples = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const p = examples.find((x) => x.participantId === id);
  assert.ok(p, `fixture is missing ${id}`);
  return p;
}

// One payload through the real CLI pipeline -> its triage entry.
function triageOf(payload) {
  const cfg = { outputDir: '.', participantIdField: 'participantId' };
  const p = extractIntegrityData(payload, cfg);
  const summaries = computeSummary([p], cfg);
  return rankTriage(summaries, detectEdgeExits([p], cfg), cfg)[0];
}

test('makeDebounced coalesces bursts', async () => {
  let calls = 0;
  const fn = makeDebounced(function () { calls++; }, 30);
  fn(); fn(); fn();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 1);
});

test('makeDebounced forwards the arguments of the LAST call in a burst', async () => {
  const seen = [];
  const fn = makeDebounced(function (x) { seen.push(x); }, 20);
  fn('first'); fn('second'); fn('third');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, ['third']);
});

// Minimal Shape-1 payload with one trial carrying `pasteCount` pastes and a
// pre-existing trialSignals/session shape — the same fields
// buildPayload()+monitor.getSessionReport() produce (payload.js's docblock,
// monitor.js endTrial/getSessionReport).
function pastePayload(pasteCount, existingCountThreshold) {
  const pasteEvents = Array.from({ length: pasteCount }, (_, i) => ({
    type: 'paste', t: 1000 + i, pastedLength: 8, isKnownInput: null, text: 'Canberra',
  }));
  const triggeredAtCollection = pasteCount >= existingCountThreshold;
  return {
    participantId: 'DEMO-test',
    trials: [{
      trialId: 'act1-paste',
      integrity: {
        trialId: 'act1-paste',
        startTime: 100,
        duration_ms: 30000,
        pasteEvents,
        copyEvents: [],
        dropEvents: [],
        tabAwayEvents: [],
        foreignInputEvents: [],
        charsPerSec: 12,
        trialSoftScore: 2,
        trialSignals: {
          hard: {
            paste: { trialHits: pasteCount, sessionTotal: pasteCount, countThreshold: existingCountThreshold },
            drop: { trialHits: 0, sessionTotal: 0, countThreshold: 2 },
          },
          soft: {
            copy: { hits: 0, capped: 0, score: 0 },
            tabAway: { hits: 0, capped: 0, score: 0 },
            typingSpeed: { charsPerSec: 12, threshold: 10, hit: 1, score: 2 },
          },
        },
      },
    }],
    metadata: {
      integritySession: {
        sidebarEvents: [],
        keyboardShortcuts: [],
        hardScore: {
          paste: { count: pasteCount, threshold: existingCountThreshold, triggered: triggeredAtCollection },
          drop: { count: 0, threshold: 2, triggered: false },
        },
        softScore: 2,
        softScoreThreshold: 6,
        anyHardTriggered: triggeredAtCollection,
        trialsCompleted: 1,
        config: { preset: 'standard', thresholds: { tabAwayDurationMs: 3000, typingSpeedCps: 10 } },
      },
      integrityScore: {
        hardScore: {
          paste: { count: pasteCount, threshold: existingCountThreshold, triggered: triggeredAtCollection },
          drop: { count: 0, threshold: 2, triggered: false },
        },
        softScore: 2,
        softScoreThreshold: 6,
        anyHardTriggered: triggeredAtCollection,
        trialsCompleted: 1,
      },
    },
  };
}

const STD_CONTROLS = { pasteHardCount: 2, tabAwayCutoffMs: 3000, typingSpeedCps: 10 };

// ── Hard tier ──────────────────────────────────────────────────────────

test('recomputeSignals: 2 pastes, threshold 2 -> anyHardTriggered true', () => {
  const payload = pastePayload(2, 2); // collected under the standard preset's own threshold (2)
  const [out] = recomputeSignals([payload], { ...STD_CONTROLS, pasteHardCount: 2 }, STD);
  assert.equal(out.metadata.integritySession.anyHardTriggered, true);
  assert.equal(out.metadata.integrityScore.anyHardTriggered, true);
  assert.deepEqual(out.trials[0].integrity.trialSignals.hard.paste,
    { trialHits: 2, sessionTotal: 2, countThreshold: 2 });
});

test('recomputeSignals: 2 pastes, threshold 3 -> anyHardTriggered false', () => {
  const payload = pastePayload(2, 2);
  const [out] = recomputeSignals([payload], { ...STD_CONTROLS, pasteHardCount: 3 }, STD);
  assert.equal(out.metadata.integritySession.anyHardTriggered, false);
  assert.equal(out.metadata.integrityScore.anyHardTriggered, false);
  assert.deepEqual(out.metadata.integritySession.hardScore.paste,
    { count: 2, threshold: 3, triggered: false });
});

test('recomputeSignals: an existing non-paste hard trigger survives a paste threshold change', () => {
  const payload = pastePayload(0, 2);
  payload.metadata.integritySession.hardScore.drop.triggered = true;
  payload.metadata.integritySession.anyHardTriggered = true;
  payload.metadata.integrityScore.hardScore.drop.triggered = true;
  payload.metadata.integrityScore.anyHardTriggered = true;
  const [out] = recomputeSignals([payload], { ...STD_CONTROLS, pasteHardCount: 5 }, STD);
  // 0 pastes never crosses 5, but the pre-existing drop trigger (no
  // playground control for drop) must still carry the tier.
  assert.equal(out.metadata.integritySession.anyHardTriggered, true);
});

// ── Soft score: full recompute from raw events ─────────────────────────

test('recomputeSignals: typing term recomputed from stored raw charsPerSec', () => {
  const payload = pastePayload(0, 2); // charsPerSec: 12, collection-time hit at threshold 10
  const stricter = recomputeSignals([payload], { ...STD_CONTROLS, typingSpeedCps: 15 }, STD)[0];
  assert.deepEqual(stricter.trials[0].integrity.trialSignals.soft.typingSpeed,
    { charsPerSec: 12, threshold: 15, hit: 0, score: 0 }); // measured cps unchanged, verdict recomputed
  assert.equal(stricter.trials[0].integrity.trialSoftScore, 0);
  assert.equal(stricter.metadata.integritySession.softScore, 0);
  assert.equal(stricter.metadata.integrityScore.softScore, 0);

  const looser = recomputeSignals([payload], { ...STD_CONTROLS, typingSpeedCps: 8 }, STD)[0];
  assert.deepEqual(looser.trials[0].integrity.trialSignals.soft.typingSpeed,
    { charsPerSec: 12, threshold: 8, hit: 1, score: STD.soft.typingSpeed.weight });
  assert.equal(looser.metadata.integritySession.softScore, STD.soft.typingSpeed.weight);
});

test('recomputeSignals: default controls reproduce example-1\'s own collection-time scoring exactly', () => {
  // Faithfulness pin: recomputing under the SAME settings the fixture was
  // generated with must be a no-op for every scored field — the strongest
  // check that the scoring.js mirror is line-faithful, not approximate.
  const example1 = loadExample('example-1');
  const [out] = recomputeSignals([example1], STD_CONTROLS, STD);
  assert.deepEqual(out, example1);
});

test('recomputeSignals: tightening typing/tab-away controls flips example-2 CLEAN -> SOFT through the real triage', () => {
  const example2 = loadExample('example-2');
  // Untouched baseline: clean on both flags.
  const before = triageOf(example2);
  assert.equal(before.hardTriggered, false);
  assert.equal(before.softFlagged, false);
  assert.equal(example2.metadata.integritySession.softScore, 0);

  // Tighten: cps 4 makes all three typed trials (4.6/5.3/4.9 cps) fast
  // (3 x weight 2 = 6), cutoff 1000ms scores the 1400ms tab-away (+1) -> 7.
  const [out] = recomputeSignals([example2], { pasteHardCount: 2, tabAwayCutoffMs: 1000, typingSpeedCps: 4 }, STD);
  assert.equal(out.metadata.integritySession.softScore, 7);
  const after = triageOf(out);
  assert.equal(after.hardTriggered, false);
  assert.equal(after.softFlagged, true); // the SOFT/CLEAN boundary moved — the reviewer's blocking case
});

test('recomputeSignals: loosening drops example-1\'s soft score and, with paste at 3, lands it CLEAN', () => {
  const example1 = loadExample('example-1');
  assert.equal(example1.metadata.integritySession.softScore, 7); // collection-time: 7 >= 6

  // Loosen everything: cutoff 15s ignores all tab-aways (max 14.2s), cps 25
  // ignores the 22.4cps trial, paste threshold 3 unwinds the hard flag.
  // Only q2's copy event survives (1 x weight 2) -> 2 < 6.
  const [out] = recomputeSignals([example1], { pasteHardCount: 3, tabAwayCutoffMs: 15000, typingSpeedCps: 25 }, STD);
  assert.equal(out.metadata.integritySession.softScore, 2);
  assert.deepEqual(out.trials.map((t) => t.integrity.trialSoftScore), [0, 2, 0]);
  const after = triageOf(out);
  assert.equal(after.hardTriggered, false);
  assert.equal(after.softFlagged, false); // HARD at collection -> CLEAN under loosened settings
});

test('recomputeSignals: strict scoring re-scores with strict weights, threshold, and gating (no soft copy)', () => {
  const example1 = loadExample('example-1');
  const strictControls = MANIFEST.presets.strict.controls; // {pasteHardCount: 1, tabAwayCutoffMs: 5000, typingSpeedCps: 8}
  const [out] = recomputeSignals([example1], strictControls, STRICT);
  // q2: tabAway 14200ms > 5000, capped at strict's maxPerTrial 1, x2 = 2
  // q3: tabAway 6500ms x2 = 2, typing 22.4 > 8 x3 = 3 -> 5; copy scores
  // NOTHING under strict (hard-only there) — total 7 against threshold 4.
  assert.deepEqual(out.trials.map((t) => t.integrity.trialSoftScore), [0, 2, 5]);
  assert.equal(out.metadata.integritySession.softScore, 7);
  assert.equal(out.metadata.integritySession.softScoreThreshold, STRICT.softScoreThreshold);
  assert.equal(out.metadata.integrityScore.softScoreThreshold, STRICT.softScoreThreshold);
  for (const t of out.trials) {
    assert.equal(t.integrity.trialSignals.soft.copy, undefined, 'strict must not score copy soft');
  }
  assert.equal(out.metadata.integritySession.anyHardTriggered, true); // 2 pastes >= strict's 1
});

test('recomputeSignals: tab-away/typing controls land on the participant\'s saved thresholds', () => {
  // summary.js/session-timeline-core.js/typing-profile-core.js all prefer
  // participant.session.config.thresholds.* over any CLI config override —
  // so those controls have no visible effect unless recomputeSignals
  // rewrites the SAVED thresholds too (see playground.js's docblock).
  const payload = pastePayload(0, 2);
  const [out] = recomputeSignals([payload], { pasteHardCount: 2, tabAwayCutoffMs: 5000, typingSpeedCps: 8 }, STD);
  assert.equal(out.metadata.integritySession.config.thresholds.tabAwayDurationMs, 5000);
  assert.equal(out.metadata.integritySession.config.thresholds.typingSpeedCps, 8);
});

// ── Purity / robustness ────────────────────────────────────────────────

test('recomputeSignals: deep-copy purity — input payloads are never mutated', () => {
  const payload = pastePayload(2, 2);
  const before = JSON.parse(JSON.stringify(payload));
  const [out] = recomputeSignals([payload], { ...STD_CONTROLS, pasteHardCount: 3, typingSpeedCps: 4 }, STD);
  assert.deepEqual(payload, before, 'input payload mutated by recomputeSignals');
  assert.notEqual(out, payload, 'recomputeSignals returned the same object reference it was given');
  assert.notEqual(out.trials[0], payload.trials[0], 'recomputeSignals did not deep-copy trials');
});

test('recomputeSignals: fixture on disk stays untouched across a recompute', () => {
  const example1 = loadExample('example-1');
  const before = JSON.parse(JSON.stringify(example1));
  recomputeSignals([example1], { pasteHardCount: 3, tabAwayCutoffMs: 1000, typingSpeedCps: 4 }, STD);
  assert.deepEqual(example1, before);
});

test('recomputeSignals: empty/missing payloads list is handled', () => {
  assert.deepEqual(recomputeSignals([], STD_CONTROLS, STD), []);
  assert.deepEqual(recomputeSignals(undefined, STD_CONTROLS, STD), []);
});
