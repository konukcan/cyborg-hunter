// replay-quality.test.js
//
// Tests for bench/pipeline/replay-quality.js — three pure scoring functions
// (eventCompleteness, temporalGranularity, inspectabilityScore) plus a
// rollup (scoreRun). Each rated 1-5 per tool per run.
//
// Run: node --test bench/pipeline/tests/replay-quality.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  eventCompleteness,
  temporalGranularity,
  inspectabilityScore,
  scoreRun,
} from '../replay-quality.js';

// --- eventCompleteness -----------------------------------------------------

test('eventCompleteness: empty expected list returns 5 (no expectations)', () => {
  assert.equal(eventCompleteness([{ type: 'paste' }], []), 5);
  assert.equal(eventCompleteness([], null), 5);
  assert.equal(eventCompleteness([], undefined), 5);
});

test('eventCompleteness: all expected behaviors present returns 5', () => {
  const events = [
    { type: 'paste', t_ms: 100 },
    { type: 'copy', t_ms: 200 },
    { type: 'tab_away', t_ms: 300 },
  ];
  const expected = ['paste', 'copy', 'tab_away'];
  assert.equal(eventCompleteness(events, expected), 5);
});

test('eventCompleteness: no expected behaviors present returns 1', () => {
  const events = [
    { type: 'click', t_ms: 100 },
    { type: 'keydown', t_ms: 200 },
  ];
  const expected = ['paste', 'copy', 'tab_away'];
  assert.equal(eventCompleteness(events, expected), 1);
});

test('eventCompleteness: half present returns 3 (linear mapping)', () => {
  const events = [
    { type: 'paste', t_ms: 100 },
    { type: 'copy', t_ms: 200 },
  ];
  const expected = ['paste', 'copy', 'tab_away', 'sidebar'];
  // 2/4 = 0.5 → 1 + 4*0.5 = 3
  assert.equal(eventCompleteness(events, expected), 3);
});

// --- temporalGranularity ---------------------------------------------------

test('temporalGranularity: empty events returns 1', () => {
  assert.equal(temporalGranularity([]), 1);
  assert.equal(temporalGranularity(null), 1);
  assert.equal(temporalGranularity(undefined), 1);
});

test('temporalGranularity: one event returns 1 (cannot compute delta)', () => {
  assert.equal(temporalGranularity([{ t_ms: 1000 }]), 1);
});

test('temporalGranularity: events 50ms apart returns 5 (<100ms)', () => {
  const events = [{ t_ms: 0 }, { t_ms: 50 }, { t_ms: 100 }];
  assert.equal(temporalGranularity(events), 5);
});

test('temporalGranularity: events 5s apart returns 3 (<10s)', () => {
  const events = [{ t_ms: 0 }, { t_ms: 5000 }];
  assert.equal(temporalGranularity(events), 3);
});

test('temporalGranularity: events 30s apart returns 2 (<60s)', () => {
  const events = [{ t_ms: 0 }, { t_ms: 30000 }];
  assert.equal(temporalGranularity(events), 2);
});

test('temporalGranularity: events 5min apart returns 1 (>=60s)', () => {
  const events = [{ t_ms: 0 }, { t_ms: 5 * 60 * 1000 }];
  assert.equal(temporalGranularity(events), 1);
});

test('temporalGranularity: identical timestamps skipped (delta=0 ignored)', () => {
  // Two events at same time, plus a third 500ms away.
  // delta=0 must be skipped; min non-zero delta is 500ms → score 4.
  const events = [{ t_ms: 1000 }, { t_ms: 1000 }, { t_ms: 1500 }];
  assert.equal(temporalGranularity(events), 4);

  // All-identical timestamps → no non-zero delta → score 1.
  const allSame = [{ t_ms: 500 }, { t_ms: 500 }, { t_ms: 500 }];
  assert.equal(temporalGranularity(allSame), 1);
});

// --- inspectabilityScore ---------------------------------------------------

test('inspectabilityScore: all-false defaults returns 1', () => {
  assert.equal(
    inspectabilityScore({ localFiles: false, authGated: true, openSource: false }),
    1
  );
  // Empty object: localFiles=false, authGated=true, openSource=false → 1
  assert.equal(inspectabilityScore({}), 1);
  // No args at all → 1
  assert.equal(inspectabilityScore(), 1);
});

test('inspectabilityScore: CH-like (local, no auth, open) returns 5', () => {
  assert.equal(
    inspectabilityScore({ localFiles: true, authGated: false, openSource: true }),
    5
  );
});

test('inspectabilityScore: RT-like (cloud, auth-gated, closed) returns 1', () => {
  assert.equal(
    inspectabilityScore({ localFiles: false, authGated: true, openSource: false }),
    1
  );
});

// --- scoreRun --------------------------------------------------------------

test('scoreRun: returns object with all three keys; values are 1-5 integers', () => {
  const events = [
    { type: 'paste', t_ms: 100 },
    { type: 'copy', t_ms: 200 },
  ];
  const expectedBehaviors = ['paste', 'copy'];
  const toolMetadata = { localFiles: true, authGated: false, openSource: true };

  const result = scoreRun({ events, expectedBehaviors, toolMetadata });

  assert.ok('eventCompleteness' in result, 'has eventCompleteness key');
  assert.ok('temporalGranularity' in result, 'has temporalGranularity key');
  assert.ok('inspectability' in result, 'has inspectability key');

  for (const [k, v] of Object.entries(result)) {
    assert.ok(Number.isInteger(v), `${k} is integer`);
    assert.ok(v >= 1 && v <= 5, `${k} is in [1,5], got ${v}`);
  }

  // Concrete expected values:
  //   completeness: both behaviors present → 5
  //   granularity:  100ms delta → <1s but not <100ms → 4
  //   inspectability: CH-like → 5
  assert.equal(result.eventCompleteness, 5);
  assert.equal(result.temporalGranularity, 4);
  assert.equal(result.inspectability, 5);
});
