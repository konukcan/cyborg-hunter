// tests/demo/results-build.test.js
// DOM-free unit tests for results.js's pure assembly step. The iframe/blob
// swap (swapIframe) and its load/error/watchdog fallback are DOM-dependent
// and get their coverage as E2E in D1 — this file only exercises
// assembleReportInputs, the pure payload+opts builder buildReportHtml and
// swapIframe are layered on top of, plus (C3) that buildReportHtml threads
// its new transformPayloads seam to the right place in the pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReportInputs, buildReportHtml } from '../../demo/results.js';

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

// A stub `core` (the module buildReportHtml treats as the dynamically-
// imported preview-core.js bundle) that only records which participantIds
// extractIntegrityData actually saw — enough to prove transformPayloads ran
// (or didn't) without pulling in the real analyzers/renderer or a DOM.
function makeStubCore(seenIds) {
  return {
    extractIntegrityData: (p) => { seenIds.push(p.participantId); return { participantId: p.participantId }; },
    computeSummary: (participants) => participants.map((p) => ({ participantId: p.participantId, totalPasteEvents: 0 })),
    detectEdgeExits: (participants) => participants.map(() => ({ edgeExits: [] })),
    rankTriage: (summaries) => summaries.map((s) => ({
      participantId: s.participantId, hardTriggered: false, softFlagged: false, reason: '', score: 0, summary: s, edgeExitCount: 0,
    })),
    renderIndexHtml: async () => '<html></html>',
    // Real preview-core.js re-exports these three draw* cores; stubbed here
    // as no-ops (this test doesn't need a rendered plot) so plot-adapter.js
    // doesn't warn about a missing function on every participant.
    drawTypingProfile: () => null,
    drawSessionTimeline: () => null,
    drawTrajectoryGrid: () => null,
  };
}

test('buildReportHtml applies transformPayloads to the payload list before extraction (C3 seam)', async () => {
  const state = {
    participantId: 'DEMO-test4', trialReports: [], sessionReport: { trialsCompleted: 0 }, violations: [],
  };
  const seenIds = [];
  const transformPayloads = (payloads) => payloads.map((p) => ({ ...p, participantId: p.participantId + '-transformed' }));

  await buildReportHtml(makeStubCore(seenIds), state, [], null, '', null, transformPayloads);

  assert.deepEqual(seenIds, ['DEMO-test4-transformed']);
});

test('buildReportHtml defaults transformPayloads to identity when the arg is omitted', async () => {
  const state = {
    participantId: 'DEMO-test5', trialReports: [], sessionReport: { trialsCompleted: 0 }, violations: [],
  };
  const seenIds = [];

  await buildReportHtml(makeStubCore(seenIds), state, [], null, '', null);

  assert.deepEqual(seenIds, ['DEMO-test5']);
});
