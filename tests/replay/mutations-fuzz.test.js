// tests/replay/mutations-fuzz.test.js
// Differential fuzz: random DOM batches → mapMutations → a fork-faithful
// player, compared against what a fresh keyframe of the same DOM would say.
//
// Why this file exists. The hand-written tests in mutations.test.js pin every
// mechanism somebody reasoned about, which is exactly why they could not find
// the four batch-composition defects the second review round did: each was a
// COMPOSITION nobody thought to write down (a removal into a fragment, a
// sibling purged with its ancestor, a nested reveal, a reorder inside a moved
// subtree). A generator does not need to have thought of them.
//
// The oracle is the format's own claim: after any batch, the tree the player
// holds must equal the tree a fresh `serializeTree` of the captured DOM would
// produce — same structure, same attributes, same ids. Exclusion placeholders
// are compared as what a reconstruction can show (`asPlayerTree`).
//
// DETERMINISTIC by construction: a seeded PRNG, fixed seed lists, fixed op
// mixes. A failure prints the seed, the op log and the first divergence, and
// re-running reproduces it exactly. Runtime is kept to a few seconds; the wide
// sweeps belong in an investigation script, not in `npm test`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { mapMutations, MUTATION_OBSERVER_INIT } from '../../src/replay/mutations.js';
import { serializeTree } from '../../src/replay/snapshot.js';
import { createSpan } from '../../src/replay/span.js';
import { createDelivery } from '../../src/replay/delivery.js';
import { createPlayer, asPlayerTree } from './support/dom-player.js';

// mulberry32: 32-bit state, uniform enough for op selection and short enough
// to read. The point is reproducibility, not statistical quality.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ['div', 'span', 'p', 'em', 'b', 'i', 'ul', 'li'];
const SEED_DOM =
  '<div id="stage"><ul id="list"><li id="a">a</li><li id="b">b</li></ul>' +
  '<div id="box"><p id="p1">one</p><p id="p2">two</p></div>' +
  '<span id="tail">tail</span></div>';

function pick(rng, list) {
  return list.length ? list[Math.floor(rng() * list.length)] : null;
}

function walk(node, out = []) {
  out.push(node);
  const kids = node.childNodes || [];
  for (let i = 0; i < kids.length; i++) walk(kids[i], out);
  return out;
}

function elements(root) {
  return walk(root).filter(n => n.nodeType === 1);
}

function texts(root) {
  return walk(root).filter(n => n.nodeType === 3);
}

// True when `maybeAncestor` contains `node` (or is it): a move must not put a
// node inside itself.
function contains(maybeAncestor, node) {
  for (let cur = node; cur; cur = cur.parentNode) if (cur === maybeAncestor) return true;
  return false;
}

// Every op returns a short label for the failure log, or null when the random
// draw found nothing to act on.
const OPS = {
  append(ctx, rng) {
    const parent = pick(rng, elements(ctx.root));
    if (!parent) return null;
    const el = ctx.doc.createElement(pick(rng, TAGS));
    el.appendChild(ctx.doc.createTextNode('t' + ctx.n++));
    parent.appendChild(el);
    return 'append <' + el.tagName.toLowerCase() + '> into ' + label(parent);
  },
  insert(ctx, rng) {
    const parent = pick(rng, elements(ctx.root).filter(e => e.childNodes.length));
    if (!parent) return null;
    const ref = pick(rng, Array.from(parent.childNodes));
    const el = ctx.doc.createElement(pick(rng, TAGS));
    el.appendChild(ctx.doc.createTextNode('t' + ctx.n++));
    parent.insertBefore(el, ref);
    return 'insert <' + el.tagName.toLowerCase() + '> before ' + label(ref);
  },
  move(ctx, rng) {
    const movable = walk(ctx.root).filter(n => n !== ctx.root && n.parentNode);
    const node = pick(rng, movable);
    if (!node) return null;
    const target = pick(rng, elements(ctx.root).filter(e => !contains(node, e)));
    if (!target) return null;
    const ref = rng() < 0.5 ? pick(rng, Array.from(target.childNodes)) : null;
    if (ref === node) return null;
    target.insertBefore(node, ref);
    return 'move ' + label(node) + ' into ' + label(target) + (ref ? ' before ' + label(ref) : '');
  },
  remove(ctx, rng) {
    const node = pick(rng, walk(ctx.root).filter(n => n !== ctx.root && n.parentNode));
    if (!node) return null;
    node.remove();
    return 'remove ' + label(node);
  },
  drain(ctx, rng) {
    // The N1 shape: empty a container into a detached fragment.
    const parent = pick(rng, elements(ctx.root).filter(e => e.childNodes.length));
    if (!parent) return null;
    const frag = ctx.doc.createDocumentFragment();
    while (parent.firstChild) frag.appendChild(parent.firstChild);
    return 'drain ' + label(parent) + ' into a fragment';
  },
  clear(ctx, rng) {
    const parent = pick(rng, elements(ctx.root).filter(e => e.childNodes.length));
    if (!parent) return null;
    parent.innerHTML = '';
    return 'clear ' + label(parent);
  },
  attr(ctx, rng) {
    const el = pick(rng, elements(ctx.root));
    if (!el) return null;
    const name = 'data-k' + Math.floor(rng() * 3);
    if (el.hasAttribute(name) && rng() < 0.4) {
      el.removeAttribute(name);
      return 'unset ' + name + ' on ' + label(el);
    }
    el.setAttribute(name, 'v' + ctx.n++);
    return 'set ' + name + ' on ' + label(el);
  },
  text(ctx, rng) {
    const node = pick(rng, texts(ctx.root));
    if (!node) return null;
    node.data = 'x' + ctx.n++;
    return 'text on ' + label(node.parentNode);
  },
  exclude(ctx, rng) {
    const el = pick(rng, elements(ctx.root));
    if (!el) return null;
    if (el.hasAttribute('data-record-exclude')) {
      el.removeAttribute('data-record-exclude');
      return 'reveal ' + label(el);
    }
    // A non-empty value on purpose. Spec §4 makes presence the signal and
    // leaves the value free, and happy-dom reports `oldValue: null` for an
    // empty-valued attribute where Chromium reports `""` — so an empty value
    // would have the harness fail on an engine artifact rather than on the
    // mapper. The empty-valued path is I3's, and it belongs to Task 9's
    // Playwright coverage, where the records are real.
    el.setAttribute('data-record-exclude', 'on');
    return 'exclude ' + label(el);
  },
};

function label(node) {
  if (!node) return 'null';
  if (node.nodeType === 3) return '#text';
  return '<' + node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + '>';
}

// Op mixes, named for what they stress. Each is a list of op names; the
// generator draws uniformly from it, so repetition is the weight.
const MIXES = {
  'all ops': ['append', 'insert', 'move', 'remove', 'drain', 'clear', 'attr', 'text', 'exclude'],
  'no exclusion toggles': ['append', 'insert', 'move', 'remove', 'drain', 'clear', 'attr', 'text'],
  'structure only': ['append', 'insert', 'move', 'remove', 'drain', 'clear'],
  'no moves or removals': ['append', 'insert', 'attr', 'text', 'exclude'],
  'exclusion heavy': ['exclude', 'exclude', 'exclude', 'append', 'remove', 'move'],
};

// Fixed seeds, so a failure is reproducible from the message alone. The wide
// sweeps (thousands of sessions) belong in an investigation script; this is
// the regression floor, sized to stay a couple of seconds of `npm test`.
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 115, 121, 144, 202, 233,
  276, 323, 350, 356, 800];
const BATCHES = 8;
const OPS_PER_BATCH = 6;

// A span for a serialization whose output is NOT going into the file. It
// keeps the recording's REGISTRY, because the ids are half of what is being
// compared and a second walk of the same nodes only re-reads what the
// recording already assigned, and takes its OWN delivery, because that model
// is the thing under test: writing into it between batches would re-sync it to
// the live DOM and repair exactly the drift this suite exists to catch.
function oracleSpan(span) {
  return { registry: span.registry, delivery: createDelivery(), reset() {} };
}

function runSession(mixName, seed) {
  const rng = mulberry32(seed);
  const win = new Window({ url: 'https://example.org/exp/' });
  const doc = win.document;
  doc.body.innerHTML = SEED_DOM;
  const root = doc.body.firstElementChild;
  const span = createSpan();
  const keyframe = serializeTree(root, span, {});
  const player = createPlayer(keyframe);
  const observer = new win.MutationObserver(() => {});
  observer.observe(root, MUTATION_OBSERVER_INIT);

  const ctx = { doc, root, n: 0 };
  const log = [];
  const names = MIXES[mixName];

  for (let batch = 0; batch < BATCHES; batch++) {
    for (let i = 0; i < OPS_PER_BATCH; i++) {
      const op = pick(rng, names);
      const line = OPS[op](ctx, rng);
      if (line) log.push('  batch ' + batch + ': ' + line);
    }
    const events = mapMutations(observer.takeRecords(), { root, span, t: batch });
    const where = 'mix "' + mixName + '" seed ' + seed + ' after batch ' + batch +
      '\n' + log.join('\n') + '\nevents: ' + JSON.stringify(events);

    try {
      player.apply(events);
    } catch (err) {
      assert.fail('player rejected a patch: ' + err.message + '\n' + where);
    }
    // The oracle: what a fresh keyframe of the captured DOM says right now.
    // On its OWN span, because a serialization is a write: sharing the
    // recording's span would re-sync the delivery model to the live DOM
    // between batches and quietly repair the drift this suite exists to
    // catch. Ids still line up, since the recording's span assigned them and
    // a second walk of the same nodes only re-reads what it already knows.
    const expected = asPlayerTree(serializeTree(root, oracleSpan(span), {}));
    assert.deepStrictEqual(player.tree(), expected, 'player diverged, ' + where);
  }
}

describe('mapMutations — differential fuzz (player vs a fresh keyframe)', () => {
  for (const mixName of Object.keys(MIXES)) {
    it('holds under random batches: ' + mixName, () => {
      for (const seed of SEEDS) runSession(mixName, seed);
    });
  }
});
