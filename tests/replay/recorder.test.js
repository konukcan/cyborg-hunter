// tests/replay/recorder.test.js
// Recorder engine: lifecycle, event buffer, caps, teardown.
// The engine is DOM-free by construction — capture modules (which touch the
// DOM) attach through its listener registry, so these tests run in plain node.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createRecorder } from '../../src/replay/recorder.js';

// Minimal window stub: startSession reads viewport geometry if available.
beforeEach(() => {
  globalThis.window = {
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2,
  };
});

function freshRecorder(overrides) {
  return createRecorder({ participantId: 'P1', ...overrides });
}

describe('recorder lifecycle', () => {
  it('enforces call order: startTrial before startSession throws', () => {
    const rec = freshRecorder();
    assert.throws(() => rec.startTrial({ trialId: 't1' }), /startSession/);
  });

  it('captures viewport at startSession', () => {
    const rec = freshRecorder();
    rec.startSession();
    const s = rec.getState();
    assert.deepStrictEqual(
      { w: s.viewport.width, h: s.viewport.height, dpr: s.viewport.dpr },
      { w: 1280, h: 800, dpr: 2 });
  });

  it('brackets events into the current trial', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushEvent('click', { x: 1, y: 2 });
    rec.endTrial();
    const s = rec.getState();
    assert.strictEqual(s.trials.length, 1);
    assert.strictEqual(s.trials[0].trialId, 't1');
    assert.strictEqual(s.trials[0].events.length, 1);
    assert.strictEqual(s.trials[0].events[0].kind, 'click');
    assert.ok(typeof s.trials[0].events[0].t === 'number');
  });

  it('startTrial with an open trial auto-closes it and logs ch:lifecycle_error', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.startTrial({ trialId: 't2' });   // forgot endTrial()
    rec.endTrial();
    const s = rec.getState();
    assert.strictEqual(s.trials.length, 2);
    const t1 = s.trials[0];
    assert.ok(t1.tEnd !== null, 'open trial must be auto-closed');
    assert.strictEqual(t1.events[t1.events.length - 1].kind, 'ch:lifecycle_error');
    assert.strictEqual(s.trials[1].trialId, 't2');
  });

  it('unbracketed events create a single implicit trial', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.pushEvent('mousemove', { x: 5, y: 5 });
    rec.pushEvent('keydown', { key: 'a' });
    rec.stopSession('finished');
    const s = rec.getState();
    assert.strictEqual(s.trials.length, 1);
    assert.strictEqual(s.trials[0].implicit, true);
    assert.strictEqual(s.trials[0].events.length, 2);
    assert.strictEqual(s.endReason, 'finished');
  });

  it('event cap stops capture with one recording.capture_stopped marker', () => {
    const rec = freshRecorder({ maxEventsPerTrial: 3 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    for (let i = 0; i < 10; i++) rec.pushEvent('mousemove', { x: i, y: i });
    rec.endTrial();
    const s = rec.getState();
    const events = s.trials[0].events;
    assert.strictEqual(events.length, 4, '3 events + 1 stop marker');
    // Spec §5.7's standard total-stop signal; the configured limit that was
    // crossed is CH diagnostics, so it rides in the vendor namespace (§9).
    assert.strictEqual(events[3].type, 'recording.capture_stopped');
    assert.strictEqual(events[3].reason, 'buffer_limit');
    assert.deepStrictEqual(events[3].extensions, { 'cyborg-hunter': { limit_events: 3 } });
    assert.strictEqual(s.captureStopped, true);
  });

  it('captureFailure records the channel and disables nothing else', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.captureFailure('scroll', new Error('boom'));
    rec.pushEvent('click', { x: 0, y: 0 });
    rec.stopSession('finished');
    const s = rec.getState();
    assert.strictEqual(s.captureFailures.length, 1);
    assert.strictEqual(s.captureFailures[0].channel, 'scroll');
    assert.match(s.captureFailures[0].message, /boom/);
    assert.strictEqual(s.trials[0].events.length, 1);
  });

  it('an open implicit trial is closed (not orphaned) by an explicit startTrial', () => {
    // A session-scoped event (e.g. a guard violation between startSession
    // and the first startTrial) lazily opens an implicit trial. The next
    // explicit startTrial must CLOSE it — overwriting currentTrial would
    // silently orphan the event.
    const rec = freshRecorder();
    rec.startSession();
    rec.pushEvent('ch:guard_violation', { reason: 'not_fullscreen', phase: 'start' });
    rec.startTrial({ trialId: 't1' });
    rec.endTrial();
    rec.stopSession('finished');
    const s = rec.getState();
    assert.strictEqual(s.trials.length, 2, 'implicit trial + explicit trial');
    assert.strictEqual(s.trials[0].implicit, true);
    assert.strictEqual(s.trials[0].events[0].kind, 'ch:guard_violation');
    assert.ok(s.trials[0].tEnd !== null, 'implicit trial must be closed');
    assert.strictEqual(s.trials[1].trialId, 't1');
  });

  it('stopSession closes an open implicit trial', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.pushEvent('click', { x: 1, y: 1 });
    rec.stopSession('finished');
    const s = rec.getState();
    assert.ok(s.trials[0].tEnd !== null, 'implicit trial closed at stopSession');
  });

  it('onTrialStart hooks fire for explicit and implicit trials', () => {
    const rec = freshRecorder();
    const seen = [];
    rec.onTrialStart((trial) => seen.push(trial.trialId));
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.endTrial();
    rec.pushEvent('click', {});          // creates the implicit trial
    assert.deepStrictEqual(seen, ['t1', '__session__']);
  });

  it('setStylesheets stores the initial stylesheet capture', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.setStylesheets([{ css: '.a{}' }, { href: 'https://x/y.css' }]);
    assert.strictEqual(rec.getState().stylesheets.length, 2);
  });

  it('destroy removes every registered listener and clears intervals', () => {
    const rec = freshRecorder();
    rec.startSession();
    const calls = [];
    const target = {
      addEventListener: (ev, fn, opts) => calls.push(['add', ev]),
      removeEventListener: (ev, fn, opts) => calls.push(['remove', ev]),
    };
    rec.addListener(target, 'pointerdown', () => {}, { passive: true });
    rec.addListener(target, 'keyup', () => {});
    const id = setInterval(() => {}, 3600000);
    rec.addInterval(id);
    rec.destroy();
    const adds = calls.filter(c => c[0] === 'add').map(c => c[1]);
    const removes = calls.filter(c => c[0] === 'remove').map(c => c[1]);
    assert.deepStrictEqual(adds.sort(), removes.sort(),
      'every add must have a matching remove');
    assert.throws(() => rec.pushEvent('click', {}), /destroyed/);
  });
});
