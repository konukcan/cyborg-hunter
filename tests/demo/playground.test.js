// tests/demo/playground.test.js
// DOM-free unit tests for the C3 config playground's two pure pieces:
// makeDebounced (generic coalescing timer) and recomputeSignals (the
// pre-pass that rewrites raw session/trial data as if the participant had
// been screened under different thresholds — see playground.js's docblock
// for why a config override alone can't do this for the paste HARD signal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeDebounced, recomputeSignals } from '../../demo/playground.js';

const here = dirname(fileURLToPath(import.meta.url));

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
        pasteEvents,
        copyEvents: [],
        dropEvents: [],
        charsPerSec: 12,
        trialSignals: {
          hard: {
            paste: { trialHits: pasteCount, sessionTotal: pasteCount, countThreshold: existingCountThreshold },
            drop: { trialHits: 0, sessionTotal: 0, countThreshold: 2 },
          },
          soft: {
            typingSpeed: { charsPerSec: 12, threshold: 10, hit: 1, score: 2 },
          },
        },
      },
    }],
    metadata: {
      integritySession: {
        hardScore: {
          paste: { count: pasteCount, threshold: existingCountThreshold, triggered: triggeredAtCollection },
          drop: { count: 0, threshold: 2, triggered: false },
        },
        softScore: 2,
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
        anyHardTriggered: triggeredAtCollection,
        trialsCompleted: 1,
      },
    },
  };
}

const BASE_CONTROLS = { tabAwayCutoffMs: 3000, typingSpeedCps: 10 };

test('recomputeSignals: 2 pastes, threshold 2 -> anyHardTriggered true', () => {
  const payload = pastePayload(2, 2); // collected under the standard preset's own threshold (2)
  const [out] = recomputeSignals([payload], { ...BASE_CONTROLS, pasteHardCount: 2 });
  assert.equal(out.metadata.integritySession.anyHardTriggered, true);
  assert.equal(out.metadata.integrityScore.anyHardTriggered, true);
  assert.deepEqual(out.trials[0].integrity.trialSignals.hard.paste,
    { trialHits: 2, sessionTotal: 2, countThreshold: 2 });
});

test('recomputeSignals: 2 pastes, threshold 3 -> anyHardTriggered false', () => {
  const payload = pastePayload(2, 2);
  const [out] = recomputeSignals([payload], { ...BASE_CONTROLS, pasteHardCount: 3 });
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
  const [out] = recomputeSignals([payload], { ...BASE_CONTROLS, pasteHardCount: 5 });
  // 0 pastes never crosses 5, but the pre-existing drop trigger (no
  // playground control for drop) must still carry the tier.
  assert.equal(out.metadata.integritySession.anyHardTriggered, true);
});

test('recomputeSignals: typing flag recomputed from stored raw charsPerSec', () => {
  const payload = pastePayload(0, 2); // charsPerSec: 12, collection-time hit at threshold 10
  const stricter = recomputeSignals([payload], { ...BASE_CONTROLS, pasteHardCount: 2, typingSpeedCps: 15 })[0];
  assert.equal(stricter.trials[0].integrity.trialSignals.soft.typingSpeed.hit, 0);
  assert.equal(stricter.trials[0].integrity.trialSignals.soft.typingSpeed.threshold, 15);
  assert.equal(stricter.trials[0].integrity.trialSignals.soft.typingSpeed.charsPerSec, 12); // measured data unchanged

  const looser = recomputeSignals([payload], { ...BASE_CONTROLS, pasteHardCount: 2, typingSpeedCps: 8 })[0];
  assert.equal(looser.trials[0].integrity.trialSignals.soft.typingSpeed.hit, 1);
  assert.equal(looser.trials[0].integrity.trialSignals.soft.typingSpeed.threshold, 8);
});

test('recomputeSignals: tab-away/typing controls land on the participant\'s saved thresholds', () => {
  // summary.js/session-timeline-core.js/typing-profile-core.js all prefer
  // participant.session.config.thresholds.* over any CLI config override —
  // so those controls have no visible effect unless recomputeSignals
  // rewrites the SAVED thresholds too (see playground.js's docblock).
  const payload = pastePayload(0, 2);
  const [out] = recomputeSignals([payload], { pasteHardCount: 2, tabAwayCutoffMs: 5000, typingSpeedCps: 8 });
  assert.equal(out.metadata.integritySession.config.thresholds.tabAwayDurationMs, 5000);
  assert.equal(out.metadata.integritySession.config.thresholds.typingSpeedCps, 8);
});

test('recomputeSignals: deep-copy purity — input payloads are never mutated', () => {
  const payload = pastePayload(2, 2);
  const before = JSON.parse(JSON.stringify(payload));
  const [out] = recomputeSignals([payload], { ...BASE_CONTROLS, pasteHardCount: 3 });
  assert.deepEqual(payload, before, 'input payload mutated by recomputeSignals');
  assert.notEqual(out, payload, 'recomputeSignals returned the same object reference it was given');
  assert.notEqual(out.trials[0], payload.trials[0], 'recomputeSignals did not deep-copy trials');
});

test('recomputeSignals: empty/missing payloads list is handled', () => {
  assert.deepEqual(recomputeSignals([], { ...BASE_CONTROLS, pasteHardCount: 2 }), []);
  assert.deepEqual(recomputeSignals(undefined, { ...BASE_CONTROLS, pasteHardCount: 2 }), []);
});

test('recomputeSignals: example-1 fixture, paste threshold 3 -> no longer hard', () => {
  const fixturePath = join(here, '..', '..', 'demo', 'assets', 'example-participants.json');
  const examples = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const example1 = examples.find((p) => p.participantId === 'example-1');
  assert.ok(example1, 'fixture is missing example-1');
  // Sanity check on the committed fixture itself (C1): 2 pastes, both in
  // trial q2, collected under the standard preset's threshold of 2 -> hard.
  assert.equal(example1.metadata.integritySession.anyHardTriggered, true);

  const [recomputed] = recomputeSignals([example1], { ...BASE_CONTROLS, pasteHardCount: 3 });
  assert.equal(recomputed.metadata.integritySession.anyHardTriggered, false);
  assert.equal(recomputed.metadata.integrityScore.anyHardTriggered, false);

  const q2 = recomputed.trials.find((t) => t.trialId === 'q2').integrity;
  assert.deepEqual(q2.trialSignals.hard.paste, { trialHits: 2, sessionTotal: 2, countThreshold: 3 });

  // The fixture on disk must stay untouched (deep-copy purity, real data).
  const reread = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.deepEqual(reread.find((p) => p.participantId === 'example-1'), example1);
});
