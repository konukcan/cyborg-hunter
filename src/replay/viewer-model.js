// src/replay/viewer-model.js
// SessionRecording v2 (spec r2) → viewer model. Pure — no Node APIs — so a
// browser demo can bundle it directly (0.7.2 extraction from
// cli/renderers/replay-assets.js, which re-exports this for existing callers).
//
// This is one of exactly two allowed wire→viewer time-conversion points (the
// other lives in the CLI ingest path): a SessionRecording carries ms since
// `recording_started_at_perf`; the viewer speaks segment-relative ms.
//
// Input is a parsed v2 recording from ANY producer, not just CH's recorder:
// the shared format's whole point is that a conforming file plays in either
// project's player. Everything CH-specific is read from
// `extensions['cyborg-hunter']` and guarded on its own key.
//
// The model is a frozen wire format between two files that ship together
// (renderReplayAssets writes it as JSONP; the report inlines its own copy of
// the viewer client), so there is no back-compat problem here — and no
// back-compat either. There is no CH-v1 playback path: v1 recordings are
// rejected by the §11 tolerant profile below and are played with the v0.7.1
// tag (design §12).

// Spec §11, tolerant loader profile. Reject ONLY these four categories;
// everything else loads with a warning-free documented default. Rationale:
// recordings are unrepeatable participant data, so rejection at runtime is
// data loss — strictness lives in CI (src/shared/schema-v2-validator.js),
// where it hits a developer instead of an analyst. The reason strings mirror
// that validator's tolerant profile verbatim so the repo holds ONE reading of
// the profile rather than two that can drift.
function tolerantReasons(rec) {
  const reasons = [];
  if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
    return ['recording must be a JSON object'];
  }
  if (rec.schema_version !== 2) reasons.push('schema_version must be the integer 2');
  if (!rec.recorder || typeof rec.recorder.name !== 'string' || typeof rec.recorder.version !== 'string') {
    reasons.push('recorder {name, version} strings are required');
  }
  if (!Array.isArray(rec.segments)) {
    reasons.push('segments array is required');
  } else {
    rec.segments.forEach((s, i) => {
      if (!s || typeof s !== 'object' || !Array.isArray(s.events)) {
        reasons.push('segments[' + i + '] must carry an events array');
      }
    });
  }
  return reasons;
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
// The wire rounds to 0.1 ms (spec §7); rebasing two rounded floats
// reintroduces binary noise (2100 − 2000 = 99.99999999999999), so every
// derived time is re-rounded to the same precision.
const round1 = (v) => Math.round(v * 10) / 10;

// A keyframe is a DomNode OBJECT. A primitive (a v1 HTML string, say) or an
// array carries none of a DomNode's fields, so treating it as a keyframe
// would hand `mountTree` something it cannot instantiate and would license
// later `dom.*` patches against a snapshot that does not exist. Same test as
// the strict profile's `isKeyframe` (validator.js:203-204).
const isKeyframe = (s) => s.initial_dom != null && typeof s.initial_dom === 'object'
  && !Array.isArray(s.initial_dom);

/**
 * The badge a recording earns: the stated tier wins, otherwise infer it
 * structurally so a foreign file gets an honest badge instead of "trace"
 * (design §10). Exported because the report's index renders the same badge
 * from the RECORDING (html-index-core.js) while the viewer renders it from
 * the MODEL — one reading of the rule, in one place, or the two drift.
 *
 * Safe on anything: the index calls it on an artifact that has not been
 * through the §11 profile yet.
 *
 * @param {object} recording  a parsed SessionRecording v2, any producer
 * @returns {'dom'|'trace'|string} the stated tier, or the inferred one
 */
export function inferTier(recording) {
  const ext = (recording && recording.extensions && recording.extensions['cyborg-hunter']) || {};
  if (ext.tier) return ext.tier;
  const segs = (recording && Array.isArray(recording.segments)) ? recording.segments : [];
  return segs.some((s) => s && isKeyframe(s)) ? 'dom' : 'trace';
}

/**
 * @param {object} recording  a parsed SessionRecording v2, any producer
 * @returns {object} the viewer model (design §9)
 * @throws {Error} with `.reasons` when the §11 tolerant profile rejects it
 */
export function buildViewerModel(recording) {
  const reasons = tolerantReasons(recording);
  if (reasons.length) {
    const err = new Error('buildViewerModel: not a loadable SessionRecording v2 — ' + reasons.join('; '));
    err.reasons = reasons;
    throw err;
  }

  const rec = recording;
  // `extensions` is nullable at every level (spec §2/§9), and a foreign
  // producer may carry the namespace for its own reasons — the T4 converter
  // stamps provenance into it. Read individual keys; never treat presence of
  // the namespace as evidence about the producer.
  const ext = (rec.extensions && rec.extensions['cyborg-hunter']) || {};

  // ── session viewport and the client (layout) box ────────────────────────
  // Spec §2's ViewportState has no client-box room, so the layout box the page
  // was formatted against travels as CH vendor data. The iframe must be sized
  // to the LAYOUT width or every reconstruction is a scrollbar-width off.
  // Chain (design §8): per-event `camera.client_w` (the viewer's business, at
  // the moment of an anchored event) → `viewport_client` at session start →
  // folded w/h minus the session scrollbar delta. The delta is computed from
  // `viewport_client` ITSELF, so an absent one is a delta of zero rather than
  // an arithmetic accident — which is exactly the foreign-file case.
  const viewport = rec.viewport && typeof rec.viewport === 'object' ? rec.viewport : null;
  const viewportClient = ext.viewport_client || null;
  const scrollbar = {
    w: viewport && viewportClient && num(viewport.w) != null && num(viewportClient.w) != null
      ? viewport.w - viewportClient.w : 0,
    h: viewport && viewportClient && num(viewport.h) != null && num(viewportClient.h) != null
      ? viewport.h - viewportClient.h : 0,
  };

  const viewportChanges = asArray(rec.viewport_changes)
    .filter((c) => c && typeof c === 'object')
    .slice()
    .sort((a, b) => (num(a.t) || 0) - (num(b.t) || 0));

  // ── segments ────────────────────────────────────────────────────────────
  const rawSegments = rec.segments;

  let spanStart = null;      // index of the keyframe the current span opens at
  const segments = rawSegments.map((s, i) => {
    const keyframe = isKeyframe(s);
    if (keyframe) spanStart = i;

    const tStart = num(s.t_start);
    const tDomReady = num(s.t_dom_ready);
    const tLoad = num(s.t_load);
    const tEnd = num(s.t_end);

    // Events are sorted BEFORE the origin is taken, because the origin can
    // fall back to the first event's time and the recorded array is not
    // guaranteed ordered in practice: RAF-coalesced input flushes with an
    // EARLIER timestamp than events pushed after it was enqueued. Spec §7
    // requires producers to emit sorted arrays; the viewer scans forward and
    // would mis-apply an out-of-order event on a seek, so a foreign producer's
    // bug must not become CH's rendering bug. Stable sort keeps equal-t order,
    // which §7 makes authoritative.
    const events = asArray(s.events)
      .filter((e) => e && typeof e === 'object')
      .slice()
      .sort((a, b) => (num(a.t) || 0) - (num(b.t) || 0));

    // Spec §3: "Segment time origin for per-segment clocks: first non-null of
    // t_load, t_dom_ready, t_start; else the first event's t."
    // Recorded because it was contested: the pre-design's carry paraphrased
    // this as "t_dom_ready, then t_load, then t_start last", swapping the
    // first two. The SPEC TEXT is the contract. The readings differ only for a
    // segment stating both t_load and t_dom_ready with different values, where
    // §3 says t_load wins — and that is also the no-change reading, since
    // CH-v1's anchor was t_load. (The fork's PLAYER still rebases by
    // `t_dom_ready ?? 0`; that divergence is a cross-repo rider, not T5 scope.)
    const origin = tLoad != null ? tLoad
      : tDomReady != null ? tDomReady
        : tStart != null ? tStart
          : (events.length > 0 && num(events[0].t) != null ? num(events[0].t) : 0);

    const lastT = events.length > 0 ? (num(events[events.length - 1].t) || origin) : origin;
    const end = tEnd != null ? tEnd : lastT;

    return {
      // Spec §7: `index` MUST equal the array position, and tolerant loaders
      // trust array order. Taking the position rather than the stated field
      // means a producer's off-by-one cannot desync the model from the array
      // every other part of the viewer indexes into.
      index: i,
      label: s.label != null ? s.label : null,
      plugin: s.plugin != null ? s.plugin : null,
      tStart, tDomReady, tLoad, tEnd,
      origin,
      durMs: Math.max(0, round1(end - origin)),
      keyframe,
      // The nearest earlier segment with a non-null initial_dom (itself if it
      // is a keyframe): the segment a restore mounts before walking forward.
      // Null until the first keyframe arrives.
      spanStart,
      // Spec §3's pre-keyframe rule, in the strict profile's reading
      // (validator.js:209): a segment with no keyframe before it is illegal
      // IFF it carries `dom.*` events, tracked with a RUNNING keyframe flag.
      // Deliberately the same predicate as the machine check rather than a
      // second reading of the same sentence — the reason the §11 rejection
      // strings above are mirrored verbatim applies here too. Two shapes turn
      // on it: a trace prologue before a later keyframe is LEGAL (it
      // reconstructs nothing, so it loses nothing), and `dom.*` before any
      // keyframe is a DEFECT even when no keyframe ever arrives (the viewer
      // would otherwise show a clean grey trace stage while dropping patches
      // §12 requires it to flag).
      defect: spanStart === null && events.some(
        (e) => typeof e.type === 'string' && e.type.indexOf('dom.') === 0)
        ? 'continuation-before-keyframe' : null,
      // v2's keyframe is a DomNode TREE, never an HTML string: the
      // reconstruction is instantiated node by node and is never parsed from
      // markup (design §4).
      initialDom: keyframe ? s.initial_dom : null,
      initialState: s.initial_state || null,
      camera: null,          // filled below, once every span start is known
      // Segment-relative times, as v1's were trial-relative. A pure
      // subtraction, NOT clamped at zero: an event recorded before its
      // segment's origin keeps a negative relative time rather than being
      // reported as happening at the segment start.
      //
      // THE CONVERSION CONTRACT (read this before writing Task 7's checkpoint
      // executor). Rebasing rounds, so the two directions are not equally
      // exact and only one of them is a rule:
      //   FORWARD (session → segment) is `round1(t − origin)`, and any
      //     consumer that needs a segment-relative time MUST compute it the
      //     same way. Do that and the comparison is exact by construction.
      //   REVERSE (`origin + tRel === t`) is NOT exact: `round1` re-rounds the
      //     difference and adding it back to a decimal origin does not
      //     reproduce the wire float (2000.1 + 14621.4 → 16621.500000000002).
      //     Measured over the corpus: 735 of jspsych-full's 909 events miss
      //     it, worst error 1.9e-7 ms. The stated bound is 5e-7 ms, pinned
      //     fixture-wide in tests/replay/viewer-model.test.js. Never compare
      //     reconstructed absolute times with ===.
      events: events.map((e) => {
        const out = Object.assign({}, e);
        out.t = round1((num(e.t) || 0) - origin);
        return out;
      }),
    };
  });

  // ── per-segment camera seed (design §8) ─────────────────────────────────
  // v1 folded per-trial view-state seeds plus in-stream resize events. v2
  // has neither: `resize` is not an event type and viewport history is
  // session-level. So the seed is `viewport_changes` folded up to the
  // segment's origin, over the top-level viewport, with window scroll taken
  // from the SPAN KEYFRAME's `initial_state` — the state a restore actually
  // opens with (design §5). Scroll is not folded across segments: the span
  // walk replays `scroll.window` itself, and a segment with no initial_state
  // opens at (0,0) because the frame survives segment changes.
  for (const seg of segments) {
    const folded = {
      w: viewport ? num(viewport.w) : null,
      h: viewport ? num(viewport.h) : null,
      dpr: viewport && num(viewport.dpr) != null ? viewport.dpr : 1,
      scale: viewport && num(viewport.scale) != null ? viewport.scale : 1,
      offset_x: viewport && num(viewport.offset_x) != null ? viewport.offset_x : 0,
      offset_y: viewport && num(viewport.offset_y) != null ? viewport.offset_y : 0,
    };
    for (const c of viewportChanges) {
      if ((num(c.t) || 0) > seg.origin) break;
      for (const k of Object.keys(folded)) if (num(c[k]) != null) folded[k] = c[k];
    }
    const keyframeSeg = seg.spanStart != null ? segments[seg.spanStart] : null;
    const seedScroll = keyframeSeg && keyframeSeg.initialState && keyframeSeg.initialState.scroll;
    seg.camera = Object.assign({}, folded, {
      scroll_x: seedScroll && num(seedScroll.x) != null ? seedScroll.x : 0,
      scroll_y: seedScroll && num(seedScroll.y) != null ? seedScroll.y : 0,
      client_w: folded.w != null ? folded.w - scrollbar.w : null,
      client_h: folded.h != null ? folded.h - scrollbar.h : null,
      // Which of the two scroll sources produced this seed. Not spec — it is
      // what makes a wrong seed legible in the viewer's own diagnostics.
      source: seedScroll ? 'initial_state' : 'default',
    });
  }

  return {
    schemaVersion: 2,
    pid: rec.participant_id != null ? String(rec.participant_id) : null,
    recorder: rec.recorder,
    host: rec.host || null,
    startTime: rec.recording_started_at || null,
    startPerf: num(rec.recording_started_at_perf),
    endReason: rec.end_reason || null,
    truncated: !!rec.truncated,
    userAgent: rec.user_agent || null,

    // `foreign` keys on PRODUCER IDENTITY, never on the presence of the
    // `extensions['cyborg-hunter']` namespace: the T4 converter stamps its
    // provenance into that namespace, so a namespace test calls the
    // designated foreign-producer fixture CH-produced. A converted CH-v1 file
    // is the mirror case — CH-produced and converter-stamped. `foreign` says
    // "the report should not pretend this file has CH panels"; it never
    // decides whether a given panel is drawn. Every panel below is guarded on
    // its OWN field's presence.
    foreign: rec.recorder.name !== 'cyborg-hunter-replay',

    // Stated tier wins; otherwise infer structurally so a foreign file gets an
    // honest badge instead of "trace" (design §10). Shared with the report's
    // index, which badges the same recording before any model exists.
    tier: inferTier(rec),
    keys: ext.keys || null,
    chVersion: ext.ch_version || null,
    preset: ext.preset || null,
    inheritedTaint: !!ext.inherited_redaction_taint,

    viewport,
    viewportClient,
    scrollbar,
    // Session-level streams keep ABSOLUTE wire times and are rebased at use:
    // one array serves every segment.
    viewportChanges,
    stylesheets: asArray(rec.stylesheets),
    stylesheetEvents: asArray(rec.stylesheet_events),

    scoring: ext.scoring || null,
    guardViolations: asArray(ext.guard_violations),
    // Channel names only: the chip says which channel went dark, and the
    // message/time detail has no surface in the report today.
    captureFailures: asArray(ext.capture_failures).map((f) => f && f.channel).filter(Boolean),
    captureStopped: !!ext.capture_stopped,

    segments,
  };
}
