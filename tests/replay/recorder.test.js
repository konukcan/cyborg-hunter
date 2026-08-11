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

  it('captures the viewport at startSession in the spec §2 ViewportState shape', () => {
    // One shape for the session-level `viewport` and for every
    // `viewport_changes` entry (capture-trace pushes the same object): the two
    // describe the same thing at different times, and a player folds them into
    // one timeline.
    const rec = freshRecorder();
    rec.startSession();
    const s = rec.getState();
    assert.deepStrictEqual(s.viewport,
      { w: 1280, h: 800, dpr: 2, scale: 1, offset_x: 0, offset_y: 0 });
  });

  it('keeps the documentElement client box beside it (CH vendor data)', () => {
    globalThis.document = { documentElement: { clientWidth: 1265, clientHeight: 800 } };
    const rec = freshRecorder();
    rec.startSession();
    assert.deepStrictEqual(rec.getState().viewportClient, { w: 1265, h: 800 });
    delete globalThis.document;
  });

  it('captures the user agent at startSession (spec §2)', () => {
    // Read from the ambient navigator, whatever it is (node supplies one too),
    // and always a string: strict validation types `user_agent` as one, and a
    // runtime without a navigator must not make the file unloadable.
    const expected = typeof navigator !== 'undefined' && navigator.userAgent
      ? String(navigator.userAgent) : '';
    const rec = freshRecorder();
    rec.startSession();
    assert.strictEqual(rec.getState().userAgent, expected);
    assert.strictEqual(typeof rec.getState().userAgent, 'string');
  });

  it('setObservedRoot records the selector of the observed subtree (spec §2)', () => {
    const rec = freshRecorder();
    rec.startSession();
    assert.strictEqual(rec.getState().observedRoot, null, 'null until DOM capture says otherwise');
    rec.setObservedRoot('#jspsych-content');
    assert.strictEqual(rec.getState().observedRoot, '#jspsych-content');
  });

  it('brackets events into the current trial', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushRecord({ type: 'mouse.click', x: 1, y: 2, button: 0, target: null });
    rec.endTrial();
    const s = rec.getState();
    assert.strictEqual(s.trials.length, 1);
    assert.strictEqual(s.trials[0].trialId, 't1');
    assert.strictEqual(s.trials[0].events.length, 1);
    assert.strictEqual(s.trials[0].events[0].type, 'mouse.click');
    assert.ok(typeof s.trials[0].events[0].t === 'number');
  });

  it('startTrial with an open trial auto-closes it and records a lifecycle failure', () => {
    // v1 pushed a `ch:lifecycle_error` EVENT. Spec §5.8 admits no vendor event
    // types in the stream, so the auditable marker moves to the capture-failure
    // channel, which the vendor extension already carries to the analyst.
    const rec = freshRecorder();
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.startTrial({ trialId: 't2' });   // forgot endTrial()
    rec.endTrial();
    const s = rec.getState();
    assert.strictEqual(s.trials.length, 2);
    const t1 = s.trials[0];
    assert.ok(t1.tEnd !== null, 'open trial must be auto-closed');
    assert.deepStrictEqual(t1.events, [], 'no vendor event type in the segment stream');
    assert.strictEqual(s.captureFailures[0].channel, 'lifecycle');
    assert.match(s.captureFailures[0].message, /startTrial_without_endTrial/);
    assert.strictEqual(s.trials[1].trialId, 't2');
  });

  it('unbracketed events create a single implicit trial', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.pushRecord({ type: 'mouse.move', x: 5, y: 5 });
    rec.pushRecord({ type: 'mouse.move', x: 6, y: 6 });
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
    for (let i = 0; i < 10; i++) rec.pushRecord({ type: 'mouse.move', x: i, y: i });
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
    rec.pushRecord({ type: 'mouse.move', x: 0, y: 0 });
    rec.stopSession('finished');
    const s = rec.getState();
    assert.strictEqual(s.captureFailures.length, 1);
    assert.strictEqual(s.captureFailures[0].channel, 'scroll');
    assert.match(s.captureFailures[0].message, /boom/);
    assert.strictEqual(s.trials[0].events.length, 1);
  });

  it('an open implicit trial is closed (not orphaned) by an explicit startTrial', () => {
    // An event arriving between startSession and the first startTrial (a click
    // on an instructions screen the researcher never bracketed) lazily opens an
    // implicit trial. The next explicit startTrial must CLOSE it — overwriting
    // currentTrial would silently orphan the event.
    const rec = freshRecorder();
    rec.startSession();
    rec.pushRecord({ type: 'mouse.move', x: 1, y: 1 });
    rec.startTrial({ trialId: 't1' });
    rec.endTrial();
    rec.stopSession('finished');
    const s = rec.getState();
    assert.strictEqual(s.trials.length, 2, 'implicit trial + explicit trial');
    assert.strictEqual(s.trials[0].implicit, true);
    assert.strictEqual(s.trials[0].events[0].type, 'mouse.move');
    assert.ok(s.trials[0].tEnd !== null, 'implicit trial must be closed');
    assert.strictEqual(s.trials[1].trialId, 't1');
  });

  it('stopSession closes an open implicit trial', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.pushRecord({ type: 'mouse.move', x: 1, y: 1 });
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
    rec.pushRecord({ type: 'mouse.move', x: 0, y: 0 });   // creates the implicit trial
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
    assert.throws(() => rec.pushRecord({ type: 'mouse.move', x: 0, y: 0 }), /destroyed/);
  });
});

describe('v2 sinks: pushRecord and pushViewportChange', () => {
  const VP = { w: 800, h: 600, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 };

  it('stamps the record time, even when the record carries one', () => {
    // `type` and `t` lead the wire, so the caller's fields merge after them —
    // which let a record carrying its own `t` silently override the stamp the
    // capture channel passed. Records never carry `t`; the sink owns it.
    const rec = freshRecorder();
    rec.startSession();
    rec.pushRecord({ type: 'mouse.move', x: 1, y: 2, t: 99999 }, 1234);
    const e = rec.getState().trials[0].events[0];
    assert.strictEqual(e.t, 1234);
    assert.deepStrictEqual(Object.keys(e), ['type', 't', 'x', 'y']);
  });

  it('drops a viewport state identical to the one before it', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.pushViewportChange(VP, 10);
    rec.pushViewportChange({ ...VP }, 20);          // same state, later time
    rec.pushViewportChange({ ...VP, scale: 2 }, 30); // a real change
    assert.deepStrictEqual(rec.getState().viewportChanges.map(c => c.t), [10, 30]);
  });

  it('caps the stream and records the drop once, without claiming truncation', () => {
    const rec = freshRecorder({ maxViewportChanges: 2 });
    rec.startSession();
    for (let i = 0; i < 10; i++) rec.pushViewportChange({ ...VP, w: 800 + i }, i);
    const s = rec.getState();
    assert.strictEqual(s.viewportChanges.length, 2);
    assert.strictEqual(s.captureFailures.length, 1);
    assert.match(s.captureFailures[0].message, /viewport/i);
    assert.strictEqual(s.captureStopped, false);
  });

  it('refuses pushes outside the recording window and after destroy', () => {
    const rec = freshRecorder();
    rec.pushViewportChange(VP, 1);           // before startSession
    rec.startSession();
    rec.pushViewportChange(VP, 2);
    rec.stopSession('finished');
    rec.pushViewportChange({ ...VP, w: 999 }, 3);
    assert.deepStrictEqual(rec.getState().viewportChanges.map(c => c.t), [2]);
    rec.destroy();
    assert.throws(() => rec.pushViewportChange(VP, 4), /destroyed/);
  });

  it('pushGuardViolation collects violations at session level, not in the stream', () => {
    // Spec §5.8: vendor events belong in `extensions`, never as unknown
    // top-level types, so v1's `ch:guard_violation` event becomes a
    // session-scoped entry the serializer files under the vendor namespace.
    // It keeps its `t`, so a viewer can still place it on the timeline.
    const rec = freshRecorder();
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushGuardViolation({ reason: 'not_fullscreen', phase: 'start' }, 500);
    const s = rec.getState();
    assert.deepStrictEqual(s.guardViolations,
      [{ reason: 'not_fullscreen', phase: 'start', t: 500 }]);
    assert.deepStrictEqual(s.trials[0].events, []);
  });

  it('pushGuardViolation is inert outside the recording window', () => {
    const rec = freshRecorder();
    rec.pushGuardViolation({ reason: 'x', phase: 'start' }, 1);
    rec.startSession();
    rec.stopSession('finished');
    rec.pushGuardViolation({ reason: 'y', phase: 'start' }, 2);
    assert.deepStrictEqual(rec.getState().guardViolations, []);
  });

  it('caps the guard-violation array and records the drop once, without claiming truncation', () => {
    // Same shape as the viewport cap above, and for the same reason: this array
    // outlives trials, so neither per-trial cap can see it — and every
    // phase:'start' entry carries a whole DOM tree.
    const rec = freshRecorder({ maxGuardViolations: 3 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    for (let i = 0; i < 10; i++) {
      rec.pushGuardViolation({ reason: 'not_fullscreen', phase: 'start' }, i);
    }
    const s = rec.getState();
    assert.strictEqual(s.guardViolations.length, 3);
    assert.deepStrictEqual(s.guardViolations.map(v => v.t), [0, 1, 2],
      'forward-only: the early violations are the ones kept');
    const failures = s.captureFailures.filter(f => f.channel === 'guard_violations');
    assert.strictEqual(failures.length, 1, 'the ceiling is recorded once, not per drop');
    assert.match(failures[0].message, /guard/i);
    assert.strictEqual(s.captureStopped, false,
      'a bounded vendor stream is not §5.7 truncation');
  });

  it('the guard-violation cap can be disabled', () => {
    const rec = freshRecorder({ maxGuardViolations: null });
    rec.startSession();
    for (let i = 0; i < 60; i++) rec.pushGuardViolation({ reason: 'x', phase: 'start' }, i);
    assert.strictEqual(rec.getState().guardViolations.length, 60);
    assert.deepStrictEqual(rec.getState().captureFailures, []);
  });
});

describe('capture stop and the keyframe size budget', () => {
  it('emits recording.capture_stopped ONCE per recording (spec §5.7)', () => {
    // v1 fired the sentinel per trial, which said "capture stopped" once for
    // every trial that hit a cap. §5.7 makes it one signal per recording, and
    // top-level `truncated` mirrors exactly that one. Per-trial RECOVERY is
    // unchanged: a fresh trial still captures.
    const rec = freshRecorder({ maxEventsPerTrial: 2 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    for (let i = 0; i < 5; i++) rec.pushRecord({ type: 'mouse.move', x: i, y: i });
    rec.endTrial();
    rec.startTrial({ trialId: 't2' });
    for (let i = 0; i < 5; i++) rec.pushRecord({ type: 'mouse.move', x: i, y: i });
    rec.endTrial();
    const s = rec.getState();
    const stops = s.trials.flatMap(t => t.events)
      .filter(e => e.type === 'recording.capture_stopped');
    assert.strictEqual(stops.length, 1, 'one stop signal for the whole recording');
    assert.strictEqual(s.trials[0].events.length, 3, 't1: 2 events + the signal');
    assert.strictEqual(s.trials[1].events.length, 2,
      't2 still captures up to its own cap, and adds no second signal');
    assert.strictEqual(s.captureStopped, true);
  });

  it('noteSnapshotChars seeds the per-trial character budget', () => {
    // The keyframe is stored on the trial, not pushed as an event, so the cap
    // cannot see it unless the capture module says how big it was. v1 seeded
    // from `initialDom.length`, which is meaningless now that the keyframe is
    // a TREE — an object's `.length` is undefined, and `undefined + n` is NaN,
    // so every comparison against the cap would silently read false.
    const rec = freshRecorder({ maxCharsPerTrial: 5000 });
    rec.onTrialStart((trial) => {
      trial.initialDom = { id: 1, kind: 'element', tag: 'div', attrs: {}, children: [] };
      rec.noteSnapshotChars(trial, 6000);
    });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushRecord({ type: 'mouse.move', x: 1, y: 1 });   // tiny, but already over
    assert.strictEqual(rec.getState().captureStopped, true);
  });

  it('a keyframe within budget leaves room for events', () => {
    const rec = freshRecorder({ maxCharsPerTrial: 5000 });
    rec.onTrialStart((trial) => { rec.noteSnapshotChars(trial, 100); });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushRecord({ type: 'mouse.move', x: 1, y: 1 });
    const s = rec.getState();
    assert.strictEqual(s.captureStopped, false);
    assert.strictEqual(s.trials[0].events.length, 1);
  });

  it('a trial starts with no keyframe and no seed (spec §3 continuation shape)', () => {
    const rec = freshRecorder();
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    const trial = rec.getState().trials[0];
    assert.strictEqual(trial.initialDom, null);
    assert.strictEqual(trial.initialState, null);
  });
});
