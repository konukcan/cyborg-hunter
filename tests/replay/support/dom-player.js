// tests/replay/support/dom-player.js
// A spec §5.1 player for tests: applies `dom.*` patches to a real DOM and says
// what tree it ended up holding. Not a test file (it lives outside the
// `tests/replay/*.test.js` glob); shared by mutations.test.js and
// mutations-fuzz.test.js so both judge the mapper against ONE reading of the
// patch vocabulary.
//
// Deliberately UNFORGIVING, and that is the point. The fork's `applyEvent`
// (jspsych-replay-fork/src/replay/engine.ts) falls back to `appendChild` when a
// `before` id is unmapped and swallows DOMExceptions, which turns a dangling
// reference into silent node loss or a quiet reorder — the failure mode two
// review rounds found the mapper capable of producing. Here every reference to
// an id the player does not hold throws. Removal purges the whole subtree from
// the id map, like the fork does, so a patch naming a purged descendant is
// caught rather than resolved against a detached node.
//
// FAITHFUL TO: jspsych-replay-fork @ 43398c7. "Faithful" means the patch
// vocabulary and the id-map lifetime, not the code — this one is stricter on
// purpose. Where the two genuinely disagreed, the fork was behind: this player
// tolerated §4 exclusion placeholders (`attrs || {}` / `children || []`) from
// the start, so the crash the real fork took on them surfaced at T3's finish
// line instead of in a unit run. They agree again as of that commit. Note the
// fork commit whenever this file is re-synced, so the next divergence is
// legible rather than discovered end to end.

import { Window } from 'happy-dom';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

// Foreign-content namespaces, MIRRORED from `src/replay/dom-instantiate.js`
// (which cannot be imported here: it must survive concatenation into the
// report's viewer script as plain script text, so it has no imports and this
// file must not become one). The rule has to live in both places for a reason
// the T5 Task-2 review found: while both players called `createElement`, an
// `svg > circle` landed in the XHTML namespace on BOTH sides, so the round-trip
// oracle agreed about a tree neither could render. An oracle that shares the
// implementation's blindness is not an oracle. Re-sync both when either moves.
//
// ONE KNOWN DIFFERENCE, recorded rather than fixed (T5 Task 3 review M-3): the
// viewer lowercases a tag before creating the element, this player creates with
// `domNode.tag` as written. SVG is case-sensitive, so `foreignObject` and
// `foreignobject` are different elements there — and neither the differential
// nor the round-trip can see it, because `readTree` reports
// `tagName.toLowerCase()`. Unreachable today: capture lowercases every tag
// (`snapshot.js:346`), which is exactly the spec-r3 item design §4 wants fixed.
// Whoever fixes it upstream makes this bite, so re-sync the casing then too.
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const FOREIGN_ROOTS = { svg: SVG_NS, math: MATHML_NS };
const SVG_HTML_INTEGRATION = { foreignobject: true, desc: true, title: true };

function namespaceFor(tag, parentNs) {
  return FOREIGN_ROOTS[tag] || parentNs || XHTML_NS;
}

function childNamespaceOf(tag, ns) {
  return ns === SVG_NS && SVG_HTML_INTEGRATION[tag] === true ? XHTML_NS : ns;
}

/**
 * @param {object} keyframe  a DomNode tree (spec §4), as serializeTree emits it
 * @returns {{root, node, apply, tree}}
 */
export function createPlayer(keyframe) {
  const win = new Window({ url: 'https://example.org/exp/' });
  const doc = win.document;
  const byId = new Map();      // id → node
  const idOf = new Map();      // node → id

  function instantiate(domNode, parentNs) {
    let el;
    if (domNode.kind === 'text') el = doc.createTextNode(domNode.text);
    else if (domNode.kind === 'comment') el = doc.createComment(domNode.text);
    else {
      const tag = String(domNode.tag == null ? '' : domNode.tag).toLowerCase();
      const ns = namespaceFor(tag, parentNs);
      el = ns === XHTML_NS
        ? doc.createElement(domNode.tag)
        : doc.createElementNS(ns, domNode.tag);
      const attrs = domNode.attrs || {};
      for (const name of Object.keys(attrs)) el.setAttribute(name, attrs[name]);
      const childNs = childNamespaceOf(tag, ns);
      for (const child of domNode.children || []) el.appendChild(instantiate(child, childNs));
    }
    byId.set(domNode.id, el);
    idOf.set(el, domNode.id);
    return el;
  }

  function held(id, what) {
    const el = byId.get(id);
    if (el === undefined) {
      throw new Error('patch names id ' + id + ' the player does not hold (' + what + ')');
    }
    return el;
  }

  function purge(el) {
    const id = idOf.get(el);
    if (id !== undefined) { byId.delete(id); idOf.delete(el); }
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) purge(kids[i]);
  }

  const root = instantiate(keyframe);

  // The player's DOM in the file's own vocabulary, so it can be compared with
  // a fresh serialization of the captured DOM.
  function tree(el) {
    return readTree(el || root, idOf);
  }

  return {
    root,
    node: (id) => held(id, 'lookup'),
    tree,
    apply(events) {
      for (const e of events) {
        if (e.type === 'dom.add') {
          const parent = held(e.parent, 'dom.add parent');
          const ref = e.before === null || e.before === undefined
            ? null : held(e.before, 'dom.add before');
          // The inserted subtree inherits the LIVE parent's namespace, so a
          // `dom.add` into an SVG subtree does not silently produce XHTML
          // children — and an add into an SVG HTML-integration point produces
          // HTML again, which is the same `childNamespaceOf` rule the keyframe
          // walk applies (T5 Task 3, mirrored in `dom-instantiate.js`).
          const childNs = childNamespaceOf(
            String(parent.tagName || '').toLowerCase(), parent.namespaceURI);
          parent.insertBefore(instantiate(e.node, childNs), ref);
        } else if (e.type === 'dom.remove') {
          const el = held(e.node, 'dom.remove');
          el.remove();
          purge(el);
        } else if (e.type === 'dom.attr') {
          const el = held(e.node, 'dom.attr');
          if (e.value === null) el.removeAttribute(e.name);
          else el.setAttribute(e.name, e.value);
        } else if (e.type === 'dom.text') {
          held(e.node, 'dom.text').data = e.text;
        } else {
          throw new Error('unknown patch type ' + e.type);
        }
      }
    },
  };
}

/**
 * A live DOM subtree in the FILE's vocabulary (spec §4), given the node → id
 * binding whoever built it holds.
 *
 * Extracted from `createPlayer`'s `tree()` — which now delegates here,
 * unchanged — so the viewer's own instantiation (`src/replay/dom-instantiate.js`,
 * T5 Task 2) is read back by the SAME reader the capture-side suites judge the
 * mutation mapper with. A second reader would let a capture suite and a viewer
 * suite be green about incompatible trees.
 *
 * @param {Node} node  the subtree root
 * @param {Map<Node, number>} idOf  node → id, for every node in the subtree
 */
export function readTree(node, idOf) {
  const id = idOf.get(node);
  if (id === undefined) throw new Error('player holds a node with no id');
  if (node.nodeType === TEXT_NODE) return { id, kind: 'text', text: node.data };
  if (node.nodeType === COMMENT_NODE) return { id, kind: 'comment', text: node.data };
  if (node.nodeType !== ELEMENT_NODE) throw new Error('unexpected node kind');
  const attrs = {};
  const live = node.attributes || [];
  for (let i = 0; i < live.length; i++) attrs[live[i].name] = live[i].value;
  const children = [];
  const kids = node.childNodes || [];
  for (let i = 0; i < kids.length; i++) children.push(readTree(kids[i], idOf));
  return { id, kind: 'element', tag: node.tagName.toLowerCase(), attrs, children };
}

/**
 * A serialized keyframe as the PLAYER can hold it: an exclusion placeholder
 * (spec §4 omits its `attrs` and `children` keys) renders as an element with
 * neither, which is what a reconstruction shows.
 */
export function asPlayerTree(node) {
  if (!node || node.kind !== 'element') return node;
  const out = {
    id: node.id, kind: 'element', tag: node.tag,
    attrs: node.attrs || {},
    children: (node.children || []).map(asPlayerTree),
  };
  if (node.canvas_size) out.canvas_size = node.canvas_size;
  if (node.media_src) out.media_src = node.media_src;
  return out;
}
