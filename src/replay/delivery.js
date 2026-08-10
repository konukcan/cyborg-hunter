// src/replay/delivery.js
// What the FILE currently contains: which nodes a player reading this
// recording holds, and under which parent.
//
// Every mutation question that matters turns out to be this one question.
// Should a removal be emitted? Only if the player holds that node under that
// parent. May a `before` name this sibling? Only if the player holds it. Does
// an insertion need its old copy removed first? Only if the player holds it
// somewhere else. Two review rounds fixed those one at a time by reasoning
// about the live DOM — the batch's own composition, detached parents, purged
// ancestors — and a differential fuzz kept finding compositions the reasoning
// missed, because the live DOM is not the question. It is the DESTINATION.
//
// Lifetime is the keyframe span, the same as node ids: a keyframe re-serializes
// the whole tree, so `reset()` belongs beside `registry.resetSpan()`.
//
// Identity-keyed WeakMaps: nothing here holds a node alive, and two recorders
// on one page never see each other's nodes.

/**
 * @returns {{deliver, purge, holds, parentOf, childrenOf, reset}}
 */
export function createDelivery() {
  var parents = new WeakMap();     // node → the parent it sits under in the file
  var children = new WeakMap();    // node → Set of its delivered children

  function detach(node) {
    var parent = parents.get(node);
    if (parent) {
      var siblings = children.get(parent);
      if (siblings) siblings.delete(node);
    }
  }

  function purgeNode(node) {
    var kids = children.get(node);
    if (kids) {
      kids.forEach(function (child) { purgeNode(child); });
      children.delete(node);
    }
    parents.delete(node);
  }

  return {
    // The file now carries `node` under `parent` (null for a keyframe root).
    // A node delivered somewhere else first leaves that place, which is what
    // makes a move a single fact rather than two.
    deliver: function (node, parent) {
      if (parents.has(node)) detach(node);
      parents.set(node, parent || null);
      if (parent) {
        var siblings = children.get(parent);
        if (!siblings) { siblings = new Set(); children.set(parent, siblings); }
        siblings.add(node);
      }
    },

    // The file no longer carries `node`, and a player removing it takes the
    // subtree with it — so its delivered descendants go too.
    purge: function (node) {
      detach(node);
      purgeNode(node);
    },

    holds: function (node) { return parents.has(node); },
    parentOf: function (node) {
      var parent = parents.get(node);
      return parent === undefined ? null : parent;
    },
    // Delivery order, not document order: callers use this to take children
    // away, where order does not matter.
    childrenOf: function (node) {
      var kids = children.get(node);
      return kids ? Array.from(kids) : [];
    },

    reset: function () { parents = new WeakMap(); children = new WeakMap(); },
  };
}

// On by default, so a capture path that forgets to thread one still tracks
// delivery rather than silently guessing. Callers that need their own scope —
// a second recorder, or a serialization taken purely to inspect it — pass one.
var defaultDelivery = createDelivery();

export function deliveryFor(candidate) {
  return candidate && typeof candidate.holds === 'function' ? candidate : defaultDelivery;
}
