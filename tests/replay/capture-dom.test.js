// tests/replay/capture-dom.test.js
// Tier-2 DOM capture WIRING, v2: keyframes on the shared capture span,
// observer batches → `dom.*` patches, stylesheet snapshots, the observed-root
// selector, and the guard-friction hook.
//
// This file tests the plumbing and nothing else. What a keyframe tree looks
// like belongs to snapshot.test.js, what a batch maps to belongs to
// mutations.test.js, and what the seed contains belongs to
// initial-state.test.js — all three are separately and more thoroughly pinned
// there. Duplicating them here would only produce a second opinion.
//
// The v1 sections this replaces (HTML-string serializer, child-index paths,
// nonce markers, `mutation` patches) died with the string walker; their
// coverage moved to snapshot.test.js and mutations.test.js when those modules
// took over the behaviour.
//
// Real happy-dom MutationRecords throughout: the observer callback's contract
// is with what a browser actually reports, and a hand-built record would agree
// with the implementation by construction.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { attachDomCapture, captureStylesheets } from '../../src/replay/capture-dom.js';
import { createRecorder } from '../../src/replay/recorder.js';
import { createSpan } from '../../src/replay/span.js';

// A recorder with tier-2 capture attached to a real (happy-dom) document.
// The MutationObserver is injected so batches flush synchronously: a real
// observer delivers records on a microtask, and every assertion here is about
// what the callback does with a batch, not about when it arrives.
function harness(html, config, envExtra) {
  const win = new Window({ url: 'https://example.org/exp/' });
  const doc = win.document;
  doc.body.innerHTML = html;
  globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };

  const rec = createRecorder(Object.assign({ participantId: 'P1', tier: 'dom' }, config));
  let now = 5000;
  let observerCb = null;
  const real = new win.MutationObserver(() => {});
  const env = Object.assign({
    doc, win,
    now: () => now,
    MutationObserver: function (cb) {
      observerCb = cb;
      return {
        observe: (node, init) => real.observe(node, init),
        disconnect: () => real.disconnect(),
      };
    },
  }, envExtra);

  rec.startSession();
  attachDomCapture(rec, env);
  return {
    rec, win, doc, env,
    root: () => (typeof rec.config.root === 'string'
      ? doc.querySelector(rec.config.root) : rec.config.root) || doc.body,
    at: (t) => { now = t; },
    // One observer callback = one batch = one `t`.
    flush: () => { observerCb(real.takeRecords()); },
    feed: (records) => { observerCb(records); },
    events: () => rec.getState().trials.flatMap(t => t.events),
    trial: (i) => rec.getState().trials[i],
  };
}

describe('captureStylesheets (spec §2 StylesheetSnapshot)', () => {
  it('gives every sheet an id and a kind, with media where declared', () => {
    const fakeDoc = {
      styleSheets: [
        { href: null, media: { mediaText: '' },
          cssRules: [{ cssText: '.a{color:red}' }, { cssText: '.b{margin:0}' }] },
        { href: 'https://cdn.example/jspsych.css', media: { mediaText: 'print' },
          cssRules: [{ cssText: '.c{}' }] },
      ],
    };
    assert.deepEqual(captureStylesheets(fakeDoc), [
      { id: 1, kind: 'inline', css: '.a{color:red}\n.b{margin:0}', media: null },
      { id: 2, kind: 'link', href: 'https://cdn.example/jspsych.css', css: '.c{}', media: 'print' },
    ]);
  });

  it('a cross-origin sheet keeps its href and reports no css', () => {
    const fakeDoc = {
      styleSheets: [
        { href: 'https://cdn.example/x.css',
          get cssRules() { throw new Error('cross-origin'); } },
      ],
    };
    assert.deepEqual(captureStylesheets(fakeDoc),
      [{ id: 1, kind: 'link', href: 'https://cdn.example/x.css', css: null, media: null }]);
  });

  it('lands on the recorder at attach', () => {
    const h = harness('<div id="stage">hi</div>');
    assert.ok(Array.isArray(h.rec.getState().stylesheets));
  });
});

describe('observed root (spec §2)', () => {
  it('records the configured selector', () => {
    const h = harness('<div id="stage">hi</div>', { root: '#stage' });
    assert.equal(h.rec.getState().observedRoot, '#stage');
  });

  it('reports an element root by its id, and the body as null', () => {
    const win = new Window({ url: 'https://example.org/' });
    win.document.body.innerHTML = '<div id="stage"></div>';
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const stage = win.document.getElementById('stage');
    const rec = createRecorder({ participantId: 'P', tier: 'dom', root: stage });
    rec.startSession();
    attachDomCapture(rec, { doc: win.document, win, now: () => 0, MutationObserver: null });
    assert.equal(rec.getState().observedRoot, '#stage');

    const plain = harness('<p>x</p>');
    assert.equal(plain.rec.getState().observedRoot, null, 'null means the document body');
  });
});

describe('keyframes at trial start (spec §3/§4)', () => {
  it('the snapshot lands on the trial as a DomNode TREE, not a string', () => {
    const h = harness('<div id="stage"><p>hello</p></div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    const dom = h.trial(0).initialDom;
    assert.equal(typeof dom, 'object');
    assert.deepEqual(
      { id: dom.id, kind: dom.kind, tag: dom.tag, attrs: dom.attrs },
      { id: 1, kind: 'element', tag: 'div', attrs: { id: 'stage' } });
    assert.equal(dom.children[0].tag, 'p');
    assert.equal(dom.children[0].children[0].text, 'hello');
  });

  it('the seed is taken on the same span, so it names the keyframe ids', () => {
    const h = harness('<div id="stage"><input id="answer"></div>', { root: '#stage' });
    h.doc.getElementById('answer').value = 'typed';
    h.rec.startTrial({ trialId: 't1' });
    const trial = h.trial(0);
    const inputId = trial.initialDom.children[0].id;
    assert.deepEqual(trial.initialState.form, [{ node: inputId, value: 'typed' }]);
  });

  it('every trial keyframes: ids restart at 1 and the seed comes with them', () => {
    // Task 8 makes the cadence size-aware; until then this is v1's behaviour
    // and the spec's advice for wiping hosts. What matters now is that the
    // span RESETS with the keyframe — ids restarting is the observable half.
    const h = harness('<div id="stage"><p>a</p></div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });
    assert.equal(h.trial(0).initialDom.id, 1);
    assert.equal(h.trial(1).initialDom.id, 1);
    assert.notEqual(h.trial(0).initialDom, h.trial(1).initialDom, 'a fresh walk each time');
  });

  it('a seed with nothing to say is omitted (spec §3)', () => {
    const h = harness('<div id="stage"><p>a</p></div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    assert.equal(h.trial(0).initialState, null);
  });

  it('enumerates capture-trace\'s scrolled elements for the seed', () => {
    // The set only the scroll listener can know (spec §3 element_scroll), fed
    // in by the assembly. Handed as a FUNCTION because it is live: elements
    // scroll after this module attaches.
    const win = new Window({ url: 'https://example.org/' });
    win.document.body.innerHTML = '<div id="stage"><div id="pane">x</div></div>';
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const pane = win.document.getElementById('pane');
    Object.defineProperty(pane, 'scrollTop', { value: 120, configurable: true });
    const scrolled = new Set();
    const rec = createRecorder({ participantId: 'P', tier: 'dom', root: '#stage' });
    rec.startSession();
    attachDomCapture(rec, {
      doc: win.document, win, now: () => 0, MutationObserver: null,
      scrolled: () => scrolled,
    });
    scrolled.add(pane);                                   // …after attach
    rec.startTrial({ trialId: 't1' });
    const trial = rec.getState().trials[0];
    assert.deepEqual(trial.initialState.element_scroll,
      [{ node: trial.initialDom.children[0].id, x: 0, y: 120 }]);
  });

  it('measures the keyframe once and seeds the trial character budget with it', () => {
    const h = harness('<div id="stage"><p>hello</p></div>', { root: '#stage' });
    const seen = [];
    const realNote = h.rec.noteSnapshotChars;
    h.rec.noteSnapshotChars = (trial, chars) => { seen.push(chars); realNote(trial, chars); };
    h.rec.startTrial({ trialId: 't1' });
    assert.equal(seen.length, 1, 'measured once per keyframe');
    assert.equal(seen[0], JSON.stringify(h.trial(0).initialDom).length,
      'the exact JSON length of the payload, not an estimate off a string');
  });

  it('drops an oversized keyframe and stops addressing nodes the file lacks', () => {
    // The keyframe is stored on the trial, so the recorder's cap cannot refuse
    // it — this module must. And once it is refused, the span's picture of
    // what the player holds is a lie: patches addressing those ids would name
    // nodes no player ever received, so the span is reset with the drop.
    const h = harness('<div id="stage"><p>a long enough stimulus</p></div>',
      { root: '#stage', maxCharsPerTrial: 5 });
    h.rec.startTrial({ trialId: 't1' });
    assert.equal(h.trial(0).initialDom, null);
    assert.equal(h.trial(0).initialState, null);
    assert.ok(h.rec.getState().captureFailures.some(f => f.channel === 'dom_snapshot'));

    h.root().appendChild(h.doc.createElement('span'));
    h.flush();
    assert.deepEqual(h.events(), [],
      'no patch may address a keyframe that is not in the file');
  });

  it('a throwing snapshot is contained as a capture failure', () => {
    const h = harness('<div id="stage"></div>', { root: '#stage' });
    Object.defineProperty(h.root(), 'childNodes', {
      get() { throw new Error('boom'); }, configurable: true,
    });
    h.rec.startTrial({ trialId: 't1' });
    assert.equal(h.trial(0).initialDom, null);
    assert.ok(h.rec.getState().captureFailures.some(f => /boom/.test(f.message)));
  });
});

describe('mutation batches → dom.* patches (spec §5.1)', () => {
  it('an insertion becomes a dom.add carrying the subtree, stamped with the batch time', () => {
    const h = harness('<div id="stage"><p id="msg">a</p></div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    const rootId = h.trial(0).initialDom.id;

    h.at(5100);
    const span = h.doc.createElement('span');
    span.textContent = 'added';
    h.root().appendChild(span);
    h.flush();

    const events = h.events();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'dom.add');
    assert.equal(events[0].t, 5100, 'one callback, one t');
    assert.equal(events[0].parent, rootId);
    assert.equal(events[0].before, null);
    assert.equal(events[0].node.tag, 'span');
    assert.equal(events[0].node.children[0].text, 'added');
  });

  it('a removal, an attribute change and a text change map to their own types', () => {
    const h = harness('<div id="stage"><p id="msg">a</p><b id="gone">x</b></div>',
      { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    const msgId = h.trial(0).initialDom.children[0].id;
    const textId = h.trial(0).initialDom.children[0].children[0].id;
    const goneId = h.trial(0).initialDom.children[1].id;

    h.doc.getElementById('msg').setAttribute('class', 'lit');
    h.doc.getElementById('msg').firstChild.data = 'b';
    h.doc.getElementById('gone').remove();
    h.flush();

    // Within a batch the order is the OBSERVER's, which is the order the
    // mutations happened in — not a per-type grouping this module invents.
    assert.deepEqual(h.events().map(e => [e.type, e.node]), [
      ['dom.attr', msgId],
      ['dom.text', textId],
      ['dom.remove', goneId],
    ]);
  });

  it('hands the observer the COMPLETE batch — no dedup, no folding', () => {
    // v1 emitted ONE childList patch per target per batch, because each patch
    // re-serialized the target's whole resulting children. A dom.add carries
    // only what was inserted, so all three insertions are stated, each with
    // its own position — and mutations.js's batch pre-scan depends on seeing
    // every record anyway.
    const h = harness('<div id="stage"></div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    for (const tag of ['a', 'b', 'i']) h.root().appendChild(h.doc.createElement(tag));
    h.flush();
    assert.deepEqual(h.events().map(e => [e.type, e.node.tag]),
      [['dom.add', 'a'], ['dom.add', 'b'], ['dom.add', 'i']]);
  });

  it('patch ids and keyframe ids are the same numbering', () => {
    const h = harness('<div id="stage"><p>a</p></div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    const keyframeIds = [];
    (function walk(n) { keyframeIds.push(n.id); (n.children || []).forEach(walk); })(
      h.trial(0).initialDom);

    h.root().appendChild(h.doc.createElement('span'));
    h.flush();
    const added = h.events()[0];
    assert.ok(!keyframeIds.includes(added.node.id),
      'a mid-span insertion continues the numbering rather than reusing it');
    assert.equal(added.parent, keyframeIds[0]);
  });

  it('a throwing batch is contained as a capture failure, and the page survives', () => {
    // Recording must never break an experiment (design §6): an exception in
    // the observer callback would otherwise propagate into the host page's
    // microtask queue.
    const h = harness('<div id="stage"></div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    const poison = [{ get type() { throw new Error('unreadable record'); } }];
    assert.doesNotThrow(() => h.feed(poison));
    assert.ok(h.rec.getState().captureFailures.some(
      f => f.channel === 'mutations' && /unreadable record/.test(f.message)));

    // …and the next batch still works.
    h.root().appendChild(h.doc.createElement('span'));
    h.flush();
    assert.deepEqual(h.events().map(e => e.type), ['dom.add']);
  });
});

describe('guard-friction cooperation', () => {
  function withFriction(html, config) {
    let onViolation = null;
    const friction = {
      onViolation: (fn) => { onViolation = fn; },
      getCurrentState: () => ({ in_violation: false }),
    };
    const win = new Window({ url: 'https://example.org/' });
    win.document.body.innerHTML = html;
    win.GuardFriction = friction;
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const rec = createRecorder(Object.assign(
      { participantId: 'P', tier: 'dom', root: '#stage' }, config));
    const span = createSpan();
    let now = 100;
    let observerCb = null;
    const real = new win.MutationObserver(() => {});
    rec.startSession();
    attachDomCapture(rec, {
      doc: win.document, win, now: () => now, span,
      MutationObserver: function (cb) {
        observerCb = cb;
        return { observe: (n, i) => real.observe(n, i), disconnect: () => real.disconnect() };
      },
    });
    return {
      rec, win, span,
      doc: win.document,
      root: () => win.document.querySelector('#stage'),
      violate: (v) => onViolation(v),
      flush: () => observerCb(real.takeRecords()),
      events: () => rec.getState().trials.flatMap(t => t.events),
    };
  }

  it('a violation is a session-level vendor entry, not an event (spec §5.8)', () => {
    const h = withFriction('<div id="stage"><p>clean</p></div>');
    h.rec.startTrial({ trialId: 't1' });
    h.violate({ phase: 'start', reason: 'not_fullscreen' });
    const violations = h.rec.getState().guardViolations;
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, 'not_fullscreen');
    assert.deepEqual(h.events(), [],
      'no vendor event type may appear in the segment stream');
  });

  it('pre_scramble_dom is a DomNode tree taken on a THROWAWAY span', () => {
    // Spec-conformant shape (a reader compares it to the keyframe by
    // structure), and inert: numbering it into the live span would tell the
    // recording that the player holds nodes it was never sent, which suppresses
    // the next patch for each of them (span.js's D1 pattern).
    const h = withFriction('<div id="stage"><p>clean</p></div>');
    h.rec.startTrial({ trialId: 't1' });

    // The hazard is a serialization taken BETWEEN a mutation and its flush: on
    // the live span it would deliver the inserted node into the model the
    // mapper reads, and the mapper would then skip the `dom.add` because the
    // player "already has" a node it was never sent. So mutate first.
    h.root().appendChild(h.doc.createElement('span'));
    h.violate({ phase: 'start', reason: 'not_fullscreen' });
    h.flush();

    const snap = h.rec.getState().guardViolations[0].pre_scramble_dom;
    assert.equal(snap.kind, 'element');
    assert.equal(snap.tag, 'div');
    assert.equal(snap.children[0].children[0].text, 'clean');
    assert.equal(snap.id, 1, 'its own span, numbered from 1');
    assert.deepEqual(h.events().map(e => e.type), ['dom.add'],
      'the live recording is unaffected by a snapshot taken beside it');
  });

  it('an oversized pre-scramble snapshot is withheld, not carried', () => {
    const h = withFriction('<div id="stage"><p>a reasonably long stimulus</p></div>',
      { maxCharsPerTrial: 20 });
    h.violate({ phase: 'start', reason: 'not_fullscreen' });
    assert.equal(h.rec.getState().guardViolations[0].pre_scramble_dom, null);
    assert.ok(h.rec.getState().captureFailures.some(f => f.channel === 'guard_violation'));
  });

  it('non-start phases carry duration and no snapshot', () => {
    const h = withFriction('<div id="stage"></div>');
    h.violate({ phase: 'end', reason: 'not_fullscreen', duration: 1200 });
    assert.deepEqual(h.rec.getState().guardViolations[0].duration_ms, 1200);
    assert.equal('pre_scramble_dom' in h.rec.getState().guardViolations[0], false);
  });
});

describe('the capture span is shared, not owned', () => {
  it('uses the span the assembly hands it', () => {
    const span = createSpan();
    const h = harness('<div id="stage"><p>a</p></div>', { root: '#stage' }, { span });
    h.rec.startTrial({ trialId: 't1' });
    // The same object capture-trace resolves event targets through: the
    // keyframe's root id is peekable from outside.
    assert.equal(span.registry.peekId(h.root()), h.trial(0).initialDom.id);
    assert.equal(span.delivery.holds(h.root()), true);
  });
});
