// src/replay/mutations.js
// MutationObserver batches → v2 `dom.*` patch events (spec §5.1).
//
// The mid-span counterpart to snapshot.js: a keyframe is a DomNode tree, and
// everything that happens to the DOM afterwards is expressed as patches
// addressing that tree's integer ids. Pure and observer-free — it maps an
// ARRAY of MutationRecords to an array of events — so it can be tested against
// records a real observer produced without a recorder, a clock, or a browser
// in the loop. Live wiring (replacing capture-dom.js's observer callback)
// happens at the capture switchover.
//
// Everything is decided at FLUSH time, against the DOM as it stands when the
// observer callback runs, which is also the state serializeTree sees:
//   - an inserted node still attached is added; one that the same batch removed
//     again is not mentioned at all (it never entered the file);
//   - `before` is resolved from the live sibling chain, skipping siblings the
//     player does not currently hold. (A MutationRecord's own `nextSibling` is
//     the sibling at MUTATION time, which mixes two moments of the DOM's
//     history in one patch — and happy-dom does not populate it at all.)
//
// RETIRED from v1 (capture-dom.js:470-507), deliberately:
//   - the one-childList-patch-per-target intra-batch dedup. It existed because
//     every v1 childList patch re-serialized the target's FULL resulting
//     children, so N appends to one container cost O(N²) of the participant's
//     CPU. A `dom.add` carries only the inserted subtree, so N appends cost
//     O(total inserted) — the storm guard now costs precision (dropping the
//     2nd..Nth insertion's position) and buys nothing.
//   - the characterData→parent-childList fold. It existed because text nodes
//     had no parser-stable address, so text changes had to be re-expressed as
//     the parent's children. Node ids ARE that address: `dom.text` names the
//     text node itself and carries nothing else.

import {
  serializeTree, isExcluded, nearestEmittedAncestor, isEmittableNode,
  carriesChildren, emittedAttrs, attrPatchValue, ATTR_WITHHELD,
} from './snapshot.js';
import { isInRedactedSubtree } from './redaction.js';

var ELEMENT_NODE = 1;

/**
 * The observer configuration this mapper's semantics assume. Exported so the
 * capture wiring cannot drift from what the tests pin.
 *
 * `attributeOldValue` is load-bearing, not diagnostic: an exclusion TOGGLE is
 * detected by re-running the exclusion predicate against the element as it was
 * before the mutation, which needs the old value. Without it, removing
 * `data-record-exclude` would read as an ordinary attribute change and the
 * hidden subtree would never come back.
 */
export var MUTATION_OBSERVER_INIT = {
  childList: true,
  attributes: true,
  attributeOldValue: true,
  characterData: true,
  subtree: true,
};

/**
 * Map one observer callback's records to `dom.*` events.
 *
 * @param {Array} records  the batch, in the order the observer reported it
 * @param {object} ctx     {root, registry, t, keepBait?, redactSelector?}
 *                         `ctx` doubles as the serializer's options bag — same
 *                         keys, so exclusion and redaction cannot be answered
 *                         one way here and another way in the keyframe.
 * @returns {Array} events, in batch order, all stamped with the same `t`
 *
 * One callback = one `t` (spec §7 forbids nothing finer, and the records of a
 * batch are a single task's worth of DOM change). Times are stamped raw; wire
 * rounding belongs to the serializer.
 */
export function mapMutations(records, ctx) {
  var out = [];
  if (!records || !records.length || !ctx) return out;
  // A root that resolved to null (a host that wiped its display container)
  // drops the batch rather than throwing inside the observer callback.
  if (!ctx.root || !ctx.registry) return out;

  var state = {
    out: out,
    root: ctx.root,
    registry: ctx.registry,
    t: ctx.t,
    opts: ctx,
    // Nodes whose subtree this batch has already emitted, and nodes this batch
    // has removed from the player's DOM. Both are about what the PLAYER holds
    // right now, which is what `before` resolution and duplicate suppression
    // need to know.
    added: new Set(),
    removed: new Set(),
  };

  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    if (!record) continue;
    if (record.type === 'childList') mapChildList(record, state);
    else if (record.type === 'attributes') mapAttributes(record, state);
    else if (record.type === 'characterData') mapCharacterData(record, state);
  }
  return out;
}

// Removals before insertions: that is the order the DOM itself performs them
// in (a replaceChild, or a move, is a removal followed by an insertion), and
// it is what keeps a moved node's `dom.remove` ahead of its `dom.add`.
function mapChildList(record, state) {
  var removed = record.removedNodes || [];
  for (var i = 0; i < removed.length; i++) {
    mapRemoved(removed[i], record.target, state);
  }
  var added = record.addedNodes || [];
  for (var j = 0; j < added.length; j++) mapAdded(added[j], state);
}

function mapRemoved(node, oldParent, state) {
  var id = state.registry.peekId(node);
  // Never numbered → never in the file. This is the add-and-remove-inside-one-
  // batch case: the insertion was skipped (the node is not attached at flush
  // time), so no id was ever minted and there is nothing to remove.
  if (id == null) return;
  // Numbered but never EMITTED — a script, or anything under an exclusion
  // placeholder or an iframe. The id names nothing in the player's tree, and
  // resolving it up to the nearest emitted ancestor would delete a node that
  // is still there.
  if (nearestEmittedAncestor(node, state.root, state.opts, oldParent) !== node) return;

  state.out.push({ type: 'dom.remove', t: state.t, node: id });
  state.removed.add(node);
  state.added.delete(node);
}

function mapAdded(node, state) {
  if (state.added.has(node)) return;
  // Serialization is final-state, so a container's patch already carries the
  // children a later record in the same batch appended to it.
  for (var p = node.parentNode; p; p = p.parentNode) {
    if (state.added.has(p)) return;
    if (p === state.root) break;
  }
  // Detached again before the callback ran, outside the observed root, or a
  // node the file never carries (script, anything under a placeholder or an
  // iframe): no patch, and — since serializeTree is never reached — no id.
  if (nearestEmittedAncestor(node, state.root, state.opts) !== node) return;

  var parentId = state.registry.peekId(node.parentNode);
  if (parentId == null) return;
  var before = beforeId(node, state);
  var tree = serializeTree(node, state.registry, state.opts);
  if (!tree) return;

  state.out.push({
    type: 'dom.add', t: state.t, parent: parentId, before: before, node: tree,
  });
  state.added.add(node);
  state.removed.delete(node);
}

// The id the player should insert before, or null to append. Siblings the
// player does not currently hold are skipped: a brand-new one (no id yet — its
// own dom.add comes later in this batch) and one this batch removed (its
// re-insertion, if any, comes later). Naming either would put a dangling
// reference in the file, which strict validation cannot catch — it type-checks
// `node` fields, it does not resolve them.
function beforeId(node, state) {
  for (var sib = node.nextSibling; sib; sib = sib.nextSibling) {
    if (state.removed.has(sib)) continue;
    var id = state.registry.peekId(sib);
    if (id == null) continue;
    if (nearestEmittedAncestor(sib, state.root, state.opts) !== sib) continue;
    return id;
  }
  return null;
}

function mapAttributes(record, state) {
  var el = record.target;
  var name = record.attributeName;
  if (!el || el.nodeType !== ELEMENT_NODE || !name) return;
  if (nearestEmittedAncestor(el, state.root, state.opts) !== el) return;
  var id = state.registry.peekId(el);
  if (id == null) return;

  var now = isExcluded(el, state.opts);
  var before = wasExcluded(el, record, state.opts);
  // A placeholder carries no attributes at all (spec §4), so an attribute
  // change on one has nothing to say — the transitions are the only exception.
  if (before && now) return;
  if (!before && now) { collapseToPlaceholder(el, id, state); return; }
  if (before && !now) { restoreFromPlaceholder(el, id, state); return; }

  var value = attrPatchValue(
    el, name, isInRedactedSubtree(el, state.opts.redactSelector));
  if (value === ATTR_WITHHELD) return;
  state.out.push({
    type: 'dom.attr', t: state.t, node: id, name: name, value: value,
  });
}

// Was this element excluded BEFORE the recorded attribute change? Answered by
// running the one exclusion predicate over a view of the element with the
// mutated attribute reverted — a second implementation of "is this excluded"
// is exactly the drift the shared predicates exist to prevent. `isExcluded`
// reads only nodeType, the attribute names, and `id`, so the view is cheap.
function wasExcluded(el, record, opts) {
  var name = record.attributeName;
  var old = record.oldValue;
  var attrs = [];
  var present = false;
  var live = el.attributes || [];
  for (var i = 0; i < live.length; i++) {
    if (live[i].name === name) { present = true; continue; }
    attrs.push({ name: live[i].name, value: live[i].value });
  }
  // An `attributes` record fires only on a real change, so an attribute that
  // is absent NOW was present before — whatever `oldValue` says. That reading
  // is what makes the un-exclusion direction robust: an empty-valued
  // `data-record-exclude` reports `oldValue: ""` in a browser and `null` in
  // happy-dom, and presence (not value) is what the exclusion predicate reads.
  if (!present) attrs.push({ name: name, value: old == null ? '' : old });
  else if (old !== null && old !== undefined) attrs.push({ name: name, value: old });
  return isExcluded({
    nodeType: ELEMENT_NODE,
    id: name === 'id' ? (old == null ? '' : old) : el.id,
    attributes: attrs,
  }, opts);
}

// Exclusion attribute ADDED to a live element (spec §4): its children leave
// the file and its attributes are cleared, leaving the bare placeholder a
// fresh snapshot would have written. The exclusion attribute clears itself
// too — a placeholder is `{id, kind, tag}` and nothing else.
function collapseToPlaceholder(el, id, state) {
  // `carriesChildren(el, false)`: whether the file held this element's
  // children a moment ago, when it was not yet a placeholder. The live DOM
  // already says otherwise, which is why the flag is passed rather than looked
  // up.
  if (carriesChildren(el, false)) {
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var kidId = state.registry.peekId(kids[i]);
      if (kidId == null || !isEmittableNode(kids[i])) continue;
      state.out.push({ type: 'dom.remove', t: state.t, node: kidId });
      state.removed.add(kids[i]);
      state.added.delete(kids[i]);
    }
  }
  var attrs = emittedAttrs(el, isInRedactedSubtree(el, state.opts.redactSelector));
  for (var name in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    state.out.push({ type: 'dom.attr', t: state.t, node: id, name: name, value: null });
  }
}

// Exclusion attribute REMOVED (spec §4): attributes come back, then the
// subtree as a freshly numbered `dom.add` per child.
//
// "Freshly numbered" means ids the file has never used, and that is what these
// are: the numbering pass walks hidden subtrees unconditionally, so the
// children were reserved numbers at the keyframe and emitted under none of
// them. Reusing those reservations keeps the span monotonic and makes a
// hide/reveal cycle idempotent — nothing is renumbered, no id is spent twice.
function restoreFromPlaceholder(el, id, state) {
  var attrs = emittedAttrs(el, isInRedactedSubtree(el, state.opts.redactSelector));
  for (var name in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    state.out.push({
      type: 'dom.attr', t: state.t, node: id, name: name, value: attrs[name],
    });
  }
  if (!carriesChildren(el, false)) return;
  var kids = el.childNodes || [];
  for (var i = 0; i < kids.length; i++) {
    var tree = serializeTree(kids[i], state.registry, state.opts);
    if (!tree) continue;
    // Appended in document order, so `before: null` reproduces that order in
    // an element the player currently holds as empty.
    state.out.push({
      type: 'dom.add', t: state.t, parent: id, before: null, node: tree,
    });
    state.added.add(kids[i]);
    state.removed.delete(kids[i]);
  }
}

function mapCharacterData(record, state) {
  var node = record.target;
  if (nearestEmittedAncestor(node, state.root, state.opts) !== node) return;
  var id = state.registry.peekId(node);
  if (id == null) return;
  // Spec §8: a redacted subtree's content must not appear anywhere in the
  // file. The keyframe already wrote this node as an empty string, so
  // suppressing the patch leaves the player exactly where the snapshot put it.
  if (isInRedactedSubtree(node, state.opts.redactSelector)) return;

  state.out.push({
    type: 'dom.text', t: state.t, node: id,
    text: String(node.textContent == null ? '' : node.textContent),
  });
}
