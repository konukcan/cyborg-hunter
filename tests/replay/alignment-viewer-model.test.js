// tests/replay/alignment-viewer-model.test.js
// buildViewerModel camera plumbing under v2 (T5 Task 1, design §8): the
// per-segment camera seed folded from SESSION-level viewport_changes, the
// three-level client-box chain, and the producer-identity `foreign` flag that
// decides which CH panels the report may draw.
//
// v1 folded per-trial `view_state` seeds plus in-stream `resize` events. v2
// has neither: `resize` is not an event type and viewport history is
// session-level, so the fold changes shape rather than being ported.
//
// Level 1 of the client-box chain (per-event `camera.client_w`) is the
// VIEWER's business at the moment of an anchored event, not the model's —
// tests for it live with the five checks (T5 Task 6).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { buildViewerModel } from '../../src/cli/renderers/replay-assets.js';

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
