// tests/replay/support/mutation-fuzz.js
// The random DOM-batch generator behind the differential suites: it drives a
// live happy-dom tree through seeded op mixes, runs the real capture path over
// each batch (`mapMutations`), and hands back the emitted `dom.*` events plus
// the capture-side oracle — what a fresh `serializeTree` of the same DOM says
// right now.
//
// EXTRACTED from `mutations-fuzz.test.js` (T5 Task 3), which still drives it,
// so that the viewer's applier (`src/replay/dom-instantiate.js`) and the strict
// test player (`support/dom-player.js`) can be run over the SAME generated
// batches. Copying the generator into the second suite would have put two
// readings of "what a batch means" in the repo, which is the failure this
// migration exists to remove — the same argument that made `readTree` shared
// rather than mirrored.
//
// DETERMINISTIC by construction: a seeded PRNG, fixed seed lists, fixed op
// mixes. A failure prints the seed, the op log and the batch index, and
// re-running reproduces it exactly. Not a test file — it lives outside the
// `tests/replay/*.test.js` glob.

import { Window } from 'happy-dom';

import { mapMutations, MUTATION_OBSERVER_INIT } from '../../../src/replay/mutations.js';
import { serializeTree } from '../../../src/replay/snapshot.js';
import { createSpan } from '../../../src/replay/span.js';
import { createDelivery } from '../../../src/replay/delivery.js';
import { asPlayerTree } from './dom-player.js';

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
    // mapper. The empty-valued path belongs to Playwright coverage, where the
    // records are real.
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
export const MIXES = {
  'all ops': ['append', 'insert', 'move', 'remove', 'drain', 'clear', 'attr', 'text', 'exclude'],
  'no exclusion toggles': ['append', 'insert', 'move', 'remove', 'drain', 'clear', 'attr', 'text'],
  'structure only': ['append', 'insert', 'move', 'remove', 'drain', 'clear'],
  'no moves or removals': ['append', 'insert', 'attr', 'text', 'exclude'],
  'exclusion heavy': ['exclude', 'exclude', 'exclude', 'append', 'remove', 'move'],
};

// Fixed seeds, so a failure is reproducible from the message alone. The wide
// sweeps (thousands of sessions) belong in an investigation script; this is
// the regression floor, sized to stay a couple of seconds of `npm test`.
export const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 115, 121, 144, 202, 233,
  276, 323, 350, 356, 800];
export const BATCHES = 8;
export const OPS_PER_BATCH = 6;

// A span for a serialization whose output is NOT going into the file. It
// keeps the recording's REGISTRY, because the ids are half of what is being
// compared and a second walk of the same nodes only re-reads what the
// recording already assigned, and takes its OWN delivery, because that model
// is the thing under test: writing into it between batches would re-sync it to
// the live DOM and repair exactly the drift these suites exist to catch.
function oracleSpan(span) {
  return { registry: span.registry, delivery: createDelivery(), reset() {} };
}

/**
 * Run one seeded session and return everything a player-side suite needs.
 *
 * @param {object} opts
 * @param {string} opts.mix   a key of `MIXES`
 * @param {number} opts.seed  any integer; the same seed replays exactly
 * @returns {{keyframe: object, batches: {events, expected, log, where}[]}}
 *   `keyframe` is the spec §4 tree a player instantiates; per batch, `events`
 *   are the emitted `dom.*` patches, `expected` is the capture-side oracle
 *   (`asPlayerTree` of a fresh serialization of the live DOM), and `where` is a
 *   ready-made failure locator carrying the mix, the seed and the op log.
 */
export function generateSession({ mix, seed, batches = BATCHES, opsPerBatch = OPS_PER_BATCH }) {
  const rng = mulberry32(seed);
  const win = new Window({ url: 'https://example.org/exp/' });
  const doc = win.document;
  doc.body.innerHTML = SEED_DOM;
  const root = doc.body.firstElementChild;
  const span = createSpan();
  const keyframe = serializeTree(root, span, {});
  const observer = new win.MutationObserver(() => {});
  observer.observe(root, MUTATION_OBSERVER_INIT);

  const ctx = { doc, root, n: 0 };
  const log = [];
  const names = MIXES[mix];
  const out = [];

  for (let batch = 0; batch < batches; batch++) {
    for (let i = 0; i < opsPerBatch; i++) {
      const op = pick(rng, names);
      const line = OPS[op](ctx, rng);
      if (line) log.push('  batch ' + batch + ': ' + line);
    }
    const events = mapMutations(observer.takeRecords(), { root, span, t: batch });
    const where = 'mix "' + mix + '" seed ' + seed + ' after batch ' + batch +
      '\n' + log.join('\n') + '\nevents: ' + JSON.stringify(events);
    // The oracle: what a fresh keyframe of the captured DOM says right now. On
    // its OWN span, because a serialization is a write: sharing the recording's
    // span would re-sync the delivery model to the live DOM between batches and
    // quietly repair the drift these suites exist to catch. Ids still line up,
    // since the recording's span assigned them and a second walk of the same
    // nodes only re-reads what it already knows.
    const expected = asPlayerTree(serializeTree(root, oracleSpan(span), {}));
    out.push({ events, expected, log: log.slice(), where });
  }

  return { keyframe, batches: out };
}
