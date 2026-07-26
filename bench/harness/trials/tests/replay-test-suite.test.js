// =============================================================================
// replay-test-suite.test.js
//
// Structural unit tests for the vendored jspsych-replay-test trial suite.
//
// Run with Node's built-in test runner:
//   node --test bench/harness/trials/tests/replay-test-suite.test.js
//
// In production, jsPsych plugin classes are globals injected by <script> tags
// in the bench harness HTML. Under Node there's no DOM and no script-tag
// loading, so we mock each plugin global with a stand-in shape that satisfies
// the module's existence check. We then exercise:
//
//   1. `buildReplayTestTrials()` returns an array.
//   2. The array length matches upstream's trial count (14 trial objects:
//      the upstream timeline has 12 named trials plus 3 stroop variants
//      spread inline → 14 — see header in replay-test-suite.js).
//   3. Every element has a `type` field pointing at one of our mock plugins.
//
// We also verify the loud-failure path: when a plugin global is missing,
// `buildReplayTestTrials()` should throw a descriptive Error rather than
// silently producing `type: undefined` trials.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Plugin global mocks ----------------------------------------------------
// Each mock is a unique sentinel object so we can assert that the trial's
// `type` field actually points at the right plugin class.
const PLUGIN_NAMES = [
  'jsPsychInstructions',
  'jsPsychFullscreen',
  'jsPsychHtmlKeyboardResponse',
  'jsPsychHtmlButtonResponse',
  'jsPsychHtmlSliderResponse',
  'jsPsychCanvasKeyboardResponse',
  'jsPsychSketchpad',
  'jsPsychFreeSort',
  'jsPsychSurveyMultiChoice',
  'jsPsychSurveyText',
];

function installPluginMocks() {
  for (const name of PLUGIN_NAMES) {
    globalThis[name] = { info: { name: name.replace(/^jsPsych/, '').toLowerCase() } };
  }
}

function uninstallPluginMocks() {
  for (const name of PLUGIN_NAMES) {
    delete globalThis[name];
  }
}

// Install before any import so the module sees the globals at lookup time.
// (`buildReplayTestTrials` reads `globalThis[name]` at call time, not import
// time, so this ordering is permissive — but we keep it tight for clarity.)
installPluginMocks();

// Dynamic import so the test file can run under `node --test` without a
// transpiler step. `replay-test-suite.js` is an ES module that exports
// `buildReplayTestTrials` as a named export.
const { buildReplayTestTrials } = await import('../replay-test-suite.js');

test('buildReplayTestTrials returns an array', () => {
  const trials = buildReplayTestTrials();
  assert.ok(Array.isArray(trials), 'expected return value to be an Array');
});

test('buildReplayTestTrials returns 14 trial objects (upstream count)', () => {
  const trials = buildReplayTestTrials();
  assert.equal(
    trials.length,
    14,
    'upstream timeline has 12 named trials with stroopTrials spread inline (3 items) → 14 total'
  );
});

test('every trial has a `type` field referencing a known plugin global', () => {
  const trials = buildReplayTestTrials();
  const validPluginRefs = new Set(PLUGIN_NAMES.map(name => globalThis[name]));

  trials.forEach((trial, idx) => {
    assert.ok(
      trial && typeof trial === 'object',
      `trial[${idx}] should be an object, got ${typeof trial}`
    );
    assert.ok(
      'type' in trial,
      `trial[${idx}] is missing required \`type\` field`
    );
    assert.ok(
      validPluginRefs.has(trial.type),
      `trial[${idx}].type does not reference any known jsPsych plugin global`
    );
  });
});

test('buildReplayTestTrials throws a descriptive error when plugins are missing', () => {
  // Tear down a single plugin global and confirm the module surfaces it.
  delete globalThis.jsPsychSketchpad;
  try {
    assert.throws(
      () => buildReplayTestTrials(),
      /jsPsychSketchpad/,
      'expected error to name the missing plugin global'
    );
  } finally {
    // Restore so subsequent tests in the same process aren't broken.
    installPluginMocks();
  }
});

// Note: we don't uninstall mocks at end-of-file because `node --test`
// runs each test file in its own process. If that changes in future Node
// versions, add a `test.after(uninstallPluginMocks)` hook here.
