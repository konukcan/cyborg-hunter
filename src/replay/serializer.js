// src/replay/serializer.js
// In-memory recorder state → SessionRecording v2 (spec §2/§3).
//
// This is one of exactly two places in the system that convert time bases (the
// other is the CLI ingest): in-memory events carry absolute performance.now()
// values; the wire carries ms since the recording started (spec §7), which is
// why the file also states that origin as `recording_started_at_perf` — the two
// halves of one claim, and a reader can put an event back on the capture clock
// by adding them.
//
// What v2 moved, and where it went (spec §14's CH list):
//   - `metadata` dissolves into the top level; `recorder` becomes a
//     {name, version} pair rather than a string.
//   - `trials` → `segments`, `trial_index` → positional `index` (+ `label`),
//     `trial_data` → `host_data`, `view_state` → `initial_state`.
//   - the initial DOM is a DomNode tree (snapshot.js), not an HTML string.
//   - `stylesheets: {initial, events}` → one id-bearing array plus
//     `stylesheet_events` (empty: CH captures no stylesheet mutations yet — a
//     recorded gap, not a claim that none happened).
//   - `ch_extensions` → `extensions["cyborg-hunter"]`, same content minus
//     `marker_attr` (integer node ids retired the nonce markers), plus the
//     `tier`/`keys` config echo that v1 kept in metadata.
//   - `capture_stopped` gains a standard mirror: top-level `truncated` (§5.7).
//
// Everything CH-specific that the format has no field for goes into the vendor
// namespace rather than riding as an unknown top-level key: an unknown key is
// indistinguishable from a producer bug, and §9 exists precisely so a player
// can ignore it knowingly.

import { VERSION } from '../shared/constants.js';

/**
 * The wire format this module emits. Exported because it is not only the
 * serializer's business: the meta pointer that rides in the host's data
 * (persistence.js, and index.js's no-session degradation) states the schema
 * version of the recording it points at, and a hard-coded literal there is how
 * a v1 pointer survived into a v2 recorder.
 */
export var SCHEMA_VERSION = 2;

// Convert an absolute performance.now() value to wire time (ms since
// recording start), rounded to 1 decimal to keep JSON compact (spec §7 permits
// producer rounding and names CH's 0.1 ms).
function wireT(t, sessionStart) {
  if (t == null) return null;
  return Math.round((t - sessionStart) * 10) / 10;
}

// Session-scoped CH arrays whose entries carry absolute `t` — converted to
// session-relative on the way into the vendor namespace.
function convertTimes(entries, sessionStart) {
  return (entries || []).map(function (e) {
    var out = Object.assign({}, e);
    if (typeof out.t === 'number') out.t = wireT(out.t, sessionStart);
    if (typeof out.start === 'number') out.start = wireT(out.start, sessionStart);
    return out;
  });
}

// Time-sorted copy. Stable by construction (Array.prototype.sort is stable in
// every engine CH supports), so events that share a `t` keep the order the
// buffer received them in — which spec §7 makes authoritative within an array.
function byTime(entries) {
  return entries.slice().sort(function (a, b) { return a.t - b.t; });
}

// Spec §2 types every ViewportState field as a number, and a recorder started
// without a window (node harness, a test) has no geometry to report. The
// format has no way to say "unknown", so zeros keep the file loadable where
// nulls would fail every consumer's type check.
var VIEWPORT_UNKNOWN = { w: 0, h: 0, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 };

function viewportState(v) {
  return v ? {
    w: num(v.w), h: num(v.h), dpr: num(v.dpr, 1),
    scale: num(v.scale, 1), offset_x: num(v.offset_x), offset_y: num(v.offset_y),
  } : Object.assign({}, VIEWPORT_UNKNOWN);
}

function num(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : (fallback == null ? 0 : fallback);
}

/**
 * @param {Object} state - recorder.getState() output
 * @param {Object} opts
 *   `chSessionReport` — pull-model CH merge: the caller (jsPsych adapter or
 *                       researcher) provides CH's session report, so the
 *                       serializer never reaches into CH itself.
 *   `host`            — the runtime the recorder was embedded in (spec §2),
 *                       `{name, version}`; null/absent for standalone use.
 */
export function serialize(state, opts) {
  opts = opts || {};
  var s0 = state.sessionStart;
  if (s0 == null) {
    throw new Error('[cyborg-hunter-replay] cannot serialize before startSession() — call startSession() first, or the timestamps would be meaningless (Unix epoch).');
  }
  var ch = opts.chSessionReport || null;

  // The last moment the recording observed, on the capture clock. Kept
  // absolute so it sits in the same frame as `recording_started_at_perf`;
  // their difference is the recording's duration in wire time.
  var lastT = s0;
  var segments = state.trials.map(function (trial, i) {
    var events = byTime(trial.events);
    var lastEventT = events.length > 0 ? events[events.length - 1].t : trial.tLoad;
    if (lastEventT > lastT) lastT = lastEventT;
    if (trial.tEnd != null && trial.tEnd > lastT) lastT = trial.tEnd;
    return {
      // Positional, not the recorder's counter: spec §7 makes the array
      // position authoritative and strict validation rejects disagreement.
      index: i,
      label: trial.trialId != null ? trial.trialId : null,
      plugin: trial.plugin != null ? trial.plugin : null,
      // t_load is the segment time origin (spec §3). t_start/t_dom_ready are
      // null when the host has no pre-render hook.
      t_start: wireT(trial.tStart, s0),
      t_dom_ready: wireT(trial.tDomReady, s0),
      t_load: wireT(trial.tLoad, s0),
      // A segment still open at serialization time (tab closed, mid-session
      // getRecording) ends at its last observed event.
      t_end: wireT(trial.tEnd != null ? trial.tEnd : lastEventT, s0),
      // Keyframe (a DomNode tree) vs continuation (null) — spec §3. Absent on
      // trace tier, where no segment ever carries one.
      initial_dom: trial.initialDom || null,
      // The replay-state seed the tree cannot carry (initial-state.js); null
      // when every field was at its default, which is the spec's omit rule.
      initial_state: trial.initialState || null,
      events: events.map(function (e) {
        var out = Object.assign({}, e);
        out.t = wireT(e.t, s0);
        return out;
      }),
      host_data: trial.hostData != null ? trial.hostData : null,
      // An implicitly opened segment (events arrived before any startTrial) is
      // a CH-side fact about bracketing, not a standard field.
      extensions: trial.implicit ? { 'cyborg-hunter': { implicit: true } } : null,
    };
  });

  var chExtensions = {
    replay_version: VERSION,
    // v1 kept these in `metadata`; spec §14 routes the config echo here.
    tier: state.tier,
    keys: state.keys,
    // documentElement's client box at session start. Spec §2's ViewportState
    // has no room for it and the per-event camera block (§6) only carries it
    // where an interaction happened, but it is the box the page was laid out
    // against — what a viewer should size its reconstruction by.
    viewport_client: state.viewportClient || null,
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
    // Guard-friction violations are CH events with no standard type (§5.8
    // forbids vendor events in the stream), so they live here with their
    // times converted like every other session-scoped CH array.
    guard_violations: convertTimes(state.guardViolations, s0),
    capture_failures: convertTimes(state.captureFailures, s0),
    capture_stopped: !!state.captureStopped
  };

  return {
    schema_version: SCHEMA_VERSION,
    recorder: { name: 'cyborg-hunter-replay', version: VERSION },
    host: opts.host || null,
    participant_id: state.participantId != null ? state.participantId : null,
    recording_started_at: new Date(state.sessionStartEpoch).toISOString(),
    recording_started_at_perf: s0,
    user_agent: state.userAgent || '',
    viewport: viewportState(state.viewport),
    observed_root: state.observedRoot || null,
    stylesheets: state.stylesheets || [],
    // Known gap: CH captures the initial sheets only. Stylesheet mutations
    // (spec §2 StylesheetEvent) need a CSSOM observer CH does not have, so the
    // array is empty rather than absent — the format's way of saying "capture
    // was on and nothing is recorded here".
    stylesheet_events: [],
    // Time-sorted on the way out (spec §7): the capture side coalesces both
    // viewport channels through RAF callbacks, and this is the last place that
    // can guarantee the property for the file.
    viewport_changes: byTime(state.viewportChanges || []).map(function (c) {
      var out = Object.assign({}, c);
      out.t = wireT(c.t, s0);
      return out;
    }),
    // CH never patches Math.random and never re-executes experiment code, so
    // RNG capture was off — which §7 spells as both fields null.
    rng: null,
    rng_calls: null,
    ended_at_perf: lastT,
    end_reason: state.endReason || 'aborted',
    // Spec §5.7: the standard mirror of the capture-stopped signal, so a
    // player can surface truncation without reading a vendor namespace.
    truncated: !!state.captureStopped,
    extensions: { 'cyborg-hunter': chExtensions },
    // Last, matching the canonical fixture's reading order: the bulk of the
    // file after everything a reader needs to interpret it.
    segments: segments,
  };
}
