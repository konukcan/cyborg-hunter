// src/replay/node-registry.js
// Node-ID registry for the v2 recording format. Pure — no imports, no DOM
// APIs — so it runs identically in the browser, in node tests against
// fake-DOM fixtures, and (later) inside the shared engine.
//
// Spec §4: every node in a recording carries an integer id; ids are scoped to
// a KEYFRAME SPAN (a keyframe segment plus its continuation segments) and are
// assigned in first-seen pre-order, restarting at 1 at each keyframe. The
// snapshot walk numbers the tree; mid-span `dom.add` subtrees continue the
// same counter (canonical-core pins ids 6,7 after a 5-node keyframe).
//
// Identity, not content: a WeakMap keyed by the LIVE node object. Nothing is
// stamped into the DOM (the v1 nonce-marker attribute mechanism, which had to
// dodge its own MutationObserver echo, is retired by this module), and a
// dropped span's entries become garbage-collectable the moment resetSpan()
// releases the map.

/**
 * Create a node-ID registry for one keyframe span.
 *
 * @returns {{
 *   idFor: (node: object) => number,
 *   assignTree: (root: object) => number,
 *   peekId: (node: object) => number | null,
 *   resetSpan: () => void,
 *   count: number
 * }}
 */
export function createRegistry() {
  let ids = new WeakMap();
  let nextId = 1;

  // Assign-if-absent for a SINGLE node (no descendant walk). In normal
  // operation every node of the observed tree is numbered by assignTree
  // first — snapshot walk at the keyframe, dom.add walks mid-span — so this
  // is the fallback path: event capture resolving a target/anchor node that
  // was never walked (e.g. a listener firing on a node outside the observed
  // root, or before the first snapshot).
  function idFor(node) {
    const existing = ids.get(node);
    if (existing !== undefined) return existing;
    const id = nextId++;
    ids.set(node, id);
    return id;
  }

  // Pre-order walk: root, then each child's whole subtree, left to right.
  // Numbers EVERY node the DomNode serialization can emit — elements, text,
  // comments — because spec §4 gives all three an id.
  //
  // Boundary: the registry numbers whatever tree it is handed. Exclusion
  // (data-record-exclude placeholders) and redaction filtering are the
  // SERIALIZER's concern (Task 2); an excluded element still occupies its
  // position and still needs an id, and the serializer decides what of the
  // subtree reaches the file. Keeping the walk unconditional means ids stay
  // stable regardless of what the serializer later chooses to emit.
  function assignTree(root) {
    const rootId = idFor(root);
    const children = root.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) assignTree(children[i]);
    }
    return rootId;
  }

  // Read-only lookup: never allocates. Used wherever an id is only meaningful
  // if the node was already part of the recorded tree — `dom.remove` targets,
  // event anchors — where inventing an id would point the player at a node it
  // has never seen.
  function peekId(node) {
    const id = ids.get(node);
    return id === undefined ? null : id;
  }

  // Keyframe boundary: drop the whole span's assignments and restart at 1.
  // A fresh WeakMap rather than per-entry deletion — the old map is simply
  // released along with the span it described.
  function resetSpan() {
    ids = new WeakMap();
    nextId = 1;
  }

  return {
    idFor,
    assignTree,
    peekId,
    resetSpan,
    // Ids are handed out only by the counter, one per node, so the number
    // assigned in this span is always nextId − 1 — no second tally to keep in
    // sync. A getter (not a snapshot property) so callers read it live.
    get count() { return nextId - 1; },
  };
}
