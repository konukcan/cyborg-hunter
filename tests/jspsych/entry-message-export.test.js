// B4: the demo's guard-entry step renders the library's own entry message
// verbatim (truth-by-construction — never a drifting copy of it). That
// requires the frozen GuardFriction public API to expose the string it
// already uses internally as createEntryTrial()'s default `message`.
//
// The core is an IIFE that runs at import time and touches window / DOM
// prototypes, so bootstrap happy-dom globals BEFORE importing — same
// pattern as tests/jspsych/guard-friction-fullscreen.test.js.

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';

before(async () => {
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
  await import('../../src/jspsych/extension-guard-friction.js');
});

describe('GuardFriction.defaultEntryMessage export', () => {
  it('exposes its default entry message as a string', () => {
    assert.strictEqual(typeof window.GuardFriction.defaultEntryMessage, 'string');
  });

  it('includes the fullscreen requirement copy', () => {
    assert.ok(window.GuardFriction.defaultEntryMessage.includes('Fullscreen mode required'));
  });

  it('includes the AI-assistant prohibition copy', () => {
    assert.ok(window.GuardFriction.defaultEntryMessage.includes('AI assistants'));
  });
});
