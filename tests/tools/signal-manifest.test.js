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

  it('gives preset thresholds precedence over defaults (order-sensitive case)', () => {
    // standard's thresholds override is {}, so both merge orders coincide
    // there — strict overrides both values, catching a swapped spread order.
    const strict = buildManifest('strict');
    const effective = { ...DEFAULT_THRESHOLDS, ...PRESETS.strict.thresholds };
    assert.strictEqual(strict.signals.tabAway.durationMs, effective.tabAwayDurationMs); // 5000, not 3000
    assert.strictEqual(strict.signals.typingSpeed.cps, effective.typingSpeedCps);       // 8, not 10
  });
});

// C3 playground data: presets.{standard,strict} carry the control prefills
// and the verbatim soft-scoring maps recomputeSignals runs with. Pinned
// against constants.js so demo-side scoring can never drift from the
// library's real presets (there is no hand-mirrored table left in demo JS).
describe('buildManifest presets block (playground scoring source)', () => {
  const m = buildManifest();

  it('emits both selectable presets regardless of the top-level preset', () => {
    assert.deepStrictEqual(Object.keys(m.presets).sort(), ['standard', 'strict']);
    assert.deepStrictEqual(Object.keys(buildManifest('strict').presets).sort(), ['standard', 'strict']);
  });

  for (const name of ['standard', 'strict']) {
    it(`${name}: controls match the library's effective thresholds`, () => {
      const effective = { ...DEFAULT_THRESHOLDS, ...PRESETS[name].thresholds };
      assert.deepStrictEqual(m.presets[name].controls, {
        pasteHardCount: PRESETS[name].scoring.hard.paste.countThreshold,
        tabAwayCutoffMs: effective.tabAwayDurationMs,
        typingSpeedCps: effective.typingSpeedCps,
      });
    });

    it(`${name}: soft scoring map + threshold are verbatim from constants.js`, () => {
      assert.deepStrictEqual(m.presets[name].scoring.soft, PRESETS[name].scoring.soft);
      assert.strictEqual(
        m.presets[name].scoring.softScoreThreshold,
        PRESETS[name].scoring.softScoreThreshold
      );
    });
  }

  it('strict has no soft.copy — the gating recomputeSignals mirrors', () => {
    // scoring.js only scores a signal whose key exists in scoring.soft;
    // strict scores copy as HARD-only. A hand-added copy entry here would
    // make the playground invent a soft term the library never computes.
    assert.strictEqual(PRESETS.strict.scoring.soft.copy, undefined);
    assert.strictEqual(m.presets.strict.scoring.soft.copy, undefined);
  });
});
