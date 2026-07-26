import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { CyborgHunterExtension } from '../../src/jspsych/extension-cyborg-hunter.js';

// Regression tests for the two bugs found while plugging the wrapper into
// quillien-2a-plural-version (April 2026):
//
//   1. on_start was missing → jsPsych 7 unconditionally calls it on every
//      trial-level extension. Crashed at trial #2 with
//      "this.extensions['cyborg-hunter'].on_start is not a function".
//
//   2. on_finish_experiment was defined but is NOT a real jsPsych extension
//      hook (only initialize / on_start / on_load / on_finish exist —
//      verified against jsPsych 7 source). Session-report attachment was
//      silently dead code; every CSV produced by the wrapper was missing
//      integritySession, integrityScore, and the integrity* scalar columns.
//      Replaced with explicit finalize() that the user calls from
//      initJsPsych({ on_finish }).
//
// The fix: ensure the four real hooks exist as functions, and finalize()
// is callable as an instance method.

describe('jsPsych extension lifecycle', () => {
  // jsPsych 7's documented extension API. Sourced by inspecting jspsych.js
  // for `this.extensions[name].<hook>(` call sites — only these four exist.
  const REQUIRED_HOOKS = ['initialize', 'on_start', 'on_load', 'on_finish'];

  for (const hook of REQUIRED_HOOKS) {
    it(`exposes ${hook} as an instance method`, () => {
      const ext = new CyborgHunterExtension({});
      assert.equal(
        typeof ext[hook],
        'function',
        `Missing ${hook}() — jsPsych 7 unconditionally calls this on every trial that lists the extension. Adding the hook as a no-op is sufficient if the wrapper has nothing to do.`
      );
    });
  }

  it('exposes finalize() as an instance method', () => {
    const ext = new CyborgHunterExtension({});
    assert.equal(
      typeof ext.finalize,
      'function',
      'finalize() must exist — it is the explicit replacement for the (non-existent) on_finish_experiment jsPsych hook. Without it, session-level integrity data is silently dropped.'
    );
  });

  it('does NOT define on_finish_experiment (which jsPsych never calls)', () => {
    const ext = new CyborgHunterExtension({});
    // If this property exists, someone re-introduced the dead-code bug.
    // The fix is to rename to finalize() and document the manual call site.
    assert.equal(
      ext.on_finish_experiment,
      undefined,
      'on_finish_experiment is NOT a real jsPsych extension hook — defining it gives a false sense that session data will be attached automatically. Use finalize() (called manually from initJsPsych on_finish) instead.'
    );
  });

  it('finalize() attaches scalars via addProperties and nested data via addDataToLastTrial', () => {
    // Mock the bits of jsPsych the extension touches.
    const propertyCalls = [];
    const lastTrialCalls = [];
    const fakeJsPsych = {
      data: {
        addProperties: (obj) => propertyCalls.push(obj),
        addDataToLastTrial: (obj) => lastTrialCalls.push(obj),
      },
    };

    const ext = new CyborgHunterExtension(fakeJsPsych);

    // Skip initialize() (would need to mock window.CyborgHunter); inject a
    // fake monitor so finalize() has something to read from.
    ext.monitor = {
      getSessionReport: () => ({
        pasteCount: 3, copyCount: 1, dropCount: 0,
        sidebarEvents: [{ type: 'opened', t: 100 }],
        keyboardShortcuts: [], windowPositions: [],
        layoutShifts: [], zoomChanges: [], idleGaps: [],
        extensionInjections: [], tabAwaySums: [], charsPerSec: [],
        aiExtensionsFound: [],
        hardScore: { paste: { triggered: true, count: 3 } },
        softScore: 8, anyHardTriggered: true,
        trialsCompleted: 5, softScoreThreshold: 6,
        config: { preset: 'strict', participantId: 'P1', thresholds: { tabAwayDurationMs: 5000, typingSpeedCps: 8 } },
        libraryVersion: '0.3.0',
      }),
      destroy: () => {},
    };

    ext.finalize();

    // Scalars should land via addProperties (one column per row).
    assert.equal(propertyCalls.length, 1);
    const props = propertyCalls[0];
    assert.equal(props.integrityPasteCount, 3);
    assert.equal(props.integrityCopyCount, 1);
    assert.equal(props.integrityAnyHardTriggered, true);
    assert.equal(props.integritySoftScore, 8);
    assert.equal(props.cyborgHunterVersion, '0.3.0');

    // Nested objects should land via addDataToLastTrial (one cell on last row).
    assert.equal(lastTrialCalls.length, 1);
    const last = lastTrialCalls[0];
    assert.ok(last.integritySession, 'integritySession must be on last trial');
    assert.equal(last.integritySession.pasteCount, 3);
    assert.equal(last.integritySession.sidebarEvents.length, 1);
    assert.ok(last.integrityScore, 'integrityScore must be on last trial');
    assert.equal(last.integrityScore.anyHardTriggered, true);
    assert.equal(last.integrityScore.softScore, 8);
    // The effective runtime config (preset + thresholds the CLI consumes) must be
    // persisted in integritySession so the report can reconstruct participant-
    // specific screening, not analyst-side defaults.
    assert.ok(last.integritySession.config, 'integritySession must carry runtime config');
    assert.equal(last.integritySession.config.preset, 'strict');
    assert.equal(last.integritySession.config.thresholds.tabAwayDurationMs, 5000);
  });

  it('finalize() is a no-op when monitor was never initialized', () => {
    // If the user calls finalize() but never set up the extension (no
    // initialize() ran), it should silently do nothing rather than crash.
    const ext = new CyborgHunterExtension({});
    assert.doesNotThrow(() => ext.finalize());
  });

  it('on_start is a callable no-op (does not crash with arbitrary params)', () => {
    const ext = new CyborgHunterExtension({});
    // jsPsych passes whatever the user put in extension.params per-trial.
    assert.doesNotThrow(() => ext.on_start({}));
    assert.doesNotThrow(() => ext.on_start({ trialId: 'r1' }));
    assert.doesNotThrow(() => ext.on_start(undefined));
  });
});

// F11: the adapter forwarded `decoyAnswer` with
// `params?.decoyAnswer || null`, which coerces an explicit `false` (the "skip
// the decoy for this trial" opt-out) into `null`, so the core auto-generates a
// decoy instead of skipping. The forward must preserve `false`.
describe('decoyAnswer pass-through (F11)', () => {
  // Minimal fake jsPsych + monitor so on_load can run without a real DOM.
  function makeExt() {
    const startTrialCalls = [];
    const fakeJsPsych = {
      getProgress: () => ({ current_trial_global: 0 }),
      getCurrentTrial: () => ({ type: { info: { name: 'html-keyboard-response' } } }),
    };
    const ext = new CyborgHunterExtension(fakeJsPsych);
    ext.params = { autoMonitor: true };
    ext.monitor = { startTrial: (opts) => startTrialCalls.push(opts) };
    return { ext, startTrialCalls };
  }

  it('forwards decoyAnswer:false as false (explicit skip), not null', () => {
    const { ext, startTrialCalls } = makeExt();
    ext.on_load({ trialId: 't1', decoyAnswer: false });
    assert.equal(startTrialCalls.length, 1);
    assert.strictEqual(startTrialCalls[0].decoyAnswer, false,
      'an explicit false opt-out must reach the core as false, not null');
  });

  it('forwards an explicit decoy string unchanged', () => {
    const { ext, startTrialCalls } = makeExt();
    ext.on_load({ trialId: 't2', decoyAnswer: 'the answer is 42' });
    assert.strictEqual(startTrialCalls[0].decoyAnswer, 'the answer is 42');
  });

  it('forwards a missing decoyAnswer as null (auto-detection path)', () => {
    const { ext, startTrialCalls } = makeExt();
    ext.on_load({ trialId: 't3' });
    assert.strictEqual(startTrialCalls[0].decoyAnswer, null);
  });
});
