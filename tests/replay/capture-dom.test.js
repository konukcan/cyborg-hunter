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

import {
  attachDomCapture, captureStylesheets, fillCrossOriginSheets, shouldKeyframe,
} from '../../src/replay/capture-dom.js';
import { createRecorder } from '../../src/replay/recorder.js';
import { createSpan } from '../../src/replay/span.js';
import { createPlayer } from './support/dom-player.js';

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

  it('reports what was OBSERVED when the selector matched nothing', () => {
    // The root is resolved once and held (see the module), so a selector that
    // matches nothing at startSession falls back to the body for the whole
    // recording. Reporting the configured selector anyway puts a lie on the
    // wire: a conforming player honouring §2's `observed_root` would mount a
    // body-rooted tree into `#stage`. The file must say what it observed.
    const h = harness('<div id="other">x</div>', { root: '#stage' });
    h.rec.startTrial({ trialId: 't1' });
    assert.equal(h.rec.getState().observedRoot, null,
      'null is §2\'s spelling for "the document body", which is what was observed');
    assert.equal(h.trial(0).initialDom.tag, 'body');
  });

  it('records a capture failure when a configured selector misses', () => {
    // The other half: `null` alone reads as "the researcher configured
    // nothing". The failure is what makes a misconfigured study diagnosable
    // instead of quietly producing a body-rooted recording.
    const h = harness('<div id="other">x</div>', { root: '#stage' });
    const failure = h.rec.getState().captureFailures.find(f => f.channel === 'observed_root');
    assert.ok(failure, 'a missed root selector must be recorded');
    assert.match(failure.message, /#stage/);
    assert.match(failure.message, /document\.body/);
  });

  it('treats an invalid selector the same way', () => {
    const h = harness('<div id="other">x</div>', { root: ':::not a selector' });
    assert.equal(h.rec.getState().observedRoot, null);
    assert.ok(h.rec.getState().captureFailures.some(f => f.channel === 'observed_root'));
  });

  it('a selector that DID resolve records no failure', () => {
    const h = harness('<div id="stage">x</div>', { root: '#stage' });
    assert.equal(h.rec.getState().observedRoot, '#stage');
    assert.deepEqual(h.rec.getState().captureFailures, []);
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

  it('a keyframe restarts the numbering at 1 and walks the tree afresh', () => {
    // `keyframeEvery: 1` is the wiping-host cadence (v1's behaviour, and what
    // the jsPsych adapter forces). The span RESETS with each keyframe, and ids
    // restarting is the observable half of that.
    const h = harness('<div id="stage"><p>a</p></div>',
      { root: '#stage', keyframeEvery: 1 });
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

  it('the measurement counts the initial_state seed too, not just the tree', () => {
    // The seed is stored on the trial exactly like the tree, so the recorder
    // cannot see it either. Dropping the seed term from the sum is invisible
    // to any fixture whose seed is null, which is what the first version of
    // the test above used.
    const h = harness('<div id="stage"><input id="answer"></div>', { root: '#stage' });
    h.doc.getElementById('answer').value = 'typed';
    const seen = [];
    const realNote = h.rec.noteSnapshotChars;
    h.rec.noteSnapshotChars = (trial, chars) => { seen.push(chars); realNote(trial, chars); };
    h.rec.startTrial({ trialId: 't1' });

    const trial = h.trial(0);
    assert.ok(trial.initialState, 'the fixture has to produce a seed for this to test anything');
    const treeChars = JSON.stringify(trial.initialDom).length;
    const seedChars = JSON.stringify(trial.initialState).length;
    assert.equal(seen[0], treeChars + seedChars);
    assert.ok(seen[0] > treeChars, 'the seed term is part of the sum');
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
  function withFriction(html, config, opts) {
    opts = opts || {};
    let onViolation = null;
    const stateReads = [];
    const friction = {
      onViolation: (fn) => { onViolation = fn; },
      // `ongoing` models a violation that STARTED BEFORE replay attached, whose
      // phase:'start' emission is long gone by subscription time. The call is
      // counted because the pre-session gate is only observable that way: the
      // recorder refuses the push too, so the OUTCOME is the same either way
      // and a test asserting it alone cannot see the gate.
      getCurrentState: () => { stateReads.push(1); return opts.ongoing || { in_violation: false }; },
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
    if (!opts.beforeSession) rec.startSession();
    attachDomCapture(rec, {
      doc: win.document, win, now: () => now, span,
      MutationObserver: function (cb) {
        observerCb = cb;
        return { observe: (n, i) => real.observe(n, i), disconnect: () => real.disconnect() };
      },
    });
    return {
      rec, win, span, stateReads,
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

  it('synthesizes an entry for a violation already in progress at subscribe', () => {
    // Friction may start before replay attaches (standalone wiring order, or a
    // participant out of fullscreen from the very first frame). Its
    // phase:'start' emission is gone by then, so the recording would silently
    // miss an ongoing violation.
    const h = withFriction('<div id="stage"><p>clean</p></div>', {},
      { ongoing: { in_violation: true, current_reason: 'not_fullscreen' } });
    const entry = h.rec.getState().guardViolations[0];
    assert.ok(entry, 'an in-progress violation must be synthesized at subscribe');
    assert.equal(entry.reason, 'not_fullscreen');
    assert.equal(entry.phase, 'start');
    assert.equal(entry.synthesized_at_subscribe, true);
    assert.deepEqual(h.events(), [], 'still not an event (spec §5.8)');
  });

  it('the synthesized snapshot is NOT called pre_scramble_dom', () => {
    // The name is the whole point. In enforcement mode the page may already be
    // scrambled by subscribe time, so this tree is "whatever the DOM looks like
    // now" — an analyst reading it as what the participant saw before the
    // violation would be reading scrambled content as evidence.
    const h = withFriction('<div id="stage"><p>clean</p></div>', {},
      { ongoing: { in_violation: true, current_reason: 'not_fullscreen' } });
    const entry = h.rec.getState().guardViolations[0];
    assert.equal('pre_scramble_dom' in entry, false);
    assert.equal(entry.dom_at_subscribe.tag, 'div');
    assert.equal(entry.dom_at_subscribe.children[0].children[0].text, 'clean');
    assert.equal(entry.dom_at_subscribe.id, 1, 'its own throwaway span, like the live path');
  });

  it('an unknown ongoing reason still records the violation', () => {
    const h = withFriction('<div id="stage"></div>', {},
      { ongoing: { in_violation: true } });
    assert.equal(h.rec.getState().guardViolations[0].reason, 'unknown');
  });

  it('does not even ASK friction for its state before the session starts', () => {
    // attachDomCapture is only ever called after startSession by the assembly;
    // the gate makes that self-evident here, so no future wiring change can
    // route a synthesized entry through a pre-session recorder.
    //
    // Asserting the empty result would not pin THIS gate: `pushGuardViolation`
    // refuses outside the recording window too (recorder.test.js pins that
    // separately), so the outcome holds with either guard alone. The call
    // counter is what makes the capture-side gate individually observable.
    const h = withFriction('<div id="stage"><p>clean</p></div>', {},
      { ongoing: { in_violation: true, current_reason: 'not_fullscreen' }, beforeSession: true });
    assert.deepEqual(h.stateReads, [], 'the gate short-circuits before the state read');
    assert.deepEqual(h.rec.getState().guardViolations, []);
  });

  it('non-start phases carry duration and no snapshot', () => {
    const h = withFriction('<div id="stage"></div>');
    h.violate({ phase: 'end', reason: 'not_fullscreen', duration: 1200 });
    assert.deepEqual(h.rec.getState().guardViolations[0].duration_ms, 1200);
    assert.equal('pre_scramble_dom' in h.rec.getState().guardViolations[0], false);
  });
});

describe('keyframe cadence — the trigger (spec §3)', () => {
  // The decision itself, at exact boundaries a scripted DOM cannot hit on
  // purpose. `state` is the cadence bookkeeping capture-dom keeps; the second
  // argument is the configured segment fallback.
  const at = (over) => Object.assign(
    { hasKeyframe: true, segments: 1, patchChars: 0, lastSnapshotChars: 1000 }, over);

  it('forces a keyframe while the span has none — whatever the counters say', () => {
    // Spec §3: the first DOM-bearing segment MUST be a keyframe, and after a
    // dropped one there is nothing for a continuation to continue from.
    assert.equal(shouldKeyframe(at({ hasKeyframe: false, segments: 0 }), 10), true);
    assert.equal(shouldKeyframe(
      at({ hasKeyframe: false, patchChars: 0, lastSnapshotChars: 0 }), null), true);
  });

  it('takes a keyframe when the patches since the last one RIVAL its size', () => {
    // The spec's self-tuning rule: at parity the keyframe is free in file size
    // and resets both seek distance and corruption blast radius. The comparison
    // is >=, so the boundary itself keyframes.
    assert.equal(shouldKeyframe(at({ patchChars: 999 }), null), false);
    assert.equal(shouldKeyframe(at({ patchChars: 1000 }), null), true);
    assert.equal(shouldKeyframe(at({ patchChars: 1001 }), null), true);
  });

  it('never fires the size trigger off a keyframe of unknown size', () => {
    // lastSnapshotChars is 0 only when no keyframe was measured (trace-tier
    // wiring, a dropped one). Comparing against 0 would make every segment a
    // keyframe on a technicality rather than because anything accumulated.
    assert.equal(shouldKeyframe(at({ patchChars: 0, lastSnapshotChars: 0 }), null), false);
  });

  it('the segment fallback bounds the span at keyframeEvery segments', () => {
    // keyframeEvery: 10 = one keyframe plus at most nine continuations, so the
    // tenth segment of a span is the next keyframe.
    assert.equal(shouldKeyframe(at({ segments: 9 }), 10), false);
    assert.equal(shouldKeyframe(at({ segments: 10 }), 10), true);
    assert.equal(shouldKeyframe(at({ segments: 11 }), 10), true);
    assert.equal(shouldKeyframe(at({ segments: 1 }), 1), true, 'every segment');
  });

  it('a keyframeEvery of the wrong TYPE is refused, once, out loud', () => {
    // `"10"` is the shape a config read from JSON or a URL parameter takes, and
    // coercing it would be the friendlier-looking choice. It is refused instead,
    // because a wrong type must not silently become a different cadence: the
    // researcher would get a differently shaped file with no other symptom.
    const warnings = [];
    const orig = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      const h = harness('<div id="stage"><p>a</p></div>',
        { root: '#stage', keyframeEvery: '10' });
      h.rec.startTrial({ trialId: 't1' });
      h.rec.endTrial();
      h.rec.startTrial({ trialId: 't2' });
      assert.equal(h.trial(1).initialDom, null,
        'the string disabled the fallback, which is what the warning says happened');
    } finally { console.warn = orig; }
    assert.equal(warnings.filter(w => /keyframeEvery/.test(w)).length, 1,
      'said once, at attach, not once per segment');
  });

  it('a null or nonsensical keyframeEvery leaves only the size trigger', () => {
    assert.equal(shouldKeyframe(at({ segments: 500 }), null), false);
    assert.equal(shouldKeyframe(at({ segments: 500 }), 0), false);
    assert.equal(shouldKeyframe(at({ segments: 500 }), -3), false);
    assert.equal(shouldKeyframe(at({ segments: 500, patchChars: 1000 }), null), true);
  });
});

describe('keyframe cadence — continuations end to end (spec §3)', () => {
  it('the first segment is a keyframe even when nothing else would ask for one', () => {
    const h = harness('<div id="stage"><p>a</p></div>',
      { root: '#stage', keyframeEvery: null });
    h.rec.startTrial({ trialId: 't1' });
    assert.ok(h.trial(0).initialDom, 'a recording cannot open on a continuation');
  });

  it('a continuation carries no keyframe and no seed', () => {
    const h = harness('<div id="stage"><input id="answer"></div>',
      { root: '#stage', keyframeEvery: 10 });
    h.doc.getElementById('answer').value = 'typed';
    h.rec.startTrial({ trialId: 't1' });
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });

    assert.ok(h.trial(0).initialState, 'the keyframe seeds the typed value');
    assert.equal(h.trial(1).initialDom, null, 'initial_dom null IS the continuation marker');
    assert.equal(h.trial(1).initialState, null,
      'seeding a continuation would re-state what the span already established');
  });

  it('a continuation does NOT reset the span: keyframe ids stay addressable', () => {
    // The whole point of a continuation. A node the keyframe numbered must
    // still be nameable by that id in a patch emitted a segment later.
    const h = harness('<div id="stage"><p id="msg">a</p></div>',
      { root: '#stage', keyframeEvery: 10 });
    h.rec.startTrial({ trialId: 't1' });
    const msgId = h.trial(0).initialDom.children[0].id;
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });

    h.doc.getElementById('msg').setAttribute('class', 'lit');
    h.doc.getElementById('msg').firstChild.data = 'b';
    h.flush();

    assert.deepEqual(h.trial(1).events.map(e => [e.type, e.node]),
      [['dom.attr', msgId], ['dom.text', h.trial(0).initialDom.children[0].children[0].id]]);
  });

  it('a mid-continuation insertion continues the numbering rather than restarting it', () => {
    const h = harness('<div id="stage"><p>a</p></div>',
      { root: '#stage', keyframeEvery: 10 });
    h.rec.startTrial({ trialId: 't1' });
    const keyframeIds = [];
    (function walk(n) { keyframeIds.push(n.id); (n.children || []).forEach(walk); })(
      h.trial(0).initialDom);
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });

    h.root().appendChild(h.doc.createElement('span'));
    h.flush();
    const added = h.trial(1).events[0];
    assert.equal(added.type, 'dom.add');
    assert.ok(!keyframeIds.includes(added.node.id),
      'a continuation allocates fresh ids from where the keyframe stopped');
    assert.equal(added.parent, keyframeIds[0], 'and names the keyframe root as parent');
  });

  it('the segment fallback keyframes every Nth segment, and ids restart there', () => {
    const h = harness('<div id="stage"><p>a</p></div>',
      { root: '#stage', keyframeEvery: 3 });
    for (let i = 0; i < 7; i++) {
      h.rec.startTrial({ trialId: 't' + i });
      h.rec.endTrial();
    }
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6].map(i => !!h.trial(i).initialDom),
      [true, false, false, true, false, false, true]);
    assert.equal(h.trial(3).initialDom.id, 1, 'the new span numbers from 1 again');
  });

  it('a patch volume that stays under the keyframe size keeps the span going', () => {
    const h = harness(
      '<div id="stage"><p id="msg">' + 'a stimulus sentence. '.repeat(40) + '</p></div>',
      { root: '#stage', keyframeEvery: null });
    h.rec.startTrial({ trialId: 't1' });
    const snapshotChars = JSON.stringify(h.trial(0).initialDom).length;

    h.doc.getElementById('msg').setAttribute('class', 'lit');
    h.flush();
    const emitted = JSON.stringify(h.trial(0).events).length;
    assert.ok(emitted < snapshotChars, 'the fixture must stay under the threshold to test it');

    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });
    assert.equal(h.trial(1).initialDom, null, 'one small patch does not earn a keyframe');
  });

  it('a patch volume that reaches the keyframe size earns a fresh one', () => {
    // Text rewrites of a CONSTANT length, so the tree the next keyframe walks
    // is the same size as the one before it. An append-only fixture cannot test
    // the accumulator: each patch also grows the snapshot it is measured
    // against, so a keyframe that forgot to zero the counter would still look
    // right at the segment after.
    const h = harness('<div id="stage"><p id="msg">' + 'x'.repeat(60) + '</p></div>',
      { root: '#stage', keyframeEvery: null });
    h.rec.startTrial({ trialId: 't1' });
    const snapshotChars = JSON.stringify(h.trial(0).initialDom).length;

    // Rewrite until the emitted patches rival the snapshot. Measured off the
    // recorded events, so the test asserts the crossing rather than assuming it.
    let emitted = 0;
    for (let i = 0; emitted < snapshotChars && i < 200; i++) {
      h.doc.getElementById('msg').firstChild.data = String.fromCharCode(97 + i % 26).repeat(60);
      h.flush();
      emitted = JSON.stringify(h.trial(0).events).length;
    }
    assert.ok(emitted >= snapshotChars, 'the loop must actually cross the threshold');

    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });
    assert.ok(h.trial(1).initialDom, 'accumulated patches rivalling the snapshot keyframe');
    assert.equal(h.trial(1).initialDom.id, 1);
    assert.ok(Math.abs(JSON.stringify(h.trial(1).initialDom).length - snapshotChars) < 10,
      'the second keyframe is the same size as the first — nothing grew');

    // …and the counter starts over with it: the next segment continues again.
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't3' });
    assert.equal(h.trial(2).initialDom, null,
      'the accumulator resets with the keyframe, or every later segment keyframes');
  });

  it('a DROPPED keyframe forces the next segment to try again', () => {
    // The drop resets the span, so the file has no tree for it. §3's first
    // rule applies again from here: continuing would leave the recording in a
    // dead zone with no keyframe until the cadence happened to ask for one.
    //
    // The case that discriminates is a drop AFTER a keyframe has landed — the
    // first segment of a recording is forced regardless, so a drop there proves
    // nothing about the recovery.
    const h = harness('<div id="stage"><p>a</p></div>',
      { root: '#stage', keyframeEvery: 10, maxCharsPerTrial: 400 });
    h.rec.startTrial({ trialId: 't1' });
    assert.ok(h.trial(0).initialDom, 'the first keyframe fits and lands');

    // Grow the DOM past the cap. The insertion also rivals the (small) keyframe
    // it was measured against, so the size trigger asks for a fresh one at t2 —
    // and that one no longer fits.
    const big = h.doc.createElement('div');
    big.textContent = 'z'.repeat(500);
    h.root().appendChild(big);
    h.flush();

    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });
    assert.equal(h.trial(1).initialDom, null, 'dropped: over the character budget');

    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't3' });
    assert.equal(h.trial(2).initialDom, null, 'still over budget');
    assert.equal(
      h.rec.getState().captureFailures.filter(f => f.channel === 'dom_snapshot').length, 2,
      'every segment tries again: a span with no keyframe never merely continues');

    // …and it recovers the moment a keyframe fits.
    h.rec.config.maxCharsPerTrial = 100000;
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't4' });
    assert.ok(h.trial(3).initialDom, 'the span still owed the file a keyframe');
    assert.equal(h.trial(3).initialDom.id, 1);
  });

  it('a batch that arrives with no trial open never lands beside a fresh keyframe', () => {
    // THE C-1 REPRODUCTION. An implicit segment is opened RE-ENTRANTLY from
    // inside pushRecord, by a capture path that has ALREADY resolved its ids
    // against the current span. A keyframe here resets that span, so the
    // records still in flight name a numbering the file no longer describes —
    // and because a fresh pre-order walk reuses the same small integers, they
    // do not dangle harmlessly: they resolve to DIFFERENT nodes.
    const h = harness('<div id="stage"><p id="msg">a</p></div>',
      { root: '#stage', keyframeEvery: 1 });
    h.rec.startTrial({ trialId: 't1' });
    const spanIds = [];
    (function walk(n) { spanIds.push(n.id); (n.children || []).forEach(walk); })(
      h.trial(0).initialDom);

    // A mid-span insertion, so the span's numbering diverges from a fresh walk
    // of the same tree — without this the collision is benign by coincidence.
    const extra = h.doc.createElement('b');
    extra.id = 'extra';
    h.root().appendChild(extra);
    h.flush();
    for (const e of h.trial(0).events) if (e.type === 'dom.add') spanIds.push(e.node.id);

    h.rec.endTrial();                       // no trial open from here
    h.doc.getElementById('msg').remove();
    h.doc.getElementById('extra').setAttribute('class', 'lit');
    h.flush();                              // maps, then pushes → implicit segment

    const implicit = h.trial(1);
    assert.equal(implicit.implicit, true, 'the fixture must produce an implicit segment');
    assert.equal(implicit.initialDom, null,
      'an implicit segment continues the span its in-flight ids came from');
    const patches = implicit.events.filter(e => e.type.startsWith('dom.'));
    assert.equal(patches.length, 2);
    for (const p of patches) {
      assert.ok(spanIds.includes(p.node),
        `patch ${p.type} names ${p.node}, which this span never issued`);
    }

    // …and the player agrees. A conforming player re-instantiates at a keyframe
    // and carries on through a continuation; either way the element it deletes
    // must be the element the page removed.
    let player = null;
    for (const t of [h.trial(0), h.trial(1)]) {
      if (t.initialDom) player = createPlayer(t.initialDom);
      player.apply(t.events.filter(e => e.type.startsWith('dom.')));
    }
    assert.deepEqual(
      Array.from(player.root.childNodes).map(n => n.tagName.toLowerCase()), ['b'],
      'the player kept #extra and dropped #msg, which is what the page did');
  });

  it('an implicit FIRST segment still keyframes (spec §3)', () => {
    // The exception to the rule above, and it is required: a continuation
    // before any keyframe is a §3 violation the strict validator rejects. It
    // is also safe — with no keyframe the span holds nothing, so no id in
    // flight can be stale (a mapped batch produces no events at all, and a
    // trace event's target already resolves to null).
    const h = harness('<div id="stage"><p id="msg">a</p></div>',
      { root: '#stage', keyframeEvery: 10 });
    h.rec.pushRecord({ type: 'mouse.move', x: 1, y: 2 }, 5000);
    assert.equal(h.trial(0).implicit, true);
    assert.ok(h.trial(0).initialDom, 'a recording cannot open on a continuation');
  });

  it('a THROWING keyframe forces the next segment to try again', () => {
    const h = harness('<div id="stage"><p>a</p></div>',
      { root: '#stage', keyframeEvery: 2 });
    h.rec.startTrial({ trialId: 't1' });
    assert.ok(h.trial(0).initialDom, 'lands');
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't2' });          // continuation
    assert.equal(h.trial(1).initialDom, null);

    let boom = false;
    Object.defineProperty(h.root(), 'childNodes', {
      get() { if (boom) throw new Error('boom'); return []; }, configurable: true,
    });
    boom = true;
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't3' });          // the fallback's keyframe: throws
    h.rec.endTrial();
    h.rec.startTrial({ trialId: 't4' });          // must try again, not continue
    assert.equal(
      h.rec.getState().captureFailures.filter(f => f.channel === 'dom_snapshot').length, 2,
      'a failed keyframe is not a continuation');
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

// ── cross-origin sheet inlining (2026-09-03) ────────────────────────────────
// A cross-origin <link> is href-only after captureStylesheets (the browser
// refuses cssRules). A fresh CORS fetch of the same URL is a different
// operation the server may permit (jsdelivr does), so the text can still be
// inlined at capture time and the recording becomes self-contained.
describe('fillCrossOriginSheets', () => {
  const linkSheet = (href, css = null) => ({ id: 1, kind: 'link', href, css, media: null });
  const okFetch = (text) => async () => ({ ok: true, status: 200, text: async () => text });

  it('fills css on an href-only link sheet from a successful CORS fetch, in place', async () => {
    const sheets = [linkSheet('https://cdn.example/jspsych.css')];
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return okFetch('.a{}')(); };
    await fillCrossOriginSheets(sheets, fetchImpl);
    assert.equal(sheets[0].css, '.a{}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://cdn.example/jspsych.css');
    assert.equal(calls[0].init.mode, 'cors');
    assert.equal(calls[0].init.credentials, 'omit', 'never send cookies for a stylesheet');
  });

  it('leaves css null when the fetch rejects or is not 2xx', async () => {
    const a = [linkSheet('https://cdn.example/a.css')];
    await fillCrossOriginSheets(a, async () => { throw new Error('CORS'); });
    assert.equal(a[0].css, null);
    const b = [linkSheet('https://cdn.example/b.css')];
    await fillCrossOriginSheets(b, async () => ({ ok: false, status: 404, text: async () => 'nope' }));
    assert.equal(b[0].css, null);
  });

  it('touches only href-only http(s) link sheets', async () => {
    const sheets = [
      { id: 1, kind: 'inline', css: '.i{}', media: null },
      linkSheet('https://cdn.example/read.css', '.already{}'),
      linkSheet('blob:https://x/abc'),
      linkSheet('https://cdn.example/need.css'),
    ];
    const urls = [];
    await fillCrossOriginSheets(sheets, async (u) => { urls.push(u); return okFetch('.n{}')(); });
    assert.deepEqual(urls, ['https://cdn.example/need.css']);
    assert.equal(sheets[0].css, '.i{}');
    assert.equal(sheets[1].css, '.already{}');
    assert.equal(sheets[2].css, null);
    assert.equal(sheets[3].css, '.n{}');
  });

  it('never throws to the caller and does nothing without a fetch', async () => {
    const sheets = [linkSheet('https://cdn.example/x.css')];
    await fillCrossOriginSheets(sheets, undefined);
    assert.equal(sheets[0].css, null);
  });
});
