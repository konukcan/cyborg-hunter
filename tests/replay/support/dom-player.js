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

import { Window } from 'happy-dom';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/**
 * @param {object} keyframe  a DomNode tree (spec §4), as serializeTree emits it
 * @returns {{root, node, apply, tree}}
 */
export function createPlayer(keyframe) {
  const win = new Window({ url: 'https://example.org/exp/' });
  const doc = win.document;
  const byId = new Map();      // id → node
  const idOf = new Map();      // node → id

  function instantiate(domNode) {
    let el;
    if (domNode.kind === 'text') el = doc.createTextNode(domNode.text);
    else if (domNode.kind === 'comment') el = doc.createComment(domNode.text);
    else {
      el = doc.createElement(domNode.tag);
      const attrs = domNode.attrs || {};
      for (const name of Object.keys(attrs)) el.setAttribute(name, attrs[name]);
      for (const child of domNode.children || []) el.appendChild(instantiate(child));
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
    const node = el || root;
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
    for (let i = 0; i < kids.length; i++) children.push(tree(kids[i]));
    return { id, kind: 'element', tag: node.tagName.toLowerCase(), attrs, children };
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
          parent.insertBefore(instantiate(e.node), ref);
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
