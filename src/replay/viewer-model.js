// src/replay/viewer-model.js
// Wire SessionRecording → viewer model. Pure — no Node APIs — so a browser
// demo can bundle it directly (0.7.2 extraction from
// cli/renderers/replay-assets.js, which re-exports this for existing
// callers).
//
// This is one of exactly two allowed wire→viewer time-conversion points (the
// other lives in the CLI ingest path): SessionRecording carries ms since
// session start; the viewer speaks trial-relative ms.

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
