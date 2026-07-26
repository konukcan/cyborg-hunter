// =============================================================================
// recording-trial.test.js
//
// Structural unit tests for the custom press-space recording plugin.
//
// Run with Node's built-in test runner:
//   node --test bench/harness/trials/tests/recording-trial.test.js
//
// The runtime behaviour of the plugin (MediaRecorder lifecycle, mic
// permission, base64 encoding) is browser-only and cannot be exercised in
// `node --test` without a heavyweight DOM + MediaRecorder shim. These tests
// stay strictly structural:
//
//   1. The plugin loads under Node — i.e. the file's top-level
//      `globalThis.jsPsychModule?.ParameterType ?? {...}` fallback works.
//   2. `RecordingTrialPlugin.info.name === 'bench-recording-trial'`.
//   3. `RecordingTrialPlugin.info.parameters` has the four expected fields.
//   4. `buildRecordingTrial({ cardImage })` returns an object whose
//      `type === RecordingTrialPlugin` and whose `stimulus` contains the
//      cardImage path.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { RecordingTrialPlugin, buildRecordingTrial } = await import('../recording-trial.js');

test('module exports RecordingTrialPlugin class', () => {
  assert.equal(typeof RecordingTrialPlugin, 'function',
    'expected RecordingTrialPlugin to be a class (function)');
});

test("plugin's static info.name is 'bench-recording-trial'", () => {
  assert.ok(RecordingTrialPlugin.info && typeof RecordingTrialPlugin.info === 'object',
    'expected static info object');
  assert.equal(RecordingTrialPlugin.info.name, 'bench-recording-trial',
    "info.name should be 'bench-recording-trial'");
});

test("plugin's info.parameters has stimulus, prompt, max_duration_ms, onstop_timeout_ms", () => {
  const params = RecordingTrialPlugin.info.parameters;
  assert.ok(params && typeof params === 'object', 'expected info.parameters object');
  for (const key of ['stimulus', 'prompt', 'max_duration_ms', 'onstop_timeout_ms']) {
    assert.ok(Object.prototype.hasOwnProperty.call(params, key),
      `info.parameters should declare "${key}"`);
  }
});

test('module exports buildRecordingTrial function', () => {
  assert.equal(typeof buildRecordingTrial, 'function',
    'expected buildRecordingTrial to be exported as a function');
});

test('buildRecordingTrial returns a trial with type === RecordingTrialPlugin', () => {
  const trial = buildRecordingTrial({ cardImage: 'foo.png' });
  assert.ok(trial && typeof trial === 'object', 'expected an object');
  assert.equal(trial.type, RecordingTrialPlugin,
    'trial.type should point at RecordingTrialPlugin');
});

test('buildRecordingTrial embeds the supplied cardImage in stimulus', () => {
  const trial = buildRecordingTrial({ cardImage: 'foo.png' });
  assert.equal(typeof trial.stimulus, 'string', 'stimulus should be a string');
  assert.ok(trial.stimulus.includes('foo.png'),
    `stimulus should include the cardImage path 'foo.png'; got: ${trial.stimulus}`);
});
