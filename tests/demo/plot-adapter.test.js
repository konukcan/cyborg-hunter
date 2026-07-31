// tests/demo/plot-adapter.test.js
// The adapter runs the pure cores against an injected canvas factory and
// returns data URIs (or null per plot when a core skips). DOM-free: cores
// come from src directly; canvases from a stub factory exposing toDataURL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makePlotAdapter } from '../../demo/plot-adapter.js';
import { extractIntegrityData } from '../../src/cli/extract-core.js';
import { drawSessionTimeline } from '../../src/cli/renderers/session-timeline-core.js';
import { drawTrajectoryGrid } from '../../src/cli/renderers/trajectories-core.js';
import { drawTypingProfile } from '../../src/cli/renderers/typing-profile-core.js';
import { makeRecordingCanvasFactory } from '../cli/plot-cores.test.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'demo', 'DEMO-FIXT.json'), 'utf8'));
const p = extractIntegrityData(raw, { outputDir: '.', participantIdField: 'participantId' });
const adapter = makePlotAdapter({ drawSessionTimeline, drawTrajectoryGrid, drawTypingProfile });

test('adapter returns a data URI per drawable plot and null per skipped plot', async () => {
  const log = [];
  const base = makeRecordingCanvasFactory(log);
  const factory = (w, h) => Object.assign(base(w, h), { toDataURL: () => 'data:image/png;base64,STUB' });
  const out = await adapter.renderPlotDataUris(p, { hardTriggered: false }, {}, factory);
  assert.deepEqual(Object.keys(out).sort(), ['sessionTimeline', 'trajectories', 'typingProfile']);
  for (const k of Object.keys(out)) assert.ok(out[k] === null || out[k] === 'data:image/png;base64,STUB', k);
  // DEMO-FIXT draws all three for real — assert non-null so this test can't
  // silently pass on a broken adapter that nulls everything:
  assert.equal(out.sessionTimeline, 'data:image/png;base64,STUB');
  assert.equal(out.typingProfile, 'data:image/png;base64,STUB');
  assert.equal(out.trajectories, 'data:image/png;base64,STUB');
});

test('a throwing core yields null for that plot, not a rejected promise', async () => {
  const bad = makePlotAdapter({
    drawSessionTimeline: () => { throw new Error('boom'); },
    drawTrajectoryGrid,
    drawTypingProfile,
  });
  const log = [];
  const factory = (w, h) => Object.assign(makeRecordingCanvasFactory(log)(w, h), { toDataURL: () => 'data:image/png;base64,STUB' });
  const out = await bad.renderPlotDataUris(p, { hardTriggered: false }, {}, factory);
  assert.equal(out.sessionTimeline, null);
  assert.equal(out.typingProfile, 'data:image/png;base64,STUB');
});
