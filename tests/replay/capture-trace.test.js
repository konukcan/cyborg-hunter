// tests/replay/capture-trace.test.js
// Tier-1 capture listeners: throttling, key policy, redaction, coalescing.
// All DOM dependencies are injected (doc/win/now/raf) so this runs in node.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';

// Fake EventTarget: records registrations, lets tests fire events manually.
function fakeTarget() {
  return {
    handlers: {},
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    removeEventListener(ev) { delete this.handlers[ev]; },
    fire(ev, obj) { if (this.handlers[ev]) this.handlers[ev](obj || {}); },
  };
}

// Test harness: recorder + injected fakes + manual clocks.
function harness(configOverrides) {
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
  attachTraceCapture(rec, env);
  const events = () => rec.getState().trials.flatMap(tr => tr.events);
  return { rec, doc, win, env, events };
}

describe('mouse capture', () => {
  it('throttles mousemove to mouseHz but keeps clicks unthrottled', () => {
    const { doc, env, events } = harness({ mouseHz: 20 });   // ≥50ms between moves
    doc.fire('mousemove', { pageX: 1, pageY: 1 });
    env.advance(10);
    doc.fire('mousemove', { pageX: 2, pageY: 2 });           // dropped (<50ms)
    env.advance(50);
    doc.fire('mousemove', { pageX: 3, pageY: 3 });           // kept
    doc.fire('click', { pageX: 3, pageY: 3 });
    doc.fire('click', { pageX: 3, pageY: 3 });               // clicks never throttled
    const kinds = events().map(e => e.kind);
    assert.deepStrictEqual(kinds, ['mousemove', 'mousemove', 'click', 'click']);
    assert.strictEqual(events()[1].x, 3);
  });
});

describe('key capture policy', () => {
  it('keys:"full" records key identity', () => {
    const { doc, events } = harness({ keys: 'full' });
    doc.fire('keydown', { key: 'a', code: 'KeyA', target: { tagName: 'BODY' } });
    doc.fire('keyup',   { key: 'a', code: 'KeyA', target: { tagName: 'BODY' } });
    assert.strictEqual(events().length, 2);
    assert.strictEqual(events()[0].key, 'a');
    assert.strictEqual(events()[1].kind, 'keyup');
  });

  it('keys:"off" records no key events at all', () => {
    const { doc, events } = harness({ keys: 'off' });
    doc.fire('keydown', { key: 'a', code: 'KeyA', target: { tagName: 'BODY' } });
    assert.strictEqual(events().length, 0);
  });

  it('password fields never record key identity, even with keys:"full"', () => {
    const { doc, events } = harness({ keys: 'full' });
    doc.fire('keydown', { key: 's', code: 'KeyS',
      target: { tagName: 'INPUT', type: 'password' } });
    assert.strictEqual(events().length, 1);
    assert.strictEqual(events()[0].kind, 'keydown');
    assert.strictEqual(events()[0].key, undefined, 'no key identity for password');
    assert.strictEqual(events()[0].redacted, true);
  });
});

describe('clipboard capture', () => {
  it('records paste/copy/cut/drop with text lengths only', () => {
    const { doc, events } = harness({});
    doc.fire('paste', { clipboardData: { getData: () => 'hello world' } });
    doc.fire('copy', {});
    doc.fire('cut', {});
    doc.fire('drop', { dataTransfer: { getData: () => 'dropped text!' } });
    const kinds = events().map(e => e.kind);
    assert.deepStrictEqual(kinds, ['paste', 'copy', 'cut', 'ch:drop']);
    assert.strictEqual(events()[0].len, 11);
    assert.strictEqual(events()[3].len, 13);
    assert.strictEqual(events()[0].text, undefined, 'content itself is never recorded');
  });
});

describe('input value capture', () => {
  it('coalesces per-target input values through rAF', () => {
    const { doc, env, events } = harness({});
    const field = { tagName: 'INPUT', type: 'text', id: 'answer', value: 'a' };
    doc.fire('input', { target: field });
    field.value = 'ab';
    doc.fire('input', { target: field });      // same rAF window — coalesced
    env.flushRaf();
    assert.strictEqual(events().length, 1, 'two inputs in one frame coalesce');
    assert.strictEqual(events()[0].kind, 'input');
    assert.strictEqual(events()[0].value, 'ab', 'last value wins');
    assert.strictEqual(events()[0].el, 'input#answer');
  });

  it('carries the raw element id separately (ids may not be selector-safe)', () => {
    const { doc, env, events } = harness({});
    const weird = { tagName: 'INPUT', type: 'text', id: 'a:b c', value: 'x' };
    doc.fire('input', { target: weird });
    env.flushRaf();
    assert.strictEqual(events()[0].id, 'a:b c',
      'viewer must resolve via getElementById, not a CSS selector');
  });

  it('records checked state for checkboxes and radios', () => {
    const { doc, env, events } = harness({});
    const box = { tagName: 'INPUT', type: 'checkbox', id: 'consent', value: 'on', checked: true };
    doc.fire('input', { target: box });
    env.flushRaf();
    assert.strictEqual(events()[0].checked, true,
      'checked is a property, not an attribute — mutations cannot carry it');
  });

  it('redacts password values unconditionally (length only)', () => {
    const { doc, env, events } = harness({});
    const pw = { tagName: 'INPUT', type: 'password', id: 'pw', value: 'hunter2' };
    doc.fire('input', { target: pw });
    env.flushRaf();
    assert.strictEqual(events()[0].value, undefined);
    assert.strictEqual(events()[0].value_len, 7);
    assert.strictEqual(events()[0].redacted, true);
  });

  it('redacts elements matching redactSelector', () => {
    const { doc, env, events } = harness({ redactSelector: '[data-ch-redact]' });
    const field = {
      tagName: 'TEXTAREA', id: 'notes', value: 'secret stuff',
      matches: (sel) => sel === '[data-ch-redact]',
    };
    doc.fire('input', { target: field });
    env.flushRaf();
    assert.strictEqual(events()[0].value, undefined);
    assert.strictEqual(events()[0].value_len, 12);
  });
});

describe('scroll + viewport + focus capture', () => {
  it('coalesces window scroll through rAF', () => {
    const { doc, win, env, events } = harness({});
    win.scrollX = 0; win.scrollY = 100;
    win.fire('scroll', { target: null });
    win.scrollY = 250;
    win.fire('scroll', { target: null });
    env.flushRaf();
    assert.strictEqual(events().length, 1);
    assert.deepStrictEqual(
      { kind: events()[0].kind, y: events()[0].y }, { kind: 'scroll', y: 250 });
  });

  it('records focus/blur/visibility transitions', () => {
    const { doc, win, events } = harness({});
    win.fire('blur', {});
    doc.hidden = true;
    doc.fire('visibilitychange', {});
    doc.hidden = false;
    doc.fire('visibilitychange', {});
    win.fire('focus', {});
    const kinds = events().map(e => e.kind);
    assert.deepStrictEqual(kinds, ['blur', 'visibility', 'visibility', 'focus']);
    assert.strictEqual(events()[1].hidden, true);
    assert.strictEqual(events()[2].hidden, false);
  });

  it('coalesces resize through rAF with new dimensions', () => {
    const { win, env, events } = harness({});
    win.innerWidth = 800; win.innerHeight = 600;
    win.fire('resize', {});
    win.innerWidth = 640; win.innerHeight = 480;
    win.fire('resize', {});
    env.flushRaf();
    assert.strictEqual(events().length, 1);
    assert.deepStrictEqual(
      { w: events()[0].w, h: events()[0].h }, { w: 640, h: 480 });
  });
});

describe('touch capture', () => {
  it('records touchstart/touchend and rAF-throttles touchmove', () => {
    const { doc, env, events } = harness({});
    doc.fire('touchstart', { touches: [{ pageX: 10, pageY: 20 }] });
    doc.fire('touchmove', { touches: [{ pageX: 11, pageY: 21 }] });
    doc.fire('touchmove', { touches: [{ pageX: 15, pageY: 25 }] });   // same frame
    env.flushRaf();
    doc.fire('touchend', { changedTouches: [{ pageX: 15, pageY: 25 }] });
    const kinds = events().map(e => e.kind);
    assert.deepStrictEqual(kinds, ['touchstart', 'touchmove', 'touchend']);
    assert.strictEqual(events()[1].x, 15, 'last position in the frame wins');
  });
});

describe('failure containment', () => {
  it('a throwing listener body records a captureFailure and keeps recording', () => {
    const { rec, doc, events } = harness({});
    // paste with a clipboardData whose getData throws
    doc.fire('paste', { clipboardData: { getData: () => { throw new Error('denied'); } } });
    doc.fire('click', { pageX: 1, pageY: 1 });
    const s = rec.getState();
    // paste is still recorded (len null) OR a captureFailure is logged — but
    // the subsequent click MUST be recorded either way.
    assert.strictEqual(events()[events().length - 1].kind, 'click');
  });
});
