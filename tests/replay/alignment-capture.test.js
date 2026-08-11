// tests/replay/alignment-capture.test.js
// Capture/serialize-layer contract for the cursor-alignment fix: what the
// recording has to carry for a player to know WHERE an interaction happened,
// and to notice when its reconstruction disagrees.
//
// Everything here is v2 (spec §5/§6/§7): dotted type names, client-frame
// coordinates, `camera`/`anchor` blocks, integer node ids.
//   - The v1 sections (HTML-string DOM capture: nonce markers, iframe span
//     placeholders, `mutation` patches, the v1 serializer's
//     `view_state`/`marker_attr`) were deleted at the T3.6 switchover, when
//     the code they tested stopped existing. Banners in place of each record
//     what died and which suite carries the behaviour now.
//
// Payload-shape coverage per channel lives in capture-trace.test.js; what this
// file owns is the alignment behaviour — ordering, staleness, coalescing, and
// the geometry a player cross-checks against.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';
import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';
import { createSpan } from '../../src/replay/span.js';
import { serializeTree } from '../../src/replay/snapshot.js';


// ── What used to be here (v1 DOM capture), and where it went ──
// Three sections died with the string walker at the v2 switchover, and their
// coverage moved rather than disappearing:
//   - NONCE MARKERS (`data-chn-*`, stable node references): replaced by the
//     span's integer ids — node-registry.test.js pins the numbering,
//     snapshot.test.js pins that a keyframe carries it.
//   - IFRAME SPAN PLACEHOLDERS with copied computed styles: spec §4/§13 record
//     the iframe ELEMENT with empty children, pinned in snapshot.test.js
//     (whose pin 6 records the trade: the player owns the placeholder now).
//   - `mutation` PATCHES with {n, tag, html}: replaced by §5.1's
//     dom.add/remove/attr/text, pinned in mutations.test.js against real
//     observer records and a fork-faithful player, and wired in
//     capture-dom.test.js.
// Deleted rather than skipped: a skipped test claims a contract nobody
// maintains, and every one of these asserted the shape of a function that no
// longer exists.

// ── Trace capture: coordinates, phases, timing, anchors ──

// Fake EventTarget that records listener options so capture-phase
// registration is assertable.
function fakeTarget() {
  return {
    handlers: {},
    options: {},
    addEventListener(ev, fn, opts) { this.handlers[ev] = fn; this.options[ev] = opts; },
    removeEventListener(ev) { delete this.handlers[ev]; },
    fire(ev, obj) { if (this.handlers[ev]) this.handlers[ev](obj || {}); },
  };
}

function harness(configOverrides, opts) {
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
    span: opts && opts.span,
  };
  rec.startSession();
  attachTraceCapture(rec, env);
  const events = () => rec.getState().trials.flatMap(tr => tr.events);
  return { rec, doc, win, env, events };
}

// A real page plus the keyframe that puts it in the file: node ids exist only
// because a snapshot walk assigned them, and only for what it emitted.
function page(html) {
  const win = new Window({ url: 'https://example.org/exp/' });
  win.document.body.innerHTML = html;
  return { doc: win.document, root: win.document.body.firstElementChild };
}
function keyframe(root, opts = {}) {
  const span = createSpan();
  serializeTree(root, span, opts);
  return span;
}

describe('client-frame coordinates on pointer events (spec §7)', () => {
  it('pointer events carry the client frame only', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { pageX: 110, pageY: 700, clientX: 110, clientY: 200 });
    doc.fire('click', { pageX: 300, pageY: 900, clientX: 300, clientY: 400, button: 0 });
    assert.deepStrictEqual(
      { x: events()[0].x, y: events()[0].y }, { x: 110, y: 200 });
    assert.deepStrictEqual(
      { x: events()[1].x, y: events()[1].y }, { x: 300, y: 400 });
    assert.deepStrictEqual(events().filter(e => 'cx' in e), [],
      'the page/client pair collapses into one normative frame');
  });

  it('touch points carry the client frame', () => {
    const { doc, env, events } = harness({});
    doc.fire('touchstart', { touches: [{ pageX: 10, pageY: 820, clientX: 10, clientY: 20 }] });
    doc.fire('touchmove', { touches: [{ pageX: 15, pageY: 825, clientX: 15, clientY: 25 }] });
    env.flushRaf();
    assert.deepStrictEqual(events()[0].touches, [{ id: 0, x: 10, y: 20 }]);
    assert.deepStrictEqual(events()[1].touches, [{ id: 0, x: 15, y: 25 }]);
  });
});

describe('original-time stamping for coalesced channels', () => {
  it('window scroll events carry the time of the scroll, not the flush', () => {
    const { win, env, events } = harness({});
    win.scrollY = 500;
    win.fire('scroll', { target: null });
    env.advance(48);                       // three frames pass before the flush
    env.flushRaf();
    assert.strictEqual(events()[0].t, 1000, 'listener time, not flush time');
  });

  it('viewport changes carry the time of the resize, not the flush', () => {
    const { rec, win, env } = harness({});
    win.innerWidth = 640;
    win.fire('resize', {});
    env.advance(30);
    env.flushRaf();
    assert.strictEqual(rec.getState().viewportChanges[0].t, 1000);
  });
});

describe('per-target scroll coalescing', () => {
  it('two containers scrolled in one frame both record, by node id', () => {
    const { root, doc: p } = page(
      '<div id="stage"><div id="box-a">a</div><div id="box-b">b</div></div>');
    const span = keyframe(root);
    const boxA = p.getElementById('box-a'); const boxB = p.getElementById('box-b');
    boxA.scrollTop = 120; boxB.scrollTop = 60;

    const { win, env, events } = harness({}, { span });
    win.fire('scroll', { target: boxA });
    win.fire('scroll', { target: boxB });
    env.flushRaf();

    const scrolls = events().filter(e => e.type === 'scroll.element');
    assert.strictEqual(scrolls.length, 2, 'one event per scrolled target');
    assert.deepStrictEqual(scrolls.map(s => s.node),
      [span.registry.peekId(boxA), span.registry.peekId(boxB)]);
  });

  it('a scroller the file does not contain is not addressable, so not emitted', () => {
    // v1 shipped a CSS-unsafe raw id for the viewer to getElementById; v2
    // addresses nodes by integer, and an element outside the keyframe has none.
    const { root, doc: p } = page('<div id="stage"><div id="in">a</div></div>');
    const span = keyframe(root);
    const outside = p.createElement('div');
    outside.scrollTop = 9;

    const { win, env, events } = harness({}, { span });
    win.fire('scroll', { target: outside });
    env.flushRaf();
    assert.deepStrictEqual(events(), []);
  });

  it('a scroller inside a redacted subtree keeps its offsets (they are not content)', () => {
    const { root, doc: p } = page(
      '<div id="stage"><div id="private" data-ch-redact="">' +
      '<div id="notes">x</div></div></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const scroller = p.getElementById('notes');
    scroller.scrollTop = 42;

    const { win, env, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    win.fire('scroll', { target: scroller });
    env.flushRaf();

    assert.deepStrictEqual(events(), [{
      type: 'scroll.element', t: 1000, node: span.registry.peekId(scroller), x: 0, y: 42,
    }], 'spec §5.6 has no redacted variant, and §7 keeps the node reference');
  });
});

describe('camera state flushes before discrete events', () => {
  it('a pending scroll lands BEFORE the mousedown that follows it', () => {
    const { doc, win, env, events } = harness({});
    win.scrollY = 2000;
    win.fire('scroll', { target: null });   // pending in RAF
    env.advance(5);
    doc.fire('mousedown', { clientX: 10, clientY: 10, button: 0 });
    assert.deepStrictEqual(events().map(e => e.type), ['scroll.window', 'mouse.down'],
      'synchronous flush must precede the discrete event');
    assert.ok(events()[0].t <= events()[1].t, 'scroll timestamped at/before the mousedown');
  });

  it('a pending resize is flushed before the click reads its camera', () => {
    // The resize leaves the event stream in v2 (spec §2), so the ordering claim
    // is across arrays: the viewport entry keeps the earlier time, and the
    // click's own camera block already carries the new geometry.
    const { rec, doc, win, env, events } = harness({});
    win.innerWidth = 700;
    win.fire('resize', {});
    env.advance(5);
    doc.fire('click', { clientX: 1, clientY: 1, button: 0 });

    const change = rec.getState().viewportChanges[0];
    assert.strictEqual(change.w, 700);
    assert.ok(change.t < events()[0].t, 'the viewport change predates the click');
    assert.strictEqual(events()[0].camera.viewport_w, 700);
  });
});

describe('viewport changes (spec §2)', () => {
  it('a resize records the complete viewport state', () => {
    const { rec, win, env } = harness({});
    win.innerWidth = 800; win.innerHeight = 600; win.devicePixelRatio = 2;
    win.fire('resize', {});
    env.flushRaf();
    assert.deepStrictEqual(rec.getState().viewportChanges, [
      { w: 800, h: 600, dpr: 2, scale: 1, offset_x: 0, offset_y: 0, t: 1000 },
    ]);
  });

  it('client dims stay on the per-event camera block, where the spec puts them', () => {
    const { doc, env, events } = harness({});
    env.doc.documentElement.clientWidth = 785;
    env.doc.documentElement.clientHeight = 600;
    doc.fire('click', { clientX: 1, clientY: 1, button: 0 });
    assert.deepStrictEqual(
      { w: events()[0].camera.client_w, h: events()[0].camera.client_h },
      { w: 785, h: 600 });
  });
});

describe('interaction anchors (spec §6)', () => {
  function button() {
    return {
      tagName: 'BUTTON', id: 'submit',
      getBoundingClientRect: () => ({ left: 40.24, top: 60.51, width: 90, height: 30 }),
    };
  }

  it('discrete events carry {tag, id, rect, node} in client space', () => {
    const { doc, events } = harness({});
    doc.fire('mousedown', { clientX: 60, clientY: 70, button: 0, target: button() });
    assert.deepStrictEqual(events()[0].anchor, {
      tag: 'button', id: 'submit',
      rect: { x: 40.2, y: 60.5, w: 90, h: 30 },   // client space, 0.1px
      node: null,                                  // no keyframe in this recording
    });
  });

  it('the anchor names the same node as the event target', () => {
    const { root, doc: p } = page('<div id="stage"><button id="go">Go</button></div>');
    const span = keyframe(root);
    const { doc, events } = harness({}, { span });
    doc.fire('click', { clientX: 1, clientY: 1, button: 0, target: p.getElementById('go') });
    assert.strictEqual(events()[0].anchor.node, events()[0].target);
    assert.strictEqual(events()[0].target, span.registry.peekId(p.getElementById('go')));
  });

  it('redacted targets omit anchor identity and keep geometry', () => {
    const { root, doc: p } = page(
      '<div id="stage"><input id="ssn" type="text" data-ch-redact=""></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const secret = p.getElementById('ssn');
    secret.getBoundingClientRect = () => ({ left: 1, top: 2, width: 3, height: 4 });

    const { doc, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    doc.fire('mousedown', { clientX: 2, clientY: 3, button: 0, target: secret });

    assert.deepStrictEqual(events()[0].anchor, {
      tag: 'input', rect: { x: 1, y: 2, w: 3, h: 4 }, node: span.registry.peekId(secret),
    });
  });

  it('password inputs are anchor-redacted unconditionally (no selector needed)', () => {
    const { root, doc: p } = page(
      '<div id="stage"><input id="pw-field" type="password"></div>');
    const span = keyframe(root);
    const pw = p.getElementById('pw-field');
    pw.getBoundingClientRect = () => ({ left: 1, top: 2, width: 3, height: 4 });

    const { doc, events } = harness({ redactSelector: null }, { span });
    doc.fire('click', { clientX: 2, clientY: 3, button: 0, target: pw });
    assert.deepStrictEqual(events()[0].anchor,
      { tag: 'input', rect: { x: 1, y: 2, w: 3, h: 4 }, node: span.registry.peekId(pw) });
  });

  it('descendants of a redacted container are redacted too (subtree semantics)', () => {
    const { root, doc: p } = page(
      '<div id="stage"><div data-ch-redact=""><span id="leaky">x</span></div></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const child = p.getElementById('leaky');
    child.getBoundingClientRect = () => ({ left: 1, top: 2, width: 3, height: 4 });

    const { doc, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    doc.fire('click', { clientX: 2, clientY: 3, button: 0, target: child });
    assert.strictEqual('id' in events()[0].anchor, false,
      'no identity for descendants of redacted containers');
  });

  it('mousemove events carry NO anchor (payload discipline)', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { clientX: 5, clientY: 5, target: button() });
    assert.strictEqual(events()[0].anchor, undefined);
    assert.strictEqual(events()[0].target, undefined, 'spec §5.2: mouse.move has no target');
  });
});

describe('subtree redaction for keys and input values (break-attempt fix #1)', () => {
  function redactedField() {
    const { root, doc: p } = page(
      '<div id="stage"><div data-ch-redact="">' +
      '<input id="inner-secret" type="text"></div></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const field = p.getElementById('inner-secret');
    field.value = 'TOP SECRET';
    return { span, field };
  }

  it('keydown inside a redacted container records no key identity', () => {
    const { span, field } = redactedField();
    const { doc, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    doc.fire('keydown', { key: 'T', code: 'KeyT', target: field });
    assert.deepStrictEqual(events()[0], { type: 'key.down', t: 1000, redacted: true });
  });

  it('input inside a redacted container records length only', () => {
    const { span, field } = redactedField();
    const { doc, env, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    doc.fire('input', { target: field });
    env.flushRaf();
    assert.deepStrictEqual(events()[0], {
      type: 'input.value', t: 1000,
      node: span.registry.peekId(field), redacted: true, value_len: 'TOP SECRET'.length,
    });
  });

  it('redacted checkboxes leak no checked state (checked IS the value)', () => {
    const { root, doc: p } = page(
      '<div id="stage"><input id="consent" type="checkbox" data-ch-redact=""></div>');
    const span = keyframe(root, { redactSelector: '[data-ch-redact]' });
    const box = p.getElementById('consent');
    box.checked = true;

    const { doc, env, events } = harness({ redactSelector: '[data-ch-redact]' }, { span });
    doc.fire('input', { target: box });
    env.flushRaf();
    assert.deepStrictEqual(events(), [],
      'spec §5.2 gives input.checked no redacted variant, so nothing is said');
  });

  it('non-redacted inputs address the node by its keyframe id', () => {
    const { root, doc: p } = page('<div id="stage"><input id="dup" type="text"></div>');
    const span = keyframe(root);
    const field = p.getElementById('dup');
    field.value = 'x';
    const { doc, env, events } = harness({}, { span });
    doc.fire('input', { target: field });
    env.flushRaf();
    assert.deepStrictEqual(events()[0], {
      type: 'input.value', t: 1000, node: span.registry.peekId(field), value: 'x',
    });
  });
});

describe('shadow-DOM host marking (break-attempt fix #3)', () => {
  // The snapshot half moved: snapshot.js emits the same data-ch-shadow flag on
  // the DomNode, pinned in snapshot.test.js.
  it('events flag shadow retargeting through the vendor extension (spec §9)', () => {
    // attachShadow() after the snapshot leaves no mutation record — the
    // composed path is the only signal, and it works for OPEN roots regardless
    // of when the root was attached. The flag is CH's note about a standard
    // event, so it rides in `extensions`, not as an anchor field.
    const { doc, events } = harness({});
    const host = {
      tagName: 'DIV', id: 'late-host',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 100, height: 40 }),
    };
    const shadowInner = { tagName: 'BUTTON' };
    doc.fire('click', {
      clientX: 5, clientY: 5, button: 0, target: host,
      composedPath: () => [shadowInner, host],
    });
    assert.deepStrictEqual(events()[0].extensions,
      { 'cyborg-hunter': { shadow_retarget: true } });
  });

  it('no shadow flag when the composed path starts at the target', () => {
    const { doc, events } = harness({});
    const btn = {
      tagName: 'BUTTON', id: 'plain',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 10, height: 10 }),
    };
    doc.fire('click', {
      clientX: 5, clientY: 5, button: 0, target: btn,
      composedPath: () => [btn],
    });
    assert.strictEqual(events()[0].extensions, undefined);
  });
});

// Intra-batch dedup and the characterData→childList fold were the v1 observer
// callback's storm guards, both retired: a `dom.add` carries only what was
// inserted, so the O(N²) they defended against is gone (mutations.js's header
// argues it, its tests pin the linear bound, and capture-dom.test.js pins that
// the callback now hands the mapper the COMPLETE batch).

describe('camera snapshot on discrete events', () => {
  it('discrete events carry the whole camera block, read synchronously', () => {
    // Scroll NOTIFICATIONS are async after programmatic scrolls — a click can
    // precede the scroll event describing its own state. The block is the
    // authoritative observation at the interaction instant.
    const { doc, win, env, events } = harness({});
    win.scrollX = 0; win.scrollY = 1733;          // scrolled, no event fired yet
    win.innerWidth = 900; win.innerHeight = 600;
    env.doc.documentElement.clientWidth = 885;
    env.doc.documentElement.clientHeight = 600;
    doc.fire('mousedown', { clientX: 450, clientY: 300, button: 0 });
    assert.deepStrictEqual(events()[0].camera, {
      scroll_x: 0, scroll_y: 1733, viewport_w: 900, viewport_h: 600,
      client_w: 885, client_h: 600, dpr: 1,
      vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0,
    });
  });

  it('mousemove events carry NO camera block (payload discipline)', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { clientX: 5, clientY: 5 });
    assert.strictEqual(events()[0].camera, undefined);
  });
});

describe('per-trial camera seed', () => {
  it('trial start no longer stamps a v1 view_state', () => {
    // The seed itself is not gone — it is spec §3's `initial_state`, taken at
    // the KEYFRAME against the span that gives it node ids (initial-state.js,
    // covered in initial-state.test.js). Stamping a second window-scroll seed
    // here would put two answers in the file.
    const { rec, win, env } = harness({});
    win.scrollX = 0; win.scrollY = 176;
    env.doc.documentElement.clientWidth = 1409;
    rec.startTrial({ trialId: 't1' });
    assert.strictEqual(rec.getState().trials[0].viewState, undefined);
  });

  it('trial start still prunes the scrolled-element tracker the seed reads', () => {
    const { root, doc: p } = page('<div id="stage"><div id="a">a</div></div>');
    const span = keyframe(root);
    const a = p.getElementById('a');
    const rec = createRecorder({ participantId: 'P1' });
    const doc = fakeTarget();
    const win = fakeTarget();
    let t = 1000;
    rec.startSession();
    const trace = attachTraceCapture(rec, {
      doc, win, span, now: () => t, raf: () => {},
    });
    win.fire('scroll', { target: a });
    assert.strictEqual(trace.getScrolledElements().size, 1);
    a.remove();
    rec.startTrial({ trialId: 't1' });
    assert.strictEqual(trace.getScrolledElements().size, 0);
  });
});

// ── Wire plumbing ──
// `view_state` and `marker_attr` were v1 serializer fields: spec §3 replaces
// the first with `initial_state` (taken at the keyframe, on the span that
// gives it node ids) and §4's integer ids retire the second. Both sections
// that pinned them are gone, and serializer.test.js owns the v2 wire — every
// one of its assertions running through the strict conformance validator,
// which is a stronger check than these ever were.
