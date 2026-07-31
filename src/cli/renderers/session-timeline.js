// src/cli/renderers/session-timeline.js
// Thin fs wrapper around the pure drawing core (session-timeline-core.js).
// The core takes an injected createCanvas and returns the drawn canvas; this
// wrapper owns node-canvas acquisition and PNG serialization so the core can
// also run in a browser (demo plot adapter) with document canvases.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { drawSessionTimeline, collectEvents, deriveSessionOffset, sanitize, shortId } from './session-timeline-core.js';
// Load-bearing re-exports: tests/cli/contract-fixes.test.js imports
// collectEvents + deriveSessionOffset from this path; drawSessionTimeline
// serves this wrapper's own loop and the future browser demo plot adapter.
export { drawSessionTimeline, collectEvents, deriveSessionOffset };

// ── Public API ───────────────────────────────────────────────────────────
export async function renderSessionTimelines(participants, config) {
  const { createCanvas } = await import('canvas');

  let rendered = 0;
  for (const p of participants) {
    try {
      const canvas = await drawSessionTimeline(p, config, createCanvas);
      if (!canvas) continue;
      const buf = canvas.toBuffer('image/png');
      const filename = `session_timeline_${sanitize(p.participantId)}.png`;
      writeFileSync(join(config.outputDir, 'images', filename), buf);
      rendered++;
    } catch (err) {
      // Defensive: never let one bad payload kill the whole report.
      console.warn(`  [warn] session timeline failed for ${shortId(p.participantId)}: ${err.message}`);
    }
  }
  console.log(`  session timelines — rendered (${rendered}/${participants.length})`);
}
