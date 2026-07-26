import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { renderTypingProfiles } from '../../src/cli/renderers/typing-profile.js';

// Smoke test for the typing-profile renderer. The P8 change introduced a
// third bar state (paste-only, hatched) distinct from "typed" and "no-data".
// We can't easily diff pixels, so the test just verifies the renderer runs
// end-to-end on a mixed participant and produces a non-trivial PNG.
describe('renderTypingProfiles (P8 paste-only markers)', () => {
  const outDir = '/tmp/cyborg-hunter-p8-test';

  it('renders a mixed typed + paste-only + no-data participant without crashing', async () => {
    // Clean output dir
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'images'), { recursive: true });

    const participant = {
      participantId: 'P-MIXED',
      trials: [
        // typed, below threshold
        { trialId: 'r1', charsPerSec: 4.2, pasteEvents: [] },
        // typed, above threshold
        { trialId: 'r2', charsPerSec: 15.0, pasteEvents: [] },
        // paste-only: single paste, no editTimestamps ≥ 2, so charsPerSec is null
        { trialId: 'r3', charsPerSec: null, pasteEvents: [{ t: 100, length: 63 }] },
        // no-data: neither typing nor paste (e.g., empty response)
        { trialId: 'r4', charsPerSec: null, pasteEvents: [] }
      ]
    };

    await renderTypingProfiles([participant], {
      outputDir: outDir,
      typingSpeedThreshold_cps: 10
    });

    // PNG should exist and be non-trivially sized. A blank 0-byte file would
    // indicate the renderer bailed; a few hundred bytes means it drew stuff.
    const pngPath = join(outDir, 'images', 'typing_profile_P-MIXED.png');
    assert.ok(existsSync(pngPath), 'expected typing_profile PNG to be written');
    assert.ok(statSync(pngPath).size > 1000, 'PNG should be larger than a blank canvas');
  });

  it('skips rendering when every trial is no-data (no typed AND no paste)', async () => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'images'), { recursive: true });

    const participant = {
      participantId: 'P-EMPTY',
      trials: [
        { trialId: 'r1', charsPerSec: null, pasteEvents: [] },
        { trialId: 'r2', charsPerSec: null, pasteEvents: [] }
      ]
    };

    await renderTypingProfiles([participant], {
      outputDir: outDir,
      typingSpeedThreshold_cps: 10
    });

    // No bars to show → renderer should skip this participant entirely.
    const pngPath = join(outDir, 'images', 'typing_profile_P-EMPTY.png');
    assert.ok(!existsSync(pngPath), 'renderer should skip participants with only no-data trials');
  });

  it('renders a mixed paste+type trial without crashing (typed bar + P marker)', async () => {
    // Participant who typed enough to get a CPS (≥ 2 edit timestamps) AND
    // also pasted. P8 extension: show the colored bar as usual, with a "P"
    // marker above it to flag the paste. Different from paste-only, which
    // has no bar fill (hatched only).
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'images'), { recursive: true });

    const participant = {
      participantId: 'P-MIXED-TRIAL',
      trials: [
        { trialId: 'r1', charsPerSec: 5.0, pasteEvents: [{ t: 100, length: 20 }] }
      ]
    };

    await renderTypingProfiles([participant], {
      outputDir: outDir,
      typingSpeedThreshold_cps: 10
    });

    const pngPath = join(outDir, 'images', 'typing_profile_P-MIXED-TRIAL.png');
    assert.ok(existsSync(pngPath), 'mixed paste+type trial should render');
    assert.ok(statSync(pngPath).size > 1000, 'PNG should include bar + P marker');
  });

  it('renders a paste-only-only participant (no typed trials) — P8 regression case', async () => {
    // This is the exact shape of participant 69b594dccc64df571f092147 that
    // originally surfaced the bug: mostly paste-only responses. Pre-P8 this
    // would have been skipped (speeds all 0) or drawn with invisible bars.
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'images'), { recursive: true });

    const participant = {
      participantId: 'P-PASTE',
      trials: [
        { trialId: 'r1', charsPerSec: null, pasteEvents: [{ t: 100, length: 40 }] },
        { trialId: 'r2', charsPerSec: null, pasteEvents: [{ t: 200, length: 55 }] },
        { trialId: 'r3', charsPerSec: 3.5, pasteEvents: [] }
      ]
    };

    await renderTypingProfiles([participant], {
      outputDir: outDir,
      typingSpeedThreshold_cps: 10
    });

    const pngPath = join(outDir, 'images', 'typing_profile_P-PASTE.png');
    assert.ok(existsSync(pngPath), 'paste-only-dominant participant should still render');
    assert.ok(statSync(pngPath).size > 1000, 'PNG should include the hatched markers');
  });
});
