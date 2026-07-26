// tests/replay/alignment-capture.test.js
// Capture/serialize-layer contract for the cursor-alignment fix:
// serialization-stable node markers, iframe placeholders, client
// coordinates on pointer events, original-time stamping for coalesced
// channels, per-target scroll state, camera flush before discrete events,
// interaction anchors, per-trial view-state seeds, and wire plumbing.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  serializeDom, mutationToPatch, createMarkerRegistry,
} from '../../src/replay/capture-dom.js';
import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';
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
  };
  if (opts && opts.markers) rec.setMarkers(opts.markers);
  rec.startSession();
  attachTraceCapture(rec, env);
  const events = () => rec.getState().trials.flatMap(tr => tr.events);
  return { rec, doc, win, env, events };
}

describe('client coordinates on pointer events', () => {
  it('mousemove and clicks carry cx/cy alongside page coords', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { pageX: 110, pageY: 700, clientX: 110, clientY: 200 });
    doc.fire('click', { pageX: 300, pageY: 900, clientX: 300, clientY: 400 });
    assert.deepStrictEqual(
      { x: events()[0].x, y: events()[0].y, cx: events()[0].cx, cy: events()[0].cy },
      { x: 110, y: 700, cx: 110, cy: 200 });
    assert.deepStrictEqual(
      { cx: events()[1].cx, cy: events()[1].cy }, { cx: 300, cy: 400 });
  });

  it('touch events carry cx/cy', () => {
    const { doc, env, events } = harness({});
    doc.fire('touchstart', { touches: [{ pageX: 10, pageY: 820, clientX: 10, clientY: 20 }] });
    doc.fire('touchmove', { touches: [{ pageX: 15, pageY: 825, clientX: 15, clientY: 25 }] });
    env.flushRaf();
    assert.deepStrictEqual({ cx: events()[0].cx, cy: events()[0].cy }, { cx: 10, cy: 20 });
    assert.deepStrictEqual({ cx: events()[1].cx, cy: events()[1].cy }, { cx: 15, cy: 25 });
  });
});

describe('capture-phase registration for pointer events', () => {
  it('discrete pointer listeners register at capture phase', () => {
    const { doc } = harness({});
    for (const kind of ['mousedown', 'mouseup', 'click']) {
      const o = doc.options[kind];
      assert.ok(o === true || (o && o.capture === true),
        kind + ' must be capture-phase (handlers that stop recording run later)');
    }
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

  it('resize events carry the time of the resize, not the flush', () => {
    const { win, env, events } = harness({});
    win.innerWidth = 640;
    win.fire('resize', {});
    env.advance(30);
    env.flushRaf();
    assert.strictEqual(events()[0].t, 1000);
  });
});

describe('per-target scroll coalescing', () => {
  it('two containers scrolled in one frame both record', () => {
    const { win, env, events } = harness({});
    const boxA = { tagName: 'DIV', id: 'box-a', scrollLeft: 0, scrollTop: 120 };
    const boxB = { tagName: 'DIV', id: 'box-b', scrollLeft: 0, scrollTop: 60 };
    win.fire('scroll', { target: boxA });
    win.fire('scroll', { target: boxB });
    env.flushRaf();
    const scrolls = events().filter(e => e.kind === 'scroll');
    assert.strictEqual(scrolls.length, 2, 'one event per scrolled target');
    assert.deepStrictEqual(scrolls.map(s => s.id).sort(), ['box-a', 'box-b']);
  });

  it('element scroll events carry the raw id for selector-unsafe resolution', () => {
    const { win, env, events } = harness({});
    const weird = { tagName: 'DIV', id: 'a:b c', scrollLeft: 0, scrollTop: 9 };
    win.fire('scroll', { target: weird });
    env.flushRaf();
    assert.strictEqual(events()[0].id, 'a:b c');
  });

  it('scrollers inside a redacted subtree leak no id/descriptor/marker', () => {
    const { win, env, events } = harness({ redactSelector: '[data-ch-redact]' });
    const container = { tagName: 'DIV', matches: (sel) => sel === '[data-ch-redact]' };
    const scroller = {
      tagName: 'DIV', id: 'secret-notes', parentNode: container,
      matches: () => false, scrollLeft: 0, scrollTop: 42,
    };
    win.fire('scroll', { target: scroller });
    env.flushRaf();
    const e = events()[0];
    assert.deepStrictEqual(
      { redacted: e.redacted, tag: e.tag, y: e.y, id: e.id, el: e.el, n: e.n },
      { redacted: true, tag: 'div', y: 42, id: undefined, el: undefined, n: undefined });
  });
});

describe('camera state flushes before discrete events', () => {
  it('a pending scroll lands BEFORE the mousedown that follows it', () => {
    const { doc, win, env, events } = harness({});
    win.scrollY = 2000;
    win.fire('scroll', { target: null });   // pending in RAF
    env.advance(5);
    doc.fire('mousedown', { pageX: 10, pageY: 2010, clientX: 10, clientY: 10 });
    const kinds = events().map(e => e.kind);
    assert.deepStrictEqual(kinds, ['scroll', 'mousedown'],
      'synchronous flush must precede the discrete event');
    assert.ok(events()[0].t <= events()[1].t, 'scroll timestamped at/before the mousedown');
  });

  it('a pending resize lands BEFORE the click that follows it', () => {
    const { doc, win, env, events } = harness({});
    win.innerWidth = 700;
    win.fire('resize', {});
    env.advance(5);
    doc.fire('click', { pageX: 1, pageY: 1, clientX: 1, clientY: 1 });
    assert.deepStrictEqual(events().map(e => e.kind), ['resize', 'click']);
  });
});

describe('resize/viewport metadata', () => {
  it('resize events carry client dims and dpr', () => {
    const { win, env, events } = harness({});
    win.innerWidth = 800; win.innerHeight = 600; win.devicePixelRatio = 2;
    env.doc.documentElement.clientWidth = 785;
    env.doc.documentElement.clientHeight = 600;
    win.fire('resize', {});
    env.flushRaf();
    assert.deepStrictEqual(
      { w: events()[0].w, h: events()[0].h, cw: events()[0].cw, ch: events()[0].ch, dpr: events()[0].dpr },
      { w: 800, h: 600, cw: 785, ch: 600, dpr: 2 });
  });
});

describe('interaction anchors', () => {
  function button(markers) {
    const b = {
      tagName: 'BUTTON', id: 'submit',
      getBoundingClientRect: () => ({ left: 40.2, top: 60.5, width: 90, height: 30 }),
    };
    return b;
  }

  it('discrete events carry a target anchor {tag, id, rect} in client space', () => {
    const { doc, events } = harness({});
    doc.fire('mousedown', {
      pageX: 60, pageY: 770, clientX: 60, clientY: 70, target: button() });
    const a = events()[0].target;
    assert.ok(a, 'anchor present');
    assert.strictEqual(a.tag, 'button');
    assert.strictEqual(a.id, 'submit');
    assert.deepStrictEqual(a.rect, [40.2, 60.5, 90, 30], 'raw client-space rect');
  });

  it('anchors carry the marker reference when a registry is attached', () => {
    const markers = createMarkerRegistry('ee');
    const { doc, events } = harness({}, { markers });
    const b = button();
    doc.fire('click', { pageX: 1, pageY: 1, clientX: 1, clientY: 1, target: b });
    assert.strictEqual(events()[0].target.n, markers.refFor(b));
  });

  it('redacted targets expose only {redacted, tag} — no id, rect, or marker', () => {
    const { doc, events } = harness({ redactSelector: '[data-ch-redact]' });
    const secret = {
      tagName: 'INPUT', id: 'ssn', type: 'text',
      matches: (sel) => sel === '[data-ch-redact]',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }),
    };
    doc.fire('mousedown', { pageX: 2, pageY: 3, clientX: 2, clientY: 3, target: secret });
    const a = events()[0].target;
    assert.deepStrictEqual(a, { redacted: true, tag: 'input' });
  });

  it('password inputs are anchor-redacted unconditionally (no selector needed)', () => {
    const { doc, events } = harness({});
    const pw = {
      tagName: 'INPUT', type: 'password', id: 'pw-field',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }),
    };
    doc.fire('click', { pageX: 2, pageY: 3, clientX: 2, clientY: 3, target: pw });
    assert.deepStrictEqual(events()[0].target, { redacted: true, tag: 'input' });
  });

  it('descendants of a redacted container are redacted too (subtree semantics)', () => {
    const { doc, events } = harness({ redactSelector: '[data-ch-redact]' });
    const container = { tagName: 'DIV', matches: (sel) => sel === '[data-ch-redact]' };
    const child = {
      tagName: 'SPAN', id: 'leaky', parentNode: container,
      matches: () => false,
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }),
    };
    doc.fire('click', { pageX: 2, pageY: 3, clientX: 2, clientY: 3, target: child });
    assert.deepStrictEqual(events()[0].target, { redacted: true, tag: 'span' },
      'no id/rect/marker for descendants of redacted containers');
  });

  it('mousemove events carry NO anchor (payload discipline)', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { pageX: 5, pageY: 5, clientX: 5, clientY: 5, target: button() });
    assert.strictEqual(events()[0].target, undefined);
  });
});

describe('subtree redaction for keys and input values (break-attempt fix #1)', () => {
  function redactedChild() {
    const container = { tagName: 'DIV', matches: (sel) => sel === '[data-ch-redact]' };
    return {
      tagName: 'INPUT', type: 'text', id: 'inner-secret', value: 'TOP SECRET',
      parentNode: container, matches: () => false,
    };
  }

  it('keydown inside a redacted container records no key identity', () => {
    const { doc, events } = harness({ redactSelector: '[data-ch-redact]' });
    doc.fire('keydown', { key: 'T', code: 'KeyT', target: redactedChild() });
    assert.strictEqual(events()[0].redacted, true);
    assert.strictEqual(events()[0].key, undefined);
  });

  it('input inside a redacted container records length only', () => {
    const { doc, env, events } = harness({ redactSelector: '[data-ch-redact]' });
    doc.fire('input', { target: redactedChild() });
    env.flushRaf();
    assert.strictEqual(events()[0].redacted, true);
    assert.strictEqual(events()[0].value, undefined);
    assert.strictEqual(events()[0].value_len, 'TOP SECRET'.length);
    assert.strictEqual(events()[0].n, undefined, 'no NEW identity fields on redacted events');
  });

  it('redacted checkboxes leak no checked state (checked IS the value)', () => {
    const { doc, env, events } = harness({ redactSelector: '[data-ch-redact]' });
    const box = {
      tagName: 'INPUT', type: 'checkbox', id: 'sensitive-consent', value: 'on',
      checked: true, matches: (sel) => sel === '[data-ch-redact]',
    };
    doc.fire('input', { target: box });
    env.flushRaf();
    assert.strictEqual(events()[0].redacted, true);
    assert.strictEqual(events()[0].checked, undefined);
  });

  it('non-redacted inputs carry a marker ref for duplicate-id-safe restore', () => {
    const markers = createMarkerRegistry('mm');
    const { doc, env, events } = harness({}, { markers });
    const field = { tagName: 'INPUT', type: 'text', id: 'dup', value: 'x' };
    doc.fire('input', { target: field });
    env.flushRaf();
    assert.strictEqual(events()[0].n, markers.refFor(field));
  });
});

describe('shadow-DOM host marking (break-attempt fix #3)', () => {
  it('elements with a shadow root carry data-ch-shadow in the snapshot', () => {
    const host = el('div', { id: 'host' }, [el('span', {}, [])]);
    host.shadowRoot = {};   // duck-typed: presence is what matters
    const html = serializeDom(el('body', {}, [host]), {});
    assert.match(html, /<div id="host"[^>]* data-ch-shadow=""|<div data-ch-shadow=""[^>]* id="host"|<div[^>]*data-ch-shadow=""/);
  });

  it('anchors flag shadow retargeting at EVENT time (post-snapshot attachShadow)', () => {
    // attachShadow() after the snapshot leaves no mutation record — the
    // composed path is the only signal, and it works for OPEN roots
    // regardless of when the root was attached.
    const { doc, events } = harness({});
    const host = {
      tagName: 'DIV', id: 'late-host',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 100, height: 40 }),
    };
    const shadowInner = { tagName: 'BUTTON' };
    doc.fire('click', {
      pageX: 5, pageY: 5, clientX: 5, clientY: 5, target: host,
      composedPath: () => [shadowInner, host],
    });
    assert.strictEqual(events()[0].target.shadow, true);
  });

  it('no shadow flag when the composed path starts at the target', () => {
    const { doc, events } = harness({});
    const btn = {
      tagName: 'BUTTON', id: 'plain',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 10, height: 10 }),
    };
    doc.fire('click', {
      pageX: 5, pageY: 5, clientX: 5, clientY: 5, target: btn,
      composedPath: () => [btn],
    });
    assert.strictEqual(events()[0].target.shadow, undefined);
  });
});

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
  it('discrete events carry sx/sy/vw/vh/cw/ch read synchronously', () => {
    // Scroll NOTIFICATIONS are async after programmatic scrolls — a click
    // can precede the scroll event describing its own state. The snapshot
    // is the authoritative observation at the interaction instant.
    const { doc, win, env, events } = harness({});
    win.scrollX = 0; win.scrollY = 1733;          // scrolled, no event fired yet
    win.innerWidth = 900; win.innerHeight = 600;
    env.doc.documentElement.clientWidth = 885;
    env.doc.documentElement.clientHeight = 600;
    doc.fire('mousedown', { pageX: 450, pageY: 2033, clientX: 450, clientY: 300 });
    const e = events()[0];
    assert.deepStrictEqual(
      { sx: e.sx, sy: e.sy, vw: e.vw, vh: e.vh, cw: e.cw, ch: e.ch },
      { sx: 0, sy: 1733, vw: 900, vh: 600, cw: 885, ch: 600 });
  });

  it('mousemove events carry NO camera snapshot (payload discipline)', () => {
    const { doc, events } = harness({});
    doc.fire('mousemove', { pageX: 5, pageY: 5, clientX: 5, clientY: 5 });
    assert.strictEqual(events()[0].sx, undefined);
  });
});

describe('per-trial view-state seed', () => {
  it('each trial records scroll + viewport state at trial start', () => {
    const { rec, win, env } = harness({});
    win.scrollX = 0; win.scrollY = 176;
    win.innerWidth = 1424; win.innerHeight = 797;
    env.doc.documentElement.clientWidth = 1409;
    env.doc.documentElement.clientHeight = 797;
    rec.startTrial({ trialId: 't1' });
    const trial = rec.getState().trials[0];
    assert.deepStrictEqual(trial.viewState,
      { x: 0, y: 176, w: 1424, h: 797, cw: 1409, ch: 797, dpr: 1 });
  });
});

// ── Wire plumbing ──
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
