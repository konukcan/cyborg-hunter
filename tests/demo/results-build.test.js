// tests/demo/results-build.test.js
// DOM-free unit tests for results.js's pure assembly step. The iframe/blob
// swap (swapIframe) and its load/error/watchdog fallback are DOM-dependent
// and get their coverage as E2E in D1 — this file only exercises
// assembleReportInputs, the pure payload+opts builder buildReportHtml and
// swapIframe are layered on top of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReportInputs } from '../../demo/results.js';

test('assembleReportInputs merges visitor + examples and builds demo opts', () => {
  const state = {
    participantId: 'DEMO-test1',
    trialReports: [
      { trialId: 'act1-paste', paste_count: 2, pasted_strings: ['Canberra', 'Canberra'] },
    ],
    sessionReport: { trialsCompleted: 1 },
    violations: [],
  };
  const examples = [
    { participantId: 'example-1', trials: [], metadata: { integritySession: {} } },
  ];
  const model = { schema: 1, frames: [] };
  const inputs = assembleReportInputs(state, examples, model);

  assert.equal(inputs.payloads.length, 2);
  assert.equal(inputs.payloads[0].participantId, 'DEMO-test1');
  assert.equal(inputs.payloads[1].participantId, 'example-1');
  assert.deepEqual(Object.keys(inputs.inlineReplayModels), ['DEMO-test1']);
  assert.equal(inputs.inlineReplayModels['DEMO-test1'], model);
});

test('assembleReportInputs omits inlineReplayModels entry when no replay model was built', () => {
  const state = {
    participantId: 'DEMO-test2',
    trialReports: [],
    sessionReport: { trialsCompleted: 0 },
    violations: [],
  };
  const inputs = assembleReportInputs(state, [], null);

  assert.equal(inputs.payloads.length, 1);
  assert.deepEqual(inputs.inlineReplayModels, {});
});

test('assembleReportInputs defaults a missing/empty examples list to just the visitor', () => {
  const state = {
    participantId: 'DEMO-test3',
    trialReports: [{ trialId: 'act1-baseline', pasted_strings: [] }],
    sessionReport: { trialsCompleted: 1 },
    violations: [{ type: 'fullscreen_exit' }],
  };
  const inputs = assembleReportInputs(state, undefined, null);

  assert.equal(inputs.payloads.length, 1);
  assert.deepEqual(inputs.payloads[0].guardFriction.violations, [{ type: 'fullscreen_exit' }]);
});
