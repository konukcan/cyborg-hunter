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
// Flush time is not enough on its own, because a patch is a statement about
// what the PLAYER holds, and the live DOM is the destination rather than the
// question. Two rounds of review fixed that one composition at a time — a
// removal into a fragment, a sibling purged with its ancestor, a reorder
// inside a moved subtree — and a differential fuzz kept finding more. So the
// module tracks the answer instead of inferring it:
//
//   - `delivery` (delivery.js) is what the file currently contains: which
//     nodes, under which parents. Removals, `before` anchors, insertions and
//     exclusion sequences all consult it, and it is maintained by the same
//     serializer that writes the file.
//   - `payloads` records the subtrees this batch has already serialized. A
//     payload is written from the FINAL DOM, so any record describing a
//     rearrangement inside one is history the payload already tells.
//   - a PRE-SCAN counts the removals and insertions still to be processed, so
//     a `before` never names a sibling whose position is not settled, and
//     keeps the first `oldValue` per (element, attribute), so an exclusion
//     toggle is decided against the pre-batch element rather than a
//     half-applied one.
//
// Exclusion transitions are emitted BEFORE the record loop, which leaves every
// element's exclusion state in the file equal to its flush-time state for the
// rest of the batch — the property the rest of the mapping assumes.
//
// tests/replay/mutations-fuzz.test.js is the check that this holds under
// compositions nobody wrote down: random batches, applied to a player, against
// what a fresh keyframe of the same DOM would say.
//
// RETIRED from v1 (capture-dom.js:470-507), deliberately:
//   - the one-childList-patch-per-target intra-batch dedup. It existed because
//     every v1 childList patch re-serialized the target's FULL resulting
//     children, so N appends to one container cost O(N²) of the participant's
//     CPU. A `dom.add` carries only the inserted subtree, and `before`
//     resolution short-circuits the append run (see `noHeldFrom`), so the same
//     batch costs O(total inserted) — the storm guard now costs precision
//     (dropping the 2nd..Nth insertion's position) and buys nothing. Measured
//     at one registry lookup per appended node; the test pins a linear BOUND
//     rather than that figure. A forward sibling walk per insertion is not
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
 * @param {object} ctx     {root, span, t, keepBait?, redactSelector?, taint?}
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
  if (!ctx.root || !ctx.span) return out;

  var state = {
    out: out,
    root: ctx.root,
    // The capture span (span.js): node ids, and what the file already
    // contains. Every "does the player have this, and where" question is
    // answered from the delivery model rather than inferred from the live DOM.
    span: ctx.span,
    registry: ctx.span.registry,
    delivery: ctx.span.delivery,
    t: ctx.t,
    opts: ctx,
    // Pre-scan results: removals and insertions not yet processed (a `before`
    // may only name a sibling whose position is already final), and
    // element → attribute → its first oldValue.
    pending: new Map(),
    pendingAdd: new Map(),
    attrs: new Map(),
    attrOrder: [],
    // Elements whose exclusion state changed this batch: their own attribute
    // records are already accounted for by the transition sequence. `restored`
    // is the revealed subset, whose re-emitted subtree covers any nested
    // transition inside it.
    transitioned: new Set(),
    restored: new Set(),
    // Subtrees this batch has already serialized. A payload is written from
    // the FINAL state, so every record describing a rearrangement inside one
    // is a description of history the payload already tells.
    payloads: new Set(),
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
      for (var j = 0; j < removed.length; j++) {
        state.pending.set(removed[j], (state.pending.get(removed[j]) || 0) + 1);
      }
      var added = record.addedNodes || [];
      for (var k = 0; k < added.length; k++) {
        state.pendingAdd.set(added[k], (state.pendingAdd.get(added[k]) || 0) + 1);
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
  var id = preBatchValue(el, 'id', state);
  return isExcluded({
    nodeType: ELEMENT_NODE,
    id: id == null ? '' : id,
    attributes: preBatchAttrList(el, state),
  }, state.opts);
}

// The element's attributes as the batch found them: every live attribute at
// its pre-batch value, plus the ones the batch has since removed. Two callers
// need this rather than the live list — the exclusion verdict, which must be
// the one the file was written under, and a collapse, which has to clear the
// attributes the PLAYER holds, including any this batch removed on the way.
function preBatchAttrList(el, state) {
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
  return attrs;
}

// Exclusion transitions run BEFORE the record loop, once per element. Two
// things follow. A placeholder being revealed is provably empty when its
// children are appended, so nothing has to guess at positions inside it; and
// an element transitions at most once, so a batch that touches the exclusion
// attribute twice cannot emit the sequence twice.
function applyExclusionTransitions(state) {
  var pending = new Map();
  for (var i = 0; i < state.attrOrder.length; i++) {
    var el = state.attrOrder[i];
    if (!el || el.nodeType !== ELEMENT_NODE) continue;
    if (!state.delivery.holds(el)) continue;
    var id = state.registry.peekId(el);
    if (id == null) continue;
    if (wasExcluded(el, state) !== isExcluded(el, state.opts)) pending.set(el, id);
  }
  var done = new Set();
  pending.forEach(function (unused, el) { runTransition(el, pending, done, state); });
}

// ANCESTORS FIRST, whatever order the records arrived in. A reveal re-emits
// its whole subtree, which already carries any nested transition's outcome:
// the nested element comes back with its current attributes, or as its own
// placeholder if it is now excluded. Running the nested transition afterwards
// would re-add a subtree the player just received, or address children it was
// never sent — so `insideEmittedAdd` retires it instead. Its own attribute
// records are still suppressed, because the ancestor's patch carried the
// element's final state.
function runTransition(el, pending, done, state) {
  if (done.has(el)) return;
  done.add(el);
  var chain = [];
  for (var p = el.parentNode; p; p = p.parentNode) {
    if (pending.has(p)) chain.push(p);
    if (p === state.root) break;
  }
  for (var i = chain.length - 1; i >= 0; i--) runTransition(chain[i], pending, done, state);

  state.transitioned.add(el);
  // An earlier transition already re-emitted this element as part of an
  // ancestor's reveal (so the file carries its final state, placeholder
  // included), or took it away with an ancestor's collapse. Either way a
  // sequence addressing it now would contradict the patch that just went out.
  if (!state.delivery.holds(el)) return;
  if (insideRestored(el, state)) return;
  if (isExcluded(el, state.opts)) collapseToPlaceholder(el, pending.get(el), state);
  else restoreFromPlaceholder(el, pending.get(el), state);
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
  for (var j = 0; j < added.length; j++) mapAdded(added[j], record.target, state);
}

function mapRemoved(node, oldParent, state) {
  // This removal is no longer pending, whatever we decide to emit for it.
  decrement(state.pending, node);

  // The whole question: does the file carry this node under this parent right
  // now? Everything a removal could be wrong about answers here — a script or
  // a hidden subtree the file never carried, a node whose insertion at this
  // position was never emitted, one an ancestor's removal already purged, one
  // an ancestor's re-emission has just re-delivered somewhere else, one that
  // left through a detached subtree the observer stopped reporting.
  // Inside a subtree this batch already serialized: that payload was written
  // from the final DOM, so it has already placed this node where it ends up.
  if (insidePayload(node, state)) return;

  var delivery = state.delivery;
  if (!delivery.holds(node) || delivery.parentOf(node) !== oldParent) return;
  // The old parent has itself left the observed tree by flush time, so its own
  // removal carries this subtree away. Emitting here would be correct and
  // redundant; dropping keeps the batch to the patches that say something.
  if (nearestEmittedAncestor(oldParent, state.root, state.opts) !== oldParent) return;

  var id = state.registry.peekId(node);
  if (id == null) return;                    // never numbered: never in the file

  state.out.push({ type: 'dom.remove', t: state.t, node: id });
  delivery.purge(node);
}

// Is this node inside a subtree this batch already serialized? The walk starts
// at the PARENT: a payload root is itself addressable (it can be removed
// again), only its contents are settled by the payload.
function insidePayload(node, state) {
  for (var p = node && node.parentNode; p; p = p.parentNode) {
    if (state.payloads.has(p)) return true;
    if (p === state.root) break;
  }
  return false;
}

function decrement(counter, node) {
  var left = (counter.get(node) || 0) - 1;
  if (left > 0) counter.set(node, left);
  else counter.delete(node);
}

function mapAdded(node, into, state) {
  // This insertion is no longer pending, whatever we decide to emit for it.
  decrement(state.pendingAdd, node);

  var delivery = state.delivery;
  var parent = node.parentNode;
  // This record describes an insertion the batch has already superseded: the
  // node moved on afterwards. The patch belongs at the record that put it
  // where it ends up, or the file states the insertion too early and a sibling
  // added in between lands on the wrong side of it.
  if (into !== parent) return;
  // Serialization is final-state, so a container's payload already carries the
  // children a later record in the same batch put inside it.
  if (insidePayload(node, state)) return;
  // Or the file already carries it exactly here, delivered by an earlier
  // patch in this batch or by the keyframe.
  if (delivery.holds(node) && delivery.parentOf(node) === parent) return;
  // Detached again before the callback ran, outside the observed root, or a
  // node the file never carries (script, anything under a placeholder or an
  // iframe): no patch, and — since serializeTree is never reached — no id.
  if (nearestEmittedAncestor(node, state.root, state.opts) !== node) return;
  if (!delivery.holds(parent)) return;       // no parent in the file to add to

  var before = beforeId(node, state);
  // Before serializing, since serialization is what re-delivers the subtree.
  pullForwardMoves(node, state);
  // …and the parent is re-checked afterwards: pulling a move forward purges a
  // whole subtree, and this insertion's parent can be inside it (a container
  // moved under a node that used to contain it). The later record that settles
  // that subtree carries this node with it.
  if (!delivery.holds(parent)) return;

  var parentId = state.registry.peekId(parent);
  if (parentId == null) return;
  var tree = serializeTree(node, state.span, state.opts);
  if (!tree) return;

  state.out.push({
    type: 'dom.add', t: state.t, parent: parentId, before: before, node: tree,
  });
  state.payloads.add(node);
  noteHeld(node, state);
}

// A patch carrying a subtree re-instantiates every node in it, including nodes
// the file already carries SOMEWHERE ELSE — a node moved into this subtree
// from elsewhere in the page. The player would then hold it twice, because
// nothing took the old copy away: the node's own removal record can arrive
// after this insertion, since the page may insert the container before moving
// the child into it. Pulling those removals forward keeps "one node, one
// place" true at every point in the stream.
//
// Purging cascades, so a node whose old copy sat inside another node being
// pulled forward needs no removal of its own; the walk continues past it
// because a node moved in from a THIRD place still does.
function pullForwardMoves(node, state) {
  var delivery = state.delivery;
  if (delivery.holds(node) && delivery.parentOf(node) !== node.parentNode) {
    var id = state.registry.peekId(node);
    if (id != null) state.out.push({ type: 'dom.remove', t: state.t, node: id });
    delivery.purge(node);
  }
  var kids = node.childNodes || [];
  for (var i = 0; i < kids.length; i++) pullForwardMoves(kids[i], state);
}

// The id the player should insert before, or null to append. Siblings the
// player does not currently hold are skipped, and each skip is a case where
// naming the sibling would put a reference in the file that the player cannot
// resolve — strict validation cannot catch that (it type-checks `node` fields,
// it does not resolve them), and the fork's player turns it into a silently
// dropped patch:
//   - a pending removal or a pending insertion: a sibling whose own patch has
//     not run yet, so its player-side position is not final. The two counters
//     together are what makes "append a row, move a row" in one task come out
//     in the right order;
//   - one the file does not carry under this parent (delivery.js): never
//     emitted, already purged, or delivered somewhere else entirely.
//
// `noHeldFrom` is what keeps a mass append linear. Its invariant: from that
// node to the end of the parent's children, the player holds nothing.
function beforeId(node, state) {
  var start = node.nextSibling;
  if (!start) return null;
  var run = state.noHeldFrom.get(node.parentNode);
  if (run !== undefined && (run === node || run === start)) return null;

  for (var sib = start; sib; sib = sib.nextSibling) {
    if (state.pending.get(sib) > 0) continue;
    if (state.pendingAdd.get(sib) > 0) continue;
    if (!state.delivery.holds(sib)) continue;
    if (state.delivery.parentOf(sib) !== node.parentNode) continue;
    var id = state.registry.peekId(sib);
    if (id == null) continue;
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
  if (!state.delivery.holds(el)) return;
  // Detached from the observed root by flush time: whatever removed it carries
  // the subtree away, so its attribute change has nothing to say.
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
// Did an ancestor's reveal already re-emit this element? That patch carried
// the element's CURRENT state — its own placeholder included, if it is now
// excluded — so a transition of its own would repeat or contradict it.
function insideRestored(el, state) {
  for (var p = el.parentNode; p; p = p.parentNode) {
    if (state.restored.has(p)) return true;
    if (p === state.root) break;
  }
  return false;
}

function collapseToPlaceholder(el, id, state) {
  // `carriesChildren(el, false)`: whether the file held this element's
  // children a moment ago, when it was not yet a placeholder. The live DOM
  // already says otherwise, which is why the flag is passed rather than looked
  // up.
  if (carriesChildren(el, false)) {
    // Exactly the children the FILE carries, which is neither the flush-time
    // child list (the same batch may have taken some away, or moved others in
    // that the player was never told about) nor a guess reconstructed from the
    // batch: delivery.js knows.
    var held = state.delivery.childrenOf(el);
    for (var i = 0; i < held.length; i++) {
      var id2 = state.registry.peekId(held[i]);
      if (id2 == null) continue;
      state.out.push({ type: 'dom.remove', t: state.t, node: id2 });
      state.delivery.purge(held[i]);
    }
  }
  // Cleared: every attribute the player is holding, which is the live set the
  // keyframe would write PLUS anything this batch removed before the exclusion
  // landed. Clearing an attribute the player does not have is a no-op; leaving
  // one behind makes the placeholder disagree with a fresh snapshot of the
  // same moment, which is the whole point of the sequence.
  var redacted = isRedactedNow(el, state);
  var names = emittedAttrs(el, redacted);
  var pre = preBatchAttrList(el, state);
  for (var i = 0; i < pre.length; i++) {
    if (attrPatchValue(el, pre[i].name, redacted) === ATTR_WITHHELD) continue;
    names[pre[i].name] = null;
  }
  for (var name in names) {
    if (!Object.prototype.hasOwnProperty.call(names, name)) continue;
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
  var attrs = emittedAttrs(el, isRedactedNow(el, state));
  for (var name in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    state.out.push({
      type: 'dom.attr', t: state.t, node: id, name: name, value: attrs[name],
    });
  }
  state.restored.add(el);
  // The reveal re-emits this element's children from the final DOM, so every
  // record about what moved inside it is history the payload already tells.
  state.payloads.add(el);
  if (!carriesChildren(el, false)) return;
  var kids = el.childNodes || [];
  for (var i = 0; i < kids.length; i++) {
    var kid = kids[i];
    // Emittability first: serializing a script here would number it on the way
    // to discarding it, which the insertion path deliberately avoids.
    if (!isEmittableNode(kid)) continue;
    if (state.delivery.holds(kid) && state.delivery.parentOf(kid) === el) continue;
    // A child the file carries somewhere ELSE has to leave that place first,
    // or the reveal hands the player a second copy.
    pullForwardMoves(kid, state);
    var tree = serializeTree(kid, state.span, state.opts);
    if (!tree) continue;
    // The player holds this placeholder EMPTY — transitions run before any
    // insertion is mapped — so appending in document order reproduces it.
    state.out.push({
      type: 'dom.add', t: state.t, parent: id, before: null, node: tree,
    });
    state.payloads.add(kid);
  }
  // The children just became held; nothing may reuse a run recorded for this
  // parent (none can exist yet, but the cache and its invariant stay in sync).
  state.noHeldFrom.delete(el);
}

function mapCharacterData(record, state) {
  var node = record.target;
  if (!state.delivery.holds(node)) return;
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
