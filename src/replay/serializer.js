// src/replay/serializer.js
// In-memory recorder state → SessionRecording v1 (jsPsych PR #3661 wire
// format) with a ch_extensions namespace for CH-only data.
//
// This is one of exactly two places in the system that convert time bases
// (the other is the CLI ingest): in-memory events carry absolute
// performance.now() values; the wire carries ms-since-session-start.

import { VERSION } from '../shared/constants.js';

// Convert an absolute performance.now() value to wire time (ms since
// session start), rounded to 1 decimal to keep JSON compact.
function wireT(t, sessionStart) {
  if (t == null) return null;
  return Math.round((t - sessionStart) * 10) / 10;
}

// Session-scoped CH arrays whose entries carry absolute `t` — converted to
// session-relative on the way into ch_extensions.
function convertTimes(entries, sessionStart) {
  return (entries || []).map(function (e) {
    var out = Object.assign({}, e);
    if (typeof out.t === 'number') out.t = wireT(out.t, sessionStart);
    if (typeof out.start === 'number') out.start = wireT(out.start, sessionStart);
    return out;
  });
}

/**
 * @param {Object} state - recorder.getState() output
 * @param {Object} opts - { chSessionReport } — pull-model CH merge; the
 *   caller (jsPsych adapter or researcher) provides CH's session report,
 *   the serializer never reaches into CH itself.
 */
export function serialize(state, opts) {
  opts = opts || {};
  var s0 = state.sessionStart;
  if (s0 == null) {
    throw new Error('[cyborg-hunter-replay] cannot serialize before startSession() — call startSession() first, or the timestamps would be meaningless (Unix epoch).');
  }
  var ch = opts.chSessionReport || null;

  var lastT = s0;
  var trials = state.trials.map(function (trial) {
    var events = trial.events.slice().sort(function (a, b) { return a.t - b.t; });
    var lastEventT = events.length > 0 ? events[events.length - 1].t : trial.tLoad;
    if (lastEventT > lastT) lastT = lastEventT;
    return {
      trial_index: trial.trialIndex,
      trial_id: trial.trialId,
      plugin: trial.plugin,
      // t_load is the trial time origin (design §10). t_start/t_dom_ready are
      // #3661-parity fields, null when the host has no pre-render hook.
      t_start: wireT(trial.tStart, s0),
      t_dom_ready: wireT(trial.tDomReady, s0),
      t_load: wireT(trial.tLoad, s0),
      // A trial still open at serialization time (tab closed, mid-session
      // getRecording) ends at its last observed event.
      t_end: wireT(trial.tEnd != null ? trial.tEnd : lastEventT, s0),
      // Scroll/viewport state at trial start — the viewer's camera seed.
      // Times inside are absolute-free (plain state), so no conversion.
      view_state: trial.viewState || null,
      initial_dom: trial.initialDom || '',
      events: events.map(function (e) {
        var out = Object.assign({}, e);
        out.t = wireT(e.t, s0);
        return out;
      }),
      trial_data: {}
    };
  });

  var chExtensions = {
    replay_version: VERSION,
    // Serialization-marker attribute name (per-recording nonce); the viewer
    // harvests these markers out of the reconstructed DOM for stable
    // mutation/anchor resolution. Null on trace-tier or legacy recordings.
    marker_attr: state.markerAttr || null,
    ch_version: ch ? (ch.libraryVersion || null) : null,
    preset: ch && ch.config ? ch.config.preset : null,
    scoring: ch ? {
      hard_score: ch.hardScore || {},
      soft_score: ch.softScore != null ? ch.softScore : null,
      soft_score_threshold: ch.softScoreThreshold != null ? ch.softScoreThreshold : null,
      any_hard_triggered: !!ch.anyHardTriggered,
      trials_completed: ch.trialsCompleted != null ? ch.trialsCompleted : null
    } : null,
    session_signals: ch ? {
      sidebar_events: convertTimes(ch.sidebarEvents, s0),
      ai_extensions_found: convertTimes(ch.aiExtensionsFound, s0),
      devtools_events: convertTimes(ch.devToolsEvents, s0),
      window_positions: convertTimes(ch.windowPositions, s0),
      layout_shifts: convertTimes(ch.layoutShifts, s0),
      zoom_changes: convertTimes(ch.zoomChanges, s0),
      extension_injections: convertTimes(ch.extensionInjections, s0)
    } : null,
    guard_violations: convertTimes(state.guardViolations, s0),
    capture_failures: convertTimes(state.captureFailures, s0),
    capture_stopped: !!state.captureStopped
  };

  return {
    schema_version: 1,
    metadata: {
      start_time: new Date(state.sessionStartEpoch).toISOString(),
      end_time: new Date(state.sessionStartEpoch + Math.max(0, Math.round(lastT - s0))).toISOString(),
      end_reason: state.endReason || 'aborted',
      participant_id: state.participantId,
      recorder: 'cyborg-hunter-replay@' + VERSION,
      tier: state.tier,
      keys: state.keys
    },
    viewport: state.viewport,
    stylesheets: { initial: state.stylesheets || [], events: [] },
    rng_calls: [],   // shape parity with #3661; CH never re-executes code
    trials: trials,
    ch_extensions: chExtensions
  };
}
