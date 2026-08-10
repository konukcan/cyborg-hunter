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
// Flush time is not enough on its own, because a record's correct patch also
// depends on what the OTHER records in the batch did. Three things therefore
// come from a PRE-SCAN of the whole batch before any patch is emitted:
//   - the nodes each parent lost, so an exclusion collapse can remove the
//     children the player actually holds rather than the ones still attached;
//   - a per-node count of removals still to be processed, so `before` never
//     names a sibling that is about to move;
//   - the first `oldValue` per (element, attribute), so an exclusion toggle is
//     decided against the pre-batch element rather than a half-applied one.
// Exclusion transitions are then emitted BEFORE the record loop, which leaves
// every element's exclusion state in the file equal to its flush-time state
// for the rest of the batch — the property the rest of the mapping assumes.
//
// RETIRED from v1 (capture-dom.js:470-507), deliberately:
//   - the one-childList-patch-per-target intra-batch dedup. It existed because
//     every v1 childList patch re-serialized the target's FULL resulting
//     children, so N appends to one container cost O(N²) of the participant's
//     CPU. A `dom.add` carries only the inserted subtree, and `before`
//     resolution short-circuits the append run (see `noHeldFrom`), so the same
//     batch costs O(total inserted) — the storm guard now costs precision
//     (dropping the 2nd..Nth insertion's position) and buys nothing. The
//     linear cost is test-pinned; a forward sibling walk per insertion is not
//     free, and an earlier draft of this module reintroduced v1's O(N²) here.
//   - the characterData→parent-childList fold. It existed because text nodes
//     had no parser-stable address, so text changes had to be re-expressed as
//     the parent's children. Node ids ARE that address: `dom.text` names the
//     text node itself and carries nothing else.
//
// Known byte noise, correct but redundant: appending a node and then setting
// its attributes in one batch emits `dom.attr` patches the freshly serialized
// subtree already carries, and create-append-move emits add/remove/add where
// one add would do. Both are idempotent for the player.

import {
  serializeTree, isExcluded, nearestEmittedAncestor, isEmittableNode,
  carriesChildren, emittedAttrs, attrPatchValue, ATTR_WITHHELD,
} from './snapshot.js';
import { isInRedactedSubtree, markRedacted, isRedactionTainted } from './redaction.js';

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
 * @param {object} ctx     {root, registry, t, keepBait?, redactSelector?, taint?}
 *                         `ctx` doubles as the serializer's options bag — same
 *                         keys, so exclusion and redaction cannot be answered
 *                         one way here and another way in the keyframe.
 * @returns {Array} events, all stamped with the same `t`
 *
 * One callback = one `t` (spec §7 forbids nothing finer, and the records of a
 * batch are a single task's worth of DOM change). Times are stamped raw; wire
 * rounding belongs to the serializer.
 *
 * Order within the batch is the observer's, with one exception: exclusion
 * transitions lead. They describe the element as the player currently holds
 * it, so running them first is what lets every later patch be read against the
 * flush-time DOM.
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
    // Pre-scan results (see the header): parent → nodes it lost this batch,
    // node → removals not yet processed, element → attribute → first oldValue.
    removedFrom: new Map(),
    pending: new Map(),
    attrs: new Map(),
    attrOrder: [],
    // Elements whose exclusion state changed this batch, and the subset that
    // was revealed: their later records are already accounted for.
    transitioned: new Set(),
    restored: new Set(),
    // parent → the first child of a run that reaches the end of the child list
    // holding nothing the player has. Makes an append run O(1) per insertion.
    noHeldFrom: new Map(),
  };

  prescan(records, state);
  applyExclusionTransitions(state);

  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    if (!record) continue;
    if (record.type === 'childList') mapChildList(record, state);
    else if (record.type === 'attributes') mapAttributes(record, state);
    else if (record.type === 'characterData') mapCharacterData(record, state);
  }
  return out;
}

// One pass over the batch, before anything is emitted. Cheap (O(records) plus
// the removed-node lists) and it is what makes the mapping batch-coherent.
function prescan(records, state) {
  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    if (!record) continue;
    if (record.type === 'childList') {
      var removed = record.removedNodes || [];
      if (!removed.length) continue;
      var lost = state.removedFrom.get(record.target);
      if (!lost) { lost = []; state.removedFrom.set(record.target, lost); }
      for (var j = 0; j < removed.length; j++) {
        lost.push(removed[j]);
        state.pending.set(removed[j], (state.pending.get(removed[j]) || 0) + 1);
      }
    } else if (record.type === 'attributes' && record.target && record.attributeName) {
      var perEl = state.attrs.get(record.target);
      if (!perEl) {
        perEl = new Map();
        state.attrs.set(record.target, perEl);
        state.attrOrder.push(record.target);
      }
      // Keyed by the name the attribute is SPELLED with on the element, so
      // the pre-batch view lines up with `node.attributes` for namespaced
      // attributes too (see qualifiedName).
      var key = qualifiedName(record.target, record) || record.attributeName;
      var seen = perEl.get(key);
      if (seen) seen.count++;
      else perEl.set(key, { first: record.oldValue, count: 1 });
    }
  }
}

// The value this attribute held before the batch: a string, or null for
// absent. Unmutated attributes read straight from the DOM.
//
// A single record ending in ABSENCE is read as "it was there before", whatever
// `oldValue` says: removeAttribute queues no record for an attribute that is
// not there, and engines disagree about the old value of an empty-valued
// attribute (Chromium says "", happy-dom says null). With TWO OR MORE records
// that reasoning collapses — add-then-remove in one task ends absent having
// started absent — so the first record's `oldValue` is used, which is the
// exact pre-batch value.
function preBatchValue(el, name, state) {
  var perEl = state.attrs.get(el);
  var seen = perEl && perEl.get(name);
  var live = attrValue(el, name);
  if (!seen) return live;
  if (seen.count === 1 && live === null) return seen.first == null ? '' : seen.first;
  return seen.first == null ? null : seen.first;
}

function attrValue(el, name) {
  var attrs = el.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].name === name) return attrs[i].value;
  }
  return null;
}

// Was this element excluded before the batch? Answered by running the ONE
// exclusion predicate over a reconstruction of the pre-batch element; a second
// implementation of "is this excluded" is the drift the shared predicates
// exist to prevent. `isExcluded` reads only nodeType, attribute names, and
// `id`, so the reconstruction is cheap.
function wasExcluded(el, state) {
  var attrs = [];
  var seen = {};
  var live = el.attributes || [];
  for (var i = 0; i < live.length; i++) {
    var name = live[i].name;
    seen[name] = true;
    var value = preBatchValue(el, name, state);
    if (value !== null) attrs.push({ name: name, value: value });
  }
  var perEl = state.attrs.get(el);
  if (perEl) {
    perEl.forEach(function (unused, name) {
      if (seen[name]) return;                     // removed during the batch
      var value = preBatchValue(el, name, state);
      if (value !== null) attrs.push({ name: name, value: value });
    });
  }
  var id = preBatchValue(el, 'id', state);
  return isExcluded({
    nodeType: ELEMENT_NODE, id: id == null ? '' : id, attributes: attrs,
  }, state.opts);
}

// Exclusion transitions run BEFORE the record loop, once per element. Two
// things follow. A placeholder being revealed is provably empty when its
// children are appended, so nothing has to guess at positions inside it; and
// an element transitions at most once, so a batch that touches the exclusion
// attribute twice cannot emit the sequence twice.
function applyExclusionTransitions(state) {
  for (var i = 0; i < state.attrOrder.length; i++) {
    var el = state.attrOrder[i];
    if (!el || el.nodeType !== ELEMENT_NODE) continue;
    if (nearestEmittedAncestor(el, state.root, state.opts) !== el) continue;
    var id = state.registry.peekId(el);
    if (id == null) continue;
    var before = wasExcluded(el, state);
    var now = isExcluded(el, state.opts);
    if (before === now) continue;
    if (now) collapseToPlaceholder(el, id, state);
    else restoreFromPlaceholder(el, id, state);
    state.transitioned.add(el);
  }
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
  // This removal is no longer pending, whatever we decide to emit for it.
  var left = (state.pending.get(node) || 0) - 1;
  if (left > 0) state.pending.set(node, left);
  else state.pending.delete(node);

  // Already gone from the player's DOM and not re-added since.
  if (state.removed.has(node)) return;
  // The old parent was revealed earlier in this batch, and the reveal sent
  // exactly the children it still had. This one was not among them.
  if (state.restored.has(oldParent) && !state.added.has(node)) return;

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
  noteHeld(node, state);
}

// The id the player should insert before, or null to append. Siblings the
// player does not currently hold are skipped, and each skip is a case where
// naming the sibling would put a reference in the file that the player cannot
// resolve — strict validation cannot catch that (it type-checks `node` fields,
// it does not resolve them), and the fork's player turns it into a silently
// dropped patch:
//   - no id yet: a brand-new node whose own dom.add comes later in this batch;
//   - a pending removal: a node this batch will move, still sitting in its old
//     position at flush time;
//   - already removed and not re-added.
//
// `noHeldFrom` is what keeps a mass append linear. Its invariant: from that
// node to the end of the parent's children, the player holds nothing.
function beforeId(node, state) {
  var start = node.nextSibling;
  if (!start) return null;
  var run = state.noHeldFrom.get(node.parentNode);
  if (run !== undefined && (run === node || run === start)) return null;

  for (var sib = start; sib; sib = sib.nextSibling) {
    if (state.removed.has(sib)) continue;
    if (state.pending.get(sib) > 0) continue;
    var id = state.registry.peekId(sib);
    if (id == null) continue;
    if (nearestEmittedAncestor(sib, state.root, state.opts) !== sib) continue;
    return id;
  }
  state.noHeldFrom.set(node.parentNode, start);
  return null;
}

// An emitted insertion makes `node` held, which can falsify the run recorded
// for its parent. Two cases keep it: the node IS the run's head (the run now
// starts one later), or the node sits immediately before the head (the run is
// untouched, which is every step of an append loop). Anything else — an
// insertion into the middle, or out of document order — drops the cache rather
// than reason about positions.
function noteHeld(node, state) {
  var parent = node.parentNode;
  var run = state.noHeldFrom.get(parent);
  if (run === undefined) return;
  if (run === node) {
    if (node.nextSibling) state.noHeldFrom.set(parent, node.nextSibling);
    else state.noHeldFrom.delete(parent);
    return;
  }
  if (node.nextSibling === run) return;
  state.noHeldFrom.delete(parent);
}

function mapAttributes(record, state) {
  var el = record.target;
  var name = record.attributeName;
  if (!el || el.nodeType !== ELEMENT_NODE || !name) return;
  // The transition sequence already carried this element's complete final
  // attribute state.
  if (state.transitioned.has(el)) return;
  if (nearestEmittedAncestor(el, state.root, state.opts) !== el) return;
  var id = state.registry.peekId(el);
  if (id == null) return;
  // A placeholder carries no attributes at all (spec §4). Reaching here means
  // it was a placeholder before the batch too, since transitions are handled
  // above.
  if (isExcluded(el, state.opts)) return;

  // MutationRecord.attributeName is the LOCAL name, while the attribute is
  // spelled with its prefix in `node.attributes` — so a namespaced attribute
  // has to be re-qualified from the live element. A namespaced REMOVAL cannot
  // be: the prefix left with the attribute, and emitting the bare local name
  // would tell the player to remove a different attribute.
  var spelled = qualifiedName(el, record);
  if (spelled === null) return;

  var redacted = isRedactedNow(el, state);
  var value = attrPatchValue(el, spelled, redacted);
  if (value === ATTR_WITHHELD) {
    if (redacted) markRedacted(el, state.opts.taint);
    return;
  }
  // Net effect: an attribute set and put back inside one batch changed
  // nothing, and neither did a no-op set.
  if (preBatchValue(el, spelled, state) === attrValue(el, spelled)) return;

  state.out.push({
    type: 'dom.attr', t: state.t, node: id, name: spelled, value: value,
  });
}

function qualifiedName(el, record) {
  var ns = record.attributeNamespace;
  if (!ns) return record.attributeName;
  var attrs = el.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].localName === record.attributeName && attrs[i].namespaceURI === ns) {
      return attrs[i].name;
    }
  }
  return null;
}

// Redacted by position, or by history: a node whose content this recording has
// already withheld keeps withholding it after a move (redaction.js).
function isRedactedNow(node, state) {
  return isInRedactedSubtree(node, state.opts.redactSelector) ||
    isRedactionTainted(node, state.opts.taint);
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
    // The children the PLAYER holds are the pre-batch ones, which is the
    // flush-time list PLUS whatever the same batch detached. Those detached
    // children get no patch of their own: by the time their own record is
    // read, the element reads as excluded and the removal is suppressed.
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) removeCollapsedChild(kids[i], state);
    var lost = state.removedFrom.get(el) || [];
    for (var j = 0; j < lost.length; j++) removeCollapsedChild(lost[j], state);
  }
  var attrs = emittedAttrs(el, isRedactedNow(el, state));
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
function removeCollapsedChild(child, state) {
  if (state.removed.has(child)) return;
  var id = state.registry.peekId(child);
  if (id == null || !isEmittableNode(child)) return;
  state.out.push({ type: 'dom.remove', t: state.t, node: id });
  state.removed.add(child);
  state.added.delete(child);
}

function restoreFromPlaceholder(el, id, state) {
  var attrs = emittedAttrs(el, isRedactedNow(el, state));
  for (var name in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    state.out.push({
      type: 'dom.attr', t: state.t, node: id, name: name, value: attrs[name],
    });
  }
  state.restored.add(el);
  if (!carriesChildren(el, false)) return;
  var kids = el.childNodes || [];
  for (var i = 0; i < kids.length; i++) {
    var kid = kids[i];
    // Emittability first: serializing a script here would number it on the way
    // to discarding it, which the insertion path deliberately avoids.
    if (!isEmittableNode(kid) || state.added.has(kid)) continue;
    var tree = serializeTree(kid, state.registry, state.opts);
    if (!tree) continue;
    // The player holds this placeholder EMPTY — transitions run before any
    // insertion is mapped — so appending in document order reproduces it.
    state.out.push({
      type: 'dom.add', t: state.t, parent: id, before: null, node: tree,
    });
    state.added.add(kid);
    state.removed.delete(kid);
  }
  // The children just became held; nothing may reuse a run recorded for this
  // parent (none can exist yet, but the cache and its invariant stay in sync).
  state.noHeldFrom.delete(el);
}

function mapCharacterData(record, state) {
  var node = record.target;
  if (nearestEmittedAncestor(node, state.root, state.opts) !== node) return;
  var id = state.registry.peekId(node);
  if (id == null) return;
  // Spec §8: a redacted subtree's content must not appear anywhere in the
  // file. The keyframe already wrote this node as an empty string, so
  // suppressing the patch leaves the player exactly where the snapshot put it.
  // Marking it keeps that true after the node is moved somewhere unredacted.
  if (isRedactedNow(node, state)) { markRedacted(node, state.opts.taint); return; }

  state.out.push({
    type: 'dom.text', t: state.t, node: id,
    text: String(node.textContent == null ? '' : node.textContent),
  });
}
