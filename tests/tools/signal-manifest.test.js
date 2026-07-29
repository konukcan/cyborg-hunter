// tests/tools/signal-manifest.test.js
// Pins the demo's generated signal-manifest numbers to the library's real
// PRESETS.standard values — steps.js copy quotes these numbers by hand, so
// a preset change here must break this test before it can silently drift
// from what the library actually enforces.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildManifest } from '../../tools/gen-signal-manifest.mjs';
import { PRESETS, DEFAULT_THRESHOLDS } from '../../src/shared/constants.js';

describe('buildManifest', () => {
  const m = buildManifest();

  it('defaults to the standard preset', () => {
    assert.strictEqual(m.preset, 'standard');
  });

  it('carries the real paste hard-screenout threshold', () => {
    assert.strictEqual(
      m.signals.paste.hardCountThreshold,
      PRESETS.standard.scoring.hard.paste.countThreshold
    );
  });

  it('carries the real soft-score screenout threshold', () => {
    assert.strictEqual(
      m.signals.softScoreThreshold,
      PRESETS.standard.scoring.softScoreThreshold
    );
  });

  it('carries the real tab-away duration cutoff', () => {
    // standard's thresholds override is {} — the effective value falls back
    // to DEFAULT_THRESHOLDS, same merge order as src/core/monitor.js.
    const effective = { ...DEFAULT_THRESHOLDS, ...PRESETS.standard.thresholds };
    assert.strictEqual(m.signals.tabAway.durationMs, effective.tabAwayDurationMs);
  });
});
