// tests/replay/mutations-fuzz.test.js
// Differential fuzz: random DOM batches → mapMutations → a fork-faithful
// player, compared against what a fresh keyframe of the same DOM would say.
//
// Why this file exists. The hand-written tests in mutations.test.js pin every
// mechanism somebody reasoned about, which is exactly why they could not find
// the four batch-composition defects the second review round did: each was a
// COMPOSITION nobody thought to write down (a removal into a fragment, a
// sibling purged with its ancestor, a nested reveal, a reorder inside a moved
// subtree). A generator does not need to have thought of them.
//
// The oracle is the format's own claim: after any batch, the tree the player
// holds must equal the tree a fresh `serializeTree` of the captured DOM would
// produce — same structure, same attributes, same ids. Exclusion placeholders
// are compared as what a reconstruction can show (`asPlayerTree`).
//
// The generator itself moved to `support/mutation-fuzz.js` in T5 Task 3, so the
// VIEWER's applier can be run over the same batches (`dom-patch.test.js`). This
// file's claim is unchanged and its seeds, mixes and batch sizes are the same
// ones: capture's output is faithfully replayable by the strict player.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPlayer } from './support/dom-player.js';
import { MIXES, SEEDS, generateSession } from './support/mutation-fuzz.js';

function runSession(mixName, seed) {
  const session = generateSession({ mix: mixName, seed });
  const player = createPlayer(session.keyframe);

  for (const batch of session.batches) {
    try {
      player.apply(batch.events);
    } catch (err) {
      assert.fail('player rejected a patch: ' + err.message + '\n' + batch.where);
    }
    assert.deepStrictEqual(player.tree(), batch.expected, 'player diverged, ' + batch.where);
  }
}

describe('mapMutations — differential fuzz (player vs a fresh keyframe)', () => {
  for (const mixName of Object.keys(MIXES)) {
    it('holds under random batches: ' + mixName, () => {
      for (const seed of SEEDS) runSession(mixName, seed);
    });
  }
});
