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
let exitFullscreenFnOf;

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
  ({ fullscreenElementOf, exitFullscreenFnOf } = await import('../../src/jspsych/extension-guard-friction.js'));
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

// exitFullscreen() is requestFullscreen()'s
// counterpart on the exit side, so exitFullscreenFnOf(doc) mirrors
// fullscreenElementOf(doc) above — same prefix fallback order, same pure/
// exported shape for unit testing without a real browser. It returns the
// METHOD unbound: every real caller must invoke it as fn.call(document),
// because document.exitFullscreen is a native method that throws "Illegal
// invocation" when called detached. That receiver requirement is easy to
// get wrong silently, because demo/tests/helpers.mjs's fullscreenMock
// patches document.exitFullscreen with a plain closure that works fine even
// when called unbound — so the last case here pins the receiver directly,
// the one thing a green demo E2E suite would NOT catch if it regressed.
describe('exitFullscreenFnOf — prefix-aware exit-fullscreen lookup', () => {
  const unpref = function () {};
  const webkit = function () {};
  const moz = function () {};

  it('returns the unprefixed exitFullscreen (modern browsers)', () => {
    assert.strictEqual(exitFullscreenFnOf({ exitFullscreen: unpref }), unpref);
  });

  it('falls back to webkitExitFullscreen (Safari <16.4, iOS WebViews)', () => {
    assert.strictEqual(exitFullscreenFnOf({ webkitExitFullscreen: webkit }), webkit);
  });

  it('falls back to mozCancelFullScreen (older Firefox)', () => {
    assert.strictEqual(exitFullscreenFnOf({ mozCancelFullScreen: moz }), moz);
  });

  it('returns null when no exit-fullscreen method is present', () => {
    assert.strictEqual(exitFullscreenFnOf({}), null);
  });

  it('prefers the unprefixed method when several are present', () => {
    assert.strictEqual(
      exitFullscreenFnOf({ exitFullscreen: unpref, webkitExitFullscreen: webkit, mozCancelFullScreen: moz }),
      unpref);
  });

  it('the returned function receives the document as its receiver when invoked as fn.call(doc)', () => {
    // Pins the .call(document) contract: a real caller does
    // `exitFullscreenFnOf(document).call(document)`. If the helper ever
    // returned a bound/wrapped function instead of the raw method, `this`
    // inside it could silently stop being the doc object passed at the call
    // site — this test fails loudly if that happens.
    const doc = {};
    let receiver = null;
    doc.exitFullscreen = function () { receiver = this; };
    exitFullscreenFnOf(doc).call(doc);
    assert.strictEqual(receiver, doc);
  });
});
