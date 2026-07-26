// =============================================================================
// describe-card.test.js
//
// Structural unit tests for the describe-card trial builder.
//
// Run with Node's built-in test runner:
//   node --test bench/harness/trials/tests/describe-card.test.js
//
// The describe-card trial is one of two "grafted" trials added to the bench
// timeline alongside the vendored jspsych-replay-test suite. It's a native
// jsPsych `survey-text` trial: a card stimulus + a short free-text response
// describing it.
//
// As in `replay-test-suite.test.js`, jsPsych plugin classes are globals
// injected by <script> tags in production. Under Node we mock the one
// plugin global this trial needs (`jsPsychSurveyText`) so the existence
// check inside `buildDescribeCardTrial()` is satisfied.
//
// Test coverage:
//   1. Module exports `buildDescribeCardTrial`.
//   2. With mocks installed, the builder returns an object.
//   3. The returned object's `type` is the survey-text plugin.
//   4. `preamble` embeds the supplied cardImage URL and the "Describe this card:" prompt.
//   5. `questions` is a single-element array shaped per the design spec
//      (required:true, rows:3, columns:60, empty prompt — preamble carries the question).
//   6. Missing-globals path throws an error mentioning `jsPsychSurveyText`.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Plugin global mocks ----------------------------------------------------
function installPluginMocks() {
  globalThis.jsPsychSurveyText = { info: { name: 'survey-text' } };
}

function uninstallPluginMocks() {
  delete globalThis.jsPsychSurveyText;
}

installPluginMocks();

const { buildDescribeCardTrial } = await import('../describe-card.js');

test('module exports buildDescribeCardTrial', () => {
  assert.equal(typeof buildDescribeCardTrial, 'function',
    'expected buildDescribeCardTrial to be exported as a function');
});

test('buildDescribeCardTrial returns an object when mocks are installed', () => {
  const trial = buildDescribeCardTrial({ cardImage: 'stim/AH.png' });
  assert.ok(trial && typeof trial === 'object',
    'expected return value to be an object');
});

test('trial.type.info.name is "survey-text"', () => {
  const trial = buildDescribeCardTrial({ cardImage: 'stim/AH.png' });
  assert.ok(trial.type && trial.type.info,
    'trial.type should be the jsPsychSurveyText plugin mock');
  assert.equal(trial.type.info.name, 'survey-text',
    'trial.type should point at the survey-text plugin');
});

test('preamble embeds the supplied cardImage path and "Describe this card:" prompt', () => {
  const cardImage = 'stim/QS.png';
  const trial = buildDescribeCardTrial({ cardImage });
  assert.equal(typeof trial.preamble, 'string',
    'preamble should be an HTML string');
  assert.ok(trial.preamble.includes(cardImage),
    `preamble should include cardImage path "${cardImage}"; got: ${trial.preamble}`);
  assert.ok(trial.preamble.includes('Describe this card:'),
    `preamble should include the "Describe this card:" prompt; got: ${trial.preamble}`);
});

test('questions is a single-element array shaped per spec', () => {
  const trial = buildDescribeCardTrial({ cardImage: 'stim/AH.png' });
  assert.ok(Array.isArray(trial.questions),
    'trial.questions should be an array');
  assert.equal(trial.questions.length, 1,
    'describe-card trial has exactly one question');

  const q = trial.questions[0];
  assert.equal(q.required, true, 'question.required should be true');
  assert.equal(q.rows, 3, 'question.rows should be 3');
  assert.equal(q.columns, 60, 'question.columns should be 60');
  assert.equal(q.prompt, '',
    'question.prompt should be empty (preamble carries the question)');
});

test('buildDescribeCardTrial throws a descriptive error when plugin global is missing', () => {
  uninstallPluginMocks();
  try {
    assert.throws(
      () => buildDescribeCardTrial({ cardImage: 'stim/AH.png' }),
      /jsPsychSurveyText/,
      'expected error to name the missing plugin global'
    );
  } finally {
    // Restore so any later tests in this process aren't broken.
    installPluginMocks();
  }
});
