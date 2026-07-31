// tests/tools/example-fixtures.test.js
// (1) Determinism: regenerating produces byte-identical output (protects the
// committed copy from drift). (2) CLI-ingestible: the real pipeline reads
// them, example-1 lands HARD-leaning, example-2 CLEAN, and both carry enough
// mouse data for the trajectory renderer. (3, sanctioned extra) all three
// plot CORES draw non-trivially over both extracted examples — the whole
// point of "rich" fixtures per spec §7.2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { extractIntegrityData } from '../../src/cli/extract-core.js';
import { computeSummary } from '../../src/cli/analyzers/summary.js';
import { detectEdgeExits } from '../../src/cli/analyzers/edge-exit.js';
import { rankTriage } from '../../src/cli/analyzers/triage.js';
import { drawSessionTimeline } from '../../src/cli/renderers/session-timeline-core.js';
import { drawTrajectoryGrid } from '../../src/cli/renderers/trajectories-core.js';
import { drawTypingProfile } from '../../src/cli/renderers/typing-profile-core.js';
import { makeRecordingCanvasFactory } from '../cli/plot-cores.test.js';

const OUT = 'demo/assets/example-participants.json';

test('generator is deterministic and matches the committed file', () => {
  const committed = readFileSync(OUT, 'utf8');
  const regenerated = execFileSync('node', ['tools/gen-example-fixtures.mjs', '--stdout']).toString();
  assert.equal(regenerated, committed);
});

test('examples are CLI-ingestible with the intended tiers and mouse data', () => {
  const config = { outputDir: '.', participantIdField: 'participantId' };
  const [ex1, ex2] = JSON.parse(readFileSync(OUT, 'utf8'));
  const ps = [extractIntegrityData(ex1, config), extractIntegrityData(ex2, config)];
  for (const p of ps) {
    assert.ok(p.trials.length >= 3);
    assert.ok(p.trials.some(t => t.mouseDataAvailable), p.participantId + ' has mouse data');
  }
  const triage = rankTriage(computeSummary(ps, config), detectEdgeExits(ps, config), config);
  const byId = Object.fromEntries(triage.map(t => [t.participantId, t]));
  assert.equal(byId['example-1'].hardTriggered, true);
  assert.equal(byId['example-2'].hardTriggered, false);
  assert.equal(byId['example-2'].softFlagged, false);
});

// Extra (sanctioned beyond the plan): the whole point of "rich" fixtures is
// that all three plot cores draw something non-trivial from them — not just
// that the CLI pipeline ingests them without error. Runs each core with the
// same recording-canvas factory plot-cores.test.js uses and asserts a
// non-null canvas plus a real amount of drawing (>50 calls) per example.
test('all three plot cores draw non-trivially over both examples', () => {
  const config = { outputDir: '.', participantIdField: 'participantId' };
  const [ex1, ex2] = JSON.parse(readFileSync(OUT, 'utf8'));
  const ps = [extractIntegrityData(ex1, config), extractIntegrityData(ex2, config)];
  const triage = rankTriage(
    computeSummary(ps, config), detectEdgeExits(ps, config), config
  );
  const byId = Object.fromEntries(triage.map(t => [t.participantId, t]));

  for (const p of ps) {
    const triageEntry = byId[p.participantId];

    const stLog = [];
    const stCanvas = drawSessionTimeline(p, config, makeRecordingCanvasFactory(stLog));
    assert.ok(stCanvas, `${p.participantId}: session-timeline core returned a canvas`);
    assert.ok(stLog.length > 50, `${p.participantId}: session-timeline drew ${stLog.length} calls (want >50)`);

    const trajLog = [];
    const trajCanvas = drawTrajectoryGrid(p, triageEntry, config, makeRecordingCanvasFactory(trajLog));
    assert.ok(trajCanvas, `${p.participantId}: trajectories core returned a canvas`);
    assert.ok(trajLog.length > 50, `${p.participantId}: trajectories drew ${trajLog.length} calls (want >50)`);

    const typeLog = [];
    const typeCanvas = drawTypingProfile(p, config, makeRecordingCanvasFactory(typeLog));
    assert.ok(typeCanvas, `${p.participantId}: typing-profile core returned a canvas`);
    assert.ok(typeLog.length > 50, `${p.participantId}: typing-profile drew ${typeLog.length} calls (want >50)`);
  }
});
