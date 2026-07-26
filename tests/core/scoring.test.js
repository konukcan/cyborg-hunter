// tests/core/scoring.test.js
// Pins the trial-window bound for session-scoped soft signals.
//
// Fresh-eyes fix (2026-07-04): sidebar/devTools scoring filtered session
// events with an open-ended upper bound of performance.now() at scoring
// time. Synchronous callers were unaffected, but any deferred scoring
// silently swallowed post-trial events. The bound must be the trial's
// logical end: startTime + duration_ms.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeTrialScores } from '../../src/core/scoring.js';

function baseConfig(soft) {
  return {
    scoring: { hard: {}, soft, softScoreThreshold: 10 },
    thresholds: { tabAwayDurationMs: 10000, typingSpeedCps: 10 },
  };
}

describe('computeTrialScores trial-window bound', () => {
  it('excludes sidebar events after the trial logical end', () => {
    const trialData = {
      startTime: 1000,
      pasteEvents: [], copyEvents: [], dropEvents: [],
      tabAwayEvents: [], foreignInputEvents: [],
    };
    const sessionData = {
      pasteCount: 0, copyCount: 0, dropCount: 0,
      sidebarEvents: [
        { t: 1050 },   // inside the trial window
        { t: 9000 },   // after trial end (1000 + 1000) — must NOT count
      ],
      keyboardShortcuts: [],
    };
    const report = { duration_ms: 1000 };
    const { trialSignals } = computeTrialScores(
      trialData, sessionData, baseConfig({ sidebarEvent: { weight: 1 } }), report);
    assert.strictEqual(trialSignals.soft.sidebarEvent.hits, 1,
      'only the in-window sidebar event may count toward this trial');
  });

  it('excludes devTools shortcuts after the trial logical end', () => {
    const trialData = {
      startTime: 500,
      pasteEvents: [], copyEvents: [], dropEvents: [],
      tabAwayEvents: [], foreignInputEvents: [],
    };
    const sessionData = {
      pasteCount: 0, copyCount: 0, dropCount: 0,
      sidebarEvents: [],
      keyboardShortcuts: [{ t: 600 }, { t: 700 }, { t: 50000 }],
    };
    const report = { duration_ms: 2000 };
    const { trialSignals } = computeTrialScores(
      trialData, sessionData, baseConfig({ devTools: { weight: 1 } }), report);
    assert.strictEqual(trialSignals.soft.devTools.hits, 2,
      'the post-trial shortcut must not count toward this trial');
  });
});
