// src/cli/renderers/typing-profile.js
// Thin fs wrapper around the pure drawing core (typing-profile-core.js).
// The core takes an injected createCanvas and returns the drawn canvas (or
// null when there's nothing to draw); this wrapper owns node-canvas
// acquisition and PNG serialization so the core can also run in a browser
// context (demo plot adapter) with document canvases.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { drawTypingProfile, sanitize } from './typing-profile-core.js';
// Load-bearing re-export: drawTypingProfile serves this wrapper's own loop
// below and the future browser demo plot adapter — mirrors
// session-timeline.js / trajectories.js. (renderTypingProfiles remains the
// only symbol external consumers import from this file — see
// tests/cli/renderers.test.js and src/cli/report.js.)
export { drawTypingProfile };

// ── Public API ───────────────────────────────────────────────────────────
export async function renderTypingProfiles(participants, config) {
  const { createCanvas } = await import('canvas');

  for (const p of participants) {
    const canvas = drawTypingProfile(p, config, createCanvas);
    if (!canvas) continue;
    const buf = canvas.toBuffer('image/png');
    const filename = `typing_profile_${sanitize(p.participantId)}.png`;
    writeFileSync(join(config.outputDir, 'images', filename), buf);
  }

  console.log(`  typing profiles — rendered`);
}
