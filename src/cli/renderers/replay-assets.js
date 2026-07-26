// src/cli/renderers/replay-assets.js
// Emits per-participant replay assets into <outputDir>/replay/ as
// JSONP-style scripts: window.__chReplay['<pid>'] = <viewer model>.
//
// Why script files instead of JSON + fetch(): the HTML report is opened
// via file:// where fetch() of local files is CORS-blocked, but <script>
// tags load fine. The report injects the script lazily when the analyst
// opens a participant's Replay section.
//
// This module is also the wire→viewer time conversion (the second of the
// two allowed conversion points): SessionRecording carries ms since
// session start; the viewer speaks trial-relative ms.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { sanitizeId as sanitize } from '../../shared/constants.js';

/**
 * Wire SessionRecording → viewer model. Times become trial-relative
 * (t − t_load); null anchors (standalone implicit trials) degrade to the
 * first event's time so durations are always finite.
 */
export function buildViewerModel(recording) {
  const md = recording.metadata || {};
  const ext = recording.ch_extensions || {};

  // ── Camera seeding (central, per Sol round-1 finding 8) ──
  // New recordings carry a per-trial view_state seed. Legacy recordings
  // don't — but the full event stream is present, so each trial's starting
  // camera is reconstructed by folding all PRIOR trials' window-scroll and
  // resize events over the session-start viewport. Initial scroll is assumed
  // 0 (a recording that starts pre-scrolled with no scroll events is
  // unrecoverable — that's what the viewer's legacy banner covers).
  const vp = recording.viewport || {};
  const vv = vp.visual_viewport || {};
  // Scrollbar delta: legacy resize events carry only innerWidth/Height; the
  // layout (client) width is estimated as w minus the session-start delta
  // between innerWidth and the layout width (visual_viewport.width).
  const sbW = (vp.width && (vp.client_width || vv.width))
    ? vp.width - (vp.client_width || vv.width) : 0;
  const sbH = (vp.height && (vp.client_height || vv.height))
    ? vp.height - (vp.client_height || vv.height) : 0;
  let foldState = {
    x: 0, y: 0,
    w: vp.width || null, h: vp.height || null,
    cw: vp.client_width || vv.width || vp.width || null,
    ch: vp.client_height || vv.height || vp.height || null,
    dpr: vp.dpr || 1
  };
  const foldEvent = (state, e) => {
    if (e.kind === 'scroll' && e.el == null && e.redacted == null) {
      state.x = Number(e.x) || 0;
      state.y = Number(e.y) || 0;
    } else if (e.kind === 'resize') {
      state.w = e.w != null ? e.w : state.w;
      state.h = e.h != null ? e.h : state.h;
      state.cw = e.cw != null ? e.cw : (e.w != null ? e.w - sbW : state.cw);
      state.ch = e.ch != null ? e.ch : (e.h != null ? e.h - sbH : state.ch);
      if (e.dpr != null) state.dpr = e.dpr;
    }
    return state;
  };

  // Defensive against malformed/truncated artifacts (a hand-edited or
  // partially-written recording): non-array trials/events and null entries must
  // degrade to empty rather than throw and abort the whole cohort report.
  const rawTrials = Array.isArray(recording.trials) ? recording.trials : [];
  const trials = rawTrials.map((trial) => {
    trial = trial || {};
    // Sort by absolute time before anchoring. RAF-coalesced input events flush
    // with an EARLIER timestamp than events pushed after they were enqueued, so
    // the recorded array is not strictly time-ordered; the viewer scrubs by
    // scanning until the first future event and would otherwise mis-apply an
    // out-of-order event on a seek. Stable sort keeps equal-time order.
    const events = (Array.isArray(trial.events) ? trial.events : [])
      .filter((e) => e && typeof e === 'object')
      .slice()
      .sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    const anchor = trial.t_load != null ? trial.t_load
      : (events.length > 0 ? events[0].t : 0);
    const lastT = events.length > 0 ? events[events.length - 1].t : anchor;
    const end = trial.t_end != null ? trial.t_end : lastT;
    // Camera seed for THIS trial: recorded view_state, else the folded state
    // as of the end of the previous trial. A recorded view_state also
    // RESYNCS the fold — in a mixed recording (some trials seeded, some
    // not: truncation, version mixes) a later unseeded trial must inherit
    // real observed state, not a fold that ignored every observation.
    if (trial.view_state) foldState = Object.assign({}, foldState, trial.view_state);
    const camera = trial.view_state
      ? Object.assign({}, trial.view_state, { source: 'view_state' })
      : Object.assign({}, foldState, { source: 'folded' });
    // Advance the fold across this trial's events for the NEXT trial's seed.
    events.forEach((e) => foldEvent(foldState, e));
    return {
      index: trial.trial_index,
      id: trial.trial_id,
      plugin: trial.plugin,
      durMs: Math.max(0, Math.round((end - anchor) * 10) / 10),
      initialDom: trial.initial_dom || '',
      camera,
      events: events.map((e) => {
        const out = Object.assign({}, e);
        out.t = Math.max(0, Math.round(((Number(e.t) || 0) - anchor) * 10) / 10);
        return out;
      })
    };
  });

  return {
    pid: md.participant_id != null ? String(md.participant_id) : 'unknown',
    tier: md.tier || 'trace',
    keys: md.keys || null,
    startTime: md.start_time || null,
    endReason: md.end_reason || null,
    recorder: md.recorder || null,
    viewport: recording.viewport || null,
    // Legacy = ANY trial lacks a view_state seed (all-legacy recordings and
    // mixed/truncated ones alike): those trials replay on folded camera
    // state, so the reduced-guarantees banner must show.
    legacy: !rawTrials.every((t) => t && t.view_state),
    markerAttr: ext.marker_attr || null,
    // Session scrollbar delta (innerWidth − layout width): the viewer uses
    // the same fallback chain as the folding above for legacy resize events.
    scrollbar: { w: sbW, h: sbH },
    stylesheets: (recording.stylesheets && recording.stylesheets.initial) || [],
    scoring: ext.scoring || null,
    guardViolations: ext.guard_violations || [],
    captureStopped: !!ext.capture_stopped,
    captureFailures: (ext.capture_failures || []).map((f) => f.channel),
    trials
  };
}

/**
 * Writes replay/<sanitizedPid>.replay.js for every participant with an
 * attached recording. Returns { count, totalBytes } so report.js can print
 * an honest size line (replay assets dominate report size at dom tier).
 */
export function renderReplayAssets(participants, outputDir) {
  let count = 0;
  let totalBytes = 0;
  const withReplay = participants.filter((p) => p.replay && p.replay.recording);
  if (withReplay.length === 0) return { count, totalBytes };

  const replayDir = join(outputDir, 'replay');
  mkdirSync(replayDir, { recursive: true });

  // Sanitization is lossy ('a/b' and 'a_b' both map to a_b) — dedupe with a
  // stable numeric suffix so a later write can never overwrite an earlier
  // participant's asset. The actual path is stamped on the participant
  // (replay.assetPath) and consumed by html-index, which must not recompute.
  const usedNames = new Set();
  for (const p of withReplay) {
    const model = buildViewerModel(p.replay.recording);
    // The store is keyed by the RAW participant id (what the report's
    // loader passes); the filename uses the sanitized form.
    // Null-prototype store: participant ids are untrusted, and a pid like
    // "__proto__" on a plain object would mutate the store's prototype
    // instead of creating an entry (prototype pollution).
    const src =
      'window.__chReplay = window.__chReplay || Object.create(null);\n' +
      'window.__chReplay[' + JSON.stringify(String(p.participantId)) + '] = ' +
      JSON.stringify(model).replace(/</g, '\\u003c') + ';\n';
    let base = sanitize(p.participantId);
    let name = base + '.replay.js';
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
      name = base + '~' + n + '.replay.js';
    }
    usedNames.add(name.toLowerCase());
    writeFileSync(join(replayDir, name), src);
    p.replay.assetPath = 'replay/' + name;
    count++;
    totalBytes += Buffer.byteLength(src);
  }
  return { count, totalBytes };
}
