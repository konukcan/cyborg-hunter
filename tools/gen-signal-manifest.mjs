// tools/gen-signal-manifest.mjs
// Generates demo/signal-manifest.json — every numeric fact the tour quotes
// ("two pastes cross the standard preset's HARD threshold", "12s tab-away",
// etc.) is read from the library's real PRESETS here, never hand-typed.
// Labels, hints, and copy stay hand-written in demo/steps.js; this file
// contributes numbers only, so a preset change can't silently drift from
// what the tour script claims.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRESETS, DEFAULT_THRESHOLDS } from '../src/shared/constants.js';

// Builds the manifest for a given preset. Merge order matches
// src/core/monitor.js: DEFAULT_THRESHOLDS, then the preset's own overrides.
export function buildManifest(presetName = 'standard') {
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset: ${presetName}`);
  }
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(preset.thresholds || {}) };
  const hard = preset.scoring.hard || {};
  const soft = preset.scoring.soft || {};

  return {
    preset: presetName,
    generated: true,
    signals: {
      paste: {
        hardCountThreshold: hard.paste?.countThreshold
      },
      drop: {
        hardCountThreshold: hard.drop?.countThreshold
      },
      copy: {
        softWeight: soft.copy?.weight,
        maxPerTrial: soft.copy?.maxPerTrial
      },
      tabAway: {
        softWeight: soft.tabAway?.weight,
        maxPerTrial: soft.tabAway?.maxPerTrial,
        durationMs: thresholds.tabAwayDurationMs
      },
      typingSpeed: {
        softWeight: soft.typingSpeed?.weight,
        cps: thresholds.typingSpeedCps
      },
      sidebarEvent: {
        softWeight: soft.sidebarEvent?.weight
      },
      devTools: {
        softWeight: soft.devTools?.weight
      },
      foreignInput: {
        softWeight: soft.foreignInput?.weight
      },
      softScoreThreshold: preset.scoring.softScoreThreshold,
      screenout: {
        enabled: preset.screenout?.enabled,
        gracePeriodTrials: preset.screenout?.gracePeriodTrials
      }
    }
  };
}

// Runs only when this file is the entry point (not on import from the test).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const manifest = buildManifest();
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', 'demo', 'signal-manifest.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${outPath}`);
}
