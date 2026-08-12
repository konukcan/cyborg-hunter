// tests/replay/alignment-viewer-model.test.js
// The §6/§8 alignment re-point, both halves (T5 Task 6).
//
// MODEL half (T5.1, kept): the per-segment camera seed folded from
// SESSION-level `viewport_changes`, levels 2 and 3 of design §8's client-box
// chain, and the producer-identity `foreign` flag that decides which CH panels
// the report may draw. v1 folded per-trial `view_state` seeds plus in-stream
// `resize` events; v2 has neither, so the fold changes shape rather than being
// ported.
//
// VIEWER half (T5.6): level 1 of the client-box chain (the per-event camera),
// the five self-check predicates, the three anchor outcomes of §7, the
// event-level `redacted` bucket, and the §6 MAY-omit rule. These run the
// SHIPPED client over a booted viewer, through the shared harness.
//
// WHY CONSTRUCTED EVENTS AND NOT THE CORPUS. Neither committed fixture can
// supply a PASS case, and the plan says so in two amendments:
//   - `jspsych-full` carries ZERO `camera` and ZERO `anchor` blocks across all
//     909 events (Task 0), so it fires no predicate in any configuration;
//   - `canonical-core`'s single anchored event is permanently `uncertain` for
//     a fixture reason — its hand-authored `anchor.rect` is 316–320 px from
//     where an unstyled `<button>` lands in any real browser (Task 4, measured
//     tri-engine and reproduced independently by the reviewer). The check is
//     WORKING there; that case is pinned in `viewer-client.test.js` and must
//     not be "fixed".
// Every constructed block below has the shape capture actually emits —
// `cameraBlock()` (capture-trace.js:282, all ten fields, complete or absent)
// and `anchorFor()` (:329: `id` OMITTED when identity is withheld, `node: null`
// when nothing applicable is held, the whole anchor dropped for an excluded
// target with no held ancestor).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { buildViewerModel } from '../../src/cli/renderers/replay-assets.js';
import { boot, withProto } from './support/viewer-harness.js';

const FIXTURES = new URL('./schema-v2/fixtures/', import.meta.url);
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'));

const VIEWPORT = { w: 1424, h: 797, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 };

function baseRecording(overrides) {
  return {
    schema_version: 2,
    recorder: { name: 'cyborg-hunter-replay', version: '0.7.5' },
    host: null,
    participant_id: 'P1',
    recording_started_at: '2026-08-11T00:00:00.000Z',
    recording_started_at_perf: 0,
    user_agent: 'test',
    viewport: { ...VIEWPORT },
    observed_root: null,
    stylesheets: [],
    stylesheet_events: [],
    viewport_changes: [],
    truncated: false,
    end_reason: 'finished',
    extensions: { 'cyborg-hunter': { tier: 'dom', viewport_client: { w: 1409, h: 797 } } },
    segments: [],
    ...overrides,
  };
}

function segment(overrides) {
  return {
    index: 0, label: null, plugin: null,
    t_start: null, t_dom_ready: null, t_load: null, t_end: null,
    initial_dom: null, initial_state: null, events: [],
    host_data: null, extensions: null,
    ...overrides,
  };
}

const keyframeTree = () => ({ id: 1, kind: 'element', tag: 'body', attrs: {}, children: [] });

describe('camera seed — session viewport and the viewport_changes fold', () => {
  it('seeds from the top-level viewport with zero scroll when nothing changed', () => {
    const model = buildViewerModel(baseRecording({
      segments: [segment({ t_load: 0, initial_dom: keyframeTree() })],
    }));
    const cam = model.segments[0].camera;
    assert.strictEqual(cam.scroll_x, 0);
    assert.strictEqual(cam.scroll_y, 0);
    assert.strictEqual(cam.w, 1424);
    assert.strictEqual(cam.h, 797);
    assert.strictEqual(cam.dpr, 1);
    assert.strictEqual(cam.scale, 1);
    assert.strictEqual(cam.source, 'default');
  });

  it('folds only the viewport_changes at or before the segment origin', () => {
    const model = buildViewerModel(baseRecording({
      viewport_changes: [
        { t: 50, ...VIEWPORT, w: 1015 },
        { t: 500, ...VIEWPORT, w: 1200 },     // exactly at segment 1's origin
        { t: 900, ...VIEWPORT, w: 900 },      // after it
      ],
      segments: [
        segment({ index: 0, t_load: 0, initial_dom: keyframeTree() }),
        segment({ index: 1, t_load: 500, initial_dom: keyframeTree() }),
      ],
    }));
    assert.strictEqual(model.segments[0].camera.w, 1424, 'nothing has changed yet at t=0');
    assert.strictEqual(model.segments[1].camera.w, 1200,
      'a change stamped at the origin is part of the state the segment opens with');
  });

  it('folds pinch state (scale / offsets / dpr) the same way', () => {
    const model = buildViewerModel(baseRecording({
      viewport_changes: [{ t: 10, w: 1424, h: 797, dpr: 2, scale: 1.5, offset_x: 40, offset_y: 12 }],
      segments: [segment({ t_load: 100, initial_dom: keyframeTree() })],
    }));
    const cam = model.segments[0].camera;
    assert.deepStrictEqual(
      { dpr: cam.dpr, scale: cam.scale, offset_x: cam.offset_x, offset_y: cam.offset_y },
      { dpr: 2, scale: 1.5, offset_x: 40, offset_y: 12 });
  });

  it('survives a recording with no viewport block at all', () => {
    const model = buildViewerModel(baseRecording({
      viewport: null,
      segments: [segment({ t_load: 0, initial_dom: keyframeTree() })],
    }));
    const cam = model.segments[0].camera;
    assert.strictEqual(cam.w, null);
    assert.strictEqual(cam.client_w, null);
    assert.strictEqual(model.viewport, null);
  });
});

describe('camera seed — window scroll comes from the span keyframe', () => {
  it('seeds scroll from the keyframe\'s initial_state', () => {
    const model = buildViewerModel(baseRecording({
      segments: [segment({
        t_load: 0, initial_dom: keyframeTree(),
        initial_state: { scroll: { x: 0, y: 176 }, element_scroll: [], media: [], form: [] },
      })],
    }));
    assert.strictEqual(model.segments[0].camera.scroll_y, 176);
    assert.strictEqual(model.segments[0].camera.source, 'initial_state');
  });

  it('a continuation inherits its SPAN KEYFRAME\'s seed, not its own null', () => {
    const model = buildViewerModel(baseRecording({
      segments: [
        segment({
          index: 0, t_load: 0, initial_dom: keyframeTree(),
          initial_state: { scroll: { x: 5, y: 176 }, element_scroll: [], media: [], form: [] },
        }),
        segment({ index: 1, t_start: 100 }),
      ],
    }));
    // The restore mounts segments[spanStart] and seeds ITS initial_state, so
    // the continuation's camera must open from the same place (design §5).
    assert.strictEqual(model.segments[1].spanStart, 0);
    assert.strictEqual(model.segments[1].camera.scroll_y, 176);
    assert.strictEqual(model.segments[1].camera.scroll_x, 5);
  });

  it('a keyframe with no initial_state opens at scroll (0,0)', () => {
    const model = buildViewerModel(baseRecording({
      segments: [
        segment({
          index: 0, t_load: 0, initial_dom: keyframeTree(),
          initial_state: { scroll: { x: 0, y: 176 }, element_scroll: [], media: [], form: [] },
        }),
        segment({ index: 1, t_load: 100, initial_dom: keyframeTree() }),
      ],
    }));
    assert.strictEqual(model.segments[1].camera.scroll_y, 0,
      'the frame survives segment changes, so a scrolled segment must not leak into the next');
    assert.strictEqual(model.segments[1].camera.source, 'default');
  });
});

describe('client-box chain (design §8, levels 2 and 3)', () => {
  it('level 2 — the session viewport_client is the layout box at the top-level viewport', () => {
    const model = buildViewerModel(baseRecording({
      segments: [segment({ t_load: 0, initial_dom: keyframeTree() })],
    }));
    assert.deepStrictEqual(model.viewportClient, { w: 1409, h: 797 });
    assert.deepStrictEqual(model.scrollbar, { w: 15, h: 0 });
    assert.strictEqual(model.segments[0].camera.client_w, 1409);
    assert.strictEqual(model.segments[0].camera.client_h, 797);
  });

  it('level 3 — a folded resize carries the same session scrollbar delta', () => {
    const model = buildViewerModel(baseRecording({
      viewport_changes: [{ t: 10, ...VIEWPORT, w: 1015, h: 600 }],
      segments: [segment({ t_load: 100, initial_dom: keyframeTree() })],
    }));
    const cam = model.segments[0].camera;
    assert.strictEqual(cam.w, 1015);
    assert.strictEqual(cam.client_w, 1000, '1015 − (1424 − 1409)');
    assert.strictEqual(cam.client_h, 600, 'the session h delta is 0');
  });

  it('an absent viewport_client is a delta of ZERO, never viewport.w − undefined.w', () => {
    const model = buildViewerModel(baseRecording({
      extensions: { 'cyborg-hunter': { tier: 'dom' } },   // CH-produced, no client box
      segments: [segment({ t_load: 0, initial_dom: keyframeTree() })],
    }));
    assert.strictEqual(model.viewportClient, null);
    assert.deepStrictEqual(model.scrollbar, { w: 0, h: 0 });
    assert.strictEqual(model.segments[0].camera.client_w, 1424);
    assert.ok(Number.isFinite(model.segments[0].camera.client_w));
  });
});

describe('foreign — producer identity, not namespace presence', () => {
  it('jspsych-full is foreign AND has a null viewportClient AND a zero scrollbar delta', () => {
    // Asserted together on purpose. jspsych-full DOES carry
    // extensions['cyborg-hunter'] (the T4 converter stamps its provenance
    // there), so a namespace-presence test reports foreign:false for the one
    // file that exists to prove foreignness — and §8's client-box chain then
    // computes viewport.w − undefined.w on the fixture that matters most.
    const rec = fixture('jspsych-full');
    assert.ok(rec.extensions['cyborg-hunter'], 'the namespace IS present on the foreign fixture');
    const model = buildViewerModel(rec);
    assert.strictEqual(model.foreign, true);
    assert.strictEqual(model.viewportClient, null);
    assert.deepStrictEqual(model.scrollbar, { w: 0, h: 0 });
    assert.strictEqual(model.segments[0].camera.client_w, rec.viewport.w);
    assert.ok(model.segments.every((s) => Number.isFinite(s.camera.client_w)));
  });

  it('a CH recording is not foreign', () => {
    const model = buildViewerModel(baseRecording({
      segments: [segment({ t_load: 0, initial_dom: keyframeTree() })],
    }));
    assert.strictEqual(model.foreign, false);
  });

  it('a hand-authored fixture is foreign', () => {
    assert.strictEqual(buildViewerModel(fixture('canonical-core')).foreign, true);
  });

  it('CH panels key on their OWN field, never on foreign', () => {
    // A converted CH-v1 file is CH-produced AND converter-stamped; a foreign
    // file may still carry a CH block. Neither case may be decided by the
    // `foreign` flag.
    const model = buildViewerModel(baseRecording({
      recorder: { name: 'jspsych', version: '8.2.3' },
      extensions: { 'cyborg-hunter': { scoring: { soft_score: 2 }, viewport_client: { w: 1409, h: 797 } } },
      segments: [segment({ t_load: 0, initial_dom: keyframeTree() })],
    }));
    assert.strictEqual(model.foreign, true);
    assert.strictEqual(model.scoring.soft_score, 2, 'the panel follows its field, not the producer');
    assert.strictEqual(model.segments[0].camera.client_w, 1409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The viewer half: the five predicates over a booted client.
// ═══════════════════════════════════════════════════════════════════════════

// ── A layout model for the frame realm, declared ───────────────────────────
// happy-dom has no layout engine: every `getBoundingClientRect()` is 0×0,
// `documentElement.clientWidth` is 0, and `elementFromPoint` returns null
// unconditionally. Four of the five §8 predicates are geometry, so in the bare
// realm the check can only ever be observed FAILING (which is what T5.4
// pinned) and never passing — and the contract here is that each predicate
// fails on its OWN corruption and passes otherwise.
//
// So this file models layout. The model is deliberately NOT a stub of the
// check's answers: every number it returns is derived from state the VIEWER
// produced, so a viewer that stops doing its job fails these tests the way a
// browser would fail them.
//   - an element's PAGE box comes from a `data-box="x,y,w,h"` attribute
//     carried by the recording, so resolving the wrong node yields the wrong
//     rect;
//   - its CLIENT rect is that box minus the window scroll the viewer applied,
//     so a scroll the reconstruction did not take shows up as a rect
//     divergence;
//   - `documentElement.clientWidth` is the iframe's own style box, which is
//     what §8's client-box chain sizes — so ignoring a per-event
//     `camera.client_w` shows up as a camera divergence, exactly as it would
//     in a browser (minus a modelled scrollbar when the reconstruction
//     overflows, which is the other direction the check exists to catch);
//   - `elementFromPoint` hit-tests the mounted tree with those rects, later
//     elements in document order winning, which is what an overlay does;
//   - the iframe's on-page offset is parsed out of the `transform` the viewer
//     WROTE, so a letterbox that was computed but never applied fails check 5.
// Real layout — fonts, reflow, borders, transforms, zoom — is Task 8's
// Playwright battery. What this file owns is the predicate logic and the
// plumbing that feeds it.

const ZERO = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const rect = (x, y, w, h) =>
  ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
const px = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };

function pageBox(el) {
  const raw = el && el.getAttribute && el.getAttribute('data-box');
  if (!raw) return null;
  const n = raw.split(',').map(Number);
  return n.length === 4 && n.every((v) => Number.isFinite(v)) ? n : null;
}

function clientRectOf(el) {
  const n = pageBox(el);
  if (!n) return null;
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  return rect(n[0] - (view ? view.scrollX || 0 : 0), n[1] - (view ? view.scrollY || 0 : 0), n[2], n[3]);
}

function translateOf(el) {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((el.style && el.style.transform) || '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

// A reconstruction that overflows grows a scrollbar the capture did not have,
// and the layout box the recording states is then wrong by its width. Modelled
// declaratively so a test can ask for it: `data-overflow` on the body.
const MODELLED_SCROLLBAR = 15;

// Options: `stageDrift` ({x, y} px added to the iframe's real on-page offset —
// a page transform the viewer does not know about), `frozenScroll` (the frame
// refuses to scroll, as a reconstruction shorter than the captured page does).
async function withLayout(v, opts, body) {
  const o = opts || {};
  const doc = v.doc();
  const iframeEl = v.frame();
  const view = doc.defaultView;
  const origEfp = Object.getOwnPropertyDescriptor(doc, 'elementFromPoint');
  const origScrollTo = o.frozenScroll ? view.scrollTo : null;
  Object.defineProperty(doc, 'elementFromPoint', {
    configurable: true,
    value: (x, y) => {
      let hit = null;
      doc.querySelectorAll('[data-box]').forEach((el) => {
        const r = clientRectOf(el);
        if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = el;
      });
      return hit;
    },
  });
  if (o.frozenScroll) view.scrollTo = () => {};
  const frameClient = (el, dim) =>
    (el.ownerDocument === doc && el === doc.documentElement)
      ? px(iframeEl.style[dim]) - (dim === 'width' && doc.body && doc.body.hasAttribute('data-overflow')
        ? MODELLED_SCROLLBAR : 0)
      : 0;   // everything else keeps happy-dom's answer, which is 0
  try {
    return await withProto(v.win, 'HTMLElement', 'getBoundingClientRect', {
      value: function () {
        if (this === iframeEl) {
          const t = translateOf(this);
          const d = o.stageDrift || { x: 0, y: 0 };
          return rect(t.x + (d.x || 0), t.y + (d.y || 0), px(this.style.width), px(this.style.height));
        }
        return clientRectOf(this) || ZERO;
      },
    }, () => withProto(v.win, 'HTMLElement', 'clientWidth', {
      get: function () { return frameClient(this, 'width'); },
    }, () => withProto(v.win, 'HTMLElement', 'clientHeight', {
      get: function () { return frameClient(this, 'height'); },
    }, body)));
  } finally {
    if (origEfp) Object.defineProperty(doc, 'elementFromPoint', origEfp);
    else delete doc.elementFromPoint;
    if (origScrollTo) view.scrollTo = origScrollTo;
  }
}

// ── the constructed recording ──────────────────────────────────────────────

const VW = 1000, VH = 800;
const CLIENT_W = 985, CLIENT_H = 800;    // a 15px scrollbar at capture time
const BUTTON_BOX = [310, 205, 64, 28];
const INPUT_BOX = [310, 260, 200, 32];
const boxAttr = (b) => b.join(',');
const boxRect = (b) => ({ x: b[0], y: b[1], w: b[2], h: b[3] });
const CLICK_X = 342, CLICK_Y = 219;      // inside BUTTON_BOX

const el = (id, tag, attrs, children) =>
  ({ id, kind: 'element', tag, attrs, children: children || [] });

// body(1) ├─ button#go(2) ─ text(3)   ├─ input#answer(4)   [+ extras]
const page = (extras, bodyAttrs) => ({
  id: 1, kind: 'element', tag: 'body', attrs: bodyAttrs || {},
  children: [
    el(2, 'button', { id: 'go', 'data-box': boxAttr(BUTTON_BOX) },
      [{ id: 3, kind: 'text', text: 'Go' }]),
    el(4, 'input', { id: 'answer', type: 'text', 'data-box': boxAttr(INPUT_BOX) }),
    ...(extras || []),
  ],
});

// capture-trace.js:282 — complete or absent, never partial.
const camera = (over) => Object.assign({
  scroll_x: 0, scroll_y: 0,
  viewport_w: VW, viewport_h: VH,
  client_w: CLIENT_W, client_h: CLIENT_H,
  dpr: 1, vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0,
}, over);

// capture-trace.js:329 — `id` present (possibly null) unless identity is
// withheld; `node` is the nearest node the file holds, or null.
const anchor = (over) => Object.assign({
  tag: 'button', id: 'go', rect: boxRect(BUTTON_BOX), node: 2,
}, over);

const click = (over) => Object.assign({
  type: 'mouse.click', t: 500, x: CLICK_X, y: CLICK_Y, button: 0, target: 2,
  camera: camera(), anchor: anchor(),
}, over);

function alignRecording(events, over) {
  const o = over || {};
  return {
    schema_version: 2,
    recorder: { name: 'cyborg-hunter-replay', version: '0.7.5' },
    participant_id: 'P1',
    recording_started_at: '2026-08-11T00:00:00.000Z',
    recording_started_at_perf: 0,
    user_agent: 'test',
    viewport: { w: VW, h: VH, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
    stylesheets: [], stylesheet_events: [],
    viewport_changes: o.viewportChanges || [],
    ended_at_perf: 10000, end_reason: 'finished', truncated: false,
    extensions: {
      'cyborg-hunter': { tier: 'dom', viewport_client: { w: CLIENT_W, h: CLIENT_H } },
    },
    segments: [{
      index: 0, label: 'trial', plugin: null,
      t_start: 0, t_dom_ready: null, t_load: 0, t_end: 2000,
      initial_dom: o.dom || page(),
      initial_state: o.initialState || null,
      events, host_data: null, extensions: null,
    }],
  };
}

// Boots, installs the layout model, plays the whole segment and hands back the
// checks. One line per test, so the corruption is the only visible difference.
async function checksFor(recording, opts) {
  const v = boot(recording);
  const checks = await withLayout(v, opts, () => {
    v.dbg.selectSegment(0);
    v.dbg.seek(2000);
    return v.dbg.getChecks();
  });
  return { v, checks };
}

const only = (checks) => { assert.equal(checks.length, 1, 'exactly one check'); return checks[0]; };

describe('T5.6 — the five predicates: clean reconstruction', () => {
  it('a faithful reconstruction passes all five', async () => {
    const { checks } = await checksFor(alignRecording([click()]));
    const c = only(checks);
    assert.deepStrictEqual({ type: c.type, status: c.status, reasons: c.reasons },
      { type: 'mouse.click', status: 'ok', reasons: [] });
  });

  it('and passes them under a scroll the viewer had to apply first', async () => {
    // The recorded rect is the CLIENT rect at event time, so it is the page box
    // minus 120. If the viewer never applied `initial_state.scroll`, the
    // replayed rect is 120px off and check 2 fires. The pass is therefore a
    // statement about the reconstruction, not about the arithmetic.
    const scrolled = boxRect(BUTTON_BOX);
    const rec = alignRecording(
      [click({ y: CLICK_Y - 120, camera: camera({ scroll_y: 120 }), anchor: anchor({ rect: { ...scrolled, y: scrolled.y - 120 } }) })],
      { initialState: { scroll: { x: 0, y: 120 }, element_scroll: [], media: [], form: [] } });
    const { v, checks } = await checksFor(rec);
    assert.equal(v.doc().defaultView.scrollY, 120, 'the seed scrolled the frame');
    assert.deepStrictEqual(only(checks).reasons, []);
  });
});

describe('T5.6 — each predicate fails on its own corruption', () => {
  it('1a camera: a reconstruction that cannot reach the recorded scroll, on EITHER axis', async () => {
    // A camera-only event (capture drops the anchor for an excluded target with
    // no held ancestor, capture-trace.js:332), so nothing but check 1 can fire.
    for (const [axis, over, expected] of [
      ['y', { scroll_y: 300 }, /applied scroll diverges \(0,0 vs 0,300\)/],
      ['x', { scroll_x: 300 }, /applied scroll diverges \(0,0 vs 300,0\)/],
    ]) {
      const rec = alignRecording([
        { type: 'mouse.down', t: 400, x: 10, y: 10, button: 0, target: null,
          camera: camera(over) },
      ]);
      const c = only((await checksFor(rec, { frozenScroll: true })).checks);
      assert.equal(c.status, 'uncertain', axis);
      assert.equal(c.reasons.length, 1, axis + ': the camera predicate alone');
      assert.match(c.reasons[0], expected);
    }
  });

  it('1b camera: a reconstruction whose layout width is not the recorded one', async () => {
    // `data-overflow` models a reconstruction that grew a scrollbar the capture
    // did not have: the frame is sized to 985 and lays out at 970.
    const rec = alignRecording([click()], { dom: page([], { 'data-overflow': '' }) });
    const c = only((await checksFor(rec)).checks);
    assert.equal(c.status, 'uncertain');
    assert.equal(c.reasons.length, 1);
    assert.match(c.reasons[0], /frame layout width 970 vs camera 985/);
  });

  it('2 rect: EACH of the four edges, so no one of them can go dark alone', async () => {
    // Four conjuncts, four separate mutations. A single corruption that moves
    // the whole box lights two edges at once and leaves the other two unpinned
    // — the class of hole T5.3's M10 found (two guards, neither individually
    // pinned), so each edge is isolated here: shift x AND widen to hold the
    // right edge still, and so on.
    const b = boxRect(BUTTON_BOX);
    const cases = [
      ['left', { ...b, x: b.x - 20, w: b.w + 20 }],
      ['top', { ...b, y: b.y - 20, h: b.h + 20 }],
      ['right', { ...b, w: b.w + 20 }],
      ['bottom', { ...b, h: b.h + 20 }],
    ];
    for (const [edge, rect] of cases) {
      const c = only((await checksFor(alignRecording([click({ anchor: anchor({ rect }) })]))).checks);
      assert.equal(c.status, 'uncertain', edge);
      assert.equal(c.reasons.length, 1,
        edge + ': the point is still inside the REPLAYED rect, so only check 2 fires');
      assert.match(c.reasons[0], /target rect moved \(Δ 20px\)/, edge);
    }
  });

  it('3 containment: EACH of the four sides of the replayed rect', async () => {
    // 310..374 × 205..233, with a 2px allowance. Same reason as above: one
    // point outside the corner would pin two comparisons and leave two loose.
    for (const [side, x, y] of [['left', 300, 219], ['right', 380, 219],
      ['above', 342, 200], ['below', 342, 240]]) {
      const c = only((await checksFor(alignRecording([click({ x, y })]))).checks);
      assert.equal(c.status, 'uncertain', side);
      assert.equal(c.reasons.length, 1, side);
      assert.match(c.reasons[0], /cursor outside target/, side);
    }
  });

  it('4 hit test: something the capture did not have is over the target', async () => {
    // The reconstruction carries a veil across the button. Rect and containment
    // both still pass — the target is where it should be and the point is on
    // it — and only the hit test can see that the click could not have reached
    // it. This is the predicate the other four cannot substitute for.
    const veil = el(5, 'div', { id: 'veil', 'data-box': '300,200,120,60' });
    const c = only((await checksFor(alignRecording([click()], { dom: page([veil]) }))).checks);
    assert.equal(c.status, 'uncertain');
    assert.equal(c.reasons.length, 1);
    assert.match(c.reasons[0], /hit-test resolves div#veil/);
  });

  it('5 stage transform: the frame is not where the letterbox says it is, on EITHER axis', async () => {
    for (const drift of [{ x: 6, y: 0 }, { x: 0, y: 6 }]) {
      const c = only((await checksFor(alignRecording([click()]), { stageDrift: drift })).checks);
      assert.equal(c.status, 'uncertain', JSON.stringify(drift));
      assert.equal(c.reasons.length, 1);
      assert.match(c.reasons[0], /stage transform drift/);
    }
  });
});

describe('T5.6 — client-box chain level 1: the per-event camera', () => {
  it('a per-event client_w re-sizes the frame, and the check follows it', async () => {
    // §8: the per-event camera is AUTHORITATIVE. Scroll and resize
    // notifications dispatch after the change, so the block on the interaction
    // can know state whose `viewport_changes` entry arrives later — there is
    // deliberately no viewport_changes entry here.
    const rec = alignRecording([
      click({ t: 300 }),
      click({ t: 700, camera: camera({ viewport_w: 875, client_w: 860 }) }),
    ]);
    const { v, checks } = await checksFor(rec);
    assert.equal(checks.length, 2);
    assert.deepStrictEqual(checks.map((c) => c.status), ['ok', 'ok']);
    assert.equal(v.dbg.getCamera().cw, 860, 'the fold took the event\'s client box');
    assert.equal(v.frame().style.width, '860px', 'and it reached the frame, not just the camera');
  });

  it('level 3 inside the walk: a session viewport_change keeps the scrollbar delta', async () => {
    const rec = alignRecording(
      [click({ t: 500, camera: camera({ viewport_w: 1200, viewport_h: 700, client_w: 1185, client_h: 700 }) })],
      { viewportChanges: [{ t: 400, w: 1200, h: 700, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 }] });
    const { v, checks } = await checksFor(rec);
    assert.equal(v.dbg.getCamera().cw, 1185, '1200 − the session delta of 15');
    assert.deepStrictEqual(only(checks).reasons, []);
  });
});

describe('T5.6 — §6 MAY-omit: absence is not failure', () => {
  it('an event carrying neither block produces NO check, not a failed one', async () => {
    // CH's capture omits alignment on key.up and on repeats (spec §6's cost
    // rule, capture-trace.js:526-551). v1 conflated absence with failure, which
    // is how key.up omissions read as misalignment.
    const rec = alignRecording([
      { type: 'key.down', t: 400, key: 'a', code: 'KeyA', repeat: false, target: 4,
        mods: { ctrl: false, shift: false, alt: false, meta: false },
        camera: camera(), anchor: { tag: 'input', id: 'answer', rect: boxRect(INPUT_BOX), node: 4 } },
      { type: 'key.up', t: 460, key: 'a', code: 'KeyA', repeat: false, target: 4,
        mods: { ctrl: false, shift: false, alt: false, meta: false } },
      { type: 'key.down', t: 520, key: 'a', code: 'KeyA', repeat: true, target: 4,
        mods: { ctrl: false, shift: false, alt: false, meta: false } },
    ]);
    const { v, checks } = await checksFor(rec);
    assert.deepStrictEqual(checks.map((c) => c.type), ['key.down'], 'one check, from the one aligned event');
    assert.equal(checks[0].status, 'ok');
    assert.equal(v.chip('data-ch-align').textContent, 'alignment verified (1 check)',
      'the two omissions are not counted as anything');
  });

  it('a camera-only event is still camera-checked', async () => {
    // The other real absence: an excluded target with no held ancestor gets no
    // anchor at all (capture-trace.js:332), and saying nothing about geometry
    // is a conforming answer. The camera block it DOES carry is still checked.
    const rec = alignRecording([
      { type: 'mouse.down', t: 400, x: 10, y: 10, button: 0, target: null, camera: camera() },
    ]);
    const c = only((await checksFor(rec)).checks);
    assert.equal(c.status, 'ok');
  });
});

describe('T5.6 — the three anchor outcomes (§7) and the redacted bucket (§8)', () => {
  it('all four statuses are distinguishable in one getChecks() call', async () => {
    const rec = alignRecording([
      click({ t: 300 }),                                            // resolves
      click({ t: 400, anchor: anchor({ node: null }) }),            // no applicable target
      click({ t: 500, anchor: anchor({ node: 4242 }) }),            // an id the span cannot hold
      { type: 'key.down', t: 600, redacted: true },                 // §5.2 redacted variant
    ]);
    const { checks } = await checksFor(rec);
    assert.deepStrictEqual(checks.map((c) => c.status),
      ['ok', 'no-anchor', 'uncertain', 'redacted']);
    assert.match(checks[2].reasons.join(' '), /anchor node 4242 not held by this span \(button#go\)/);
    assert.deepStrictEqual(checks[1].reasons, [], 'no applicable target is not a failure');
    assert.deepStrictEqual(checks[3].reasons, ['redacted event']);
  });

  it('a camera divergence on a no-anchor event is NOT swallowed by the bucket', async () => {
    // `node: null` suppresses the ANCHOR predicates and nothing else. Bucketing
    // the whole event as "no anchor" hid a camera divergence in a bucket the
    // chip counts as clean — and `node: null` is the shape every interaction
    // outside the observed root carries, so the hole was not a corner.
    const rec = alignRecording([
      click({ camera: camera({ scroll_y: 300 }), anchor: anchor({ node: null }) }),
    ]);
    const c = only((await checksFor(rec, { frozenScroll: true })).checks);
    assert.equal(c.status, 'uncertain', 'a real divergence, reported as one');
    assert.match(c.reasons.join(' '), /applied scroll diverges/);
  });

  it('a stage-transform drift on a no-anchor event is not swallowed either', async () => {
    const rec = alignRecording([click({ anchor: anchor({ node: null }) })]);
    const c = only((await checksFor(rec, { stageDrift: { x: 6, y: 6 } })).checks);
    assert.equal(c.status, 'uncertain');
    assert.match(c.reasons.join(' '), /stage transform drift/);
  });

  it('the chip says which interactions could not be verified, and does not over-claim', async () => {
    // `no-anchor` is counted by the summary and, until T5.6, said by nothing:
    // a segment whose interactions all landed outside the observed root read
    // as a segment with no interactions at all, and a mixed one read as fully
    // verified. Neither is a failure and both are the silence this chip exists
    // to prevent.
    const none = await checksFor(alignRecording([
      click({ t: 300, anchor: anchor({ node: null }) }),
      click({ t: 400, anchor: anchor({ node: null }) }),
    ]));
    assert.equal(none.v.chip('data-ch-align').textContent,
      'alignment unverified (2 with no target)');

    const mixed = await checksFor(alignRecording([
      click({ t: 300 }),
      click({ t: 400, anchor: anchor({ node: null }) }),
      { type: 'key.down', t: 500, redacted: true },
    ]));
    assert.equal(mixed.v.chip('data-ch-align').textContent,
      'alignment verified (1 check; 1 redacted, 1 with no target)');
  });

  it('a REDACTED ANCHOR is checked, not bucketed as unverifiable', async () => {
    // §8 omits `anchor.id` for a redacted target but keeps `node` and `rect`,
    // so the geometry is verifiable — strictly more than v1, where a redacted
    // anchor could not be checked at all. The event itself is not redacted:
    // that is the other bucket, and they must not be confused.
    const redactedAnchor = { tag: 'input', rect: boxRect(INPUT_BOX), node: 4 };
    const keyEvent = (a) => ({
      type: 'key.down', t: 500, key: 'x', code: 'KeyX', repeat: false, target: 4,
      mods: { ctrl: false, shift: false, alt: false, meta: false },
      camera: camera(), anchor: a,
    });
    const clean = only((await checksFor(alignRecording([keyEvent(redactedAnchor)]))).checks);
    assert.equal(clean.status, 'ok', 'checked, and it passed');
    assert.ok(!('id' in redactedAnchor), 'identity is withheld, as §8 requires');

    // The same anchor with a divergent rect must FAIL, or "checked" was empty.
    const moved = { ...redactedAnchor, rect: { ...boxRect(INPUT_BOX), y: INPUT_BOX[1] + 40 } };
    const bad = only((await checksFor(alignRecording([keyEvent(moved)]))).checks);
    assert.equal(bad.status, 'uncertain');
    assert.match(bad.reasons.join(' '), /target rect moved/);
  });
});
