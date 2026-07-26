// F7: guard-friction requests
// fullscreen with a prefix fallback (requestFullscreen || webkitRequestFullscreen
// || mozRequestFullScreen) and getDiagnostics() reads a prefix-aware fullscreen
// element, but the AUTHORITATIVE check() / start() / resize-settling gate used
// only the unprefixed document.fullscreenElement. On a browser exposing ONLY
// the webkit/moz-prefixed API (Safari <16.4, some iOS WebViews), a participant
// who successfully enters fullscreen reads a null unprefixed element and gets
// trapped behind a permanent false 'not_fullscreen' violation.
//
// The fix extracts a pure, prefix-aware `fullscreenElementOf(doc)` used by all
// the gating code. This test pins that helper's behavior.

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';

let fullscreenElementOf;

before(async () => {
  // The core is an IIFE that runs at import time and touches window / DOM
  // prototypes / requestAnimationFrame, so bootstrap those globals first.
  const win = new Window();
  global.window = win;
  global.document = win.document;
  global.Node = win.Node;
  global.Document = win.Document;
  global.EventTarget = win.EventTarget;
  global.Event = win.Event;
  global.performance = win.performance || { now: () => Date.now() };
  global.requestAnimationFrame = win.requestAnimationFrame
    ? win.requestAnimationFrame.bind(win)
    : (cb) => setTimeout(() => cb(Date.now()), 0);
  ({ fullscreenElementOf } = await import('../../src/jspsych/extension-guard-friction.js'));
});

describe('F7 — prefix-aware fullscreen-element lookup', () => {
  const EL = { tagName: 'HTML' };

  it('reads the unprefixed fullscreenElement (modern browsers)', () => {
    assert.strictEqual(fullscreenElementOf({ fullscreenElement: EL }), EL);
  });

  it('falls back to webkitFullscreenElement (Safari <16.4, iOS WebViews)', () => {
    assert.strictEqual(fullscreenElementOf({ webkitFullscreenElement: EL }), EL);
  });

  it('falls back to mozFullScreenElement (older Firefox)', () => {
    assert.strictEqual(fullscreenElementOf({ mozFullScreenElement: EL }), EL);
  });

  it('returns null when no fullscreen element is present', () => {
    assert.strictEqual(fullscreenElementOf({ fullscreenElement: null }), null);
    assert.strictEqual(fullscreenElementOf({}), null);
  });

  it('prefers the unprefixed element when several are present', () => {
    const unpref = { tagName: 'UNPREF' };
    const webkit = { tagName: 'WEBKIT' };
    assert.strictEqual(
      fullscreenElementOf({ fullscreenElement: unpref, webkitFullscreenElement: webkit }),
      unpref);
  });
});
