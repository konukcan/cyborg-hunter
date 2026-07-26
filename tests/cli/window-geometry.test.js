import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pickWindowGeometryForTrial, chooseScreenFrame, computeZoomScale } from '../../src/cli/renderers/trajectories.js';

// Companion fix to task #25 (window-vs-viewport nested rectangles).
// trajectories.js already had chooseScreenFrame() that knows how to draw
// nested rectangles when given metadata.{screenWidth,screenHeight,windowX,Y,W,H}.
// What was missing: a step that translates session.windowPositions[] (the
// 2-second-poll samples from core/signals/browser.js) into that per-trial
// metadata shape, picking the sample whose timestamp is nearest the trial's
// trialStart_perfNow anchor.

describe('pickWindowGeometryForTrial', () => {
  const samples = [
    { x: 50,   y: 0,  w: 1200, h: 800, iw: 1180, ih: 760, sw: 2560, sh: 1440, t: 1000 },
    { x: 50,   y: 0,  w: 1200, h: 800, iw: 1180, ih: 760, sw: 2560, sh: 1440, t: 3000 },
    { x: 800,  y: 0,  w: 800,  h: 800, iw: 780,  ih: 760, sw: 2560, sh: 1440, t: 5000 },
  ];

  it('returns the sample closest in time to the trial start', () => {
    // Trial starting at t=2900 → closest sample is t=3000 (delta 100).
    const g = pickWindowGeometryForTrial({ trialStart_perfNow: 2900 }, samples);
    assert.equal(g.windowX, 50);
    assert.equal(g.windowWidth, 1200);
    assert.equal(g.screenWidth, 2560);
  });

  it('handles a trial that starts after the last sample', () => {
    // Trial starting at t=10000 → closest sample is t=5000 (last one).
    const g = pickWindowGeometryForTrial({ trialStart_perfNow: 10000 }, samples);
    assert.equal(g.windowX, 800);
    assert.equal(g.windowWidth, 800);
  });

  it('produces the field shape that chooseScreenFrame and computeZoomScale expect', () => {
    // chooseScreenFrame reads: screenWidth, screenHeight, windowX, windowY,
    // windowWidth, windowHeight.
    // computeZoomScale needs BOTH axes: outerWidth/innerWidth AND
    // outerHeight/innerHeight (chrome asymmetry → x and y zoom factors
    // genuinely differ; an earlier version dropped the heights and silently
    // disabled Y scaling, plotting mouse Y outside the outline).
    const g = pickWindowGeometryForTrial({ trialStart_perfNow: 1000 }, samples);
    for (const k of ['screenWidth', 'screenHeight', 'windowX', 'windowY',
                     'windowWidth', 'windowHeight',
                     'outerWidth', 'outerHeight', 'innerWidth', 'innerHeight']) {
      assert.ok(k in g, `missing field: ${k}`);
    }
  });

  it('integrates with computeZoomScale to yield non-identity Y when zoom present', () => {
    // End-to-end check that the geometry passed to computeZoomScale gives
    // both axes scaled when the underlying sample has all four dimensions.
    // Catches the missing-height-field regression directly.
    const sample = { x: 50, y: 6, w: 3372, h: 1440, iw: 3666, ih: 1691, t: 50000 };
    const g = pickWindowGeometryForTrial({ trialStart_perfNow: 50000 }, [sample]);
    const z = computeZoomScale(g);
    assert.notEqual(z.x, 1, 'x scale should be inferred (zoom present)');
    assert.notEqual(z.y, 1, 'y scale should be inferred (zoom present) — was failing because pickWindowGeometryForTrial dropped outerHeight/innerHeight');
    assert.equal(z.x.toFixed(3), '0.920');
    assert.equal(z.y.toFixed(3), '0.852');
  });

  it('prefers a fitting sample over closest-in-time when mouse extent demands it', () => {
    // Trial that spans a window resize. Sample A is closer in time but mouse
    // exceeds its viewport; Sample B fits the mouse extent. Picker should
    // prefer fit over time-proximity. This covers the round-3-style case
    // from quillien verification, where a trial straddled a resize.
    const trial = {
      trialStart_perfNow: 1100,
      duration_ms: 2000,
      mouseEvents: [{ type: 'move', x: 2400, y: 100 }],
    };
    const inRangeSamples = [
      // A: closer in time (Δt=100), mouse 2400 * (1500/2000) = 1800 > 1500 (NO FIT)
      { t: 1000, x: 0, y: 0, w: 1500, h: 800, iw: 2000, ih: 1000 },
      // B: farther in time (Δt=900), mouse 2400 * (1500/2500) = 1440 < 1500 (fits)
      { t: 2000, x: 0, y: 0, w: 1500, h: 800, iw: 2500, ih: 1200 },
    ];
    const g = pickWindowGeometryForTrial(trial, inRangeSamples);
    assert.equal(g.innerWidth, 2500, 'should pick the fitting sample (B), not the closer-in-time one (A)');
  });

  it('falls back to largest-viewport sample when no in-range sample fits', () => {
    // No sample's viewport is large enough for the mouse. Picker takes the
    // one with the largest viewport area (mouse will overflow least).
    const trial = {
      trialStart_perfNow: 1500,
      duration_ms: 1000,
      mouseEvents: [{ type: 'move', x: 5000, y: 5000 }],
    };
    const samples = [
      { t: 1000, x: 0, y: 0, w: 1500, h: 800, iw: 1500, ih: 800 },   // small
      { t: 2000, x: 0, y: 0, w: 1500, h: 800, iw: 2000, ih: 1200 },  // larger viewport
    ];
    const g = pickWindowGeometryForTrial(trial, samples);
    assert.equal(g.innerWidth, 2000, 'should pick the larger-viewport sample');
  });

  it('returns null when windowPositions is empty', () => {
    assert.equal(pickWindowGeometryForTrial({ trialStart_perfNow: 1000 }, []), null);
  });

  it('returns null when the trial has no time anchor', () => {
    assert.equal(pickWindowGeometryForTrial({}, samples), null);
  });

  it('passes through dpr and vvScale when present on sample', () => {
    const samples = [{
      x: 0, y: 0, w: 1200, h: 800, iw: 1180, ih: 760,
      sw: 2560, sh: 1440, dpr: 2, vvScale: 1.0, t: 1000
    }];
    const g = pickWindowGeometryForTrial({ trialStart_perfNow: 1000 }, samples);
    assert.equal(g.devicePixelRatio, 2);
    assert.equal(g.visualViewportScale, 1.0);
  });

  it('omits screenWidth/screenHeight when sample lacks them (pre-monitor-fix data)', () => {
    // Old samples (before April 2026 sw/sh addition) only had x/y/w/h/iw/ih.
    // We should still populate window* fields so the inner rectangle draws,
    // but leave screen* unset — chooseScreenFrame will fall back to its
    // compatibility/auto-fit branches without inventing a screen size.
    const old = [{ x: 0, y: 0, w: 1200, h: 800, iw: 1180, ih: 760, t: 1000 }];
    const g = pickWindowGeometryForTrial({ trialStart_perfNow: 1000 }, old);
    assert.equal(g.windowWidth, 1200);
    assert.equal(g.screenWidth, undefined);
    assert.equal(g.screenHeight, undefined);
  });
});

describe('chooseScreenFrame: window-only branch', () => {
  // April 2026: added a 4th branch that draws ONLY the window rectangle when
  // metadata has window geometry but no screen dimensions. The pre-existing
  // legacy branch required screenWidth/screenHeight to draw anything at all,
  // so jsPsych extension recordings made before the monitor's screen.width
  // capture went silently into auto-fit (no rectangles drawn).

  it('returns window-only mode when window data present but screen absent', () => {
    const f = chooseScreenFrame({
      windowX: 50, windowY: 6, windowWidth: 1200, windowHeight: 800,
    });
    assert.equal(f.mode, 'window-only');
    assert.equal(f.winX, 50);
    assert.equal(f.winW, 1200);
    assert.equal(f.drawOuter, false, 'no screen rect when no screen data');
  });

  it('still picks legacy when both window AND screen are present', () => {
    const f = chooseScreenFrame({
      screenWidth: 2560, screenHeight: 1440,
      windowX: 50, windowY: 6, windowWidth: 1200, windowHeight: 800,
    });
    assert.equal(f.mode, 'legacy');
    assert.equal(f.drawOuter, true);
  });

  it('still falls back to auto-fit when nothing is known', () => {
    assert.equal(chooseScreenFrame({}).mode, 'auto-fit');
    assert.equal(chooseScreenFrame(null).mode, 'auto-fit');
  });

  it('window-only requires positive windowWidth (rejects zero/negative)', () => {
    assert.equal(chooseScreenFrame({ windowWidth: 0, windowHeight: 800 }).mode, 'auto-fit');
    assert.equal(chooseScreenFrame({ windowWidth: -100, windowHeight: 800 }).mode, 'auto-fit');
  });
});

describe('computeZoomTag', () => {
  // Imported lazily to keep the import line at the top of the file shorter.
  // Regression: the divisor used to be `windowWidth ?? innerWidth`, but in our
  // pipeline `windowWidth` is an alias for `outerWidth`. That made the ratio
  // outerWidth/outerWidth = 1 every time, so the tag never appeared on
  // jsPsych extension data even when the participant was clearly zoomed.
  it('flags zoom-out when innerWidth > outerWidth, even with windowWidth alias present', async () => {
    const { computeZoomTag } = await import('../../src/cli/renderers/trajectories.js');
    // Real shape from quillien-verify: 80% zoom, windowWidth aliased to outerWidth.
    const tag = computeZoomTag({ outerWidth: 3372, innerWidth: 4215, windowWidth: 3372, windowHeight: 1440 });
    assert.ok(tag, 'should produce a tag string for clearly-zoomed data');
    assert.match(tag, /zoom × 1\.\d{2}/);
  });

  it('returns null when zoom is within ±10% of 100% (no false alarms)', async () => {
    const { computeZoomTag } = await import('../../src/cli/renderers/trajectories.js');
    // Typical 100% zoom with normal scrollbar offset (~17px on macOS).
    assert.equal(computeZoomTag({ outerWidth: 1200, innerWidth: 1183 }), null);
  });

  it('prefers visualViewport.scale when present (more direct than the inferred ratio)', async () => {
    const { computeZoomTag } = await import('../../src/cli/renderers/trajectories.js');
    const tag = computeZoomTag({ visualViewportScale: 1.5, outerWidth: 1200, innerWidth: 1200 });
    assert.equal(tag, 'zoom × 1.50');
  });
});

describe('computeZoomScale', () => {
  // CSS-level browser zoom isn't directly readable from JS, but we can infer
  // it from outerWidth (window frame, fixed in screen pixels) vs innerWidth
  // (viewport, scales with zoom). Mouse coords are in viewport CSS pixels;
  // the window outline is in screen pixels. Multiplying mouse coords by
  // outer/inner makes them line up with the outline regardless of zoom.

  it('returns separate {x, y} scales (chrome makes them differ on macOS)', () => {
    // Real macOS data at 92% CSS zoom: outer 3372x1440, inner 3666x1691.
    // X ratio = 3372/3666 = 0.92 (no horizontal chrome → matches CSS zoom).
    // Y ratio = 1440/1691 = 0.85 (vertical chrome ~80px → smaller ratio).
    // Without per-axis scales, mouse Y plots outside the outline.
    const z = computeZoomScale({ outerWidth: 3372, innerWidth: 3666, outerHeight: 1440, innerHeight: 1691 });
    assert.equal(z.x.toFixed(3), '0.920');
    assert.equal(z.y.toFixed(3), '0.852');
  });

  it('returns identity {1, 1} when dimensions missing', () => {
    assert.deepEqual(computeZoomScale({}), { x: 1, y: 1 });
    assert.deepEqual(computeZoomScale(null), { x: 1, y: 1 });
  });

  it('returns identity per-axis independently when only one axis is missing', () => {
    // Width data present, height missing → x is computed, y falls back to 1.
    const z = computeZoomScale({ outerWidth: 1200, innerWidth: 1500 });
    assert.equal(z.x, 0.8);
    assert.equal(z.y, 1);
  });

  it('returns identity when dimension is non-positive (defensive)', () => {
    const z = computeZoomScale({ outerWidth: 0, innerWidth: 1200, outerHeight: -1, innerHeight: 800 });
    assert.equal(z.x, 1);
    assert.equal(z.y, 1);
  });
});
