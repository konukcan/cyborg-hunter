// src/cli/renderers/trajectories.js
// Thin fs wrapper around the pure drawing core (trajectories-core.js).
// The core takes an injected createCanvas and returns the drawn canvas (or
// null when the participant has no trials); this wrapper owns node-canvas
// acquisition, the triage lookup, and PNG serialization so the core can also
// run in a browser context (demo plot adapter) with document canvases.
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  drawTrajectoryGrid,
  orderTrials,
  pickWindowGeometryForTrial,
  computeZoomScale,
  chooseScreenFrame,
  computeZoomTag,
  sanitize,
} from './trajectories-core.js';
// Load-bearing re-exports (ESM `export { x } from './y.js'` binds no local
// name, so each of these is imported above and re-exported here explicitly):
//   orderTrials                 — tests/cli/trajectory-order.test.js
//   pickWindowGeometryForTrial  — tests/cli/window-geometry.test.js
//   computeZoomScale            — tests/cli/window-geometry.test.js
//   chooseScreenFrame           — tests/cli/window-geometry.test.js,
//                                  tests/cli/trajectory-frame.test.js
//   computeZoomTag              — tests/cli/trajectory-frame.test.js
// drawTrajectoryGrid serves this wrapper's own loop below and the future
// browser demo plot adapter.
export { drawTrajectoryGrid, orderTrials, pickWindowGeometryForTrial, computeZoomScale, chooseScreenFrame, computeZoomTag };

// ── Public API ───────────────────────────────────────────────────────────
export async function renderTrajectories(participants, triage, config) {
  const { createCanvas } = await import('canvas');
  const triageMap = new Map(triage.map(t => [t.participantId, t]));

  for (const p of participants) {
    const triageEntry = triageMap.get(p.participantId);
    const canvas = drawTrajectoryGrid(p, triageEntry, config, createCanvas);
    if (!canvas) continue;
    const buf = canvas.toBuffer('image/png');
    const filename = `trajectories_${sanitize(p.participantId)}.png`;
    writeFileSync(join(config.outputDir, 'images', filename), buf);
  }

  console.log(`  trajectories — ${participants.length} images`);
}
