// tests/replay/initial-state.test.js
// Keyframe replay-state seeds (spec §3 `initial_state`) and the scrolled-element
// tracker that feeds them.
//
// happy-dom rather than duck-typed fixtures, for the same reason as
// snapshot.test.js: this module reads IDL state the DOM defines — `value` vs
// `defaultValue`, `checked` vs `defaultChecked`, option selectedness,
// `isConnected`, `scrollTop` — and a hand-rolled fake would be free to agree
// with the implementation about every one of them.
//
// The tracker tests keep the injected-fake harness of capture-trace.test.js
// (that suite is untouched by Task 4) but use REAL elements as scroll targets,
// since connectedness is half of what the tracker has to get right.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import { buildInitialState } from '../../src/replay/initial-state.js';
import { serializeTree } from '../../src/replay/snapshot.js';
import { createSpan } from '../../src/replay/span.js';
import { markRedacted } from '../../src/replay/redaction.js';
import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const canonical = JSON.parse(
  readFileSync(join(HERE, 'schema-v2', 'fixtures', 'canonical-core.json'), 'utf8'));

// One-line HTML only: the parser keeps inter-tag whitespace as real text nodes,
// which get ids and shift the numbering.
function build(html, url = 'https://example.org/exp/') {
  const win = new Window({ url });
  win.document.body.innerHTML = html;
  return { win, doc: win.document, root: win.document.body.firstElementChild };
}

// The normal capture sequence: a keyframe walk numbers and emits the tree,
// THEN the state seed is taken against the same span.
function keyframe(root, opts = {}) {
  const span = createSpan();
  const tree = serializeTree(root, span, opts);
  return { span, tree };
}

const SENTINEL = 'zzq-sentinel-9137';

describe('buildInitialState — spec §3 shape', () => {
  it('reproduces the canonical-core segment-2 initial_state exactly', () => {
    // The machine check that CH speaks the contract: the fixture's form
    // segment, rebuilt as live DOM, must produce the fixture's seed — node
    // ids included, and with the password field absent (spec §8 floor).
    const { root, doc } = build(
      '<div id="stage"><form>' +
      '<input id="answer" type="text"><input id="secret" type="password">' +
      '</form></div>');
    doc.getElementById('answer').value = 'ab';
    doc.getElementById('secret').value = SENTINEL;
    const { span, tree } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 120 } });

    assert.deepStrictEqual(tree, canonical.segments[2].initial_dom);
    assert.deepStrictEqual(state, canonical.segments[2].initial_state);
  });

  it('carries all four keys whenever it emits anything', () => {
    // The spec interface types all four as required; only the whole object is
    // optional. A seed that omitted its empty arrays would make consumers
    // guess whether "absent" means "none" or "not captured".
    const { root } = build('<div id="stage"><p>x</p></div>');
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 3, scrollY: 4 } });

    assert.deepStrictEqual(Object.keys(state).sort(),
      ['element_scroll', 'form', 'media', 'scroll']);
    assert.deepStrictEqual(state.scroll, { x: 3, y: 4 });
  });

  it('rounds window offsets to integers', () => {
    const { root } = build('<div id="stage"></div>');
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 10.4, scrollY: 120.6 } });

    assert.deepStrictEqual(state.scroll, { x: 10, y: 121 });
  });
});

describe('buildInitialState — all-default omission', () => {
  it('returns null when nothing is off its default', () => {
    const { root } = build(
      '<div id="stage"><input id="a" type="text"><video id="v" src="a.mp4"></video>' +
      '<div id="sc">deep</div></div>');
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 },
      scrolled: new Set([root.querySelector('#sc')]),   // tracked, but at 0/0
    });

    assert.strictEqual(state, null);
  });

  it('emits as soon as one field is non-default (form only, scroll at origin)', () => {
    const { root, doc } = build('<div id="stage"><input id="a" type="text"></div>');
    doc.getElementById('a').value = 'typed';
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.deepStrictEqual(state, {
      scroll: { x: 0, y: 0 }, element_scroll: [], media: [],
      form: [{ node: 2, value: 'typed' }],
    });
  });

  it('treats a missing window as scroll at the origin', () => {
    const { root } = build('<div id="stage"></div>');
    const { span } = keyframe(root);

    assert.strictEqual(buildInitialState(root, span, { win: null }), null);
  });
});

describe('buildInitialState — element_scroll', () => {
  it('seeds current offsets and registry ids for tracked scrollers', () => {
    const { root, doc } = build(
      '<div id="stage"><div id="list">a</div><div id="pane">b</div></div>');
    const list = doc.getElementById('list');
    const pane = doc.getElementById('pane');
    list.scrollTop = 40; list.scrollLeft = 5;
    pane.scrollTop = 12;
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, scrolled: new Set([list, pane]),
    });

    assert.deepStrictEqual(state.element_scroll, [
      { node: span.registry.peekId(list), x: 5, y: 40 },
      { node: span.registry.peekId(pane), x: 0, y: 12 },
    ]);
  });

  it('skips a tracked element that has scrolled back to the origin', () => {
    // The reconstructed DOM starts at 0/0, so a 0/0 entry seeds nothing —
    // same reasoning as the whole-object default omission.
    const { root, doc } = build('<div id="stage"><div id="list">a</div></div>');
    const list = doc.getElementById('list');
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 9 }, scrolled: new Set([list]),
    });

    assert.deepStrictEqual(state.element_scroll, []);
  });

  it('skips an element that has left the document', () => {
    // Handled by the same seedable-ness rule as the cases below: a removed
    // element is no longer a descendant of the observed root, so the file does
    // not contain it. (Keeping the tracker's Set from growing is a separate
    // job, pinned in the tracker tests.)
    const { root, doc } = build(
      '<div id="stage"><div id="list">a</div><div id="pane">b</div></div>');
    const list = doc.getElementById('list');
    const pane = doc.getElementById('pane');
    list.scrollTop = 40; pane.scrollTop = 12;
    const { span } = keyframe(root);
    list.remove();

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, scrolled: new Set([list, pane]),
    });

    assert.deepStrictEqual(state.element_scroll,
      [{ node: span.registry.peekId(pane), x: 0, y: 12 }]);
  });

  it('skips an element outside the observed root', () => {
    // The tracker listens at the window, so it sees scrollers the snapshot
    // never covered. An id for one of them would name nothing in the player.
    const { root, doc } = build(
      '<div id="stage"><p>in</p></div><div id="outside">out</div>');
    const outside = doc.getElementById('outside');
    outside.scrollTop = 30;
    const { span } = keyframe(root);

    // Non-zero window scroll so the seed survives the all-default omission and
    // the assertion is about element_scroll rather than about the whole object.
    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 9 }, scrolled: new Set([outside]),
    });

    assert.strictEqual(span.registry.peekId(outside), null);
    assert.deepStrictEqual(state.element_scroll, []);
  });

  it('skips a scroller hidden behind an exclusion placeholder', () => {
    // Numbered (assignTree is unconditional) but not in the file: seeding its
    // scroll would address a node the player never received.
    const { root, doc } = build(
      '<div id="stage"><div data-record-exclude><div id="inner">deep</div></div></div>');
    const inner = doc.getElementById('inner');
    inner.scrollTop = 25;
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 9 }, scrolled: new Set([inner]),
    });

    assert.notStrictEqual(span.registry.peekId(inner), null, 'numbered');
    assert.deepStrictEqual(state.element_scroll, [], 'but not emitted');
  });

  it('skips a scroller inside a redacted subtree', () => {
    // §3 gives element_scroll no redacted variant: the entry is nothing but a
    // node reference plus offsets, and §8 keeps redacted targets unidentified.
    const { root, doc } = build(
      '<div id="stage"><div data-ch-redact><div id="inner">deep</div></div></div>');
    const inner = doc.getElementById('inner');
    inner.scrollTop = 25;
    const { span } = keyframe(root, { redactSelector: '[data-ch-redact]' });

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 9 }, scrolled: new Set([inner]),
      redactSelector: '[data-ch-redact]',
    });

    assert.deepStrictEqual(state.element_scroll, []);
  });

  it('agrees with the span delivery model about what the file holds', () => {
    // Two independent answers to "is this node in the file" would eventually
    // disagree; this pins them together across the interesting shapes.
    const { root, doc } = build(
      '<div id="stage"><div id="ok">a</div><script>x()</script>' +
      '<div data-record-exclude><div id="hidden">b</div></div>' +
      '<iframe><div id="framed">c</div></iframe></div>');
    const nodes = ['ok', 'hidden', 'framed'].map(id => doc.getElementById(id))
      .filter(Boolean);
    nodes.forEach((n) => { n.scrollTop = 15; });
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, scrolled: new Set(nodes),
    });

    const seeded = new Set(state ? state.element_scroll.map(e => e.node) : []);
    for (const node of nodes) {
      assert.strictEqual(seeded.has(span.registry.peekId(node)),
        span.delivery.holds(node), 'disagreement for ' + node.id);
    }
  });
});

describe('buildInitialState — media', () => {
  it('seeds current_time and paused per media element', () => {
    const { root, doc } = build(
      '<div id="stage"><video id="v" src="a.mp4"></video><audio id="a" src="b.mp3"></audio></div>');
    const v = doc.getElementById('v');
    v.currentTime = 12.3456;
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.deepStrictEqual(state.media,
      [{ node: span.registry.peekId(v), current_time: 12.346, paused: true }]);
  });

  it('skips media at its default position', () => {
    const { root } = build('<div id="stage"><video id="v" src="a.mp4"></video></div>');
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.strictEqual(state, null);
  });

  it('seeds a playing element even at position zero', () => {
    const { root, doc } = build('<div id="stage"><video id="v" src="a.mp4"></video></div>');
    const v = doc.getElementById('v');
    Object.defineProperty(v, 'paused', { value: false, configurable: true });
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.deepStrictEqual(state.media,
      [{ node: span.registry.peekId(v), current_time: 0, paused: false }]);
  });

  it('skips media inside a redacted subtree', () => {
    const { root, doc } = build(
      '<div id="stage"><div data-ch-redact><video id="v" src="a.mp4"></video></div></div>');
    doc.getElementById('v').currentTime = 5;
    const { span } = keyframe(root, { redactSelector: '[data-ch-redact]' });

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, redactSelector: '[data-ch-redact]',
    });

    assert.strictEqual(state, null);
  });
});

describe('buildInitialState — form', () => {
  it('seeds only the controls whose IDL state diverges from the reconstructed DOM', () => {
    // The keyframe tree already carries the `value`/`checked` ATTRIBUTES, so a
    // control still at its default needs no seed; what the tree cannot carry is
    // the IDL state a participant changed.
    const { root, doc } = build(
      '<div id="stage">' +
      '<input id="untouched" type="text" value="seed">' +
      '<input id="typed" type="text" value="seed">' +
      '<textarea id="notes">preset</textarea>' +
      '<input id="box" type="checkbox">' +
      '<input id="preboxed" type="checkbox" checked>' +
      '</div>');
    doc.getElementById('typed').value = 'edited';
    doc.getElementById('notes').value = 'rewritten';
    doc.getElementById('box').checked = true;
    const { span } = keyframe(root);
    const id = (n) => span.registry.peekId(doc.getElementById(n));

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.deepStrictEqual(state.form, [
      { node: id('typed'), value: 'edited' },
      { node: id('notes'), value: 'rewritten' },
      { node: id('box'), checked: true },
    ]);
  });

  it('seeds select state as an array of selected values', () => {
    const { root, doc } = build(
      '<div id="stage">' +
      '<select id="single"><option value="one">1</option><option value="two">2</option></select>' +
      '<select id="untouched"><option value="a">a</option><option value="b">b</option></select>' +
      '<select id="multi" multiple><option value="p">p</option><option value="q">q</option></select>' +
      '</div>');
    doc.getElementById('single').options[1].selected = true;
    doc.getElementById('multi').options[0].selected = true;
    doc.getElementById('multi').options[1].selected = true;
    const { span } = keyframe(root);
    const id = (n) => span.registry.peekId(doc.getElementById(n));

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.deepStrictEqual(state.form, [
      { node: id('single'), selected: ['two'] },
      { node: id('multi'), selected: ['p', 'q'] },
    ]);
  });

  it('never records a password value, with or without a redaction selector', () => {
    const { root, doc } = build(
      '<div id="stage"><input id="pw" type="password"></div>');
    doc.getElementById('pw').value = SENTINEL;
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.strictEqual(state, null);
  });

  it('never records a file input', () => {
    // Spec §13: file names and contents are never recorded, and browsers hand
    // out a fake path here rather than an empty string.
    const { root, doc } = build('<div id="stage"><input id="f" type="file"></div>');
    const f = doc.getElementById('f');
    Object.defineProperty(f, 'value', { value: 'C:\\fakepath\\' + SENTINEL, configurable: true });
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.strictEqual(state, null);
  });

  it('skips controls inside a redaction-selector subtree', () => {
    const { root, doc } = build(
      '<div id="stage"><div data-ch-redact><textarea id="notes"></textarea></div>' +
      '<input id="open" type="text"></div>');
    doc.getElementById('notes').value = SENTINEL;
    doc.getElementById('open').value = 'visible';
    const { span } = keyframe(root, { redactSelector: '[data-ch-redact]' });

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, redactSelector: '[data-ch-redact]',
    });

    assert.deepStrictEqual(state.form,
      [{ node: span.registry.peekId(doc.getElementById('open')), value: 'visible' }]);
  });

  it('skips a control whose content this recording has already withheld', () => {
    // The taint set (redaction.js): a field that spent part of the session
    // inside a redacted container stays withheld after it is moved out.
    const { root, doc } = build('<div id="stage"><input id="moved" type="text"></div>');
    const moved = doc.getElementById('moved');
    moved.value = SENTINEL;
    const taint = new WeakSet();
    markRedacted(moved, taint);
    const { span } = keyframe(root, { taint });

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, taint,
    });

    assert.strictEqual(state, null);
  });

  it('skips a control behind an exclusion placeholder', () => {
    const { root, doc } = build(
      '<div id="stage"><div data-record-exclude><input id="bait" type="text"></div></div>');
    doc.getElementById('bait').value = SENTINEL;
    const { span } = keyframe(root);

    const state = buildInitialState(root, span, { win: { scrollX: 0, scrollY: 0 } });

    assert.strictEqual(state, null);
  });
});

describe('buildInitialState — redaction leak scan (spec §8)', () => {
  it('puts no redacted content anywhere in the emitted seed', () => {
    const taint = new WeakSet();
    const { root, doc } = build(
      '<div id="stage">' +
      '<input id="pw" type="password">' +
      '<div data-ch-redact><textarea id="notes"></textarea><input id="inner" type="text"></div>' +
      '<div data-record-exclude><input id="bait" type="text"></div>' +
      '<input id="tainted" type="text">' +
      '<input id="open" type="text">' +
      '</div>');
    for (const id of ['pw', 'notes', 'inner', 'bait', 'tainted']) {
      doc.getElementById(id).value = SENTINEL + '-' + id;
    }
    doc.getElementById('open').value = 'kept';
    markRedacted(doc.getElementById('tainted'), taint);
    const { span } = keyframe(root, { redactSelector: '[data-ch-redact]', taint });

    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, redactSelector: '[data-ch-redact]', taint,
    });

    const json = JSON.stringify(state);
    assert.strictEqual(json.includes(SENTINEL), false, 'sentinel leaked: ' + json);
    assert.strictEqual(state.form.length, 1, 'only the open field is seeded');
    assert.strictEqual(state.form[0].value, 'kept');
  });
});

// ── scrolled-element tracker (capture-trace.js) ────────────────────────────

// The capture-trace harness of capture-trace.test.js: fake doc/win targets and
// manual clocks, so no browser is involved in the listener wiring.
function fakeTarget() {
  return {
    handlers: {},
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    removeEventListener(ev) { delete this.handlers[ev]; },
    fire(ev, obj) { if (this.handlers[ev]) this.handlers[ev](obj || {}); },
  };
}

function traceHarness(configOverrides) {
  globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };
  const rec = createRecorder({ participantId: 'P1', ...configOverrides });
  const doc = fakeTarget();
  const win = fakeTarget();
  win.scrollX = 0; win.scrollY = 0;
  let t = 1000;
  const rafQueue = [];
  const env = {
    doc, win,
    now: () => t,
    raf: (fn) => { rafQueue.push(fn); },
    advance: (ms) => { t += ms; },
    flushRaf: () => { const q = rafQueue.splice(0); q.forEach(f => f()); },
  };
  rec.startSession();
  const trace = attachTraceCapture(rec, env);
  const events = () => rec.getState().trials.flatMap(tr => tr.events);
  return { rec, doc, win, env, events, trace };
}

// Tracked elements BY ID, in Set order. Asserting on the elements themselves
// would be a stronger claim and a much worse test: a failing deep-equal makes
// node inspect two live DOM nodes, which took ~60 s and printed nothing usable
// when this suite's fault injections were verified. Identity is pinned
// separately with `.has()`, which needs no diff.
const trackedIds = (set) => [...set].map(el => el.id);

describe('scrolled-element tracker (capture-trace)', () => {
  it('records every element that scrolls, and no window scroll', () => {
    const { win, env, trace } = traceHarness({});
    const { doc: page } = build('<div id="stage"><div id="a">a</div><div id="b">b</div></div>');
    const a = page.getElementById('a');
    const b = page.getElementById('b');

    win.fire('scroll', { target: a });
    win.fire('scroll', { target: null });          // window scroll
    win.fire('scroll', { target: b });
    env.flushRaf();

    assert.deepStrictEqual(trackedIds(trace.getScrolledElements()), ['a', 'b']);
    assert.ok(trace.getScrolledElements().has(a), 'the live element, not a copy');
  });

  it('keeps its elements across trial boundaries', () => {
    // The Set outlives segments by construction (it belongs to the capture
    // attachment, not the trial): the next keyframe must seed a scroller the
    // participant moved three trials ago.
    const { rec, win, env, trace } = traceHarness({});
    const { doc: page } = build('<div id="stage"><div id="a">a</div><div id="b">b</div></div>');
    const a = page.getElementById('a');
    const b = page.getElementById('b');

    rec.startTrial({ trialId: 't1' });
    win.fire('scroll', { target: a });
    env.flushRaf();
    rec.endTrial();
    rec.startTrial({ trialId: 't2' });
    win.fire('scroll', { target: b });
    env.flushRaf();
    rec.endTrial();

    assert.deepStrictEqual(trackedIds(trace.getScrolledElements()), ['a', 'b']);
  });

  it('drops elements that have left the document', () => {
    // Otherwise the Set is a retention leak: a strong reference to every
    // scrolled element of every trial, for the life of the session.
    const { rec, win, env, trace } = traceHarness({});
    const { doc: page } = build('<div id="stage"><div id="a">a</div><div id="b">b</div></div>');
    const a = page.getElementById('a');
    const b = page.getElementById('b');
    win.fire('scroll', { target: a });
    win.fire('scroll', { target: b });
    env.flushRaf();

    a.remove();

    assert.deepStrictEqual(trackedIds(trace.getScrolledElements()), ['b']);
    rec.startTrial({ trialId: 't2' });
    assert.deepStrictEqual(trackedIds(trace.getScrolledElements()), ['b']);
  });

  it('keeps duck-typed targets that never claim to be disconnected', () => {
    const { win, env, trace } = traceHarness({});
    const fake = { tagName: 'DIV', id: 'fake', scrollTop: 4, scrollLeft: 0 };

    win.fire('scroll', { target: fake });
    env.flushRaf();

    assert.deepStrictEqual(trackedIds(trace.getScrolledElements()), ['fake']);
  });

  it('leaves the v1 scroll events exactly as they were', () => {
    // Task 4 is additive: the tracker rides along on the existing listener and
    // changes nothing on the wire (capture-trace.test.js stays green untouched).
    const { win, env, events } = traceHarness({});
    const { doc: page } = build('<div id="stage"><div id="a">a</div></div>');
    const a = page.getElementById('a');
    a.scrollTop = 40; a.scrollLeft = 5;

    win.scrollX = 0; win.scrollY = 100;
    win.fire('scroll', { target: null });
    win.fire('scroll', { target: a });
    env.flushRaf();

    assert.deepStrictEqual(events().map(e => e.kind), ['scroll', 'scroll']);
    assert.deepStrictEqual(Object.keys(events()[0]).sort(), ['kind', 't', 'x', 'y']);
    assert.deepStrictEqual(
      { x: events()[0].x, y: events()[0].y }, { x: 0, y: 100 });
    assert.deepStrictEqual(Object.keys(events()[1]).sort(),
      ['el', 'id', 'kind', 't', 'x', 'y']);
    assert.deepStrictEqual(
      { el: events()[1].el, id: events()[1].id, x: events()[1].x, y: events()[1].y },
      { el: 'div#a', id: 'a', x: 5, y: 40 });
  });

  it('feeds buildInitialState end to end', () => {
    // The wiring Task 6 will do, done by hand: scroll two elements, take a
    // keyframe, and seed from the tracker's Set.
    const { win, env, trace } = traceHarness({});
    const { root, doc: page } = build(
      '<div id="stage"><div id="a">a</div><div id="b">b</div></div>');
    const a = page.getElementById('a');
    const b = page.getElementById('b');
    a.scrollTop = 40; b.scrollTop = 0;

    win.fire('scroll', { target: a });
    win.fire('scroll', { target: b });
    env.flushRaf();

    const { span } = keyframe(root);
    const state = buildInitialState(root, span, {
      win: { scrollX: 0, scrollY: 0 }, scrolled: trace.getScrolledElements(),
    });

    assert.deepStrictEqual(state, {
      scroll: { x: 0, y: 0 },
      element_scroll: [{ node: span.registry.peekId(a), x: 0, y: 40 }],
      media: [], form: [],
    });
  });
});
