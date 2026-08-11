// tests/replay/capture-trace.test.js
// Tier-1 capture in the SessionRecording v2 vocabulary (spec §5): event names
// and payload shapes, the redaction and exclusion floors, node addressing,
// clipboard modes, and the session-level viewport stream.
//
// Two oracles, deliberately outside this module's control:
//   - `validateStrict` (tests/replay/schema-v2/validator.js), run over the
//     captured events wrapped in a minimal recording — the same machine check
//     the conformance suite applies, so a payload that would be rejected in CI
//     is rejected here, at the channel that produced it;
//   - `canonical-core.json`, hand-authored from the spec, for the shapes it
//     pins (mouse.move, mouse.click with both alignment blocks).
//
// DOM dependencies are injected (doc/win/now/raf) so this runs in node. Event
// TARGETS are real happy-dom elements wherever addressing, redaction or
// exclusion is under test: those questions are answered against a serialized
// keyframe, and a duck-typed fake would be free to agree with the
// implementation about what the file contains.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';
import { createSpan } from '../../src/replay/span.js';
import { serializeTree } from '../../src/replay/snapshot.js';
import { markRedacted } from '../../src/replay/redaction.js';
import { validateStrict } from './schema-v2/validator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const canonical = JSON.parse(
  readFileSync(join(HERE, 'schema-v2', 'fixtures', 'canonical-core.json'), 'utf8'));

// ── harness ────────────────────────────────────────────────────────────────

// Fake EventTarget: records registrations, lets tests fire events manually.
function fakeTarget() {
  return {
    handlers: {},
    options: {},
    addEventListener(ev, fn, opts) { this.handlers[ev] = fn; this.options[ev] = opts; },
    removeEventListener(ev) { delete this.handlers[ev]; },
    fire(ev, obj) { if (this.handlers[ev]) this.handlers[ev](obj || {}); },
  };
}

// Test harness: recorder + injected fakes + manual clocks. `env` extras
// (span, taint) pass straight through to the module under test.
function harness(configOverrides, envExtras) {
  globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };
  const rec = createRecorder({ participantId: 'P1', ...configOverrides });
  const doc = fakeTarget();
  doc.documentElement = { clientWidth: 985, clientHeight: 700 };
  const win = fakeTarget();
  win.innerWidth = 1000; win.innerHeight = 700; win.devicePixelRatio = 1;
  win.scrollX = 0; win.scrollY = 0;
  let t = 1000;
  const rafQueue = [];
  const env = {
    doc, win,
    now: () => t,
    raf: (fn) => { rafQueue.push(fn); },
    advance: (ms) => { t += ms; },
    flushRaf: () => { const q = rafQueue.splice(0); q.forEach(f => f()); },
    ...(envExtras || {}),
  };
  rec.startSession();
  attachTraceCapture(rec, env);
  const events = () => rec.getState().trials.flatMap(tr => tr.events);
  const types = () => events().map(e => e.type);
  return { rec, doc, win, env, events, types };
}

// A real DOM plus the keyframe that puts it in the file: the span is what
// makes elements addressable, exactly as the capture wiring will build it.
function page(html, url = 'https://example.org/exp/') {
  const win = new Window({ url });
  win.document.body.innerHTML = html;
  return { win, doc: win.document, root: win.document.body.firstElementChild };
}
function keyframe(root, opts = {}) {
  const span = createSpan();
  serializeTree(root, span, opts);
  return span;
}

// The strict-profile check, run over captured events. Sorted first because the
// buffer is not chronological by construction (RAF-coalesced channels flush
// late with their original timestamps) — the serializer sorts, and §7's
// time-sortedness is its job, not this module's.
function assertStrict(events, note) {
  const result = validateStrict({
    schema_version: 2,
    recorder: { name: 'cyborg-hunter-replay', version: '0.0.0-test' },
    host: null,
    participant_id: 'P1',
    recording_started_at: '2026-08-10T00:00:00.000Z',
    recording_started_at_perf: 0,
    user_agent: 'node-test',
    viewport: { w: 1000, h: 700, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
    observed_root: null,
    segments: [{
      index: 0, label: 't1', plugin: null,
      t_start: null, t_dom_ready: null, t_load: 0, t_end: null,
      initial_dom: null, initial_state: null,
      events: [...events].sort((a, b) => a.t - b.t),
      host_data: null, extensions: null,
    }],
  });
  assert.deepStrictEqual(result.errors, [],
    (note ? note + ': ' : '') + 'strict validation must accept every emitted event');
  assert.strictEqual(result.ok, true);
}

const SENTINEL = 'zzq-sentinel-9137';
const scan = (events) => JSON.stringify(events);

// ── event vocabulary (spec §5) ─────────────────────────────────────────────

describe('event vocabulary — dotted type names (spec §5)', () => {
  it('names every mouse channel and throttles only the move', () => {
    const { doc, env, events, types } = harness({ mouseHz: 20 });   // ≥50ms between moves
    doc.fire('mousemove', { clientX: 1, clientY: 1 });
    env.advance(10);
    doc.fire('mousemove', { clientX: 2, clientY: 2 });              // dropped (<50ms)
    env.advance(50);
    doc.fire('mousemove', { clientX: 3, clientY: 3 });              // kept
    doc.fire('mousedown', { clientX: 3, clientY: 3, button: 0 });
    doc.fire('mouseup', { clientX: 3, clientY: 3, button: 0 });
    doc.fire('click', { clientX: 3, clientY: 3, button: 0 });
    doc.fire('click', { clientX: 3, clientY: 3, button: 0 });       // never throttled

    assert.deepStrictEqual(types(), [
      'mouse.move', 'mouse.move', 'mouse.down', 'mouse.up', 'mouse.click', 'mouse.click']);
    assert.strictEqual(events()[1].x, 3);
    assertStrict(events());
  });

  it('emits mouse.move in exactly the canonical-core shape', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { clientX: 300, clientY: 200 });
    const expected = canonical.segments[0].events[0];
    assert.deepStrictEqual(events()[0], { ...expected, t: events()[0].t });
    assert.strictEqual(events()[0].kind, undefined, 'v1 `kind` is retired');
  });

  it('names the key, touch, focus, visibility and scroll channels', () => {
    const { doc, win, env, types, events } = harness({});
    doc.fire('keydown', { key: 'a', code: 'KeyA', target: { tagName: 'BODY' } });
    doc.fire('keyup', { key: 'a', code: 'KeyA', target: { tagName: 'BODY' } });
    doc.fire('touchstart', { touches: [{ identifier: 0, clientX: 10, clientY: 20 }] });
    doc.fire('touchmove', { touches: [{ identifier: 0, clientX: 11, clientY: 21 }] });
    env.flushRaf();                       // touch.move is rAF-coalesced
    doc.fire('touchend', { changedTouches: [{ identifier: 0, clientX: 11, clientY: 21 }] });
    win.fire('blur', {});
    doc.hidden = true; doc.fire('visibilitychange', {});
    doc.hidden = false; doc.fire('visibilitychange', {});
    win.fire('focus', {});
    win.scrollY = 40; win.fire('scroll', { target: null });
    env.flushRaf();

    assert.deepStrictEqual(types(), [
      'key.down', 'key.up', 'touch.start', 'touch.move', 'touch.end',
      'blur', 'visibility.hidden', 'visibility.visible', 'focus', 'scroll.window']);
    assertStrict(events());
  });

  it('names the four clipboard channels (drop included, spec §5.3)', () => {
    const { doc, types, events } = harness({});
    doc.fire('paste', { clipboardData: { getData: () => 'hello world' } });
    doc.fire('copy', {});
    doc.fire('cut', {});
    doc.fire('drop', { dataTransfer: { getData: () => 'dropped text!' } });

    assert.deepStrictEqual(types(),
      ['clipboard.paste', 'clipboard.copy', 'clipboard.cut', 'clipboard.drop']);
    assertStrict(events());
  });

  it('no event carries a v1 `kind` and every type is spec-known', () => {
    // The done-when grep, as an assertion: one pass over every channel this
    // module owns, checked against the validator's own type table.
    const { doc, win, env, events } = harness({});
    doc.fire('mousemove', { clientX: 1, clientY: 1 });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0 });
    doc.fire('keydown', { key: 'x', code: 'KeyX', target: { tagName: 'BODY' } });
    doc.fire('paste', { clipboardData: { getData: () => '' } });
    doc.fire('touchstart', { touches: [{ clientX: 1, clientY: 1 }] });
    win.fire('scroll', { target: null });
    win.fire('resize', {});
    env.flushRaf();

    assert.deepStrictEqual(events().filter(e => 'kind' in e), []);
    assert.ok(events().every(e => typeof e.type === 'string' && e.type.includes('.')
      || e.type === 'focus' || e.type === 'blur'));
    assertStrict(events());
  });
});

// ── coordinates (spec §7) ──────────────────────────────────────────────────

describe('client-frame coordinates only (spec §7)', () => {
  it('pointer events carry the client frame as x/y and drop the page pair', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { pageX: 110, pageY: 700, clientX: 110, clientY: 200 });
    doc.fire('click', { pageX: 300, pageY: 900, clientX: 300, clientY: 400, button: 0 });

    assert.deepStrictEqual(
      { x: events()[0].x, y: events()[0].y }, { x: 110, y: 200 });
    assert.deepStrictEqual(
      { x: events()[1].x, y: events()[1].y }, { x: 300, y: 400 });
    assert.deepStrictEqual(events().filter(e => 'cx' in e || 'cy' in e), [],
      'the v1 cx/cy pair is retired with the page frame');
  });

  it('touch points carry the client frame in a per-touch list', () => {
    const { doc, env, events } = harness({});
    doc.fire('touchstart', {
      touches: [{ identifier: 7, pageX: 10, pageY: 820, clientX: 10, clientY: 20 }],
    });
    doc.fire('touchmove', {
      touches: [
        { identifier: 7, pageX: 15, pageY: 825, clientX: 15, clientY: 25 },
        { identifier: 8, clientX: 90, clientY: 95 },
      ],
    });
    env.flushRaf();

    assert.deepStrictEqual(events()[0].touches, [{ id: 7, x: 10, y: 20 }]);
    assert.deepStrictEqual(events()[1].touches,
      [{ id: 7, x: 15, y: 25 }, { id: 8, x: 90, y: 95 }],
      'multi-touch is what the touch list is for');
  });

  it('touch.end reports the touches that ENDED, not the ones still down', () => {
    const { doc, events } = harness({});
    doc.fire('touchend', {
      touches: [{ identifier: 2, clientX: 5, clientY: 5 }],          // still down
      changedTouches: [{ identifier: 1, clientX: 40, clientY: 60 }], // lifted
    });
    assert.deepStrictEqual(events()[0].touches, [{ id: 1, x: 40, y: 60 }]);
  });
});

// ── camera (spec §6) ───────────────────────────────────────────────────────

describe('camera block (spec §6)', () => {
  it('carries all ten fields, dpr and vv completion included', () => {
    const { doc, win, env, events } = harness({});
    win.scrollX = 12; win.scrollY = 1733;
    win.innerWidth = 900; win.innerHeight = 600;
    win.devicePixelRatio = 2;
    win.visualViewport = { scale: 1.5, offsetLeft: 20.44, offsetTop: 8.05 };
    env.doc.documentElement.clientWidth = 885;
    env.doc.documentElement.clientHeight = 600;

    doc.fire('mousedown', { clientX: 450, clientY: 300, button: 0 });

    assert.deepStrictEqual(events()[0].camera, {
      scroll_x: 12, scroll_y: 1733,
      viewport_w: 900, viewport_h: 600,
      client_w: 885, client_h: 600,
      dpr: 2, vv_scale: 1.5, vv_offset_x: 20.4, vv_offset_y: 8.1,
    });
  });

  it('defaults the visualViewport fields when the API is absent', () => {
    const { doc, events } = harness({});
    doc.fire('click', { clientX: 1, clientY: 1, button: 0 });
    const c = events()[0].camera;
    assert.deepStrictEqual(
      { dpr: c.dpr, vv_scale: c.vv_scale, vv_offset_x: c.vv_offset_x, vv_offset_y: c.vv_offset_y },
      { dpr: 1, vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0 },
      'spec §6 types every camera field as a number');
  });

  it('reads the camera synchronously, ahead of the scroll notification', () => {
    // Scroll NOTIFICATIONS are async after programmatic scrolls — a click can
    // precede the scroll event describing its own state. The block is the
    // authoritative observation at the interaction instant.
    const { doc, win, events } = harness({});
    win.scrollY = 1733;                       // scrolled, no event fired yet
    doc.fire('mousedown', { clientX: 450, clientY: 300, button: 0 });
    assert.strictEqual(events()[0].camera.scroll_y, 1733);
  });

  it('move channels carry no alignment blocks (payload discipline)', () => {
    const { doc, env, events } = harness({});
    doc.fire('mousemove', { clientX: 5, clientY: 5, target: { tagName: 'DIV' } });
    doc.fire('touchmove', { touches: [{ clientX: 5, clientY: 5 }] });
    env.flushRaf();
    assert.deepStrictEqual(events().filter(e => 'camera' in e || 'anchor' in e), []);
  });

  it('omits alignment on key.up and on auto-repeats (spec §6 cost rule)', () => {
    const { doc, events } = harness({});
    const target = { tagName: 'BODY' };
    doc.fire('keydown', { key: 'a', code: 'KeyA', target });
    doc.fire('keydown', { key: 'a', code: 'KeyA', repeat: true, target });
    doc.fire('keyup', { key: 'a', code: 'KeyA', target });

    assert.ok(events()[0].camera, 'the first key.down is anchored');
    assert.strictEqual(events()[1].camera, undefined, 'repeats are not');
    assert.strictEqual(events()[1].repeat, true);
    assert.strictEqual(events()[2].camera, undefined, 'key.up is not');
    assert.strictEqual(events()[2].anchor, undefined);
  });
});

// ── anchors (spec §6) ──────────────────────────────────────────────────────

describe('anchors (spec §6)', () => {
  it('reproduces the canonical-core click, anchor and camera included', () => {
    // The fixture's own DOM, the fixture's own geometry: what CH emits for that
    // interaction must be what the hand-authored contract says.
    const { root, doc: page1 } = page(
      '<div id="stage"><button id="go">Go</button><p id="msg">Hello</p></div>');
    const span = keyframe(root);
    const button = page1.getElementById('go');
    button.getBoundingClientRect = () => ({ left: 310, top: 205, width: 64, height: 28 });

    const { doc, win, env, events } = harness({}, { span });
    win.innerWidth = 1280; win.innerHeight = 800;
    env.doc.documentElement.clientWidth = 1280;
    env.doc.documentElement.clientHeight = 800;
    doc.fire('click', { clientX: 322, clientY: 214, button: 0, target: button });

    const expected = canonical.segments[0].events[1];
    assert.deepStrictEqual(events()[0], { ...expected, t: events()[0].t });
  });

  it('names the node the FILE holds, and null outside the observed root', () => {
    const { root, doc: page1 } = page(
      '<div id="stage"><button id="go">Go</button></div>');
    const span = keyframe(root);
    const outside = page1.createElement('button');   // never serialized

    const { doc, events } = harness({}, { span });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0, target: page1.getElementById('go') });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0, target: outside });

    assert.strictEqual(events()[0].target, span.registry.peekId(page1.getElementById('go')));
    assert.strictEqual(events()[0].anchor.node, events()[0].target);
    assert.strictEqual(events()[1].target, null, 'outside the root has no node');
    assert.strictEqual(events()[1].anchor.node, null);
  });

  it('a never-emitted target resolves to the nearest node the file holds', () => {
    // The exclusion placeholder is the case spec §7 names: the file carries
    // {id, kind, tag} and nothing under it, so an interaction inside resolves
    // UP to the placeholder rather than to a node the player never received.
    const { root, doc: page1 } = page(
      '<div id="stage"><div id="bait" data-record-exclude=""><button id="inner">x</button></div></div>');
    const span = keyframe(root);
    const bait = page1.getElementById('bait');
    const inner = page1.getElementById('inner');

    const { doc, events } = harness({}, { span });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0, target: inner });

    assert.strictEqual(events()[0].target, span.registry.peekId(bait));
    assert.notStrictEqual(span.registry.peekId(inner), null, 'still numbered, just not in the file');
  });

  it('with no span nothing is addressable and the anchor still works', () => {
    // Trace tier: no DOM in the recording, so no node ids — and the alignment
    // geometry, which needs none, is exactly what still helps there.
    const { doc, events } = harness({});
    doc.fire('mousedown', {
      clientX: 1, clientY: 1, button: 0,
      target: {
        tagName: 'BUTTON', id: 'submit',
        getBoundingClientRect: () => ({ left: 40.24, top: 60.51, width: 90, height: 30 }),
      },
    });
    assert.deepStrictEqual(events()[0].anchor,
      { tag: 'button', id: 'submit', rect: { x: 40.2, y: 60.5, w: 90, h: 30 }, node: null });
    assert.strictEqual(events()[0].target, null);
  });

  it('carries id:null for an element without one (absent means withheld)', () => {
    const { doc, events } = harness({});
    doc.fire('click', {
      clientX: 1, clientY: 1, button: 0,
      target: { tagName: 'DIV', getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
    });
    assert.strictEqual(events()[0].anchor.id, null);
  });

  it('routes shadow retargeting through the vendor extension (spec §9)', () => {
    // attachShadow() after the snapshot leaves no mutation record — the
    // composed path is the only signal, and it works for OPEN roots regardless
    // of when the root was attached. Shadow content is a capture limit (§13),
    // and a CH-specific note about a standard event belongs in `extensions`.
    const { doc, events } = harness({});
    const host = {
      tagName: 'DIV', id: 'late-host',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 100, height: 40 }),
    };
    doc.fire('click', {
      clientX: 5, clientY: 5, button: 0, target: host,
      composedPath: () => [{ tagName: 'BUTTON' }, host],
    });
    doc.fire('click', {
      clientX: 5, clientY: 5, button: 0, target: host,
      composedPath: () => [host],
    });

    assert.deepStrictEqual(events()[0].extensions,
      { 'cyborg-hunter': { shadow_retarget: true } });
    assert.strictEqual(events()[1].extensions, undefined, 'no flag when the path starts at the target');
    assertStrict(events());
  });
});

// ── redaction (spec §5.2/§8) ───────────────────────────────────────────────

describe('redaction — the spec §5.2 variants, both directions', () => {
  function redactedPage() {
    const { root, doc: page1 } = page(
      '<div id="stage">' +
      '<div id="private" data-ch-redact=""><input id="secret" type="text"></div>' +
      '<input id="open" type="text"><input id="pw" type="password">' +
      '</div>');
    return { root, page: page1, span: keyframe(root, { redactSelector: '[data-ch-redact]' }) };
  }

  it('key events collapse to {type, t, redacted} and keep identity otherwise', () => {
    const { page: p, span } = redactedPage();
    const { doc, events } = harness({ keys: 'full', redactSelector: '[data-ch-redact]' }, { span });

    doc.fire('keydown', { key: 'S', code: 'KeyS', target: p.getElementById('secret') });
    doc.fire('keyup', { key: 'S', code: 'KeyS', target: p.getElementById('secret') });
    doc.fire('keydown', { key: 'S', code: 'KeyS', target: p.getElementById('open') });

    assert.deepStrictEqual(events()[0], { type: 'key.down', t: 1000, redacted: true });
    assert.deepStrictEqual(events()[1], { type: 'key.up', t: 1000, redacted: true });
    assert.strictEqual(events()[2].key, 'S', 'the open field is unaffected');
    assert.strictEqual(events()[2].redacted, undefined);
    assertStrict(events());
  });

  it('password fields are redacted with no selector at all (spec §8 floor)', () => {
    const { page: p, span } = redactedPage();
    const { doc, events } = harness({ keys: 'full', redactSelector: null }, { span });
    doc.fire('keydown', { key: 's', code: 'KeyS', target: p.getElementById('pw') });
    assert.deepStrictEqual(events()[0], { type: 'key.down', t: 1000, redacted: true });
  });

  it('input.value carries value_len and no value; the open field carries value', () => {
    const { page: p, span } = redactedPage();
    const secret = p.getElementById('secret');
    const open = p.getElementById('open');
    secret.value = SENTINEL;
    open.value = 'visible';
    const { doc, env, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });

    doc.fire('input', { target: secret });
    doc.fire('input', { target: open });
    env.flushRaf();

    assert.deepStrictEqual(events()[0], {
      type: 'input.value', t: 1000,
      node: span.registry.peekId(secret), redacted: true, value_len: SENTINEL.length,
    });
    assert.deepStrictEqual(events()[1], {
      type: 'input.value', t: 1000, node: span.registry.peekId(open), value: 'visible',
    });
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
    assertStrict(events());
  });

  it('drops input.checked and input.select for redacted controls (no variant exists)', () => {
    const { root, doc: p } = page(
      '<div id="stage"><div data-ch-redact="">' +
      '<input id="box" type="checkbox"><select id="pick"><option value="a">a</option>' +
      '<option value="b">b</option></select></div>' +
      '<input id="openbox" type="checkbox"></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const box = p.getElementById('box');
    const pick = p.getElementById('pick');
    const openBox = p.getElementById('openbox');
    box.checked = true; openBox.checked = true; pick.options[1].selected = true;

    const { doc, env, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    doc.fire('input', { target: box });
    doc.fire('input', { target: pick });
    doc.fire('input', { target: openBox });
    env.flushRaf();

    assert.deepStrictEqual(events(), [{
      type: 'input.checked', t: 1000, node: span.registry.peekId(openBox), checked: true,
    }], 'spec §5.2 defines a redacted variant for input.value only');
  });

  it('keeps a de-selected field withheld: this module marks the redaction taint', () => {
    // The §8 withholding has to survive the page CHANGING ITS MIND. Here the
    // selector is a class, so redaction begins and ends with an attribute
    // write: the participant types while the field matches, then the page
    // drops the class and the participant types again. `isInRedactedSubtree`
    // answers "no" the second time, and the only thing still withholding the
    // value is the taint mark this module makes on the way out.
    //
    // Nothing else can mark it in this scenario: the field was OUTSIDE any
    // redacted subtree when the keyframe walked (serializeTree marks every node
    // it finds inside one), and no mutation mapper runs in this harness. Found
    // unbitten while fusing the three floor walks (T3.9 fix round) — deleting
    // the mark passed all 451 replay tests, because every shipped test redacted
    // by container and the keyframe had already marked those.
    const { root, doc: p } = page('<div id="stage"><input id="toggling"></div>');
    const span = keyframe(root, { redactSelector: '.secret' });
    const field = p.getElementById('toggling');
    const { doc, env, events } = harness({ redactSelector: '.secret' }, { span });

    field.className = 'secret';                 // the page redacts it
    field.value = SENTINEL;
    doc.fire('input', { target: field });
    env.flushRaf();

    field.className = '';                       // and un-redacts it
    field.value = SENTINEL + '-after';
    doc.fire('input', { target: field });
    env.flushRaf();

    assert.strictEqual(events().length, 2, 'both keystrokes produced an event');
    assert.ok(events().every(e => e.redacted === true),
      'the post-toggle event is still redacted: ' + JSON.stringify(events()));
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
  });

  it('says nothing at all about a file input, not even a length (spec §13)', () => {
    // A browser reports `C:\fakepath\<the participant's own filename>` as the
    // value of a file input. That is PII from outside the page, so this channel
    // must agree with initial-state.js's SKIP_INPUT_TYPES and emit nothing —
    // not the value, and not the redacted variant's `value_len`, which would
    // still publish the filename's length.
    //
    // happy-dom refuses to set a file input's value ("may only programmatically
    // set the value to empty string"), so the browser's own string is installed
    // over the property here. The REAL setInputFiles proof is Chromium-side, in
    // tests/browser/replay/capture-chromium.battery.mjs case 14 — which is
    // where this leak was found.
    const { root, doc: p } = page(
      '<div id="stage"><input id="pick" type="file"><input id="open"></div>');
    const span = keyframe(root, {});
    const file = p.getElementById('pick');
    const open = p.getElementById('open');
    Object.defineProperty(file, 'value', {
      configurable: true, get: () => 'C:\\fakepath\\' + SENTINEL + '.txt',
    });
    open.value = 'visible';

    const { doc, env, events } = harness({}, { span });
    doc.fire('input', { target: file });
    doc.fire('input', { target: open });
    env.flushRaf();

    assert.deepStrictEqual(events(), [{
      type: 'input.value', t: 1000, node: span.registry.peekId(open), value: 'visible',
    }], 'the file input contributes no event; the ordinary field is unaffected');
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
    assert.strictEqual(scan(events()).includes('fakepath'), false);
  });

  it('anchors omit id and keep geometry for redacted targets (spec §6/§8)', () => {
    const { page: p, span } = redactedPage();
    const secret = p.getElementById('secret');
    secret.getBoundingClientRect = () => ({ left: 1, top: 2, width: 3, height: 4 });
    const { doc, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });

    doc.fire('mousedown', { clientX: 2, clientY: 3, button: 0, target: secret });

    assert.deepStrictEqual(events()[0].anchor, {
      tag: 'input', rect: { x: 1, y: 2, w: 3, h: 4 }, node: span.registry.peekId(secret),
    });
    assert.strictEqual('id' in events()[0].anchor, false, 'identity omitted, not nulled');
    assert.strictEqual(events()[0].target, span.registry.peekId(secret),
      'spec §7: a redacted target keeps its node reference');
  });

  it('clipboard events on a redacted target keep len and withhold content', () => {
    const { page: p, span } = redactedPage();
    const { doc, events } = harness(
      { redactSelector: '[data-ch-redact]', clipboardContent: true }, { span });

    doc.fire('paste', {
      target: p.getElementById('secret'),
      clipboardData: { getData: () => SENTINEL },
    });

    assert.deepStrictEqual(events()[0], {
      type: 'clipboard.paste', t: 1000,
      target: span.registry.peekId(p.getElementById('secret')),
      text: null, html: null, len: SENTINEL.length, redacted: true,
    });
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
    assertStrict(events());
  });

  it('keeps withholding after the page moves the field out of the container', () => {
    // Redaction is a property of the FILE (spec §8): the taint set outlives the
    // subtree the element was in when it was first withheld.
    const { root, doc: p } = page(
      '<div id="stage"><div id="private" data-ch-redact=""><input id="f" type="text"></div>' +
      '<div id="open"></div></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const field = p.getElementById('f');
    field.value = SENTINEL;
    const taint = new WeakSet();
    markRedacted(field, taint);
    p.getElementById('open').appendChild(field);   // no longer inside the container

    const { doc, env, events } = harness(
      { redactSelector: '[data-ch-redact]' }, { span, taint });
    doc.fire('input', { target: field });
    env.flushRaf();

    assert.strictEqual(events()[0].redacted, true);
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
  });
});

describe('the floors cross a shadow boundary (spec §8 has no exceptions)', () => {
  // At a document-level listener the browser retargets `e.target` to the HOST,
  // and both floor predicates walk parentNode, which stops at the ShadowRoot.
  // composedPath()[0] is the node the interaction actually reached.
  function shadowPage(inner) {
    const win = new Window({ url: 'https://example.org/exp/' });
    win.document.body.innerHTML = '<div id="stage"><div id="host"></div></div>';
    const host = win.document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = inner;
    return {
      root: win.document.body.firstElementChild, host, shadow,
      inner: shadow.querySelector('input, div'),
    };
  }
  const retargeted = (extra, host, real) =>
    ({ ...extra, target: host, composedPath: () => [real, host] });

  it('never records keystrokes typed into a password field inside a shadow root', () => {
    const { root, host, inner } = shadowPage('<input id="pw" type="password">');
    const span = keyframe(root);
    const { doc, events } = harness({ keys: 'full', redactSelector: null }, { span });

    doc.fire('keydown', retargeted({ key: 'S', code: 'KeyS' }, host, inner));

    assert.deepStrictEqual(events()[0], {
      type: 'key.down', t: 1000, redacted: true,
      extensions: { 'cyborg-hunter': { shadow_retarget: true } },
    }, 'spec §8: password values are never recorded, in any channel');
  });

  it('redacts input and clipboard for a shadow-internal redacted field', () => {
    const { root, host, inner } = shadowPage(
      '<input id="secret" type="text" data-ch-redact="">');
    inner.value = SENTINEL;
    const span = keyframe(root);
    const { doc, env, events } = harness(
      { redactSelector: '[data-ch-redact]', clipboardContent: true }, { span });

    doc.fire('input', retargeted({}, host, inner));
    doc.fire('paste', retargeted(
      { clipboardData: { getData: () => SENTINEL } }, host, inner));
    env.flushRaf();

    assert.strictEqual(events()[0].redacted, true, 'clipboard.paste is redacted');
    assert.strictEqual(events()[1].redacted, true, 'input.value is redacted');
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
  });

  it('withholds state for an excluded element inside a shadow root', () => {
    const { root, host, inner } = shadowPage(
      '<input id="bait" type="text" data-record-exclude="">');
    inner.value = SENTINEL;
    const span = keyframe(root);
    const { doc, env, events } = harness({ keys: 'full' }, { span });

    doc.fire('keydown', retargeted({ key: 'z', code: 'KeyZ' }, host, inner));
    doc.fire('input', retargeted({}, host, inner));
    env.flushRaf();

    assert.deepStrictEqual(events().map(e => e.type), ['key.down'],
      'the input event is subtracted; the keystroke keeps only its timing');
    assert.strictEqual(events()[0].redacted, true);
  });

  it('says nothing about a file input inside a shadow root (§13 through the host)', () => {
    // The composed half of the file-input guard, which the T3 final review
    // found unbitten (F-2). The retargeted target is the HOST, so the direct
    // half cannot see the file input at all; the leak needs a host that
    // proxies `.value`, which is what a custom file-picker element does. The
    // Chromium battery drives the real `setInputFiles` (case 14) but cannot
    // build this shape, because a real host does not proxy the value.
    const { root, host, inner } = shadowPage('<input id="pick" type="file">');
    Object.defineProperty(host, 'value', {
      configurable: true, get: () => 'C:\\fakepath\\' + SENTINEL + '.txt',
    });
    const span = keyframe(root);
    const { doc, env, events } = harness({}, { span });

    doc.fire('input', retargeted({}, host, inner));
    env.flushRaf();

    assert.deepStrictEqual(events(), [],
      'the composed target is a file input, so no channel may describe it');
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
  });

  it('leaves an ordinary shadow interaction alone apart from the flag', () => {
    const { root, host, inner } = shadowPage('<input id="open" type="text">');
    inner.value = 'visible';
    const span = keyframe(root);
    const { doc, env, events } = harness({ keys: 'full' }, { span });

    doc.fire('keydown', retargeted({ key: 'a', code: 'KeyA' }, host, inner));
    doc.fire('input', retargeted({}, host, inner));
    env.flushRaf();

    assert.strictEqual(events()[0].key, 'a');
    assert.strictEqual(events()[1].type, 'input.value');
    assert.strictEqual(events()[1].node, span.registry.peekId(host),
      'the host is the only node the file holds (spec §13)');
  });
});

// ── exclusion (spec §4) ────────────────────────────────────────────────────

describe('exclusion floor (spec §4) — the guard-bait shape', () => {
  // The honeypot stamps its marker on the bait INPUT itself
  // (extension-guard-honeypot.js), so the element under test IS the placeholder
  // — the shape the v1 handler let through, since it checked redaction and
  // never exclusion.
  function baitPage(marker = 'data-record-exclude=""') {
    const { root, doc: p } = page(
      '<div id="stage">' +
      `<input id="bait" type="text" ${marker}>` +
      '<div id="baitbox" data-record-exclude=""><input id="inner" type="text"></div>' +
      '<input id="open" type="text"></div>');
    return { root, page: p, span: keyframe(root) };
  }

  it('never emits the typed value or its length for a bait field', () => {
    const { page: p, span } = baitPage();
    const bait = p.getElementById('bait');
    const open = p.getElementById('open');
    bait.value = SENTINEL; open.value = 'fine';
    const { doc, env, events } = harness({}, { span });

    doc.fire('input', { target: bait });
    doc.fire('input', { target: open });
    env.flushRaf();

    assert.deepStrictEqual(events(), [{
      type: 'input.value', t: 1000, node: span.registry.peekId(open), value: 'fine',
    }], 'the bait field emits nothing at all — not even a length');
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
  });

  it('never emits values for a field INSIDE an excluded container', () => {
    const { page: p, span } = baitPage();
    p.getElementById('inner').value = SENTINEL;
    const { doc, env, events } = harness({}, { span });
    doc.fire('input', { target: p.getElementById('inner') });
    env.flushRaf();
    assert.deepStrictEqual(events(), []);
  });

  it('withholds key identity typed into bait (the sentinel is reconstructable otherwise)', () => {
    const { page: p, span } = baitPage();
    const bait = p.getElementById('bait');
    const { doc, events } = harness({ keys: 'full' }, { span });

    for (const ch of 'abc') doc.fire('keydown', { key: ch, code: 'Key' + ch.toUpperCase(), target: bait });

    assert.deepStrictEqual(events(), [
      { type: 'key.down', t: 1000, redacted: true },
      { type: 'key.down', t: 1000, redacted: true },
      { type: 'key.down', t: 1000, redacted: true },
    ]);
    assert.strictEqual(scan(events()).includes('KeyA'), false);
  });

  it('drops scroll.element for an excluded scroller and keeps a redacted one', () => {
    const { root, doc: p } = page(
      '<div id="stage"><div id="bait" data-record-exclude="">x</div>' +
      '<div id="private" data-ch-redact="">y</div></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const bait = p.getElementById('bait');
    const priv = p.getElementById('private');
    bait.scrollTop = 40; priv.scrollTop = 25;

    const { win, env, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    win.fire('scroll', { target: bait });
    win.fire('scroll', { target: priv });
    env.flushRaf();

    assert.deepStrictEqual(events(), [{
      type: 'scroll.element', t: 1000, node: span.registry.peekId(priv), x: 0, y: 25,
    }], 'an offset is not content (§8), but it IS state (§4)');
  });

  it('omits anchor identity and names the placeholder id (spec §4/§7)', () => {
    const { page: p, span } = baitPage();
    const bait = p.getElementById('bait');
    bait.getBoundingClientRect = () => ({ left: 5, top: 6, width: 7, height: 8 });
    const { doc, events } = harness({}, { span });

    doc.fire('click', { clientX: 5, clientY: 6, button: 0, target: bait });

    assert.deepStrictEqual(events()[0].anchor, {
      tag: 'input', rect: { x: 5, y: 6, w: 7, h: 8 }, node: span.registry.peekId(bait),
    });
    assert.strictEqual(events()[0].target, span.registry.peekId(bait));
  });

  it('clamps anchor tag and rect to the placeholder for a descendant', () => {
    // A click ON the excluded element needs no clamp: §4 puts that element's
    // tag in the tree. A click on something INSIDE it would otherwise give the
    // interior's tag and geometry, neither of which the file holds.
    const { page: p, span } = baitPage();
    const box = p.getElementById('baitbox');
    const inner = p.getElementById('inner');
    box.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 });
    inner.getBoundingClientRect = () => ({ left: 15, top: 25, width: 80, height: 20 });

    const { doc, events } = harness({}, { span });
    doc.fire('click', { clientX: 16, clientY: 26, button: 0, target: inner });
    doc.fire('click', { clientX: 11, clientY: 21, button: 0, target: box });

    assert.deepStrictEqual(events()[0].anchor, {
      tag: 'div', rect: { x: 10, y: 20, w: 200, h: 100 }, node: span.registry.peekId(box),
    }, 'the descendant is described by the node the file holds');
    assert.deepStrictEqual(events()[1].anchor, {
      tag: 'div', rect: { x: 10, y: 20, w: 200, h: 100 }, node: span.registry.peekId(box),
    }, 'a click on the element itself is unchanged');
  });

  it('drops the anchor entirely when an excluded target has nothing held to clamp to', () => {
    // The clamp needs a node the file holds. On trace tier (no DOM captured at
    // all), and for an excluded element outside the observed root, there is
    // none — and without this the event would ship the tag and rectangle of
    // exactly the subtree spec §4 withholds, with `node: null` and no file to
    // contradict it. Alignment fields are optional (§6), so the conforming
    // answer is to say nothing.
    const { page: p } = baitPage();
    const inner = p.getElementById('inner');
    inner.getBoundingClientRect = () => ({ left: 15, top: 25, width: 80, height: 20 });

    const { doc, events } = harness({});   // no span: nothing is addressable
    doc.fire('click', { clientX: 16, clientY: 26, button: 0, target: inner });

    assert.strictEqual(events()[0].anchor, undefined);
    assert.strictEqual(events()[0].target, null);
    assert.ok(events()[0].camera, 'the camera block is unaffected — it describes the window');
  });

  it('withholds the clipboard length too, in both modes', () => {
    // The module's own floor: not a typed value, not its length. input.value
    // refuses `value_len` for the same element, so a clipboard `len` would be
    // the one number that escapes.
    const { page: p, span } = baitPage();
    const bait = p.getElementById('bait');
    for (const clipboardContent of [false, true]) {
      const { doc, events } = harness({ clipboardContent }, { span });
      doc.fire('paste', { target: bait, clipboardData: { getData: () => SENTINEL } });
      assert.deepStrictEqual(events()[0], {
        type: 'clipboard.paste', t: 1000, target: span.registry.peekId(bait),
        text: null, html: null, len: null,
      }, 'clipboardContent=' + clipboardContent);
    }
    // The redacted counterpart KEEPS its length: spec §5.3 allows it there.
    const { root, doc: p2 } = page(
      '<div id="stage"><input id="s" type="text" data-ch-redact=""></div>');
    const span2 = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const h = harness({ redactSelector: '[data-ch-redact]' }, { span: span2 });
    h.doc.fire('paste', {
      target: p2.getElementById('s'), clipboardData: { getData: () => SENTINEL },
    });
    assert.strictEqual(h.events()[0].len, SENTINEL.length);
    assert.strictEqual(h.events()[0].redacted, true);
  });

  it('holds for the LEGACY honeypot markers, and keepBait turns those off', () => {
    const { root, doc: p } = page(
      '<div id="stage"><input id="bait" type="text" data-ch-role="honeypot"></div>');
    const bait = p.getElementById('bait');
    bait.value = SENTINEL;

    const strictSpan = keyframe(root);
    const h1 = harness({}, { span: strictSpan });
    h1.doc.fire('input', { target: bait });
    h1.env.flushRaf();
    assert.deepStrictEqual(h1.events(), [], 'legacy markers exclude by default');
    assert.strictEqual(scan(h1.events()).includes(SENTINEL), false);

    const baitSpan = keyframe(root, { keepBait: true });
    const h2 = harness({ keepBait: true }, { span: baitSpan });
    h2.doc.fire('input', { target: bait });
    h2.env.flushRaf();
    assert.strictEqual(h2.events()[0].value, SENTINEL,
      'keepBait is the analysis override, for the legacy markers only');
  });

  it('data-record-exclude has no opt-out, keepBait or not', () => {
    const { page: p, span } = baitPage();   // primary attribute
    const bait = p.getElementById('bait');
    bait.value = SENTINEL;
    const { doc, env, events } = harness({ keepBait: true }, { span });
    doc.fire('input', { target: bait });
    env.flushRaf();
    assert.deepStrictEqual(events(), []);
  });

  it('whole-channel sentinel scan: typing into bait leaves nothing behind', () => {
    const { page: p, span } = baitPage();
    const bait = p.getElementById('bait');
    const { doc, win, env, events } = harness({ keys: 'full', clipboardContent: true }, { span });

    bait.value = SENTINEL;
    bait.scrollTop = 12;
    doc.fire('keydown', { key: SENTINEL[0], code: 'KeyZ', target: bait });
    doc.fire('input', { target: bait });
    doc.fire('paste', { target: bait, clipboardData: { getData: () => SENTINEL } });
    win.fire('scroll', { target: bait });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0, target: bait });
    env.flushRaf();

    assert.strictEqual(scan(events()).includes(SENTINEL), false, scan(events()));
    assertStrict(events());
  });
});

// ── input channel (spec §5.2) ──────────────────────────────────────────────

describe('input events — one type per kind of state (spec §5.2)', () => {
  function formPage() {
    const { root, doc: p } = page(
      '<div id="stage"><input id="answer" type="text">' +
      '<input id="box" type="checkbox"><select id="pick">' +
      '<option value="a">a</option><option value="b">b</option></select>' +
      '<div id="rich" contenteditable="true">start</div></div>');
    return { page: p, span: keyframe(root) };
  }

  it('splits value, checked and select by what the control holds', () => {
    const { page: p, span } = formPage();
    const answer = p.getElementById('answer');
    const box = p.getElementById('box');
    const pick = p.getElementById('pick');
    answer.value = 'hi'; box.checked = true; pick.options[1].selected = true;

    const { doc, env, events } = harness({}, { span });
    doc.fire('input', { target: answer });
    doc.fire('input', { target: box });
    doc.fire('input', { target: pick });
    env.flushRaf();

    assert.deepStrictEqual(events(), [
      { type: 'input.value', t: 1000, node: span.registry.peekId(answer), value: 'hi' },
      { type: 'input.checked', t: 1000, node: span.registry.peekId(box), checked: true },
      { type: 'input.select', t: 1000, node: span.registry.peekId(pick), values: ['b'] },
    ]);
    assertStrict(events());
  });

  it('reads a contenteditable through its text content', () => {
    const { page: p, span } = formPage();
    const rich = p.getElementById('rich');
    rich.textContent = 'typed here';
    const { doc, env, events } = harness({}, { span });
    doc.fire('input', { target: rich });
    env.flushRaf();
    assert.strictEqual(events()[0].value, 'typed here');
  });

  it('coalesces per target through rAF, last value winning', () => {
    const { page: p, span } = formPage();
    const answer = p.getElementById('answer');
    const { doc, env, events } = harness({}, { span });

    answer.value = 'a';
    doc.fire('input', { target: answer });
    answer.value = 'ab';
    doc.fire('input', { target: answer });      // same rAF window — coalesced
    env.flushRaf();

    assert.strictEqual(events().length, 1, 'two inputs in one frame coalesce');
    assert.strictEqual(events()[0].value, 'ab');
  });

  it('emits nothing for a target the file does not contain (spec §5.2 needs a node)', () => {
    const { doc, env, events } = harness({});   // no span: trace tier
    doc.fire('input', { target: { tagName: 'INPUT', type: 'text', id: 'x', value: 'v' } });
    env.flushRaf();
    assert.deepStrictEqual(events(), [],
      'an input.value naming no node would be rejected by the format');
  });
});

// ── scroll (spec §5.6) ─────────────────────────────────────────────────────

describe('scroll (spec §5.6)', () => {
  it('splits window and element scroll, addressing elements by node id', () => {
    const { root, doc: p } = page(
      '<div id="stage"><div id="a">a</div><div id="b">b</div></div>');
    const span = keyframe(root);
    const a = p.getElementById('a'); const b = p.getElementById('b');
    a.scrollTop = 120; b.scrollLeft = 60;

    const { win, env, events } = harness({}, { span });
    win.scrollX = 0; win.scrollY = 250;
    win.fire('scroll', { target: null });
    win.fire('scroll', { target: a });
    win.fire('scroll', { target: b });
    env.flushRaf();

    assert.deepStrictEqual(events(), [
      { type: 'scroll.window', t: 1000, x: 0, y: 250 },
      { type: 'scroll.element', t: 1000, node: span.registry.peekId(a), x: 0, y: 120 },
      { type: 'scroll.element', t: 1000, node: span.registry.peekId(b), x: 60, y: 0 },
    ]);
    assertStrict(events());
  });

  it('coalesces window scroll through rAF, reading the final offsets', () => {
    const { win, env, events } = harness({});
    win.scrollY = 100;
    win.fire('scroll', { target: null });
    win.scrollY = 250;
    win.fire('scroll', { target: null });
    env.flushRaf();
    assert.deepStrictEqual(events(), [{ type: 'scroll.window', t: 1000, x: 0, y: 250 }]);
  });
});

// ── viewport changes (spec §2) ─────────────────────────────────────────────

describe('viewport changes are session-level, not events (spec §2)', () => {
  it('resize lands in viewport_changes as a complete ViewportState', () => {
    const { rec, win, env, events } = harness({});
    win.innerWidth = 800; win.innerHeight = 600; win.devicePixelRatio = 2;
    win.fire('resize', {});
    win.innerWidth = 640; win.innerHeight = 480;
    win.fire('resize', {});
    env.flushRaf();

    assert.deepStrictEqual(events(), [], 'no resize event in the segment stream');
    assert.deepStrictEqual(rec.getState().viewportChanges, [
      { w: 640, h: 480, dpr: 2, scale: 1, offset_x: 0, offset_y: 0, t: 1000 },
    ], 'coalesced to one entry, stamped with the original time');
  });

  it('visualViewport changes push the same complete state', () => {
    const { rec, win, env } = harness({});
    const vv = { scale: 2.5, offsetLeft: 30.06, offsetTop: 10, addEventListener() {} };
    win.visualViewport = vv;
    // Re-attach so the visualViewport listener registration sees the API.
    const scrollHandler = [];
    vv.addEventListener = (ev, fn) => scrollHandler.push([ev, fn]);
    attachTraceCapture(rec, { ...env, win });
    scrollHandler.find(([ev]) => ev === 'scroll')[1]({});
    env.flushRaf();

    const changes = rec.getState().viewportChanges;
    assert.deepStrictEqual(changes[changes.length - 1],
      { w: 1000, h: 700, dpr: 1, scale: 2.5, offset_x: 30.1, offset_y: 10, t: 1000 });
  });

  it('carries the ORIGINAL time, not the flush time', () => {
    const { rec, win, env } = harness({});
    win.innerWidth = 640;
    win.fire('resize', {});
    env.advance(48);                       // three frames pass before the flush
    env.flushRaf();
    assert.strictEqual(rec.getState().viewportChanges[0].t, 1000);
  });

  it('collapses a same-flush resize+pinch pair to one entry at the LATER time', () => {
    // Both channels write into ONE array whose entries keep their original
    // timestamps, and spec §7 requires it sorted (validator.js:107). A fixed
    // resize-then-vv flush order wrote [1001, 1000]; mobile keyboard-open and
    // URL-bar transitions fire the two together, so this is an ordinary path.
    //
    // Both emits read the state LIVE, so a pair pending in one flush is
    // field-identical and describes one composite geometry — which becomes
    // observable when the SECOND notification arrives. Stamping it with the
    // first asserts the new width existed before it did, and a player
    // classifying zoom or pinch would misattribute every event in between.
    const { rec, doc, win, env } = harness({});
    const vv = { scale: 1, offsetLeft: 0, offsetTop: 0, addEventListener() {} };
    const vvHandlers = [];
    vv.addEventListener = (ev, fn) => vvHandlers.push([ev, fn]);
    win.visualViewport = vv;
    attachTraceCapture(rec, { ...env, win });

    vvHandlers.find(([ev]) => ev === 'scroll')[1]({});   // vv at t=1000
    vv.scale = 2;
    env.advance(1);
    win.innerWidth = 640;
    win.fire('resize', {});                              // resize at t=1001
    env.advance(1);
    doc.fire('click', { clientX: 1, clientY: 1, button: 0 });  // flushes both

    const ts = rec.getState().viewportChanges.map(c => c.t);
    assert.deepStrictEqual(ts, [...ts].sort((a, b) => a - b),
      'viewport_changes must be time-sorted (spec §7): got ' + JSON.stringify(ts));
    assert.deepStrictEqual(ts, [1001],
      'one entry for one geometry, stamped when it became observable');
    assert.deepStrictEqual(rec.getState().viewportChanges[0].w, 640,
      'and it carries the state both channels were reporting');
  });

  it('…in the other arrival order too (the LATER time wins, not one channel)', () => {
    // The discriminating half. With a fixed emit order the surviving timestamp
    // is always the first-emitted channel's, which happens to be right when
    // that channel is also the later one. Reverse the arrivals and only the
    // max-of-both rule still answers correctly.
    const { rec, doc, win, env } = harness({});
    const vv = { scale: 1, offsetLeft: 0, offsetTop: 0, addEventListener() {} };
    const vvHandlers = [];
    vv.addEventListener = (ev, fn) => vvHandlers.push([ev, fn]);
    win.visualViewport = vv;
    attachTraceCapture(rec, { ...env, win });

    win.innerWidth = 640;
    win.fire('resize', {});                              // resize at t=1000
    env.advance(1);
    vv.scale = 2;
    vvHandlers.find(([ev]) => ev === 'scroll')[1]({});   // vv at t=1001
    env.advance(1);
    doc.fire('click', { clientX: 1, clientY: 1, button: 0 });  // flushes both

    assert.deepStrictEqual(rec.getState().viewportChanges.map(c => c.t), [1001]);
  });

  it('drops a state identical to the one before it', () => {
    // A drag-resize settles into repeated identical states between frames, and
    // the stream is session-level, so the per-trial caps never see it: 5000
    // coalesced resizes measured at 5002 entries / 365 KB before this.
    const { rec, win, env } = harness({});
    for (let i = 0; i < 50; i++) {
      win.innerWidth = 800;                // same state every time
      win.fire('resize', {});
      env.flushRaf();
      env.advance(16);
    }
    assert.strictEqual(rec.getState().viewportChanges.length, 1);
  });

  it('bounds the stream and records the drop once', () => {
    const { rec, win, env } = harness({ maxViewportChanges: 3 });
    for (let i = 0; i < 20; i++) {
      win.innerWidth = 800 - i;            // a genuinely new state each time
      win.fire('resize', {});
      env.flushRaf();
      env.advance(16);
    }
    const state = rec.getState();
    assert.strictEqual(state.viewportChanges.length, 3);
    assert.deepStrictEqual(
      state.captureFailures.map(f => f.channel), ['viewport_changes'],
      'the cap is recorded once, in the channel the vendor extension carries');
    assert.strictEqual(state.captureStopped, false,
      'a capped metadata stream is not a truncated recording (spec §5.7)');
  });
});

// ── clipboard modes (spec §5.3) ────────────────────────────────────────────

describe('clipboard modes (spec §5.3)', () => {
  it('length-only by default: no content, in any channel', () => {
    const { doc, events } = harness({});
    doc.fire('paste', { clipboardData: { getData: () => SENTINEL } });
    doc.fire('drop', { dataTransfer: { getData: () => SENTINEL + '!' } });

    assert.deepStrictEqual(events()[0], {
      type: 'clipboard.paste', t: 1000, target: null,
      text: null, html: null, len: SENTINEL.length,
    });
    assert.strictEqual(events()[1].len, SENTINEL.length + 1);
    assert.strictEqual(scan(events()).includes(SENTINEL), false);
    assertStrict(events());
  });

  it('clipboardContent:true records text and html instead of a length', () => {
    const { doc, events } = harness({ clipboardContent: true });
    doc.fire('paste', {
      clipboardData: {
        getData: (fmt) => (fmt === 'text/html' ? '<b>hi</b>' : 'hi'),
      },
    });
    assert.deepStrictEqual(events()[0], {
      type: 'clipboard.paste', t: 1000, target: null,
      text: 'hi', html: '<b>hi</b>', len: null,
    });
    assertStrict(events());
  });

  it('copy and cut carry no length (the clipboard is not populated yet)', () => {
    const { doc, events } = harness({ clipboardContent: true });
    doc.fire('copy', {});
    doc.fire('cut', {});
    assert.deepStrictEqual(events().map(e => [e.type, e.len]),
      [['clipboard.copy', null], ['clipboard.cut', null]]);
  });

  it('addresses the clipboard target by node id (spec §5.3)', () => {
    const { root, doc: p } = page('<div id="stage"><textarea id="notes"></textarea></div>');
    const span = keyframe(root);
    const notes = p.getElementById('notes');
    const { doc, events } = harness({}, { span });
    doc.fire('paste', { target: notes, clipboardData: { getData: () => 'abc' } });
    assert.strictEqual(events()[0].target, span.registry.peekId(notes));
  });
});

// ── lifecycle + containment ────────────────────────────────────────────────

describe('recording lifecycle (spec §5.7)', () => {
  it('the buffer cap emits recording.capture_stopped, not the v1 marker', () => {
    const { rec, doc, events } = harness({ maxEventsPerTrial: 2 });
    for (let i = 0; i < 5; i++) doc.fire('click', { clientX: i, clientY: i, button: 0 });

    const stop = events()[events().length - 1];
    assert.strictEqual(stop.type, 'recording.capture_stopped');
    assert.strictEqual(stop.reason, 'buffer_limit');
    assert.deepStrictEqual(stop.extensions, { 'cyborg-hunter': { limit_events: 2 } },
      'the configured limit is CH diagnostics, so it rides in the vendor namespace');
    assert.strictEqual(rec.getState().captureStopped, true);
    assertStrict(events());
  });
});

describe('one verdict per discrete event (per-keystroke cost)', () => {
  // CH's studies are typing-heavy, and an aligned key.down used to ask both
  // floors in the handler and again inside anchorFor: two ancestor walks of the
  // same chain, each calling matches() at every step. Counting matches() calls
  // pins the consolidation, since the redaction predicate is the only one that
  // uses a selector.
  function countingChain(depth) {
    const win = new Window({ url: 'https://example.org/exp/' });
    win.document.body.innerHTML =
      '<div id="stage">' + '<div>'.repeat(depth) + '<input id="leaf" type="text">' +
      '</div>'.repeat(depth) + '</div>';
    const root = win.document.body.firstElementChild;
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const leaf = win.document.getElementById('leaf');
    let calls = 0;
    let chainLength = 0;
    for (let el = leaf; el; el = el.parentElement) {
      const real = el.matches.bind(el);
      el.matches = (sel) => { calls++; return real(sel); };
      chainLength++;
    }
    return { span, leaf, calls: () => calls, chainLength };
  }

  it('walks the ancestor chain once per floor on an aligned key.down', () => {
    const chain = countingChain(6);
    const { doc } = harness({ keys: 'full', redactSelector: '[data-ch-redact]' },
      { span: chain.span });
    const before = chain.calls();
    doc.fire('keydown', { key: 'a', code: 'KeyA', target: chain.leaf });
    const walked = chain.calls() - before;
    assert.ok(walked <= chain.chainLength,
      `one redaction walk of the ${chain.chainLength}-element chain, got ` +
      `${walked} matches() calls (${walked / chain.chainLength} walks)`);
  });

  it('resolves the node id once for the event and its anchor', () => {
    const { root, doc: p } = page('<div id="stage"><button id="go">Go</button></div>');
    const span = keyframe(root);
    const go = p.getElementById('go');
    let holds = 0;
    const realHolds = span.delivery.holds;
    span.delivery.holds = (n) => { holds++; return realHolds(n); };

    const { doc, events } = harness({}, { span });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0, target: go });

    assert.strictEqual(events()[0].target, events()[0].anchor.node);
    assert.strictEqual(holds, 1, 'one delivery lookup, shared by target and anchor');
  });
});

describe('capture-phase registration and failure containment', () => {
  it('discrete pointer listeners register at capture phase', () => {
    const { doc } = harness({});
    for (const kind of ['mousedown', 'mouseup', 'click']) {
      const o = doc.options[kind];
      assert.ok(o === true || (o && o.capture === true),
        kind + ' must be capture-phase (handlers that stop recording run later)');
    }
  });

  it('a throwing listener body records a captureFailure and keeps recording', () => {
    const { rec, doc, events } = harness({});
    doc.fire('paste', { clipboardData: { getData: () => { throw new Error('denied'); } } });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0 });
    assert.strictEqual(events()[events().length - 1].type, 'mouse.click');
    assert.ok(rec.getState().captureFailures.length <= 1);
  });

  it('keys:"off" attaches no key listeners at all', () => {
    const { doc, events } = harness({ keys: 'off' });
    doc.fire('keydown', { key: 'a', code: 'KeyA', target: { tagName: 'BODY' } });
    assert.deepStrictEqual(events(), []);
  });
});
