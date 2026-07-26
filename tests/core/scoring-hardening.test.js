// Node-side tests for two 0.6.2 hardening fixes:
//
//   F6 — a nested typo in a scoring override (e.g. `countThreshhold`) used to
//        silently disable a hard screenout rule with no warning, because the
//        rule object is merged wholesale and validation only checked top-level
//        keys. init() now emits a warning when a merged hard rule has no
//        numeric countThreshold (or a soft rule no numeric weight).
//
//   F9 — a `cut` event is documented as equivalent to `copy` ("text leaving the
//        page") and is counted in the soft-copy score and the per-trial hard
//        `trialHits`, but it never incremented sessionData.copyCount, so the
//        hard-copy screenout could never trigger on cuts. Cut now counts.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';

let win, monitor, init;

beforeEach(async () => {
  win = new Window();
  global.window = win;
  global.document = win.document;
  global.Node = win.Node;
  global.MutationObserver = win.MutationObserver;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  ({ init } = await import('../../src/core/monitor.js'));
});

afterEach(() => {
  if (monitor) { try { monitor.destroy(); } catch { /* already destroyed */ } }
  monitor = null;
  win.close();
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.MutationObserver;
  delete global.ResizeObserver;
});

// Capture console.warn output produced during a callback.
function captureWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try { fn(); } finally { console.warn = orig; }
  return warnings;
}

describe('F6 — nested scoring typo must not silently disable a hard rule', () => {
  it('warns when a hard rule override drops its countThreshold via a typo', () => {
    const warnings = captureWarnings(() => {
      monitor = init({
        participantId: 'F6',
        // Typo: countThreshhold (extra h). The whole `paste` rule object is
        // replaced, so the real countThreshold is lost.
        scoring: { hard: { paste: { countThreshhold: 2 } } },
      });
    });
    const hit = warnings.find(w => /hard\.paste/.test(w) && /countThreshold/.test(w));
    assert.ok(hit,
      `expected a warning about hard.paste missing countThreshold, got:\n${warnings.join('\n')}`);
  });

  it('does NOT warn for a correct hard-rule override', () => {
    const warnings = captureWarnings(() => {
      monitor = init({
        participantId: 'F6b',
        scoring: { hard: { paste: { countThreshold: 5 } } },
      });
    });
    const spurious = warnings.find(w => /countThreshold/.test(w));
    assert.ok(!spurious,
      `a valid override must not warn, got:\n${warnings.join('\n')}`);
  });

  it('warns when a soft rule override drops its weight via a typo', () => {
    const warnings = captureWarnings(() => {
      monitor = init({
        participantId: 'F6c',
        scoring: { soft: { tabAway: { wieght: 2 } } },
      });
    });
    const hit = warnings.find(w => /soft\.tabAway/.test(w) && /weight/.test(w));
    assert.ok(hit,
      `expected a warning about soft.tabAway missing weight, got:\n${warnings.join('\n')}`);
  });

  // Re-review (round 4): typeof NaN === 'number', so a NaN/Infinity threshold
  // slipped past the shape check while still disabling detection.
  it('warns on a NaN hard countThreshold (not just a missing one)', () => {
    const warnings = captureWarnings(() => {
      monitor = init({ participantId: 'F6d', scoring: { hard: { paste: { countThreshold: NaN } } } });
    });
    assert.ok(warnings.find(w => /hard\.paste/.test(w) && /countThreshold/.test(w)),
      `NaN threshold must warn, got:\n${warnings.join('\n')}`);
  });

  it('warns on a non-finite soft weight (Infinity)', () => {
    const warnings = captureWarnings(() => {
      monitor = init({ participantId: 'F6e', scoring: { soft: { tabAway: { weight: Infinity } } } });
    });
    assert.ok(warnings.find(w => /soft\.tabAway/.test(w) && /weight/.test(w)),
      `Infinity weight must warn, got:\n${warnings.join('\n')}`);
  });

  // Round-5 re-review: the warning string must not itself throw on a value that
  // can't be coerced to a string (e.g. a Symbol), which template interpolation
  // does. init() must warn, not crash.
  it('does not throw when an invalid threshold is a non-stringifiable value (Symbol)', () => {
    let warnings;
    assert.doesNotThrow(() => {
      warnings = captureWarnings(() => {
        monitor = init({ participantId: 'F6f', scoring: { hard: { paste: { countThreshold: Symbol('bad') } } } });
      });
    });
    assert.ok(warnings.find(w => /hard\.paste/.test(w) && /countThreshold/.test(w)),
      `a Symbol threshold must still warn, got:\n${warnings.join('\n')}`);
  });
});

describe('F9 — cut counts toward the hard-copy screenout', () => {
  it('two cut events trigger the strict-preset hard-copy rule', () => {
    // strict preset: hard.copy.countThreshold = 2, signals.copy = true.
    monitor = init({ participantId: 'F9', preset: 'strict' });
    monitor.startSession();
    monitor.startTrial({ trialId: 't1' });

    win.document.dispatchEvent(new win.Event('cut'));
    win.document.dispatchEvent(new win.Event('cut'));

    monitor.endTrial();
    const score = monitor.getSessionScore();
    assert.ok(score.hardScore.copy, 'strict preset defines a hard-copy rule');
    assert.equal(score.hardScore.copy.count, 2, 'both cuts count toward the session copy total');
    assert.equal(score.hardScore.copy.triggered, true,
      'two cuts must trip the hard-copy screenout (threshold 2)');
    assert.equal(score.anyHardTriggered, true);
  });

  it('a single cut is recorded but does not yet trip the threshold', () => {
    monitor = init({ participantId: 'F9b', preset: 'strict' });
    monitor.startSession();
    monitor.startTrial({ trialId: 't1' });
    win.document.dispatchEvent(new win.Event('cut'));
    monitor.endTrial();
    const score = monitor.getSessionScore();
    assert.equal(score.hardScore.copy.count, 1);
    assert.equal(score.hardScore.copy.triggered, false);
  });
});
