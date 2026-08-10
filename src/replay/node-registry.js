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
  // is the fallback path for a node that WILL be serialized but has not been
  // walked yet.
  //
  // NOT the way to resolve an event target or anchor: use peekId there. A
  // target outside the observed root must resolve to null (design §2), and
  // minting an id for it would put a number in the file that names nothing in
  // the player's tree. dom.remove (Task 3) and anchors (Task 5) are peekId
  // callers for the same reason.
  //
  // ids.set BEFORE the counter advances, so a call that throws (a non-object
  // node) burns no id and leaves the span's numbering intact.
  function idFor(node) {
    const existing = ids.get(node);
    if (existing !== undefined) return existing;
    ids.set(node, nextId);
    return nextId++;
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
  //
  // Precondition for the fixture's tidy 1..N numbering: the keyframe snapshot
  // walk must be the FIRST allocation after each resetSpan(). Spec §4 only
  // demands unique first-seen ids, and this registry stays correct either way
  // (an idFor between reset and snapshot just shifts the tree to 2..N+1), but
  // the canonical-core keyframe reads 1..5 only because nothing allocates
  // ahead of its walk. Callers: reset, then snapshot, then everything else.
  function assignTree(root) {
    const rootId = idFor(root);
    const children = root.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) assignTree(children[i]);
    }
    return rootId;
  }

  // Read-only lookup: never allocates. Used wherever minting an id would be
  // wrong rather than merely early — `dom.remove` targets, event anchors —
  // because a fresh id there names a node the player was never sent.
  //
  // What it does NOT tell you: a non-null id does not mean the player has the
  // node. assignTree numbers unconditionally, so descendants of a
  // data-record-exclude placeholder, script/noscript elements the serializer
  // skips, and anything numbered by an idFor fallback outside the observed
  // root all peek non-null while appearing nowhere in the file. Strict
  // validation only number-checks `node` fields, so a dangling reference
  // survives validation and shows up as broken replay. Resolving a hit up to
  // the nearest EMITTED ancestor (the placeholder, per spec §4) is the
  // caller's job — this function answers "was it numbered", not "was it sent".
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
