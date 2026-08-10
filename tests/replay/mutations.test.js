// tests/replay/mutations.test.js
// MutationObserver batches → v2 `dom.*` patches (spec §5.1), the mid-span half
// of the node-tree capture whose keyframe half is snapshot.test.js.
//
// Real happy-dom MutationRecords, taken synchronously with takeRecords(), not
// hand-built fakes: the mapper's whole job is reading what the observer
// actually reports (record order, what a move looks like, which mutations get
// a record at all), and a hand-rolled record would be free to agree with the
// implementation about all of it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import { validateStrict } from './schema-v2/validator.js';
import { mapMutations, MUTATION_OBSERVER_INIT } from '../../src/replay/mutations.js';
import { serializeTree, nearestEmittedAncestor } from '../../src/replay/snapshot.js';
import { createRegistry } from '../../src/replay/node-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const canonical = JSON.parse(
  readFileSync(join(HERE, 'schema-v2', 'fixtures', 'canonical-core.json'), 'utf8'));

// A capture in miniature: keyframe (serializeTree numbers the observed root),
// then batches of mutations mapped at observer-callback time. One-line HTML
// only — whitespace between tags is real text nodes with real ids.
function session(html, opts = {}) {
  const win = new Window({ url: 'https://example.org/exp/' });
  const doc = win.document;
  doc.body.innerHTML = html;
  const root = doc.body.firstElementChild;
  // The registry is wrapped so a test can count lookups: `before` resolution
  // walks siblings through peekId, which is where the cost of a mass append
  // shows up (I1).
  const inner = createRegistry();
  const stats = { peek: 0 };
  const registry = {
    idFor: (n) => inner.idFor(n),
    assignTree: (n) => inner.assignTree(n),
    peekId: (n) => { stats.peek++; return inner.peekId(n); },
    resetSpan: () => inner.resetSpan(),
    get count() { return inner.count; },
  };
  const keyframe = serializeTree(root, registry, opts);
  const observer = new win.MutationObserver(() => {});
  observer.observe(root, MUTATION_OBSERVER_INIT);
  return {
    win, doc, root, registry, keyframe, stats,
    // One observer callback = one batch = one `t`.
    flush(t = 100) {
      return mapMutations(observer.takeRecords(),
        Object.assign({ root, registry, t }, opts));
    },
    takeRecords() { return observer.takeRecords(); },
  };
}

// Every node under `root`, including text and comments — the population the
// registry numbers, as opposed to the population the serializer emits.
function allNodes(node, out = []) {
  out.push(node);
  const kids = node.childNodes || [];
  for (let i = 0; i < kids.length; i++) allNodes(kids[i], out);
  return out;
}

function flattenIds(node, out = []) {
  if (!node) return out;
  out.push(node.id);
  for (const child of node.children || []) flattenIds(child, out);
  return out;
}

// Structure and order, without attributes: what a player must reproduce.
function shape(node) {
  if (node.nodeType === 3) return JSON.stringify(node.data);
  if (node.nodeType === 8) return '<!--' + node.data + '-->';
  const kids = Array.from(node.childNodes).map(shape).join('');
  return '<' + node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + '>' +
    kids + '</' + node.tagName.toLowerCase() + '>';
}

/**
 * A spec §5.1 player, deliberately UNFORGIVING. The fork's `applyEvent`
 * (engine.ts) falls back to appendChild when a `before` id is unmapped and
 * swallows DOMExceptions, which turns a dangling reference into silent node
 * loss or a quiet reorder. Here every reference to an id the player was never
 * sent throws, so a patch stream that only survives by the player's charity
 * fails the test rather than passing it.
 */
function playerFor(session) {
  const win = new Window({ url: 'https://example.org/exp/' });
  const doc = win.document;
  const idMap = new Map();

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
    idMap.set(domNode.id, el);
    return el;
  }

  function held(id, what) {
    const el = idMap.get(id);
    if (!el) throw new Error('patch names id ' + id + ' the player never received (' + what + ')');
    return el;
  }

  const root = instantiate(session.keyframe);
  return {
    root,
    node: (id) => held(id, 'lookup'),
    apply(events) {
      for (const e of events) {
        if (e.type === 'dom.add') {
          const parent = held(e.parent, 'dom.add parent');
          const ref = e.before === null ? null : held(e.before, 'dom.add before');
          parent.insertBefore(instantiate(e.node), ref);
        } else if (e.type === 'dom.remove') {
          held(e.node, 'dom.remove').remove();
        } else if (e.type === 'dom.attr') {
          const el = held(e.node, 'dom.attr');
          if (e.value === null) el.removeAttribute(e.name);
          else el.setAttribute(e.name, e.value);
        } else if (e.type === 'dom.text') {
          held(e.node, 'dom.text').data = e.text;
        }
      }
    },
  };
}

describe('mapMutations — canonical shapes (spec §5.1)', () => {
  it('reproduces the canonical-core mid-span dom.attr / dom.add / dom.remove', () => {
    // The machine check that the mapper speaks the contract: the same DOM the
    // canonical keyframe describes, mutated the way its continuation segment
    // says, must produce those exact events — key names, `before: null`,
    // and the mid-span ids (6,7 after a 5-node keyframe) included.
    const s = session(
      '<div id="stage"><button id="go">Go</button><p id="msg">Hello</p></div>');
    const [attrEvent, addEvent, removeEvent] = canonical.segments[1].events;

    s.doc.getElementById('go').setAttribute('disabled', '');
    assert.deepStrictEqual(s.flush(2100.0), [attrEvent]);

    const span = s.doc.createElement('span');
    span.setAttribute('id', 'note');
    span.appendChild(s.doc.createTextNode('saved'));
    s.root.appendChild(span);
    assert.deepStrictEqual(s.flush(2200.0), [addEvent]);

    span.remove();
    assert.deepStrictEqual(s.flush(2300.0), [removeEvent]);
  });

  it('maps characterData to dom.text addressing the TEXT node itself', () => {
    // v1 folded characterData into a parent-level childList patch because text
    // nodes had no parser-stable address. Node ids are that address, so the
    // fold is retired: one event, aimed at the text node, carrying no siblings.
    const s = session(
      '<div id="stage"><button id="go">Go</button><p id="msg">Hello</p></div>');
    const text = s.doc.getElementById('msg').firstChild;

    text.data = 'Clicked!';

    assert.deepStrictEqual(s.flush(460.0), [canonical.segments[0].events[2]]);
    assert.strictEqual(canonical.segments[0].events[2].node, s.registry.peekId(text));
  });
});

describe('mapMutations — strict profile (spec §11)', () => {
  it('emits events the strict validator accepts inside a real recording', () => {
    // The wire-format claim, machine-checked rather than asserted in prose:
    // the mapper's output is dropped into a valid recording's continuation
    // segment and the strict profile must still pass it.
    const s = session(
      '<div id="stage"><button id="go">Go</button><p id="msg">Hello</p></div>');
    const events = [];

    s.doc.getElementById('go').setAttribute('disabled', '');
    events.push(...s.flush(2100));
    const span = s.doc.createElement('span');
    span.appendChild(s.doc.createTextNode('saved'));
    s.root.insertBefore(span, s.doc.getElementById('msg'));
    s.doc.getElementById('msg').firstChild.data = 'Bye';
    events.push(...s.flush(2200));
    span.remove();
    s.doc.getElementById('go').removeAttribute('disabled');
    events.push(...s.flush(2300));

    const recording = JSON.parse(JSON.stringify(canonical));
    recording.segments[1].events = events;
    const result = validateStrict(recording);

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(events.map(e => e.type),
      ['dom.attr', 'dom.add', 'dom.text', 'dom.remove', 'dom.attr']);
  });
});

describe('mapMutations — dom.add', () => {
  it('serializes the whole inserted subtree with ids continuing the span', () => {
    const s = session('<div id="stage"><p></p></div>');
    const box = s.doc.createElement('div');
    box.innerHTML = '<b>deep</b>';

    s.root.appendChild(box);
    const [event] = s.flush();

    assert.strictEqual(event.type, 'dom.add');
    assert.strictEqual(event.parent, 1);
    // stage=1, p=2 at the keyframe; the inserted subtree continues from 3.
    assert.deepStrictEqual(flattenIds(event.node), [3, 4, 5]);
    assert.deepStrictEqual(event.node.children[0].children[0],
      { id: 5, kind: 'text', text: 'deep' });
  });

  it('appends with before: null and inserts with the next sibling id', () => {
    const s = session('<div id="stage"><p id="a"></p><p id="b"></p></div>');
    const bId = s.registry.peekId(s.doc.getElementById('b'));

    s.root.appendChild(s.doc.createElement('em'));            // append
    s.root.insertBefore(s.doc.createElement('i'), s.doc.getElementById('b'));

    const events = s.flush();
    assert.deepStrictEqual(events.map(e => e.before), [null, bId]);
  });

  it('skips a sibling that this batch already removed when resolving before', () => {
    // The sibling is still in the live DOM but no longer in the player's, so
    // naming it in `before` would be a dangling reference — which strict
    // validation cannot catch (it only type-checks node fields).
    const s = session('<div id="stage"><p id="a"></p><p id="b"></p></div>');
    const a = s.doc.getElementById('a');
    const b = s.doc.getElementById('b');
    const bId = s.registry.peekId(b);

    a.remove();                                   // player loses A…
    s.root.insertBefore(s.doc.createElement('em'), b);
    s.root.insertBefore(a, b);                    // …and gets it back after EM

    const events = s.flush();
    assert.deepStrictEqual(events.map(e => e.type),
      ['dom.remove', 'dom.add', 'dom.add']);
    assert.strictEqual(events[1].before, bId);    // NOT A's id
  });

  it('emits one patch for a subtree built up across several records', () => {
    // Serialization happens at flush time against the FINAL state, so the
    // container's patch already carries the children appended after it.
    const s = session('<div id="stage"></div>');
    const box = s.doc.createElement('div');
    s.root.appendChild(box);
    const kid = s.doc.createElement('span');
    box.appendChild(kid);
    kid.appendChild(s.doc.createTextNode('late'));

    const events = s.flush();

    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(flattenIds(events[0].node), [2, 3, 4]);
    assert.strictEqual(events[0].node.children[0].children[0].text, 'late');
  });

  it('emits nothing for an inserted script or noscript', () => {
    const s = session('<div id="stage"></div>');
    const script = s.doc.createElement('script');
    script.textContent = 'alert(1)';

    s.root.appendChild(script);
    s.root.appendChild(s.doc.createElement('noscript'));

    assert.deepStrictEqual(s.flush(), []);
  });

  it('emits an inserted iframe as the element only, srcdoc stripped', () => {
    const s = session('<div id="stage"></div>');
    const frame = s.doc.createElement('iframe');
    frame.setAttribute('src', 'https://example.org/embed');
    frame.setAttribute('srcdoc', '<p>evil-markup</p>');

    s.root.appendChild(frame);
    const [event] = s.flush();

    assert.strictEqual(event.node.tag, 'iframe');
    assert.deepStrictEqual(event.node.children, []);
    assert.ok(!('srcdoc' in event.node.attrs));
    assert.ok(!JSON.stringify(event).includes('evil-markup'));
  });

  it('emits nothing for an insertion inside an excluded subtree', () => {
    const s = session('<div id="stage"><div id="bait" data-record-exclude></div></div>');

    s.doc.getElementById('bait').appendChild(s.doc.createElement('input'));

    assert.deepStrictEqual(s.flush(), []);
  });
});

describe('mapMutations — dom.remove', () => {
  it('addresses the removed node by its existing id', () => {
    const s = session('<div id="stage"><p id="a"></p></div>');
    const id = s.registry.peekId(s.doc.getElementById('a'));

    s.doc.getElementById('a').remove();

    assert.deepStrictEqual(s.flush(300), [{ type: 'dom.remove', t: 300, node: id }]);
  });

  it('suppresses both halves of an add+remove pair inside one batch', () => {
    // The node was never numbered, so it was never in the file: there is
    // nothing to add and nothing to remove.
    const s = session('<div id="stage"></div>');
    const before = s.registry.count;

    const tmp = s.doc.createElement('u');
    s.root.appendChild(tmp);
    tmp.remove();

    assert.deepStrictEqual(s.flush(), []);
    assert.strictEqual(s.registry.count, before);   // and no id was burned
  });

  it('suppresses removal of a never-emitted descendant of an exclusion placeholder', () => {
    // The registry NUMBERS excluded descendants (ids stay stable across a
    // toggle), so peekId answers non-null here — and emitting that id would
    // tell the player to delete a node it never received. Resolving up to the
    // nearest emitted ancestor would be worse still: it would delete the
    // placeholder.
    const s = session('<div id="stage"><div id="bait" data-record-exclude><b>x</b></div></div>');
    const hidden = s.doc.getElementById('bait').firstChild;
    assert.notStrictEqual(s.registry.peekId(hidden), null);

    hidden.remove();

    assert.deepStrictEqual(s.flush(), []);
  });

  it('suppresses removal of a script (numbered, never emitted)', () => {
    const s = session('<div id="stage"><script>alert(1)</script><p></p></div>');
    const script = s.root.firstChild;
    assert.notStrictEqual(s.registry.peekId(script), null);

    script.remove();

    assert.deepStrictEqual(s.flush(), []);
  });

  it('drops a removal whose old parent this batch also removed', () => {
    const s = session('<div id="stage"><div id="box"><p id="leaf"></p></div></div>');
    const boxId = s.registry.peekId(s.doc.getElementById('box'));

    s.doc.getElementById('leaf').remove();
    s.doc.getElementById('box').remove();

    // The box's removal carries its subtree; the leaf's patch would address a
    // chain that no longer reaches the observed root.
    assert.deepStrictEqual(s.flush(700), [{ type: 'dom.remove', t: 700, node: boxId }]);
  });
});

describe('mapMutations — dom.attr', () => {
  it('carries the new value', () => {
    const s = session('<div id="stage"><p id="a"></p></div>');
    const id = s.registry.peekId(s.doc.getElementById('a'));

    s.doc.getElementById('a').setAttribute('class', 'lit');

    assert.deepStrictEqual(s.flush(11),
      [{ type: 'dom.attr', t: 11, node: id, name: 'class', value: 'lit' }]);
  });

  it('encodes attribute REMOVAL as value: null (spec §5.1)', () => {
    const s = session('<div id="stage"><p id="a" class="lit"></p></div>');
    const id = s.registry.peekId(s.doc.getElementById('a'));

    s.doc.getElementById('a').removeAttribute('class');

    assert.deepStrictEqual(s.flush(12),
      [{ type: 'dom.attr', t: 12, node: id, name: 'class', value: null }]);
  });

  it('applies the snapshot serializer\'s attribute filters', () => {
    // Same rules as the keyframe: no event handlers, no iframe srcdoc. A patch
    // that carries what the snapshot refuses is a leak one mutation later.
    const s = session('<div id="stage"><iframe id="f"></iframe></div>');

    s.root.setAttribute('onclick', 'evil()');
    s.doc.getElementById('f').setAttribute('srcdoc', '<p>evil-markup</p>');

    assert.deepStrictEqual(s.flush(), []);
  });

  it('resolves an img src to the absolute url the snapshot would emit', () => {
    const s = session('<div id="stage"><img id="i"></div>');
    const id = s.registry.peekId(s.doc.getElementById('i'));

    s.doc.getElementById('i').setAttribute('src', 'stim/a.png');

    assert.deepStrictEqual(s.flush(13), [{
      type: 'dom.attr', t: 13, node: id, name: 'src',
      value: 'https://example.org/exp/stim/a.png',
    }]);
  });

  it('emits nothing for an attribute change inside an excluded subtree', () => {
    const s = session('<div id="stage"><div data-record-exclude><p id="a"></p></div></div>');

    s.doc.getElementById('a').setAttribute('class', 'lit');

    assert.deepStrictEqual(s.flush(), []);
  });
});

describe('mapMutations — batch semantics', () => {
  it('stamps one t on the whole batch and preserves record order', () => {
    const s = session('<div id="stage"><button id="go">Go</button><p id="msg">Hi</p></div>');

    s.doc.getElementById('go').setAttribute('disabled', '');
    s.root.appendChild(s.doc.createElement('span'));
    s.doc.getElementById('msg').firstChild.data = 'Bye';

    const events = s.flush(42.5);
    assert.deepStrictEqual(events.map(e => e.type),
      ['dom.attr', 'dom.add', 'dom.text']);
    assert.deepStrictEqual(events.map(e => e.t), [42.5, 42.5, 42.5]);
  });

  it('returns an empty array for an empty or missing batch', () => {
    const s = session('<div id="stage"></div>');
    assert.deepStrictEqual(s.flush(), []);
    assert.deepStrictEqual(
      mapMutations(undefined, { root: s.root, registry: s.registry, t: 1 }), []);
  });

  it('exports the observer init the mapper assumes (attributeOldValue included)', () => {
    // attributeOldValue is not decoration: the exclusion-toggle direction is
    // computed from the pre-mutation attribute value. Exported so Task 5's
    // wiring cannot drift from the semantics tested here.
    assert.deepStrictEqual(MUTATION_OBSERVER_INIT, {
      childList: true, attributes: true, attributeOldValue: true,
      characterData: true, subtree: true,
    });
  });
});

describe('mapMutations — redaction (spec §8)', () => {
  const SENTINEL = 'hunter2-sentinel';

  it('suppresses dom.text inside a redacted subtree', () => {
    const s = session('<div id="stage"><div class="secret"><p>old</p></div></div>',
      { redactSelector: '.secret' });

    s.root.querySelector('p').firstChild.data = SENTINEL;

    assert.deepStrictEqual(s.flush(), []);
  });

  it('suppresses a value attribute on a redacted field but keeps the rest', () => {
    const s = session('<div id="stage"><input id="pw" type="password"></div>',
      { redactSelector: '.secret' });
    const id = s.registry.peekId(s.doc.getElementById('pw'));
    const input = s.doc.getElementById('pw');

    input.setAttribute('value', SENTINEL);
    input.setAttribute('class', 'filled');

    assert.deepStrictEqual(s.flush(20),
      [{ type: 'dom.attr', t: 20, node: id, name: 'class', value: 'filled' }]);
  });

  it('emits structural adds inside a redacted subtree with content stripped', () => {
    // Structure is not content (design §4): the player still needs the shape,
    // so the patch emits — through the same stripping the keyframe applies.
    const s = session('<div id="stage"><div class="secret"></div></div>',
      { redactSelector: '.secret' });
    const box = s.root.querySelector('.secret');
    const p = s.doc.createElement('p');
    p.appendChild(s.doc.createTextNode(SENTINEL));
    const input = s.doc.createElement('input');
    input.setAttribute('value', SENTINEL);
    p.appendChild(input);

    box.appendChild(p);
    const [event] = s.flush();

    assert.strictEqual(event.type, 'dom.add');
    assert.strictEqual(event.node.tag, 'p');
    assert.strictEqual(event.node.children[0].text, '');
    assert.ok(!('value' in event.node.children[1].attrs));
  });

  it('leak sentinel: nothing typed into a redacted subtree reaches any patch', () => {
    const s = session(
      '<div id="stage"><div class="secret" contenteditable><p>a</p></div>' +
      '<input id="pw" type="password"><p id="ok">fine</p></div>',
      { redactSelector: '.secret' });
    const secret = s.root.querySelector('.secret');

    secret.querySelector('p').firstChild.data = SENTINEL;
    s.doc.getElementById('pw').setAttribute('value', SENTINEL);
    const extra = s.doc.createElement('span');
    extra.appendChild(s.doc.createTextNode(SENTINEL));
    secret.appendChild(extra);
    s.doc.getElementById('ok').firstChild.data = 'still recorded';

    const events = s.flush();

    assert.ok(events.some(e => e.type === 'dom.text' && e.text === 'still recorded'));
    const json = JSON.stringify(events);
    assert.ok(!json.includes(SENTINEL),
      'redacted content leaked into patches: ' + json);
  });

  it('mirrors the snapshot\'s attribute boundary: only `value` is stripped', () => {
    // The known residual pinned in snapshot.test.js (a page that mirrors typed
    // content into some OTHER attribute leaks it): patches must behave the same
    // way, or keyframe and mid-span would disagree about what redaction means.
    // Widening the strip is a spec question for r3, not a silent divergence.
    const s = session('<div id="stage"><div class="secret"></div></div>',
      { redactSelector: '.secret' });

    s.root.querySelector('.secret').setAttribute('data-draft', SENTINEL);
    const [event] = s.flush();

    assert.strictEqual(event.name, 'data-draft');
    assert.strictEqual(event.value, SENTINEL);
  });
});

describe('mapMutations — exclusion dynamics (spec §4)', () => {
  it('collapses a live node to its placeholder when the attribute is added', () => {
    const s = session('<div id="stage"><div id="box" class="c"><b>secret</b>tail</div></div>');
    const box = s.doc.getElementById('box');
    const boxId = s.registry.peekId(box);
    const bId = s.registry.peekId(box.childNodes[0]);
    const tailId = s.registry.peekId(box.childNodes[1]);

    box.setAttribute('data-record-exclude', '');
    const events = s.flush(50);

    // Children first, then every attribute the player holds — including the
    // exclusion attribute itself, because a fresh snapshot's placeholder
    // carries no attributes at all.
    assert.deepStrictEqual(events, [
      { type: 'dom.remove', t: 50, node: bId },
      { type: 'dom.remove', t: 50, node: tailId },
      { type: 'dom.attr', t: 50, node: boxId, name: 'id', value: null },
      { type: 'dom.attr', t: 50, node: boxId, name: 'class', value: null },
      { type: 'dom.attr', t: 50, node: boxId, name: 'data-record-exclude', value: null },
    ]);
    assert.ok(!JSON.stringify(events).includes('secret'));
  });

  it('restores attributes and children when the attribute is removed', () => {
    const s = session(
      '<div id="stage"><div id="box" data-record-exclude><b>secret</b>tail</div></div>');
    const box = s.doc.getElementById('box');
    const boxId = s.registry.peekId(box);
    // The numbering pass reserved ids for the hidden subtree at the keyframe;
    // "freshly numbered" (spec §4) means ids the file has never used, which is
    // exactly what those are — so the reveal reuses them rather than
    // renumbering the span.
    const bId = s.registry.peekId(box.childNodes[0]);
    const spanCountBefore = s.registry.count;

    box.removeAttribute('data-record-exclude');
    const events = s.flush(60);

    assert.deepStrictEqual(events, [
      { type: 'dom.attr', t: 60, node: boxId, name: 'id', value: 'box' },
      {
        type: 'dom.add', t: 60, parent: boxId, before: null,
        node: {
          id: bId, kind: 'element', tag: 'b', attrs: {},
          children: [{ id: bId + 1, kind: 'text', text: 'secret' }],
        },
      },
      {
        type: 'dom.add', t: 60, parent: boxId, before: null,
        node: { id: bId + 2, kind: 'text', text: 'tail' },
      },
    ]);
    assert.strictEqual(s.registry.count, spanCountBefore);
  });

  it('suppresses ordinary attribute patches while the placeholder stands', () => {
    const s = session('<div id="stage"><div id="box" data-record-exclude></div></div>');

    s.doc.getElementById('box').setAttribute('class', 'lit');

    assert.deepStrictEqual(s.flush(), []);
  });

  it('treats the legacy CH bait markers as exclusion, and keepBait as opt-out', () => {
    const s = session('<div id="stage"><div id="box"><b>bait</b></div></div>');
    const kept = session('<div id="stage"><div id="box"><b>bait</b></div></div>',
      { keepBait: true });

    s.doc.getElementById('box').setAttribute('data-ch-role', 'honeypot');
    kept.doc.getElementById('box').setAttribute('data-ch-role', 'honeypot');

    assert.deepStrictEqual(s.flush().map(e => e.type),
      ['dom.remove', 'dom.attr', 'dom.attr']);
    assert.deepStrictEqual(kept.flush().map(e => [e.type, e.name, e.value]),
      [['dom.attr', 'data-ch-role', 'honeypot']]);
  });
});

describe('mapMutations — moves (registry id stability)', () => {
  it('emits remove-then-add carrying the SAME id', () => {
    // assignTree assigns only when absent, so a moved subtree keeps its
    // numbers. The player must re-bind the id to the re-created node rather
    // than treat the second add as a duplicate — which is what makes an anchor
    // recorded before the move still resolve after it.
    const s = session('<div id="stage"><div id="from"><b id="m">x</b></div><div id="to"></div></div>');
    const moved = s.doc.getElementById('m');
    const movedId = s.registry.peekId(moved);
    const textId = s.registry.peekId(moved.firstChild);
    const toId = s.registry.peekId(s.doc.getElementById('to'));

    s.doc.getElementById('to').appendChild(moved);
    const events = s.flush(80);

    assert.deepStrictEqual(events, [
      { type: 'dom.remove', t: 80, node: movedId },
      {
        type: 'dom.add', t: 80, parent: toId, before: null,
        node: {
          id: movedId, kind: 'element', tag: 'b', attrs: { id: 'm' },
          children: [{ id: textId, kind: 'text', text: 'x' }],
        },
      },
    ]);
    assert.strictEqual(s.registry.peekId(moved), movedId);   // no renumbering
  });
});

describe('mapMutations — root and detachment (M4)', () => {
  it('emits nothing without an observed root', () => {
    // A root that resolved to null (a display container the host wiped) must
    // drop the batch, not throw inside the observer callback and take the rest
    // of the capture down with it.
    const s = session('<div id="stage"><p id="a"></p></div>');
    s.doc.getElementById('a').remove();
    const records = s.takeRecords();

    assert.ok(records.length > 0);
    assert.deepStrictEqual(
      mapMutations(records, { root: null, registry: s.registry, t: 1 }), []);
  });

  it('drops patches for a target this batch detached from the root', () => {
    const s = session('<div id="stage"><div id="box"><p id="leaf">t</p></div></div>');
    const boxId = s.registry.peekId(s.doc.getElementById('box'));

    s.doc.getElementById('leaf').setAttribute('class', 'lit');
    s.doc.getElementById('leaf').firstChild.data = 'changed';
    s.doc.getElementById('box').remove();

    assert.deepStrictEqual(s.flush(90), [{ type: 'dom.remove', t: 90, node: boxId }]);
  });

  it('refuses an unserializable insertion before numbering it', () => {
    // serializeTree returns null for an unserializable root, and the mapper
    // keeps a guard for that — but the shared emission predicate rejects these
    // first, so no id is burned on a node the file will never contain.
    const s = session('<div id="stage"></div>');
    const before = s.registry.count;

    s.root.appendChild(s.doc.createElement('noscript'));

    assert.deepStrictEqual(s.flush(), []);
    assert.strictEqual(s.registry.count, before);
  });
});

describe('mapMutations — batch coherence (C1 to C3)', () => {
  it('C1: removes the children the same batch removed when the exclusion lands', () => {
    // The player holds the PRE-batch children, so the collapse has to name
    // them. Enumerating flush-time childNodes alone leaves the excluded
    // content rendered under the placeholder until the next keyframe, which
    // is exactly the content the researcher asked to hide.
    const s = session(
      '<div id="stage"><div id="box"><b id="A">aaa</b><i id="B">bbb</i></div></div>');
    const p = playerFor(s);
    const box = s.doc.getElementById('box');
    const boxId = s.registry.peekId(box);
    const gone = [s.doc.getElementById('A'), s.doc.getElementById('B')]
      .map(n => s.registry.peekId(n));

    box.setAttribute('data-record-exclude', '');
    box.innerHTML = '';
    const events = s.flush(50);

    assert.deepStrictEqual(
      events.filter(e => e.type === 'dom.remove').map(e => e.node).sort(), gone.sort());
    p.apply(events);
    assert.strictEqual(p.node(boxId).childNodes.length, 0);
    assert.ok(!JSON.stringify(events).includes('aaa'));
  });

  it('C1: removes a child the batch detached before the exclusion landed', () => {
    const s = session(
      '<div id="stage"><div id="box"><b id="A">aaa</b><i id="B">bbb</i></div></div>');
    const p = playerFor(s);
    const box = s.doc.getElementById('box');
    const boxId = s.registry.peekId(box);
    const expected = [s.doc.getElementById('A'), s.doc.getElementById('B')]
      .map(n => s.registry.peekId(n)).sort();

    box.setAttribute('data-record-exclude', '');
    s.doc.getElementById('A').remove();
    const events = s.flush(51);

    assert.deepStrictEqual(
      events.filter(e => e.type === 'dom.remove').map(e => e.node).sort(), expected);
    p.apply(events);
    assert.strictEqual(p.node(boxId).childNodes.length, 0);
  });

  it('C2a: populate-then-reveal adds each child exactly once, in order', () => {
    const s = session(
      '<div id="stage"><div id="box" data-record-exclude><b id="A">old</b></div></div>');
    const p = playerFor(s);
    const box = s.doc.getElementById('box');
    const boxId = s.registry.peekId(box);
    const span = s.doc.createElement('span');
    span.appendChild(s.doc.createTextNode('NEW'));

    box.appendChild(span);
    box.removeAttribute('data-record-exclude');
    const events = s.flush(60);

    const addedIds = events.filter(e => e.type === 'dom.add').map(e => e.node.id);
    assert.deepStrictEqual(addedIds, [...new Set(addedIds)]);
    p.apply(events);
    assert.strictEqual(shape(p.node(boxId)), shape(box));
  });

  it('C2b: an exclusion attribute added and removed in one batch emits nothing', () => {
    const s = session('<div id="stage"><div id="box"><b>keep</b></div></div>');
    const box = s.doc.getElementById('box');

    box.setAttribute('data-record-exclude', '');
    box.removeAttribute('data-record-exclude');

    assert.deepStrictEqual(s.flush(61), []);
  });

  it('emits nothing for an attribute restored to its pre-batch value', () => {
    const s = session('<div id="stage"><p id="a" class="lit"></p></div>');
    const a = s.doc.getElementById('a');

    a.setAttribute('class', 'dim');
    a.setAttribute('class', 'lit');

    assert.deepStrictEqual(s.flush(62), []);
  });

  it('C3: append plus move-to-end reproduces the final order', () => {
    const s = session('<div id="stage"><p id="A">a</p><p id="B">b</p></div>');
    const p = playerFor(s);
    const em = s.doc.createElement('em');
    em.appendChild(s.doc.createTextNode('N'));

    s.root.appendChild(em);                          // [A, B, N]
    s.root.appendChild(s.doc.getElementById('A'));   // [B, N, A]
    p.apply(s.flush(70));

    assert.strictEqual(shape(p.root), shape(s.root));
  });

  it('C3: insert-before a sibling that moves in later keeps every node', () => {
    // The reference sibling is still under its OLD parent when the player
    // applies the insertion, so naming it makes insertBefore throw and the
    // fork's swallowed exception loses the inserted node entirely.
    const s = session(
      '<div id="stage"><div id="P"><p id="A">a</p></div>' +
      '<div id="Q"><p id="B">b</p></div></div>');
    const p = playerFor(s);
    const P = s.doc.getElementById('P');
    const pId = s.registry.peekId(P);
    const em = s.doc.createElement('em');
    em.appendChild(s.doc.createTextNode('N'));

    P.insertBefore(em, s.doc.getElementById('A'));            // P: [N, A]
    P.insertBefore(s.doc.getElementById('B'), s.doc.getElementById('A'));  // P: [N, B, A]
    p.apply(s.flush(71));

    assert.strictEqual(shape(p.node(pId)), shape(P));
  });
});

describe('mapMutations — before resolution cost (I1)', () => {
  it('does not reuse an append run after an out-of-order insertion', () => {
    // The short-circuit that makes appends linear claims "the player holds
    // nothing from here to the end of this parent". An insertion that lands
    // inside that run falsifies the claim, and reusing it would append a node
    // that belongs in the middle.
    const s = session('<div id="stage"><p id="anchor"></p></div>');
    const p = playerFor(s);
    const make = (label) => {
      const el = s.doc.createElement('em');
      el.appendChild(s.doc.createTextNode(label));
      return el;
    };
    const A = make('A'), X = make('X'), Y = make('Y'), Q = make('Q');

    s.root.appendChild(A);
    s.root.appendChild(Q);
    s.root.insertBefore(X, Q);      // record order A, Q, X, Y…
    s.root.insertBefore(Y, Q);      // …against document order A, X, Y, Q
    p.apply(s.flush(72));

    assert.strictEqual(shape(p.root), shape(s.root));
  });

  it('resolves a mass append in linear time', () => {
    // v1's intra-batch dedup guarded "a single task appending N children to
    // one container". The retirement claim only holds if `before` resolution
    // does not walk the tail once per insertion.
    function peeks(n) {
      const s = session('<div id="stage"><p id="anchor"></p></div>');
      for (let i = 0; i < n; i++) s.root.appendChild(s.doc.createElement('span'));
      s.stats.peek = 0;
      const events = s.flush();
      assert.strictEqual(events.length, n);
      return s.stats.peek;
    }

    const small = peeks(50);
    const big = peeks(200);

    // Quadratic would be ~16x for 4x the nodes; linear is ~4x.
    assert.ok(big < small * 6, `peekId calls grew ${(big / small).toFixed(1)}x for 4x nodes`);
    assert.ok(big < 200 * 8, `peekId calls ${big} for 200 appends`);
  });
});

describe('mapMutations — redaction taint (I2)', () => {
  const SENTINEL = 'hunter2-sentinel';

  it('does not leak content when a node moves OUT of a redacted subtree', () => {
    const s = session(
      '<div id="stage"><div class="secret"><p id="typed">' + SENTINEL + '</p></div>' +
      '<div id="open"></div></div>', { redactSelector: '.secret' });
    assert.ok(!JSON.stringify(s.keyframe).includes(SENTINEL));

    s.doc.getElementById('open').appendChild(s.doc.getElementById('typed'));
    const events = s.flush();

    assert.ok(events.some(e => e.type === 'dom.add'));
    assert.ok(!JSON.stringify(events).includes(SENTINEL),
      'redacted content followed the node out: ' + JSON.stringify(events));
  });

  it('keeps a moved-out field\'s value and later text stripped', () => {
    const s = session(
      '<div id="stage"><div class="secret"><input id="pw" type="text"></div>' +
      '<div id="open"><p id="msg">x</p></div></div>', { redactSelector: '.secret' });
    const input = s.doc.getElementById('pw');
    const secretText = s.doc.getElementById('msg');   // moved INTO .secret, then out

    s.root.querySelector('.secret').appendChild(secretText);
    s.flush(1);                                        // serialized under redaction
    secretText.firstChild.data = SENTINEL;
    s.flush(2);                                        // dom.text suppressed
    input.setAttribute('value', SENTINEL);
    s.doc.getElementById('open').appendChild(secretText);
    s.doc.getElementById('open').appendChild(input);
    const events = s.flush(3);

    assert.ok(!JSON.stringify(events).includes(SENTINEL),
      'taint did not survive the move: ' + JSON.stringify(events));
  });
});

describe('mapMutations — minors', () => {
  it('M1: spells a namespaced attribute with its qualified name', () => {
    // Chromium reports `attributeName` as the LOCAL name plus a namespace,
    // while happy-dom reports the qualified name and no namespace — so the
    // Chromium record shape has to be supplied directly here. The DOM the
    // record describes is real.
    const s = session('<div id="stage"><svg id="s"></svg></div>');
    const svg = s.doc.getElementById('s');
    svg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#icon');
    s.takeRecords();
    const id = s.registry.peekId(svg);

    const events = mapMutations([{
      type: 'attributes', target: svg, attributeName: 'href',
      attributeNamespace: 'http://www.w3.org/1999/xlink', oldValue: null,
    }], { root: s.root, registry: s.registry, t: 5 });

    assert.deepStrictEqual(events,
      [{ type: 'dom.attr', t: 5, node: id, name: 'xlink:href', value: '#icon' }]);
  });

  it('M1: drops a namespaced removal it cannot spell', () => {
    // The prefix lives in the attribute that just disappeared. Emitting the
    // bare local name would tell the player to remove a DIFFERENT attribute.
    const s = session('<div id="stage"><svg id="s"></svg></div>');
    const svg = s.doc.getElementById('s');

    const events = mapMutations([{
      type: 'attributes', target: svg, attributeName: 'href',
      attributeNamespace: 'http://www.w3.org/1999/xlink', oldValue: '#icon',
    }], { root: s.root, registry: s.registry, t: 6 });

    assert.deepStrictEqual(events, []);
  });

  it('M3: burns no id on an unemittable child during a reveal', () => {
    // The script arrives while the subtree is hidden, so it was never
    // numbered; the reveal must not number it on its way to discarding it.
    const s = session('<div id="stage"><div id="box" data-record-exclude><b>shown</b></div></div>');
    const box = s.doc.getElementById('box');
    const script = s.doc.createElement('script');
    script.textContent = 'alert(1)';

    box.appendChild(script);
    assert.deepStrictEqual(s.flush(63), []);
    const before = s.registry.count;
    box.removeAttribute('data-record-exclude');
    const events = s.flush(64);

    assert.strictEqual(s.registry.count, before);
    assert.ok(!JSON.stringify(events).includes('alert(1)'));
  });
});

describe('nearestEmittedAncestor (M6)', () => {
  const MIXED =
    '<section id="stage"><script>alert(1)</script>' +
    '<div id="bait" data-record-exclude><b>hidden</b></div>' +
    '<iframe id="f">fallback</iframe><!--c-->text<span>kept</span></section>';

  it('agrees with serializeTree about which nodes reach the file', () => {
    // The drift guard: one predicate, cross-checked against the serializer's
    // actual output over every never-emitted class at once.
    const win = new Window({ url: 'https://example.org/exp/' });
    win.document.body.innerHTML = MIXED;
    const root = win.document.body.firstElementChild;
    const registry = createRegistry();

    const tree = serializeTree(root, registry, {});
    const emitted = new Set(flattenIds(tree));

    for (const node of allNodes(root)) {
      const self = nearestEmittedAncestor(node, root, {}) === node;
      assert.strictEqual(self, emitted.has(registry.peekId(node)),
        'disagreement at ' + (node.tagName || node.nodeName));
    }
  });

  it('resolves a hidden node up to its exclusion placeholder (spec §7)', () => {
    const win = new Window({ url: 'https://example.org/exp/' });
    win.document.body.innerHTML = MIXED;
    const root = win.document.body.firstElementChild;
    const bait = win.document.getElementById('bait');

    assert.strictEqual(nearestEmittedAncestor(bait.firstChild, root, {}), bait);
    assert.strictEqual(nearestEmittedAncestor(bait, root, {}), bait);
  });

  it('returns null outside the observed root', () => {
    const win = new Window({ url: 'https://example.org/exp/' });
    win.document.body.innerHTML = MIXED + '<p id="outside"></p>';
    const root = win.document.body.firstElementChild;

    assert.strictEqual(
      nearestEmittedAncestor(win.document.getElementById('outside'), root, {}), null);
  });

  it('resolves a removed node through the parent it was detached from', () => {
    const win = new Window({ url: 'https://example.org/exp/' });
    win.document.body.innerHTML = '<div id="stage"><p id="a"></p></div>';
    const root = win.document.getElementById('stage');
    const a = win.document.getElementById('a');

    a.remove();

    assert.strictEqual(nearestEmittedAncestor(a, root, {}), null);
    assert.strictEqual(nearestEmittedAncestor(a, root, {}, root), a);
  });
});
