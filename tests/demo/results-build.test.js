// tests/demo/results-build.test.js
// DOM-free unit tests for results.js's pure assembly step. The iframe/blob
// swap (swapIframe) and its load/error/watchdog fallback are DOM-dependent
// and get their coverage as E2E in D1 — this file only exercises
// assembleReportInputs, the pure payload+opts builder buildReportHtml and
// swapIframe are layered on top of, plus (C3) that buildReportHtml threads
// its new transformPayloads seam to the right place in the pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReportInputs, buildReportHtml, resolveInitialRun } from '../../demo/results.js';

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

// ── Persistence seam (walkthrough item 7, ENG-REVIEW amendment) ────────
// buildResults' FIRST run() call previously always used run(null) — a
// step-11 weight edit threaded through state.scoringOverrides would be
// silently discarded on the report's first render, only reaching a LATER
// playground rerun. buildResults now takes an optional 5th `initial` arg
// and resolves its first-run args through resolveInitialRun (exported
// below); buildResults itself is DOM-dependent (iframe load, blob swap —
// see this file's top docblock) and gets its coverage as E2E
// (demo/tests/tour.spec.js), so these tests pin the seam at the two layers
// that ARE unit-testable: the pure arg-resolution decision, and the same
// pipeline call buildResults' first run() makes with those args.

test('resolveInitialRun: passes through the caller-supplied initial transform/config', () => {
  const transformPayloads = (p) => p;
  const configOverrides = { scoring: { softScoreThreshold: 2 } };
  assert.deepEqual(resolveInitialRun({ configOverrides, transformPayloads }), { configOverrides, transformPayloads });
});

test('resolveInitialRun: defaults to no overrides when initial is omitted (untouched baseline first render)', () => {
  assert.deepEqual(resolveInitialRun(undefined), { configOverrides: null, transformPayloads: undefined });
  assert.deepEqual(resolveInitialRun(null), { configOverrides: null, transformPayloads: undefined });
});

test('buildReportHtml, given the args resolveInitialRun hands the FIRST run() call, reflects a state.scoringOverrides-shaped transform', async () => {
  // Mirrors what demo.js's buildInitialScoringTransform actually builds from
  // a populated state.scoringOverrides (playground.js's mergePlaygroundConfig
  // + recomputeSignals) — here stubbed as a simple, checkable rewrite so this
  // test stays independent of the real scoring pipeline (that pipeline is
  // covered separately in playground.test.js).
  const state = {
    participantId: 'DEMO-test6', trialReports: [], sessionReport: { trialsCompleted: 0 }, violations: [],
  };
  const seenIds = [];
  const transformPayloads = (payloads) => payloads.map((p) => ({ ...p, participantId: p.participantId + '-recomputed' }));
  const initial = resolveInitialRun({ configOverrides: { scoring: { softScoreThreshold: 2 } }, transformPayloads });

  await buildReportHtml(makeStubCore(seenIds), state, [], null, '', initial.configOverrides, initial.transformPayloads);

  assert.deepEqual(seenIds, ['DEMO-test6-recomputed']);
});
