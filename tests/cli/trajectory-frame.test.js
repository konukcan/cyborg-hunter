import { describe, it } from 'node:test';
import assert from 'node:assert';
import { chooseScreenFrame, computeZoomTag } from '../../src/cli/renderers/trajectories.js';

// P7: the renderer's geometry-frame chooser. Three branches:
//   - 'screen-api': trusts metadata.screens (Window Management API), always draws both rects
//   - 'legacy': uses primaryScreenWidth/screenWidth, drops outer rect on paradox
//   - 'auto-fit': no screen metadata, fallback to mouse-bounds
//
// Tests cover backward compat (existing pre-P7 data still renders the same)
// AND the new disambiguation cases (zoom-out, multi-monitor, screen-api).
describe('chooseScreenFrame (P7)', () => {
  it('returns auto-fit when no metadata', () => {
    assert.equal(chooseScreenFrame(null).mode, 'auto-fit');
    assert.equal(chooseScreenFrame({}).mode, 'auto-fit');
  });

  it('legacy path: window fits inside screen → draws both rects (drawOuter true)', () => {
    // The common "everything is fine" case — current showcase data should look identical.
    const meta = {
      screenWidth: 1920, screenHeight: 1080,
      windowWidth: 1280, windowHeight: 800,
      windowX: 100, windowY: 50
    };
    const frame = chooseScreenFrame(meta);
    assert.equal(frame.mode, 'legacy');
    assert.equal(frame.drawOuter, true);
    assert.equal(frame.screenW, 1920);
  });

  it('legacy path: window exceeds screen (zoom-out paradox) → drops outer rect', () => {
    // Participant zoomed out: innerWidth becomes larger than the primary screen.
    // Pre-P7 renderer drew an impossible "screen smaller than window" picture.
    // P7 fix: drop the outer rect rather than draw a paradox.
    const meta = {
      screenWidth: 1280, screenHeight: 800,
      windowWidth: 1600, windowHeight: 1000,  // bigger than screen!
      windowX: 0, windowY: 0
    };
    const frame = chooseScreenFrame(meta);
    assert.equal(frame.mode, 'legacy');
    assert.equal(frame.drawOuter, false, 'outer rect should be suppressed');
  });

  it('legacy path: window on secondary monitor (windowX > screenWidth) → drops outer rect', () => {
    // Multi-monitor, browser on the second screen which the primary-only
    // screen.width fields can't see. windowX exceeds screenWidth.
    const meta = {
      screenWidth: 1920, screenHeight: 1080,
      windowWidth: 1280, windowHeight: 800,
      windowX: 2000, windowY: 100
    };
    const frame = chooseScreenFrame(meta);
    assert.equal(frame.drawOuter, false);
  });

  it('legacy path: prefers primaryScreenWidth alias over legacy screenWidth', () => {
    // Post-P7 collection renames screenWidth → primaryScreenWidth but keeps
    // screenWidth for one release as an alias. New name should win.
    const meta = {
      primaryScreenWidth: 1920, primaryScreenHeight: 1080,
      screenWidth: 999, screenHeight: 999,  // stale alias, should be ignored
      windowWidth: 1280, windowHeight: 800,
      windowX: 0, windowY: 0
    };
    const frame = chooseScreenFrame(meta);
    assert.equal(frame.screenW, 1920);
  });

  it('screen-api path: metadata.screens present → uses current screen, always draws outer', () => {
    // Window Management API gave us a labeled multi-screen layout. The window
    // sits on a secondary monitor; we render in its frame, not the primary's.
    const meta = {
      screens: [
        { label: 'primary', width: 1920, height: 1080, availLeft: 0, availTop: 0, isPrimary: true },
        { label: 'external', width: 2560, height: 1440, availLeft: 1920, availTop: 0, isPrimary: false }
      ],
      currentScreenLabel: 'external',
      windowX: 2200, windowY: 100,
      windowWidth: 1280, windowHeight: 800
    };
    const frame = chooseScreenFrame(meta);
    assert.equal(frame.mode, 'screen-api');
    assert.equal(frame.screenW, 2560, 'should use the external screen, not the primary');
    assert.equal(frame.drawOuter, true);
  });

  it('screen-api path: falls back to containing screen when label is missing', () => {
    const meta = {
      screens: [
        { width: 1920, height: 1080, availLeft: 0, availTop: 0, isPrimary: true },
        { width: 2560, height: 1440, availLeft: 1920, availTop: 0 }
      ],
      windowX: 2200, windowY: 100,
      windowWidth: 1280, windowHeight: 800
    };
    const frame = chooseScreenFrame(meta);
    assert.equal(frame.screenW, 2560, 'should pick the screen containing the window origin');
  });
});

describe('computeZoomTag (P7)', () => {
  it('returns null when no zoom metadata present (pre-P7 data)', () => {
    assert.equal(computeZoomTag(null), null);
    assert.equal(computeZoomTag({}), null);
    assert.equal(computeZoomTag({ screenWidth: 1920, windowWidth: 1280 }), null);
  });

  it('returns null when visualViewportScale is exactly 1', () => {
    assert.equal(computeZoomTag({ visualViewportScale: 1 }), null);
  });

  it('detects zoom-out via visualViewportScale', () => {
    assert.match(computeZoomTag({ visualViewportScale: 0.75 }), /zoom × 0\.75/);
  });

  it('detects zoom via outerWidth/innerWidth ratio when visualViewport is unavailable', () => {
    // outerWidth=1280, innerWidth=1600 → user zoomed out, viewport > chrome.
    const tag = computeZoomTag({ outerWidth: 1280, innerWidth: 1600 });
    assert.ok(tag, 'should detect zoom from outer/inner ratio');
    assert.match(tag, /zoom ×/);
  });

  it('does NOT flag normal browser chrome offset (small ratio deviation)', () => {
    // outerWidth=1300, innerWidth=1280 → normal chrome, no zoom.
    assert.equal(computeZoomTag({ outerWidth: 1300, innerWidth: 1280 }), null);
  });
});
