// tests/core/trial-intervals.test.js
// Pins trial-scoped interval registration.
//
// Fresh-eyes fix (2026-07-04): idle-gap and element-trace intervals were
// registered via ctx.addInterval (session-scoped, cleared only at destroy).
// Every trial leaked one live interval; a 100-trial session accumulated 100
// timers firing until destroy(). Trial-scoped intervals must register via
// ctx.addTrialInterval so endTrial can clear them.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { attachIdleGapSignals } from '../../src/core/signals/focus.js';
import { attachElementTrace } from '../../src/core/signals/browser.js';

beforeEach(() => { globalThis.document = {}; });

function fakeCtx(overrides) {
  const ctx = {
    sessionIntervals: [],
    trialIntervals: [],
    config: {
      signals: { idleGaps: true },
      thresholds: { idleGapMs: 10000, idleCheckIntervalMs: 3600000, elementTraceHz: 3600000 },
      collectForPostHoc: { elementTrace: true },
    },
    trialData: { startTime: 0, idleGaps: [] },
    addTrialListener: () => {},
    addInterval: (id) => ctx.sessionIntervals.push(id),
    addTrialInterval: (id) => ctx.trialIntervals.push(id),
    fireSignal: () => {},
    getTrialData: () => null,  // interval body early-returns if it ever fires
    ...overrides,
  };
  return ctx;
}

describe('trial-scoped interval registration', () => {
  it('idle-gap interval registers as trial-scoped, not session-scoped', () => {
    const ctx = fakeCtx();
    attachIdleGapSignals(ctx);
    try {
      assert.strictEqual(ctx.trialIntervals.length, 1,
        'idle-gap interval must go through addTrialInterval');
      assert.strictEqual(ctx.sessionIntervals.length, 0,
        'idle-gap interval must NOT go through session addInterval');
    } finally {
      ctx.trialIntervals.forEach(clearInterval);
      ctx.sessionIntervals.forEach(clearInterval);
    }
  });

  it('element-trace interval registers as trial-scoped, not session-scoped', () => {
    const ctx = fakeCtx();
    attachElementTrace(ctx);
    try {
      assert.strictEqual(ctx.trialIntervals.length, 1,
        'element-trace interval must go through addTrialInterval');
      assert.strictEqual(ctx.sessionIntervals.length, 0);
    } finally {
      ctx.trialIntervals.forEach(clearInterval);
      ctx.sessionIntervals.forEach(clearInterval);
    }
  });
});
