// tests/replay/alignment-viewer-model.test.js
// buildViewerModel camera plumbing for the cursor-alignment fix: per-trial
// camera seeds (view_state, or centrally folded for legacy recordings),
// legacy detection, and marker-attribute passthrough.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildViewerModel } from '../../src/cli/renderers/replay-assets.js';

function baseRecording(overrides) {
  return {
    schema_version: 1,
    metadata: { participant_id: 'P1', tier: 'dom', keys: 'full',
      start_time: '2026-07-13T00:00:00Z', end_reason: 'finished',
      recorder: 'cyborg-hunter-replay@0.7.0' },
    viewport: { width: 1424, height: 797, dpr: 1,
      visual_viewport: { width: 1409, height: 797, scale: 1 } },
    stylesheets: { initial: [], events: [] },
    rng_calls: [],
    trials: [],
    ch_extensions: {},
    ...overrides,
  };
}

describe('camera seeds — new recordings (view_state present)', () => {
  it('uses the recorded view_state verbatim and is not legacy', () => {
    const rec = baseRecording({
      viewport: { width: 1424, height: 797, dpr: 1, visual_viewport: null,
        client_width: 1409, client_height: 797 },
      trials: [{
        trial_index: 0, trial_id: 't0', plugin: 'p',
        t_load: 0, t_end: 100, initial_dom: '', events: [],
        view_state: { x: 0, y: 176, w: 1424, h: 797, cw: 1409, ch: 797, dpr: 1 },
      }],
      ch_extensions: { marker_attr: 'data-chn-ab12' },
    });
    const model = buildViewerModel(rec);
    assert.strictEqual(model.legacy, false);
    assert.strictEqual(model.markerAttr, 'data-chn-ab12');
    assert.deepStrictEqual(model.trials[0].camera,
      { x: 0, y: 176, w: 1424, h: 797, cw: 1409, ch: 797, dpr: 1, source: 'view_state' });
  });
});

describe('camera seeds — legacy recordings (central folding)', () => {
  it('trial 0 seeds from the session viewport with assumed zero scroll', () => {
    const rec = baseRecording({
      trials: [{
        trial_index: 0, trial_id: 't0', plugin: 'p',
        t_load: 0, t_end: 100, initial_dom: '', events: [],
      }],
    });
    const model = buildViewerModel(rec);
    assert.strictEqual(model.legacy, true);
    const cam = model.trials[0].camera;
    assert.deepStrictEqual(
      { x: cam.x, y: cam.y, w: cam.w, h: cam.h, cw: cam.cw, ch: cam.ch, source: cam.source },
      // cw falls back to visual_viewport.width (layout width w/o scrollbar)
      { x: 0, y: 0, w: 1424, h: 797, cw: 1409, ch: 797, source: 'folded' });
  });

  it('later trials fold prior trials\' window scroll and resize events', () => {
    // Mirrors the user fixture: trial 0 scrolls to 176 and resizes to 1015
    // then back to 1424; trial 1 must therefore seed at scroll 176 and
    // viewport 1424 even though it records neither itself.
    const rec = baseRecording({
      trials: [
        {
          trial_index: 0, trial_id: 't0', plugin: 'p',
          t_load: 0, t_end: 100, initial_dom: '',
          events: [
            { t: 10, kind: 'scroll', x: 0, y: 176 },
            { t: 20, kind: 'resize', w: 1015, h: 797 },
            { t: 30, kind: 'resize', w: 1424, h: 797 },
          ],
        },
        {
          trial_index: 1, trial_id: 't1', plugin: 'p',
          t_load: 100, t_end: 200, initial_dom: '', events: [],
        },
      ],
    });
    const model = buildViewerModel(rec);
    const cam = model.trials[1].camera;
    assert.strictEqual(cam.source, 'folded');
    assert.strictEqual(cam.y, 176, 'window scroll folded across the trial boundary');
    assert.strictEqual(cam.w, 1424, 'resize folded (last state wins)');
    // legacy resize events carry no cw — estimated as w minus the session
    // scrollbar delta (1424−1409 = 15)
    assert.strictEqual(cam.cw, 1409);
  });

  it('element scrolls do NOT fold into the window camera', () => {
    const rec = baseRecording({
      trials: [
        {
          trial_index: 0, trial_id: 't0', plugin: 'p',
          t_load: 0, t_end: 100, initial_dom: '',
          events: [{ t: 10, kind: 'scroll', el: 'div#box', id: 'box', x: 0, y: 999 }],
        },
        { trial_index: 1, trial_id: 't1', plugin: 'p',
          t_load: 100, t_end: 200, initial_dom: '', events: [] },
      ],
    });
    const model = buildViewerModel(rec);
    assert.strictEqual(model.trials[1].camera.y, 0,
      'container scroll must not masquerade as window scroll');
  });
});

describe('mixed recordings (some trials seeded, some not)', () => {
  it('resyncs the fold from available view_states and stays legacy-flagged', () => {
    // Trial 0 starts pre-scrolled (y=500) with NO scroll events — only its
    // view_state knows. Trial 1 (truncated/legacy) must inherit y=500, and
    // the reduced-guarantees banner must still show for the unseeded trial.
    const rec = baseRecording({
      trials: [
        {
          trial_index: 0, trial_id: 't0', plugin: 'p',
          t_load: 0, t_end: 100, initial_dom: '', events: [],
          view_state: { x: 0, y: 500, w: 1424, h: 797, cw: 1409, ch: 797, dpr: 1 },
        },
        { trial_index: 1, trial_id: 't1', plugin: 'p',
          t_load: 100, t_end: 200, initial_dom: '', events: [] },
      ],
    });
    const model = buildViewerModel(rec);
    assert.strictEqual(model.trials[1].camera.y, 500,
      'fold resynced from the seeded trial\'s view_state');
    assert.strictEqual(model.trials[1].camera.source, 'folded');
    assert.strictEqual(model.legacy, true,
      'any unseeded trial keeps the reduced-guarantees banner');
  });
});

describe('degradation', () => {
  it('a recording with no viewport at all still builds (nulls, not throws)', () => {
    const rec = baseRecording({ viewport: null, trials: [{
      trial_index: 0, trial_id: 't0', plugin: 'p',
      t_load: 0, t_end: 1, initial_dom: '', events: [],
    }] });
    const model = buildViewerModel(rec);
    assert.strictEqual(model.trials[0].camera.w, null);
    assert.strictEqual(model.legacy, true);
    assert.strictEqual(model.markerAttr, null);
  });
});
