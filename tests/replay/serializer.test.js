// tests/replay/serializer.test.js
// In-memory buffer (absolute performance.now) → SessionRecording v1 wire
// format (ms since session start) + ch_extensions merge.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { serialize } from '../../src/replay/serializer.js';

// A hand-built recorder state (what recorder.getState() returns).
function state(overrides) {
  return {
    participantId: 'P1',
    tier: 'dom',
    keys: 'full',
    sessionStart: 10000,             // performance.now() at startSession
    sessionStartEpoch: 1751600000000,
    viewport: { width: 1280, height: 800, dpr: 2, visual_viewport: null },
    stylesheets: [{ css: '.a{}' }],
    trials: [
      {
        trialIndex: 0, trialId: 'rule-1', plugin: 'html-button-response',
        implicit: false,
        tLoad: 11000, tStart: 10950, tDomReady: 10990, tEnd: 15000,
        initialDom: '<div>stim</div>',
        events: [
          { t: 11500, kind: 'mousemove', x: 5, y: 5 },
          { t: 12000, kind: 'paste', len: 42 },
        ],
      },
      {
        trialIndex: 1, trialId: '__session__', plugin: 'ch:standalone',
        implicit: true,
        tLoad: 15000, tStart: null, tDomReady: null, tEnd: null,
        initialDom: '',
        events: [{ t: 16000, kind: 'click', x: 1, y: 2 }],
      },
    ],
    guardViolations: [],
    captureFailures: [{ channel: 'scroll', message: 'boom', t: 12500 }],
    captureStopped: false,
    endReason: 'finished',
    state: 'stopped',
  };
}

describe('serialize → SessionRecording v1', () => {
  it('produces the v1 shell with session-relative timestamps', () => {
    const rec = serialize(state(), {});
    assert.strictEqual(rec.schema_version, 1);
    assert.strictEqual(rec.metadata.participant_id, 'P1');
    assert.strictEqual(rec.metadata.tier, 'dom');
    assert.strictEqual(rec.metadata.end_reason, 'finished');
    assert.match(rec.metadata.recorder, /^cyborg-hunter-replay@/);
    // start_time is wall-clock ISO from the epoch capture
    assert.strictEqual(rec.metadata.start_time, new Date(1751600000000).toISOString());
    assert.deepStrictEqual(rec.rng_calls, []);
    assert.strictEqual(rec.viewport.width, 1280);
    assert.strictEqual(rec.stylesheets.initial.length, 1);

    const t0 = rec.trials[0];
    assert.strictEqual(t0.trial_index, 0);
    assert.strictEqual(t0.trial_id, 'rule-1');
    assert.strictEqual(t0.t_load, 1000);          // 11000 − 10000
    assert.strictEqual(t0.t_start, 950);
    assert.strictEqual(t0.t_end, 5000);
    assert.strictEqual(t0.events[0].t, 1500);     // 11500 − 10000
    assert.strictEqual(t0.events[0].kind, 'mousemove');
    assert.deepStrictEqual(t0.trial_data, {});
  });

  it('implicit trials carry null t_start/t_dom_ready and open t_end falls back to last event', () => {
    const rec = serialize(state(), {});
    const t1 = rec.trials[1];
    assert.strictEqual(t1.t_start, null);
    assert.strictEqual(t1.t_dom_ready, null);
    assert.strictEqual(t1.t_end, 6000, 'open trial closes at its last event time');
  });

  it('events are sorted by t within each trial', () => {
    const s = state();
    s.trials[0].events = [
      { t: 12000, kind: 'paste', len: 1 },
      { t: 11500, kind: 'mousemove', x: 1, y: 1 },
    ];
    const rec = serialize(s, {});
    assert.deepStrictEqual(rec.trials[0].events.map(e => e.kind), ['mousemove', 'paste']);
  });

  it('merges CH session report into ch_extensions (no trial_derived)', () => {
    const chSessionReport = {
      libraryVersion: '0.6.0',
      config: { preset: 'standard', participantId: 'P1' },
      hardScore: { paste: { count: 3, threshold: 2, triggered: true } },
      softScore: 7, softScoreThreshold: 6, anyHardTriggered: true, trialsCompleted: 2,
      sidebarEvents: [{ t: 11800, type: 'opened', deltaIW: 340 }],
      aiExtensionsFound: [{ name: 'Monica AI', t: 10100 }],
      devToolsEvents: [], windowPositions: [], layoutShifts: [], zoomChanges: [],
      keyboardShortcuts: [], idleGaps: [], extensionInjections: [],
      pasteCount: 3, copyCount: 0, dropCount: 0, tabAwaySums: [], charsPerSec: [],
    };
    const rec = serialize(state(), { chSessionReport });
    const ext = rec.ch_extensions;
    assert.strictEqual(ext.ch_version, '0.6.0');
    assert.strictEqual(ext.preset, 'standard');
    assert.strictEqual(ext.scoring.soft_score, 7);
    assert.strictEqual(ext.scoring.any_hard_triggered, true);
    // session signals converted to session-relative time too
    assert.strictEqual(ext.session_signals.sidebar_events[0].t, 1800);
    assert.strictEqual(ext.session_signals.ai_extensions_found[0].name, 'Monica AI');
    assert.strictEqual(ext.trial_derived, undefined, 'trial_derived was cut by design review');
  });

  it('omits scoring when no CH report is provided (standalone use)', () => {
    const rec = serialize(state(), {});
    assert.strictEqual(rec.ch_extensions.scoring, null);
    assert.deepStrictEqual(rec.ch_extensions.capture_failures.length, 1);
  });

  it('throws a clear error when serialized before startSession', () => {
    // Direct serialize/getRecording before startSession is a programmer
    // error (there is no timestamp base) and fails loudly. The teardown
    // path (autoSaveNow) degrades to a no_session result instead — see
    // extension.test.js "finalize before any trial".
    const s0 = state();
    s0.sessionStart = null;    // never started
    s0.sessionStartEpoch = null;
    assert.throws(() => serialize(s0, {}), /startSession/,
      'serializing a pre-session recorder must fail loudly, not emit epoch timestamps');
  });

  it('end_time never precedes start_time (empty recording)', () => {
    const s0 = state();
    s0.trials = [];
    const rec = serialize(s0, {});
    assert.ok(Date.parse(rec.metadata.end_time) >= Date.parse(rec.metadata.start_time));
  });

  it('is JSON-round-trip stable', () => {
    const rec = serialize(state(), {});
    const again = JSON.parse(JSON.stringify(rec));
    assert.deepStrictEqual(again, rec);
  });
});
