// tests/replay/viewer-model.test.js
// Pure-module shape check for the 0.7.2 extraction: buildViewerModel moved
// out of cli/renderers/replay-assets.js into replay/viewer-model.js so a
// browser demo can bundle it without pulling in fs/path. Full conversion
// behavior (camera folding, time-relativizing, etc.) is already covered by
// tests/cli/replay-render.test.js and tests/replay/alignment-viewer-model.test.js
// against the same function via its re-export; this file only guards the new
// module's existence, shape, and purity.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { buildViewerModel } from '../../src/replay/viewer-model.js';

// Smallest recording buildViewerModel accepts without throwing: it defaults
// every other field internally (see the function's `|| {}` / `|| []` guards),
// so only the participant id is needed to get a non-degenerate model back.
function minimalRecording() {
  return {
    metadata: { participant_id: 'P1' },
    trials: [],
  };
}

describe('buildViewerModel (pure module)', () => {
  it('builds a non-null viewer model from the smallest accepted recording', () => {
    const model = buildViewerModel(minimalRecording());
    assert.strictEqual(typeof model, 'object');
    assert.notStrictEqual(model, null);
    assert.strictEqual(model.pid, 'P1');
  });

  it('imports no Node fs/path APIs (must stay bundleable for the browser demo)', () => {
    const src = readFileSync(
      new URL('../../src/replay/viewer-model.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"](node:)?(fs|path)['"]/);
  });
});
