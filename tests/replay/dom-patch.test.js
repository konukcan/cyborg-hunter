// tests/replay/dom-patch.test.js
// T5 Task 3 — the spec §5.1 patch applier: `dom.add`/`dom.remove`/`dom.attr`/
// `dom.text` applied to a mounted keyframe through the integer-ID map.
//
// The applier ships in `src/replay/dom-instantiate.js` beside the instantiation
// it depends on (Task 2's recorded build-concatenation decision: one module,
// one reading of §4, no imports, one strippable export line). It gets its own
// test file because the two halves are separately interesting and Task 2's file
// is already long.
//
// TWO POSTURES, both deliberate, and this file pins the difference. The viewer
// is TOLERANT (design §4): a patch naming an id the map does not hold is
// skipped and counted into `patchFailures`, because an analyst looking at an
// unrepeatable session is better served by as much of it as survives than by a
// blank stage. `tests/replay/support/dom-player.js` is STRICT: it throws,
// because its job is to catch mapper bugs. The consequence — a tolerant viewer
// cannot detect a producer emitting dangling references, which is why T7 owes a
// dangling-reference negative fixture — is design §14 risk 2, and the two
// postures are asserted against each other here rather than described.
//
// Node IDENTITY goes through `same()` for the reason Task 2 found the hard way:
// a failing `assert.equal` on two happy-dom nodes renders both with
// `util.inspect`, which walks `ownerDocument → defaultView → …` until the
// runner is SIGKILLed with no per-test output.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { Window } from 'happy-dom';

import {
  instantiateTree, mountTree, applyPatch, applyPatches,
} from '../../src/replay/dom-instantiate.js';
import { createPlayer, readTree, asPlayerTree } from './support/dom-player.js';
import { MIXES, SEEDS, generateSession } from './support/mutation-fuzz.js';

const FIXTURES = new URL('./schema-v2/fixtures/', import.meta.url);
const EXPECTATIONS = new URL('./schema-v2/expectations/', import.meta.url);
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'));
const expectations = (name) =>
  JSON.parse(readFileSync(new URL(name + '.json', EXPECTATIONS), 'utf8'));

function freshDoc() {
  return new Window({ url: 'https://example.org/exp/' }).document;
}

function same(actual, expectedNode, what) {
  assert.ok(actual === expectedNode, what);
}

function invert(idMap) {
  const idOf = new Map();
  for (const [id, node] of idMap) idOf.set(node, id);
  assert.equal(idOf.size, idMap.size, 'two ids bound to the same node');
  return idOf;
}

// The §5 restore walk's time filter, reduced to what this task owns: the
// patches of one segment up to a time. Interleaving with the session streams
// and the `initial_state` seed is Task 4's.
function patchesUpTo(segment, t) {
  return segment.events.filter((e) => e.t <= t);
}

const el = (id, tag, attrs, children) => ({
  id, kind: 'element', tag, attrs: attrs || {}, children: children || [],
});
const text = (id, value) => ({ id, kind: 'text', text: value });

// A tiny stage every constructed case mounts: <div#stage><p#msg>hi</p></div>.
function stage() {
  const doc = freshDoc();
  const dom = el(1, 'div', { id: 'stage' }, [el(2, 'p', { id: 'msg' }, [text(3, 'hi')])]);
  return { doc, dom, mount: mountTree(dom, doc.body, doc) };
}

describe('applyPatches — the canonical continuation reaches its checkpoints', () => {
  // The plan's first contract: segment 1's patch sequence applied to segment
  // 0's tree reaches the state the fixture's own checkpoints name. The
  // checkpoint entries are read from the expectations file and their shape is
  // asserted, so a fixture edit fails here instead of leaving this test quietly
  // asserting something the fixture no longer claims. EXECUTING them (bounds
  // checks, prop dispatch, the fork cross-verification) is Task 7's.
  const rec = fixture('canonical-core');
  const checkpoints = expectations('canonical-core').checkpoints;
  const at = (t) => checkpoints.find((c) => c.t === t);

  function spanZero() {
    const doc = freshDoc();
    const mount = mountTree(rec.segments[0].initial_dom, doc.body, doc);
    return { doc, mount };
  }

  it('segment 0: the dom.text patch reaches checkpoint t=500', () => {
    assert.deepEqual(at(500).assert, [{ node: 5, prop: 'text', equals: 'Clicked!' }]);
    const { mount } = spanZero();
    assert.equal(mount.idMap.get(5).nodeValue, 'Hello');
    applyPatches(patchesUpTo(rec.segments[0], 500), mount);
    assert.equal(mount.idMap.get(5).nodeValue, 'Clicked!');
    assert.equal(mount.patchFailures, 0);
    assert.equal(mount.skipped, 0);
  });

  it('segment 1 continues segment 0’s span: t=2250 holds the added subtree', () => {
    assert.deepEqual(at(2250).assert, [
      { node: 6, prop: 'exists', equals: true },
      { node: 7, prop: 'text', equals: 'saved' },
    ]);
    const { mount } = spanZero();
    applyPatches(rec.segments[0].events, mount);
    applyPatches(patchesUpTo(rec.segments[1], 2250), mount);

    // dom.attr at t=2100, then dom.add at t=2200.
    assert.equal(mount.idMap.get(2).getAttribute('disabled'), '');
    const added = mount.idMap.get(6);
    assert.ok(added, 'node 6 exists');
    assert.equal(added.tagName.toLowerCase(), 'span');
    assert.equal(added.getAttribute('id'), 'note');
    assert.equal(mount.idMap.get(7).nodeValue, 'saved');
    // `before: null` appends, so the new span is the stage's LAST child.
    same(mount.idMap.get(1).lastChild, added, 'appended, not inserted');
    assert.equal(mount.patchFailures, 0);
    assert.equal(mount.skipped, 0);
  });

  it('t=2350: the dom.remove purges the node AND its subtree from the map', () => {
    assert.deepEqual(at(2350).assert, [{ node: 6, prop: 'exists', equals: false }]);
    const { mount } = spanZero();
    applyPatches(rec.segments[0].events, mount);
    applyPatches(patchesUpTo(rec.segments[1], 2350), mount);

    assert.equal(mount.idMap.has(6), false, 'the removed node is unbound');
    // The descendant goes with it (design §4, matching dom-player.js): leaving
    // node 7 bound would resolve a later patch against a detached node.
    assert.equal(mount.idMap.has(7), false, 'its text child is unbound too');
    assert.equal(mount.idMap.get(1).querySelectorAll('span').length, 0);
    assert.equal(mount.patchFailures, 0);
  });

  it('non-dom events in the same array are left to the vocabulary dispatch', () => {
    // Segment 1 also carries scroll.window and two visibility events. The
    // applier reports "not mine" and counts nothing — Task 5 owns those.
    const { mount } = spanZero();
    const others = rec.segments[1].events.filter((e) => !/^dom\./.test(e.type));
    assert.equal(others.length, 3);
    for (const e of others) assert.equal(applyPatch(e, mount), false, e.type);
    assert.equal(mount.patchFailures, 0);
    assert.equal(applyPatch({ type: 'dom.text', node: 5, text: 'x' }, mount), true);
  });
});

describe('moves and re-binding (T3 Task 3 pin M5)', () => {
  it('remove + add of the same id is a MOVE: one node, the map on the new one', () => {
    const { doc, mount } = stage();
    const before = mount.idMap.get(2);
    const target = mount.idMap.get(1);

    applyPatches([
      { type: 'dom.remove', t: 1, node: 2 },
      { type: 'dom.add', t: 2, parent: 1, before: null,
        node: el(2, 'p', { id: 'msg', class: 'moved' }, [text(3, 'hi')]) },
    ], mount);

    const after = mount.idMap.get(2);
    assert.ok(after !== before, 'the binding moved to the freshly added node');
    assert.equal(after.getAttribute('class'), 'moved');
    // One node, not two: the re-bind must never leave the old one in the tree.
    assert.equal(target.querySelectorAll('p').length, 1);
    same(target.firstChild, after, 'and it is the one in the document');
    same(before.parentNode, null, 'the old node is detached');
    // Both directions, which is what makes the reverse index usable for the
    // subtree purge: id → node and node → id agree, and the OLD node is gone
    // from the reverse index rather than lingering with a stale id.
    same(mount.idOf.get(after), 2, 'reverse index points at the new node');
    assert.equal(mount.idOf.has(before), false, 'and no longer at the old one');
    assert.equal(mount.idMap.get(3).nodeValue, 'hi');
    assert.equal(mount.patchFailures, 0);
    assert.deepEqual(invert(mount.idMap), mount.idOf);
    assert.ok(doc);
  });

  it('a dom.add re-binding an id the map still holds OVERWRITES it — in the MAP', () => {
    // The same pin without the removal: a producer that emits the add first
    // must not leave two nodes claiming one id in the map. Treating the second
    // binding as a duplicate loses the node (design §4).
    //
    // What "never a duplicate" does NOT claim, pinned here after review M-7
    // read the phrase as a DOM-level guarantee: the old subtree stays in the
    // DOCUMENT. Nothing asked for it to be removed — a bare re-add with no
    // preceding `dom.remove` is a non-conforming shape capture never emits, and
    // inventing a detach would be the viewer editing the reconstruction. The
    // ghost's descendants stay resolvable, which is what keeps the map an exact
    // inversion and a later patch addressing them harmless.
    const { mount } = stage();
    const first = mount.idMap.get(2);
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null, node: el(2, 'b', { id: 'again' }, []) },
    ], mount);
    const second = mount.idMap.get(2);
    assert.ok(second !== first);
    assert.equal(second.tagName.toLowerCase(), 'b');
    assert.equal(mount.idOf.has(first), false, 'the stale reverse entry is dropped');
    assert.deepEqual(invert(mount.idMap), mount.idOf);

    same(first.parentNode, mount.idMap.get(1), 'the ghost is still in the document');
    assert.equal(mount.idMap.get(3).nodeValue, 'hi', 'and its child still resolves');
    same(mount.idMap.get(3).parentNode, first, 'to a node inside the ghost');
    assert.equal(mount.patchFailures, 0);
  });

  it('`before` resolves an existing sibling and inserts ahead of it', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: 2, node: el(9, 'i', {}, []) },
    ], mount);
    const parent = mount.idMap.get(1);
    same(parent.firstChild, mount.idMap.get(9), 'inserted before node 2');
    same(parent.lastChild, mount.idMap.get(2), 'which kept its place');
    assert.equal(mount.patchFailures, 0);
  });

  it('inserts at every position of a multi-child parent, in the recorded order', () => {
    // Review M-6: all 101 `dom.add` events in both fixtures carry
    // `before: null`, so the corpus pin certifies nothing about positional
    // insertion — the differential is the only other thing that does, and it is
    // generated. One constructed case with a real middle position, asserted as
    // an ordering rather than as three separate parent links.
    const doc = freshDoc();
    const dom = el(1, 'div', {}, [
      el(2, 'i', { id: 'a' }, []), el(3, 'i', { id: 'b' }, []), el(4, 'i', { id: 'c' }, []),
    ]);
    const mount = mountTree(dom, doc.body, doc);

    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: 2, node: el(9, 'i', { id: 'head' }, []) },
      { type: 'dom.add', t: 2, parent: 1, before: 4, node: el(10, 'i', { id: 'middle' }, []) },
      { type: 'dom.add', t: 3, parent: 1, before: null, node: el(11, 'i', { id: 'tail' }, []) },
    ], mount);

    assert.deepEqual(
      Array.from(mount.idMap.get(1).childNodes).map((n) => n.getAttribute('id')),
      ['head', 'a', 'b', 'middle', 'c', 'tail']);
    assert.equal(mount.patchFailures, 0);
  });

  it('a dom.add with no `before` key at all appends, and counts nothing', () => {
    // Guard pin (review I-2, H5): the `undefined` half of the `before` test.
    // Every corpus `dom.add` states `before: null` explicitly, but §5.1's shape
    // is what a producer must emit, not what a hand-edited file will carry, and
    // without the `undefined` half a missing key counts a spurious failure.
    const { mount } = stage();
    applyPatches([{ type: 'dom.add', t: 1, parent: 1, node: el(9, 'i', {}, []) }], mount);
    same(mount.idMap.get(1).lastChild, mount.idMap.get(9), 'appended');
    assert.equal(mount.patchFailures, 0, 'a missing key is an append, not a lost position');
  });
});

describe('the reconstruction root is not re-bindable (review I-1)', () => {
  // `bind()` overwrites both directions by design (§4's MOVE rule), and fix
  // round 1 is where that rule learns its one exception. A `dom.add` carrying
  // the id the mount bound to the root moved the binding onto an
  // attacker-chosen element with ZERO counted failures: the root id then
  // answered about the impostor for Task 7's `exists`/`attr:<name>`, for every
  // `anchor.node` naming it and for the §8 camera chain, and `mount.root` fell
  // out of `idOf` so `readTree` — the shared reader the differential and Task
  // 7's harness walk — threw one layer up. Unreachable from CH capture
  // (`pullForwardMoves` keeps a move's remove ahead of its add, and the
  // observed root is never re-added) and absent from both fixtures; reachable
  // from any foreign or hand-edited file, which is the population §12's player
  // duties exist for.
  //
  // The guard lives in `bind` rather than in `applyAdd` so it covers the
  // buried case too, and a refused bind drops the node from the tree: leaving
  // it in the DOM unbound breaks `readTree` exactly as the original defect did.

  function rootStillSound(mount, expectedRoot, what) {
    same(mount.idMap.get(1), expectedRoot, what + ': the root id still resolves');
    same(mount.idOf.get(expectedRoot), 1, what + ': and the reverse index holds it');
    assert.doesNotThrow(() => readTree(mount.root, mount.idOf),
      what + ': the shared reader still walks the tree');
  }

  it('a dom.add carrying the body-root id is refused and counted', () => {
    const doc = freshDoc();
    const dom = el(1, 'body', { class: 'jspsych' }, [el(2, 'div', { id: 'display' }, [])]);
    const mount = mountTree(dom, doc.body, doc);

    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null,
        node: el(1, 'div', { id: 'impostor' }, []) },
    ], mount);

    rootStillSound(mount, doc.body, 'body root');
    assert.equal(mount.patchFailures, 1);
    assert.equal(doc.body.querySelectorAll('#impostor').length, 0,
      'and the impostor never entered the reconstruction');
  });

  it('a dom.add carrying a non-body root id is refused and counted', () => {
    const doc = freshDoc();
    const dom = el(1, 'div', { id: 'stage' }, [el(2, 'p', {}, [])]);
    const mount = mountTree(dom, doc.body, doc);
    const root = mount.root;

    applyPatches([
      { type: 'dom.add', t: 1, parent: 2, before: null,
        node: el(1, 'section', { id: 'impostor' }, []) },
    ], mount);

    rootStillSound(mount, root, 'non-body root');
    assert.equal(mount.patchFailures, 1);
    assert.equal(root.querySelectorAll('#impostor').length, 0);
  });

  it('the refusal reaches a root id buried inside the added subtree', () => {
    // The reason the guard is in `bind` and not in `applyAdd`: a subtree whose
    // DESCENDANT carries the root id unmaps it by the same route. The rest of
    // the subtree still lands — the posture is skip-and-count, not
    // abort-the-patch.
    const doc = freshDoc();
    const dom = el(1, 'div', { id: 'stage' }, []);
    const mount = mountTree(dom, doc.body, doc);
    const root = mount.root;

    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null,
        node: el(9, 'section', {}, [
          el(1, 'span', { id: 'impostor' }, [el(10, 'text-holder', {}, [])]),
          el(11, 'em', {}, []),
        ]) },
    ], mount);

    rootStillSound(mount, root, 'buried');
    assert.equal(mount.patchFailures, 1);
    assert.equal(root.querySelectorAll('#impostor').length, 0);
    assert.equal(mount.idMap.has(10), false,
      'the refused node takes its own descendants out of the map with it');
    assert.equal(mount.idMap.get(9).childNodes.length, 1);
    same(mount.idMap.get(9).firstChild, mount.idMap.get(11), 'the sibling survives');
  });

  it('a dom.remove naming the mounted root is refused for both root shapes', () => {
    // The same invariant under the other verb. The body-root case is M-7 (a
    // blind `.remove()` detaches the frame's own <body>); the non-body case is
    // the reader's, and the two are now ONE predicate — `node === mount.root` —
    // rather than a list of frame parts, so every disjunct is pinned.
    for (const [shape, tag] of [['body root', 'body'], ['non-body root', 'div']]) {
      const doc = freshDoc();
      const dom = el(1, tag, {}, [el(2, 'p', {}, [])]);
      const mount = mountTree(dom, doc.body, doc);
      const root = mount.root;

      applyPatches([{ type: 'dom.remove', t: 1, node: 1 }], mount);

      assert.equal(mount.patchFailures, 1, shape);
      rootStillSound(mount, root, shape);
      assert.ok(root.parentNode, shape + ': the root is still attached');
      assert.equal(mount.idMap.has(2), true, shape + ': its subtree is not purged');
    }
  });

  it('a dom.add TARGETING the root as parent still works, both shapes', () => {
    // The partner assertion, so the fix cannot be widened into "the root is
    // untouchable". Adding into the root and patching it are ordinary.
    for (const tag of ['body', 'div']) {
      const doc = freshDoc();
      const mount = mountTree(el(1, tag, {}, []), doc.body, doc);
      applyPatches([
        { type: 'dom.add', t: 1, parent: 1, before: null, node: el(2, 'p', {}, []) },
        { type: 'dom.attr', t: 2, node: 1, name: 'class', value: 'live' },
      ], mount);
      same(mount.root.firstChild, mount.idMap.get(2), tag + ' root accepts children');
      assert.equal(mount.root.getAttribute('class'), 'live');
      assert.equal(mount.patchFailures, 0, tag);
    }
  });
});

describe('tolerant posture — unresolvable references are counted, never thrown', () => {
  it('a patch naming a purged descendant counts and changes nothing', () => {
    const { mount } = stage();
    applyPatches([{ type: 'dom.remove', t: 1, node: 2 }], mount);
    const htmlBefore = mount.idMap.get(1).innerHTML;

    applyPatches([
      { type: 'dom.text', t: 2, node: 3, text: 'ghost' },
      { type: 'dom.attr', t: 3, node: 3, name: 'class', value: 'ghost' },
      { type: 'dom.add', t: 4, parent: 3, before: null, node: el(9, 'i', {}, []) },
      { type: 'dom.remove', t: 5, node: 3 },
    ], mount);

    assert.equal(mount.patchFailures, 4, 'one per unresolvable reference');
    assert.equal(mount.idMap.get(1).innerHTML, htmlBefore, 'the tree is untouched');
    assert.equal(mount.idMap.has(9), false, 'and the orphan subtree never bound');
  });

  it('`before` naming an id the map does not hold appends, and counts', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: 4242, node: el(9, 'i', {}, []) },
    ], mount);
    const parent = mount.idMap.get(1);
    same(parent.lastChild, mount.idMap.get(9), 'appended rather than dropped');
    assert.equal(parent.childNodes.length, 2);
    // Counted, because the recorded POSITION could not be honoured even though
    // the node could: the reconstruction is knowingly approximate here.
    assert.equal(mount.patchFailures, 1);
  });

  it('`before` naming a node that is not a child of `parent` appends, and counts', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 2, before: 1, node: el(9, 'i', {}, []) },
    ], mount);
    same(mount.idMap.get(2).lastChild, mount.idMap.get(9), 'appended into the parent');
    assert.equal(mount.patchFailures, 1);
  });

  it('a dom.add whose parent is a text node counts rather than throwing', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 3, before: null, node: el(9, 'i', {}, []) },
    ], mount);
    assert.equal(mount.patchFailures, 1);
    assert.equal(mount.idMap.has(9), false);
  });

  it('an insertion the host itself refuses is counted, and unbinds its subtree', () => {
    // The `insertBefore` guard, pinned rather than left as an unfalsifiable
    // defensive line. Nothing reachable through the four §5.1 shapes makes a
    // real happy-dom insertion throw once the parent is known to be an element,
    // so the refusal is injected: a node bound into the map whose insertion
    // raises. What is being asserted is the POSTURE — a DOMException from the
    // host aborts one patch, not the segment walk — and that the subtree the
    // walk already instantiated is unbound again rather than left in the map
    // pointing at nodes nothing can see.
    const { mount } = stage();
    mount.idMap.set(99, {
      nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
      insertBefore() { throw new Error('HierarchyRequestError'); },
    });
    const after = { type: 'dom.text', t: 2, node: 3, text: 'the walk continued' };
    applyPatches([
      { type: 'dom.add', t: 1, parent: 99, before: null,
        node: el(9, 'div', {}, [el(10, 'p', {}, [])]) },
      after,
    ], mount);

    assert.equal(mount.patchFailures, 1);
    assert.equal(mount.idMap.has(9), false, 'the orphaned subtree is unbound');
    assert.equal(mount.idMap.has(10), false, 'its descendants too');
    assert.equal(mount.idMap.get(3).nodeValue, 'the walk continued');
  });

  it('a dom.attr on a text node and a dom.text on an element are both counted', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.attr', t: 1, node: 3, name: 'class', value: 'x' },
      { type: 'dom.text', t: 2, node: 2, text: 'not a character node' },
    ], mount);
    assert.equal(mount.patchFailures, 2);
    assert.equal(mount.idMap.get(2).textContent, 'hi', 'the element kept its text child');
  });

  it('a malformed node in a dom.add subtree is skipped and counted, not thrown', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null,
        node: el(9, 'div', {}, [el(10, 'a b', {}, []), el(11, 'em', {}, []), null]) },
    ], mount);
    assert.equal(mount.skipped, 2, 'the malformed child and the null entry');
    assert.equal(mount.patchFailures, 0, 'the patch itself resolved');
    assert.equal(mount.idMap.get(9).childNodes.length, 1);
    same(mount.idMap.get(9).firstChild, mount.idMap.get(11), 'the well-formed child survives');
  });

  it('a dom.add whose own node is malformed inserts nothing and counts a skip', () => {
    // Guard pin (review I-2, H7a): the `if (!node) return` after
    // `instantiateNode`. Without it the applier hands `null` to `insertBefore`,
    // which the host refuses, so the failure reads as a hierarchy error and
    // counts a `patchFailures` on top of the skip — two counters moving for one
    // defect, in the bucket that means something else.
    const { mount } = stage();
    const childCount = mount.idMap.get(1).childNodes.length;
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null, node: el(9, 'a b', {}, []) },
      { type: 'dom.add', t: 2, parent: 1, before: null, node: null },
    ], mount);
    assert.equal(mount.skipped, 2);
    assert.equal(mount.patchFailures, 0, 'the patch resolved; the node was unusable');
    assert.equal(mount.idMap.get(1).childNodes.length, childCount);
  });

  it('the strict player THROWS where the viewer counts — design §14 risk 2', () => {
    // The postures asserted against each other rather than described. The same
    // dangling patch: the test player raises, the viewer counts one failure and
    // keeps the segment playable.
    const dom = el(1, 'div', {}, [el(2, 'p', {}, [])]);
    const dangling = [{ type: 'dom.attr', t: 1, node: 99, name: 'class', value: 'x' }];

    const player = createPlayer(dom);
    assert.throws(() => player.apply(dangling), /does not hold/);

    const mount = instantiateTree(dom, freshDoc());
    applyPatches(dangling, mount);
    assert.equal(mount.patchFailures, 1);
  });

  it('garbage patches degrade rather than abort the walk', () => {
    const { mount } = stage();
    const survivor = { type: 'dom.text', t: 9, node: 3, text: 'still applied' };
    applyPatches([
      null, undefined, 'dom.remove', 42, {}, { type: null },
      { type: 'dom.remove' }, { type: 'dom.attr', node: 2 },
      survivor,
    ], mount);
    assert.equal(mount.idMap.get(3).nodeValue, 'still applied');
  });

  it('a dom.attr with no `value` key removes, as a null value does', () => {
    // Guard pin (review I-2, H4): the `undefined` half of the removal test.
    // JSON cannot express `undefined`, so only a hand-constructed or
    // programmatically built patch reaches it — and the tolerant reading is
    // that an absent value is an absent attribute, not an empty one. Without
    // the half, the same patch SETS `class=""`, which is a state the page never
    // had.
    const { mount } = stage();
    applyPatches([
      { type: 'dom.attr', t: 1, node: 2, name: 'id' },
    ], mount);
    assert.equal(mount.idMap.get(2).getAttribute('id'), null);
    assert.equal(mount.idMap.get(2).hasAttribute('id'), false);
  });
});

describe('spec §12 filters on the patch path', () => {
  it('an on* attribute arriving by dom.attr is refused, and moves no counter', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.attr', t: 1, node: 2, name: 'onclick', value: 'alert(1)' },
      { type: 'dom.attr', t: 2, node: 2, name: 'ONMOUSEOVER', value: 'alert(2)' },
      { type: 'dom.attr', t: 3, node: 2, name: 'class', value: 'kept' },
    ], mount);
    const p = mount.idMap.get(2);
    assert.equal(p.getAttribute('onclick'), null);
    assert.equal(p.getAttribute('onmouseover'), null);
    assert.equal(p.getAttribute('class'), 'kept');
    // A SECURITY refusal moves nothing, and the parity is the argument:
    // instantiation drops the same names silently, so counting them would make
    // a hostile file light up the "changes could not be reapplied" chip for a
    // filter working exactly as designed. The reconstruction is visually right
    // without the handler; that is what the chip is about.
    assert.equal(mount.patchFailures, 0);
    assert.equal(mount.skipped, 0);
  });

  it('a NAME-TOKEN refusal is counted, because the page really had it', () => {
    // Review I-4: the same predicate covers two refusal classes with opposite
    // consequences. `isNameToken` also drops names all three engines ACCEPT —
    // `@click`, `[ngModel]`, `(click)`, `*ngIf`, `1x`, `café`, `<` (Task 2's
    // tri-engine table) — which are page state the analyst loses to a
    // realm-determinism decision. Those move `skipped`, the counter the report
    // defines as "the file said something no DOM here could hold", so the loss
    // has a surface instead of only a comment in the module header.
    const { mount } = stage();
    const angular = ['@click', '[ngModel]', '(click)', '*ngIf', '1x', 'café', '<'];
    applyPatches(angular.map((name, i) => (
      { type: 'dom.attr', t: i + 1, node: 2, name, value: 'v' })), mount);

    for (const name of angular) assert.equal(mount.idMap.get(2).getAttribute(name), null);
    assert.equal(mount.skipped, angular.length);
    assert.equal(mount.patchFailures, 0, 'the patch resolved; the name was unusable here');
  });

  it('a javascript: URL arriving by dom.attr is refused, ordinary URLs are not', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.attr', t: 1, node: 2, name: 'href', value: 'java\tscript:alert(1)' },
      { type: 'dom.attr', t: 2, node: 2, name: 'title', value: 'javascript:not a URL' },
    ], mount);
    assert.equal(mount.idMap.get(2).getAttribute('href'), null);
    assert.equal(mount.idMap.get(2).getAttribute('title'), 'javascript:not a URL');

    applyPatches([
      { type: 'dom.attr', t: 3, node: 2, name: 'href', value: 'https://example.org/x' },
    ], mount);
    assert.equal(mount.idMap.get(2).getAttribute('href'), 'https://example.org/x');
  });

  it('dom.attr with value null removes the attribute', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.attr', t: 1, node: 2, name: 'id', value: null },
    ], mount);
    assert.equal(mount.idMap.get(2).getAttribute('id'), null);
    assert.equal(mount.patchFailures, 0);
  });

  it('a dom.add subtree runs through the same filters as a keyframe', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null, node: el(9, 'a', {
        href: 'javascript:alert(1)', onclick: 'alert(2)', id: 'link',
      }, []) },
      { type: 'dom.add', t: 2, parent: 1, before: null, node: el(10, 'iframe', {
        src: 'https://survey.example.com/s/1', width: '300',
      }, []) },
      { type: 'dom.add', t: 3, parent: 1, before: null, node: el(11, 'script', {}, []) },
    ], mount);
    assert.equal(mount.idMap.get(9).getAttribute('href'), null);
    assert.equal(mount.idMap.get(9).getAttribute('onclick'), null);
    assert.equal(mount.idMap.get(9).getAttribute('id'), 'link');
    assert.equal(mount.idMap.get(10).getAttribute('src'), null);
    assert.equal(mount.idMap.get(10).getAttribute('data-ch-placeholder'), 'iframe');
    assert.equal(mount.idMap.get(11).tagName.toLowerCase(), 'template');
  });

  it('dom.text writes character data on text AND comment nodes', () => {
    const doc = freshDoc();
    const dom = el(1, 'div', {}, [text(2, 'a'), { id: 3, kind: 'comment', text: 'c' }]);
    const mount = mountTree(dom, doc.body, doc);
    applyPatches([
      { type: 'dom.text', t: 1, node: 2, text: 'text updated' },
      { type: 'dom.text', t: 2, node: 3, text: 'comment updated' },
    ], mount);
    assert.equal(mount.idMap.get(2).nodeValue, 'text updated');
    assert.equal(mount.idMap.get(3).nodeValue, 'comment updated');
    assert.equal(mount.patchFailures, 0);
  });
});

describe('carried duties from Task 2', () => {
  it('a dom.add subtree merges BOTH maps — idMap and canvases', () => {
    // Task-2 review M-3, which has NO corpus instance: 0 `canvas_size` and 0
    // `media_src` inside any of the 100 `dom.add` subtrees in either fixture,
    // so a merge that forgot `canvases` would break design §3.1/§3.3 for a
    // canvas added mid-segment and be discovered by an analyst, not by a test.
    const { mount } = stage();
    assert.equal(mount.canvases.size, 0);
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null,
        node: el(9, 'div', {}, [
          Object.assign(el(10, 'canvas', { id: 'sketch' }, []),
            { canvas_size: { w: 400, h: 300 } }),
          Object.assign(el(11, 'video', {}, []),
            { media_src: 'https://example.org/exp/clip.mp4' }),
        ]) },
    ], mount);

    assert.deepEqual(mount.canvases.get(10), { w: 400, h: 300 });
    assert.equal(mount.canvases.size, 1);
    assert.equal(mount.idMap.get(10).tagName.toLowerCase(), 'canvas');
    assert.equal(mount.idMap.get(11).getAttribute('src'),
      'https://example.org/exp/clip.mp4');
    // And a later patch resolves against the added descendants, which is the
    // point of merging into the span's map rather than a fresh one.
    applyPatches([
      { type: 'dom.attr', t: 2, node: 10, name: 'width', value: '400' },
    ], mount);
    assert.equal(mount.idMap.get(10).getAttribute('width'), '400');
    assert.equal(mount.patchFailures, 0);
  });

  it('removing a canvas subtree purges its canvases entry too', () => {
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null,
        node: el(9, 'div', {}, [
          Object.assign(el(10, 'canvas', {}, []), { canvas_size: { w: 10, h: 10 } }),
        ]) },
      { type: 'dom.remove', t: 2, node: 9 },
    ], mount);
    assert.equal(mount.idMap.has(10), false);
    assert.equal(mount.canvases.has(10), false,
      'a composite for a node nothing can resolve is a leak');
  });

  it('a dom.remove naming the body-root id is skipped and counted (M-7)', () => {
    // `mountTree` binds a `body` root to the frame's OWN <body>, so a blind
    // `.remove()` here detaches the element every later mount and patch depends
    // on. Pinned in Task 2's `mountTree` docblock; enforced here.
    const doc = freshDoc();
    const dom = el(1, 'body', { class: 'jspsych' }, [el(2, 'div', { id: 'display' }, [])]);
    const mount = mountTree(dom, doc.body, doc);
    same(mount.idMap.get(1), doc.body, 'the root id IS the frame body');

    applyPatches([{ type: 'dom.remove', t: 1, node: 1 }], mount);

    assert.equal(mount.patchFailures, 1);
    same(doc.body.parentNode, doc.documentElement, 'the frame body is still attached');
    same(mount.idMap.get(1), doc.body, 'and still bound');
    assert.equal(mount.idMap.has(2), true, 'its subtree is not purged either');
    assert.equal(doc.body.childNodes.length, 1);
  });

  it('a dom.add can still target the body root', () => {
    const doc = freshDoc();
    const dom = el(1, 'body', {}, []);
    const mount = mountTree(dom, doc.body, doc);
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null, node: el(2, 'div', {}, []) },
    ], mount);
    same(doc.body.firstChild, mount.idMap.get(2), 'the body accepts children');
    assert.equal(mount.patchFailures, 0);
  });

  it('reserved xml:/xmlns: tag prefixes are skipped, not thrown on', () => {
    // Task-2 review residual, re-measured here tri-engine (playwright-core
    // 1.62.1): `createElementNS(<any ns>, 'xml:foo' | 'xmlns:foo' | 'xmlns')`
    // throws NamespaceError on chromium, firefox and webkit, while happy-dom
    // accepts all three — so an unguarded foreign subtree aborts the mount in a
    // browser and passes in this realm. `a:b` and a bare `xml` are fine
    // everywhere and must keep working. Case matters only because the walk
    // lowercases first: `XML:Foo` reaches `createElementNS` as `xml:foo`.
    const { mount } = stage();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null,
        node: el(9, 'svg', {}, [
          el(10, 'xml:foo', {}, []),
          el(11, 'xmlns:bar', {}, []),
          el(12, 'xmlns', {}, []),
          el(13, 'XML:Foo', {}, []),
          el(14, 'a:b', {}, []),
          el(15, 'circle', { r: '4' }, []),
        ]) },
    ], mount);
    assert.equal(mount.skipped, 4, 'the four reserved names');
    for (const id of [10, 11, 12, 13]) assert.equal(mount.idMap.has(id), false, 'id ' + id);
    assert.equal(mount.idMap.get(14).tagName.toLowerCase(), 'a:b');
    assert.equal(mount.idMap.get(15).namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(mount.idMap.get(9).childNodes.length, 2);
  });

  it('the same guard holds at the keyframe boundary', () => {
    const out = instantiateTree(
      el(1, 'svg', {}, [el(2, 'xmlns:x', {}, []), el(3, 'circle', {}, [])]), freshDoc());
    assert.equal(out.skipped, 1);
    assert.equal(out.idMap.has(2), false);
    assert.equal(out.root.childNodes.length, 1);
  });

  it('the shipped reverse index is the exact inversion of the id map', () => {
    // Task 2 left `idOf` as the test file's own inversion helper and routed the
    // decision here. It ships now, because `dom.remove`'s subtree purge needs
    // node → id and rebuilding it per patch is O(tree) per removal. The pin is
    // that the two never drift.
    for (const name of ['canonical-core', 'jspsych-full']) {
      for (const seg of fixture(name).segments) {
        if (!seg.initial_dom) continue;
        const doc = freshDoc();
        const mount = mountTree(seg.initial_dom, doc.body, doc);
        applyPatches(seg.events, mount);
        assert.deepEqual(invert(mount.idMap), mount.idOf,
          name + ' segment ' + seg.index);
      }
    }
  });

  it('the purge deletes only the binding the node actually owns', () => {
    // Guard pin (review I-2, H3), the one survivor with teeth rather than
    // redundancy. Given the inversion the test above pins, `idMap.get(id) ===
    // node` is always true — so the guard's only effect is on a map that is
    // ALREADY broken, where deleting by id alone would unbind an innocent node
    // and turn a loud inconsistency into a quiet one. The inconsistency is
    // therefore injected: a node in the tree claiming, through `idOf` only, an
    // id that belongs to the root.
    const { mount } = stage();
    const doc = mount.doc;
    const ghost = doc.createElement('span');
    mount.idMap.get(2).appendChild(ghost);
    mount.idOf.set(ghost, 1);                    // 1 really belongs to the root

    const root = mount.root;
    applyPatches([{ type: 'dom.remove', t: 1, node: 2 }], mount);

    same(mount.idMap.get(1), root, 'the root keeps its binding');
    assert.equal(mount.idOf.has(ghost), false, 'the ghost loses its false claim');
    assert.equal(mount.idMap.has(3), false, 'the honest descendants still purge');
  });
});

describe('namespace inheritance on dom.add', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  function svgMount() {
    const doc = freshDoc();
    const dom = el(1, 'div', {}, [
      el(2, 'svg', { width: '100', height: '100' }, [
        el(3, 'foreignobject', { width: '50', height: '50' }, []),
      ]),
    ]);
    return mountTree(dom, doc.body, doc);
  }

  it('a subtree added into an svg parent is created in the SVG namespace', () => {
    const mount = svgMount();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 2, before: null,
        node: el(9, 'g', {}, [el(10, 'circle', { r: '4' }, [])]) },
    ], mount);
    assert.equal(mount.idMap.get(9).namespaceURI, SVG_NS);
    assert.equal(mount.idMap.get(10).namespaceURI, SVG_NS);
  });

  it('a subtree added into a foreignObject is HTML again', () => {
    const mount = svgMount();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 3, before: null, node: el(9, 'p', {}, []) },
    ], mount);
    assert.equal(mount.idMap.get(9).namespaceURI, XHTML_NS);
  });

  it('a subtree added into ordinary HTML stays HTML', () => {
    const mount = svgMount();
    applyPatches([
      { type: 'dom.add', t: 1, parent: 1, before: null, node: el(9, 'p', {}, []) },
    ], mount);
    assert.equal(mount.idMap.get(9).namespaceURI, XHTML_NS);
  });

  it('the strict test player infers the same namespaces on dom.add', () => {
    // The oracle has to carry the rule or the differential agrees about a tree
    // neither player can render — the failure mode Task 2's review found when
    // both sides shared `createElement`.
    const player = createPlayer(el(1, 'div', {}, [
      el(2, 'svg', {}, [el(3, 'foreignobject', {}, [])]),
    ]));
    player.apply([
      { type: 'dom.add', t: 1, parent: 2, before: null, node: el(9, 'circle', {}, []) },
      { type: 'dom.add', t: 2, parent: 3, before: null, node: el(10, 'p', {}, []) },
    ]);
    assert.equal(player.node(9).namespaceURI, SVG_NS);
    assert.equal(player.node(10).namespaceURI, XHTML_NS);
  });
});

describe('differential — the same patches through the viewer and the strict player', () => {
  // The plan's differential contract: the capture-side fuzz generator's output
  // driven through THIS applier and `dom-player.js` in parallel. The generator
  // is imported rather than copied (`support/mutation-fuzz.js`, extracted from
  // `mutations-fuzz.test.js`, which still drives it): two readings of the patch
  // vocabulary is the exact failure this migration exists to remove, and a
  // second generator would be a second reading of what a batch means.
  //
  // Each batch is compared three ways: viewer vs strict player (the plan's
  // contract), and both against the capture-side oracle — what a fresh
  // `serializeTree` of the live DOM says right now — so a drift that moved both
  // players together would still fail.
  for (const mixName of Object.keys(MIXES)) {
    it('agrees with the strict player under random batches: ' + mixName, () => {
      for (const seed of SEEDS) {
        const session = generateSession({ mix: mixName, seed });
        const player = createPlayer(session.keyframe);
        const mount = instantiateTree(session.keyframe, freshDoc());

        for (const batch of session.batches) {
          let strictThrew = null;
          try {
            player.apply(batch.events);
          } catch (err) {
            strictThrew = err;
          }
          applyPatches(batch.events, mount);
          const viewerTree = readTree(mount.root, mount.idOf);

          if (strictThrew) {
            // The plan's contract is "the same tree wherever the strict player
            // does not throw". If it ever throws on generated output that is a
            // capture-side defect, not a viewer one — say so loudly rather than
            // passing quietly on the tolerant side.
            assert.fail('the strict player rejected generated output: ' +
              strictThrew.message + '\n' + batch.where);
          }
          assert.deepStrictEqual(viewerTree, player.tree(),
            'viewer and strict player diverged, ' + batch.where);
          assert.deepStrictEqual(viewerTree, batch.expected,
            'both players diverged from the capture oracle, ' + batch.where);
          assert.equal(mount.patchFailures, 0, 'unresolvable patch, ' + batch.where);
          assert.equal(mount.skipped, 0, 'unusable node, ' + batch.where);
        }
      }
    });
  }
});

describe('the real corpus — every committed segment applies its own patches', () => {
  // The fuzz explores shapes nobody thought of; this pins the shapes a real
  // foreign producer actually emitted. jspsych-full's 14 segments carry 100
  // `dom.add`, 136 `dom.remove` and 233 `dom.attr` between them.
  it('applies cleanly with zero failures, and skips only the known bad name', () => {
    let segments = 0;
    let patches = 0;
    for (const name of ['canonical-core', 'jspsych-full']) {
      const rec = fixture(name);
      for (const seg of rec.segments) {
        if (!seg.initial_dom) continue;
        const doc = freshDoc();
        const mount = mountTree(seg.initial_dom, doc.body, doc);
        const doms = seg.events.filter((e) => /^dom\./.test(e.type));
        applyPatches(seg.events, mount);
        assert.equal(mount.patchFailures, 0, name + ' segment ' + seg.index);
        // Since fix round 1 a name-token refusal moves `skipped` (review I-4),
        // so the corpus's one malformed attribute — jsPsych 8.2.3's free-sort
        // arena, the `<` Task 2 found — now reports itself on mount instead of
        // vanishing. Everything else is still zero, and the exception is tied
        // to its segment so a second one cannot hide behind it.
        assert.equal(mount.skipped, name === 'jspsych-full' && seg.index === 10 ? 1 : 0,
          name + ' segment ' + seg.index);
        segments++;
        patches += doms.length;
      }
    }
    // A silent zero would make this a green test over nothing.
    assert.equal(segments, 16);
    // 469 in jspsych-full (100 add / 136 remove / 233 attr) + canonical-core
    // segment 0's single `dom.text`. Its segment 1 is a CONTINUATION, so its
    // six patches belong to segment 0's span and are counted by the checkpoint
    // suite above, not here.
    assert.equal(patches, 470);
  });

  it('and reaches the same tree the strict player does, where it can hold one', () => {
    // Segment 10 is the exception, and it is a REALM divergence rather than a
    // disagreement: happy-dom refuses `setAttribute('<', …)`, so the strict
    // player cannot instantiate jsPsych's free-sort arena in this realm at all
    // (Task 2 I-2 — browsers accept it). The viewer's name filter drops the
    // attribute and plays the segment, which is the whole point of filtering by
    // a fixed predicate instead of deferring to the host.
    let compared = 0;
    let skipped = [];
    for (const name of ['canonical-core', 'jspsych-full']) {
      for (const seg of fixture(name).segments) {
        if (!seg.initial_dom) continue;
        let player;
        try {
          player = createPlayer(seg.initial_dom);
        } catch (err) {
          skipped.push(name + ':' + seg.index);
          continue;
        }
        const doms = seg.events.filter((e) => /^dom\./.test(e.type));
        player.apply(doms);
        const doc = freshDoc();
        const mount = mountTree(seg.initial_dom, doc.body, doc);
        applyPatches(doms, mount);
        assert.deepStrictEqual(readTree(mount.root, mount.idOf), player.tree(),
          name + ' segment ' + seg.index);
        compared++;
      }
    }
    assert.equal(compared, 15);
    assert.deepEqual(skipped, ['jspsych-full:10']);
  });
});
