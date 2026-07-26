// F10: GuardHoneypot.init()
// re-injected the DOM and re-subscribed to friction idempotently, but did NOT
// reset the accumulated forensic state (violations, currentViolation,
// trialViolationStartIdx) or the bait-field values. A second init() in the
// same page — jsPsych preview, a restart, or two experiments sharing a tab —
// therefore inherited the first run's violation evidence and AI disclosures.
//
// The honeypot core is an IIFE that attaches window.GuardHoneypot at import
// time, so we bootstrap happy-dom globals BEFORE importing, once, and reuse the
// same window (GuardHoneypot is defined non-configurable on it).

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';

let GuardHoneypot, win;

before(async () => {
  win = new Window();
  global.window = win;
  global.document = win.document;
  global.Node = win.Node;
  global.Document = win.Document;
  global.EventTarget = win.EventTarget;
  global.Event = win.Event;
  global.performance = win.performance || { now: () => Date.now() };
  await import('../../src/jspsych/extension-guard-honeypot.js');
  GuardHoneypot = win.GuardHoneypot;
});

// A fake friction module: captures the honeypot's onViolation callback so a
// test can feed violation events directly, without the real friction plugin.
function fakeFriction() {
  let cb = null;
  return {
    onViolation(fn) { cb = fn; return () => { cb = null; }; },
    emit(event) { if (cb) cb(event); },
  };
}

describe('F10 — honeypot re-init clears prior-run state', () => {
  it('a fresh init() does not inherit the previous run\'s violations', () => {
    const friction = fakeFriction();

    GuardHoneypot.init({ jsPsych: null, friction });
    friction.emit({ phase: 'start', reason: 'not_fullscreen', t: 10 });
    friction.emit({ phase: 'end', reason: 'not_fullscreen', t: 20, duration: 10 });
    assert.equal(
      GuardHoneypot.getSessionSummary().guard_assistance_violation_count_session, 1,
      'sanity: the first run recorded one violation');

    // Second run in the same page (preview / restart).
    GuardHoneypot.init({ jsPsych: null, friction });
    assert.equal(
      GuardHoneypot.getSessionSummary().guard_assistance_violation_count_session, 0,
      'a fresh init() must not carry the prior run\'s violations');
    assert.equal(GuardHoneypot.getViolations().length, 0);
  });

  it('a fresh init() clears prior-run bait-field disclosures', () => {
    const friction = fakeFriction();
    GuardHoneypot.init({ jsPsych: null, friction });

    // Simulate an AI agent tripping the bait in the first run.
    win.document.getElementById('fg-ai-use').checked = true;
    win.document.getElementById('fg-ai-report').value = 'ai-agent answered the task';
    assert.equal(GuardHoneypot.getHoneypotData().ai_use, true, 'sanity: bait tripped');

    GuardHoneypot.init({ jsPsych: null, friction });
    const hp = GuardHoneypot.getHoneypotData();
    assert.equal(hp.ai_use, false, 'ai_use flag must reset on a fresh init()');
    assert.equal(hp.ai_report, '', 'ai_report must reset on a fresh init()');
  });

  it('the per-trial violation window also resets across runs', () => {
    const friction = fakeFriction();

    GuardHoneypot.init({ jsPsych: null, friction });
    friction.emit({ phase: 'start', reason: 'tab_hidden', t: 5 });
    friction.emit({ phase: 'end', reason: 'tab_hidden', t: 8, duration: 3 });
    GuardHoneypot.getTrialDataSnapshot(); // advances trialViolationStartIdx

    GuardHoneypot.init({ jsPsych: null, friction });
    // After reset, a new violation must be visible to the first trial snapshot.
    friction.emit({ phase: 'start', reason: 'window_blurred', t: 12 });
    friction.emit({ phase: 'end', reason: 'window_blurred', t: 15, duration: 3 });
    const snap = GuardHoneypot.getTrialDataSnapshot();
    assert.equal(snap.guard_assistance_violation_count, 1,
      'the new run\'s first trial must see its own violation, not zero');
  });
});
