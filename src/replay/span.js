// src/replay/span.js
// The KEYFRAME SPAN: one recording's node ids and one recording's picture of
// what the file already contains, bound together because they are the same
// lifetime and the same mistake.
//
// A span is what capture threads through everything. `serializeTree` writes
// into it (numbering nodes, recording what it emitted) and `mapMutations`
// reads it (which node the player holds, and where). Two properties follow
// from binding them, and neither survived them being separate:
//
//   - **Resetting is one call.** Ids restart at a keyframe and the delivered
//     picture is rebuilt by the same walk, so they must reset together.
//     Missing one is not stale bookkeeping: a keyframe taken with a stale
//     delivery model believes the player already holds what it is about to
//     stop describing, and the next patch for that node is suppressed. The
//     node then never appears in the recording.
//   - **A serialization taken to measure cannot corrupt a live recording.**
//     Sizing a snapshot (Task 8's cadence trigger, a byte-cap probe) means
//     serializing a tree the recorder is also serializing. Give that call its
//     OWN span and it writes into its own ids and its own delivered set; there
//     is no shared default to fall back into.
//
// NOT in the span, deliberately: the redaction taint set (redaction.js). It
// tracks content this recording has ever withheld, which must outlive any
// keyframe — a leak scan reads the whole file — and a stray serialization can
// only ever add to it, which is the safe direction.

import { createRegistry } from './node-registry.js';
import { createDelivery } from './delivery.js';

/**
 * Create a capture span.
 *
 * @returns {{registry: object, delivery: object, reset: () => void}}
 *   `registry` — node ids (node-registry.js)
 *   `delivery` — what the file contains (delivery.js)
 *   `reset()`  — start a new keyframe span: ids restart at 1 and the delivered
 *                picture empties, in one call so neither can be forgotten.
 *
 * One per recording (the capture wiring creates it); reset at each keyframe
 * (the cadence logic calls it); a fresh one for any serialization whose output
 * is not going into the file.
 */
export function createSpan() {
  var registry = createRegistry();
  var delivery = createDelivery();
  return {
    registry: registry,
    delivery: delivery,
    reset: function () {
      registry.resetSpan();
      delivery.reset();
    },
  };
}
