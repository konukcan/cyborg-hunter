// tests/replay/alignment-capture.test.js
// Capture/serialize-layer contract for the cursor-alignment fix: what the
// recording has to carry for a player to know WHERE an interaction happened,
// and to notice when its reconstruction disagrees.
//
// Two vocabularies live here during the v2 migration, and the sections say
// which they are:
//
//   - TRACE sections are v2 (spec §5/§6/§7): dotted type names, client-frame
//     coordinates, `camera`/`anchor` blocks, integer node ids. Rewritten in
//     T3.5 alongside capture-trace.js.
//   - Sections marked **TASK-6-DOOMED (v1)** still test the HTML-string DOM
//     capture: nonce markers, iframe span placeholders, `mutation` patches,
//     the v1 serializer's `view_state`/`marker_attr`. capture-dom.js and
//     serializer.js are rewritten in Task 6; these sections die with them.
//     They are kept green rather than deleted early so the v1 path stays
//     honest until its replacement lands.
//
// Payload-shape coverage per channel lives in capture-trace.test.js; what this
// file owns is the alignment behaviour — ordering, staleness, coalescing, and
// the geometry a player cross-checks against.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';
import {
  serializeDom, mutationToPatch, createMarkerRegistry,
} from '../../src/replay/capture-dom.js';
import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';
import { createSpan } from '../../src/replay/span.js';
import { serializeTree } from '../../src/replay/snapshot.js';
import { serialize } from '../../src/replay/serializer.js';

// ── Fake DOM builders (same duck-typing as capture-dom.test.js) ──
const ELEMENT = 1, TEXT = 3;
function el(tagName, attrs, children) {
  const node = {
    nodeType: ELEMENT,
    tagName: tagName.toUpperCase(),
    attributes: Object.entries(attrs || {}).map(([name, value]) => ({ name, value })),
    childNodes: children || [],
  };
  (children || []).forEach(c => { c.parentNode = node; });
  node.attributes.forEach(({ name, value }) => {
    if (name === 'id') node.id = value;
    if (name === 'type') node.type = value;
    if (name === 'value') node.value = value;
  });
  return node;
}
function text(s) { return { nodeType: TEXT, textContent: s, childNodes: [] }; }

// ── Marker registry + serialization ──
// TASK-6-DOOMED (v1): nonce markers are replaced by the span's integer node
// ids (node-registry.js); this whole describe dies with capture-dom's string
// walker.
describe('serialization-stable node markers', () => {
  it('stamps every serialized element with the nonce marker attribute', () => {
    const markers = createMarkerRegistry('abc123');
    const root = el('div', {}, [el('p', {}, [text('hi')]), el('span', {}, [])]);
    const html = serializeDom(root, { markers });
    assert.match(html, /<div data-chn-abc123="\d+"/);
    assert.match(html, /<p data-chn-abc123="\d+"/);
    assert.match(html, /<span data-chn-abc123="\d+"/);
  });

  it('marker ids are stable across repeated serializations of the same nodes', () => {
    const markers = createMarkerRegistry('abc123');
    const p = el('p', {}, []);
    const root = el('div', {}, [p]);
    const first = serializeDom(root, { markers });
    const second = serializeDom(root, { markers });
    assert.strictEqual(first, second, 'same nodes, same ids');
  });

  it('marker ids are unique per node', () => {
    const markers = createMarkerRegistry('ff');
    const a = el('p', {}, []), b = el('p', {}, []);
    assert.notStrictEqual(markers.refFor(a), markers.refFor(b));
    assert.strictEqual(markers.refFor(a), markers.refFor(a));
  });

  it('without a registry the output carries no marker attributes (legacy shape)', () => {
    const html = serializeDom(el('div', {}, []), {});
    assert.ok(!html.includes('data-chn-'));
  });
});

// TASK-6-DOOMED (v1): spec §4/§13 record the iframe ELEMENT with empty
// children (snapshot.js), not a styled <span> swap; the footprint-style patches
// go with it.
describe('iframe placeholders', () => {
  it('serializes iframes as inert size-preserving placeholders', () => {
    const frame = el('iframe', { src: 'https://evil.example/w' }, []);
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 180 });
    const html = serializeDom(el('div', {}, [frame]), {});
    assert.ok(!html.includes("<iframe"), "no live iframe in the artifact");
    assert.ok(!html.includes('evil.example'), 'src never carried over');
    assert.match(html, /data-ch-iframe=""/);
    assert.match(html, /width:320px;height:180px/);
  });

  it('placeholder uses width/height attributes when layout is unreadable', () => {
    const frame = el('iframe', { width: '400', height: '250' }, []);
    const html = serializeDom(el('div', {}, [frame]), {});
    assert.match(html, /width:400px;height:250px/);
  });

  it('a hidden 0×0 iframe keeps its 0×0 footprint (no invented default box)', () => {
    const frame = el('iframe', {}, []);
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    const html = serializeDom(el('div', {}, [frame]), {});
    assert.match(html, /width:0px;height:0px/);
  });

  it('iframe attribute mutations become footprint style patches for the span', () => {
    // width/height attributes don't size a <span>, so an iframe resize must
    // arrive as a style patch carrying the new measured footprint.
    const frame = el('iframe', { width: '400' }, []);
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 220 });
    const root = el('div', {}, [frame]);
    const patch = mutationToPatch(
      { type: 'attributes', target: frame, attributeName: 'width' }, root, {});
    assert.strictEqual(patch.op, 'attributes');
    assert.strictEqual(patch.name, 'style');
    assert.match(patch.value, /width:500px;height:220px/);
  });

  it('iframe patch refs carry the RECONSTRUCTED tag (span) for resolver validation', () => {
    const markers = createMarkerRegistry('bb');
    const frame = el('iframe', {}, []);
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50 });
    const root = el('div', {}, [frame]);
    const patch = mutationToPatch(
      { type: 'attributes', target: frame, attributeName: 'height' }, root, { markers });
    assert.strictEqual(patch.tag, 'span',
      'tag is what resolution validates against — the placeholder, not the source');
  });

  it('placeholder copies layout-affecting computed styles (position, margin)', () => {
    const frame = el('iframe', {}, []);
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
    frame.ownerDocument = {
      defaultView: {
        getComputedStyle: () => ({
          display: 'block',
          getPropertyValue: (p) => ({
            position: 'absolute', top: '12px', left: '30px', margin: '4px 8px',
          }[p] || ''),
        }),
      },
    };
    const html = serializeDom(el('div', {}, [frame]), {});
    assert.match(html, /display:block/);
    assert.match(html, /position:absolute/);
    assert.match(html, /top:12px/);
    assert.match(html, /margin:4px 8px/);
  });
});

// TASK-6-DOOMED (v1): `mutation` patches with {n, tag, html} are replaced by
// spec §5.1's dom.add/remove/attr/text (mutations.js, already written and
// tested in mutations.test.js — this section tests the path it replaces).
describe('mutation patches carry marker references', () => {
  it('childList patches carry {n, tag} for the target plus marked children', () => {
    const markers = createMarkerRegistry('aa');
    const added = el('div', { class: 'feedback' }, [text('Correct!')]);
    const container = el('main', {}, [added]);
    const root = el('div', {}, [container]);
    const record = { type: 'childList', target: container, addedNodes: [added], removedNodes: [] };
    const patch = mutationToPatch(record, root, { markers });
    assert.strictEqual(typeof patch.n, 'number');
    assert.strictEqual(patch.n, markers.refFor(container));
    assert.strictEqual(patch.tag, 'main');
    assert.match(patch.html, /data-chn-aa="\d+"/, 'children re-marked in the patch HTML');
    assert.deepStrictEqual(patch.path, [0], 'child-index path kept as diagnostic fallback');
  });

  it('attribute patches carry {n, tag}', () => {
    const markers = createMarkerRegistry('aa');
    const target = el('button', {}, []);
    target.getAttribute = () => 'true';
    const root = el('div', {}, [target]);
    const patch = mutationToPatch(
      { type: 'attributes', target, attributeName: 'disabled' }, root, { markers });
    assert.strictEqual(patch.n, markers.refFor(target));
    assert.strictEqual(patch.tag, 'button');
  });

  it('characterData mutations become parent-level childList snapshots (parser-stable)', () => {
    // Text nodes are not parser-stable references (adjacent nodes merge on
    // reparse; empty ones vanish), so text changes are recorded as the
    // parent's resulting-children snapshot instead.
    const markers = createMarkerRegistry('aa');
    const t = text('updated');
    const p = el('p', {}, [t]);
    const root = el('div', {}, [p]);
    const patch = mutationToPatch({ type: 'characterData', target: t }, root, { markers });
    assert.strictEqual(patch.op, 'childList');
    assert.strictEqual(patch.n, markers.refFor(p));
    assert.match(patch.html, /updated/);
  });

  it('characterData stays a plain patch without markers (legacy path unchanged)', () => {
    const t = text('updated');
    const p = el('p', {}, [t]);
    const root = el('div', {}, [p]);
    const patch = mutationToPatch({ type: 'characterData', target: t }, root, {});
    assert.strictEqual(patch.op, 'characterData');
    assert.deepStrictEqual(patch.path, [0, 0]);
  });
});

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
  if (opts && opts.markers) rec.setMarkers(opts.markers);
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
  // TASK-6-DOOMED (v1): the snapshot half. snapshot.js already emits the same
  // data-ch-shadow flag on the DomNode (snapshot.test.js pins it there).
  it('elements with a shadow root carry data-ch-shadow in the snapshot', () => {
    const host = el('div', { id: 'host' }, [el('span', {}, [])]);
    host.shadowRoot = {};   // duck-typed: presence is what matters
    const html = serializeDom(el('body', {}, [host]), {});
    assert.match(html, /<div id="host"[^>]* data-ch-shadow=""|<div data-ch-shadow=""[^>]* id="host"|<div[^>]*data-ch-shadow=""/);
  });

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

// TASK-6-DOOMED (v1): intra-batch dedup and the characterData→childList fold
// are retired by mutations.js (its header records why); this section tests the
// v1 observer callback that Task 6 replaces.
describe('mutation batch dedup (break-attempt fix #9)', () => {
  it('N childList records on one target serialize once (last wins)', () => {
    globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P1', tier: 'dom' });
    let observerCb = null;
    const env = {
      doc: { body: el('body', {}, []), styleSheets: [] },
      win: {},
      MutationObserver: function (cb) {
        observerCb = cb;
        return { observe() {}, disconnect() {} };
      },
    };
    rec.startSession();
    rec.startTrial({ trialId: 't' });
    // attachDomCapture is imported lazily here to keep the fake env local
    return import('../../src/replay/capture-dom.js').then(({ attachDomCapture }) => {
      attachDomCapture(rec, env);
      const container = el('main', {}, [el('span', {}, [text('a')])]);
      env.doc.body.childNodes.push(container);
      container.parentNode = env.doc.body;
      const other = el('p', {}, []);
      env.doc.body.childNodes.push(other);
      other.parentNode = env.doc.body;
      observerCb([
        { type: 'childList', target: container },
        { type: 'childList', target: container },
        { type: 'childList', target: container },
        { type: 'attributes', target: other, attributeName: 'class' },
      ]);
      const muts = rec.getState().trials[0].events.filter(e => e.kind === 'mutation');
      assert.strictEqual(muts.filter(m => m.op === 'childList').length, 1,
        'three same-target childList records collapse to the final snapshot');
      assert.strictEqual(muts.filter(m => m.op === 'attributes').length, 1,
        'other record types are never skipped');
    });
  });

  it('characterData storms dedup on the PARENT they convert to (final Sol finding)', () => {
    // In marker mode a characterData record becomes a parent-level childList
    // snapshot — N same-node text rewrites are the same O(N²) storm as N
    // appends and must collapse to one parent serialization.
    globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P1', tier: 'dom' });
    let observerCb = null;
    const env = {
      doc: { body: el('body', {}, []), styleSheets: [] },
      win: {},
      MutationObserver: function (cb) {
        observerCb = cb;
        return { observe() {}, disconnect() {} };
      },
    };
    rec.startSession();
    rec.startTrial({ trialId: 't' });
    return import('../../src/replay/capture-dom.js').then(({ attachDomCapture }) => {
      attachDomCapture(rec, env);
      const t1 = text('rewritten');
      const p = el('p', {}, [t1]);
      env.doc.body.childNodes.push(p);
      p.parentNode = env.doc.body;
      observerCb([
        { type: 'characterData', target: t1 },
        { type: 'characterData', target: t1 },
        { type: 'characterData', target: t1 },
        { type: 'childList', target: p },      // same parent — also subsumed
      ]);
      const muts = rec.getState().trials[0].events.filter(e => e.kind === 'mutation');
      assert.strictEqual(muts.length, 1, 'one parent snapshot for the whole storm');
      assert.strictEqual(muts[0].op, 'childList');
      assert.strictEqual(muts[0].tag, 'p');
    });
  });

  it('dedup keeps FIRST-occurrence order: ancestor patches precede in-batch children', () => {
    // parent.append(child); child.append(grandchild); parent.append(other)
    // → the parent's patch must be emitted BEFORE the child's, or the child
    // reference cannot resolve at replay (the child doesn't exist until the
    // parent patch creates it).
    globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P1', tier: 'dom' });
    let observerCb = null;
    const env = {
      doc: { body: el('body', {}, []), styleSheets: [] },
      win: {},
      MutationObserver: function (cb) {
        observerCb = cb;
        return { observe() {}, disconnect() {} };
      },
    };
    rec.startSession();
    rec.startTrial({ trialId: 't' });
    return import('../../src/replay/capture-dom.js').then(({ attachDomCapture, createMarkerRegistry: mk }) => {
      attachDomCapture(rec, env);
      const parent = el('main', {}, []);
      env.doc.body.childNodes.push(parent);
      parent.parentNode = env.doc.body;
      const child = el('section', {}, []);
      parent.childNodes.push(child);
      child.parentNode = parent;
      observerCb([
        { type: 'childList', target: parent },   // parent.append(child)
        { type: 'childList', target: child },    // child.append(grandchild)
        { type: 'childList', target: parent },   // parent.append(other)
      ]);
      const muts = rec.getState().trials[0].events.filter(e => e.kind === 'mutation');
      assert.strictEqual(muts.length, 2, 'two unique targets');
      assert.strictEqual(muts[0].tag, 'main', 'ancestor patch first');
      assert.strictEqual(muts[1].tag, 'section', 'in-batch child patch after its creator');
    });
  });
});

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
// TASK-6-DOOMED (v1): `view_state` and `marker_attr` are v1 serializer fields;
// spec §3 replaces the first with `initial_state` and §4's integer ids retire
// the second. Task 6 rewrites serializer.js and this section with it.
describe('serializer wire additions', () => {
  function stateWith(extra) {
    return {
      participantId: 'P1', tier: 'dom', keys: 'full',
      sessionStart: 1000, sessionStartEpoch: 1700000000000,
      viewport: { width: 1000, height: 700, dpr: 1, visual_viewport: null,
                  client_width: 985, client_height: 700 },
      stylesheets: [], guardViolations: [], captureFailures: [],
      captureStopped: false, endReason: 'finished',
      trials: [{
        trialIndex: 0, trialId: 't0', plugin: 'p', implicit: false,
        tLoad: 1000, tStart: null, tDomReady: null, tEnd: 2000,
        initialDom: '', events: [],
        viewState: { x: 0, y: 10, w: 1000, h: 700, cw: 985, ch: 700, dpr: 1 },
      }],
      ...extra,
    };
  }

  it('emits view_state per trial and marker_attr in ch_extensions', () => {
    const wire = serialize(stateWith({ markerAttr: 'data-chn-abc123' }), {});
    assert.deepStrictEqual(wire.trials[0].view_state,
      { x: 0, y: 10, w: 1000, h: 700, cw: 985, ch: 700, dpr: 1 });
    assert.strictEqual(wire.ch_extensions.marker_attr, 'data-chn-abc123');
    assert.strictEqual(wire.viewport.client_width, 985);
  });

  it('legacy state without the new fields serializes with nulls (no throw)', () => {
    const s = stateWith({});
    delete s.trials[0].viewState;
    const wire = serialize(s, {});
    assert.strictEqual(wire.trials[0].view_state, null);
    assert.strictEqual(wire.ch_extensions.marker_attr, null);
  });
});

// TASK-6-DOOMED (v1): the marker registry passthrough exists for capture-dom's
// string walker; capture-trace no longer reads it.
describe('recorder marker plumbing', () => {
  it('setMarkers/getMarkers round-trips an opaque registry', () => {
    globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P1' });
    const reg = createMarkerRegistry('zz');
    rec.setMarkers(reg);
    assert.strictEqual(rec.getMarkers(), reg);
    rec.setMarkerAttr(reg.attr);
    rec.startSession();
    const wire = serialize(rec.getState(), {});
    assert.strictEqual(wire.ch_extensions.marker_attr, 'data-chn-zz');
  });
});
