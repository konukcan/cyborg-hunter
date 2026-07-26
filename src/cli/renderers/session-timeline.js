// src/cli/renderers/session-timeline.js
//
// Renders per-participant SESSION timeline images using node-canvas.
// Produces one PNG per participant showing every recorded integrity signal
// along a single shared time axis from session start to session end.
//
// Why this replaces tab-timeline.js:
//   The old tab-timeline.js used per-trial rows on the chart. That layout
//   only made sense when every integrity event landed in a per-trial bucket.
//   For studies whose sessions are punctuated by long study phases (galleries,
//   typing prompts, comprehension gates, demographics, etc.) where most off-
//   task behavior actually happens, per-trial-row charts hide most of what
//   matters and produce blank charts for participants whose tab-aways landed
//   between trials.
//
// Layout:
//   Title strip
//   ─────────────────────────────────────────────
//   Phase strip      [consent | tut | comp | gallery+class+typing per rule]
//   Tab-aways lane   |  vertical markers, colored by duration bin
//   Sidebars lane    |  horizontal spans, opened → closed
//   Layout shifts    |  thin vertical ticks
//   Guard-friction   |  vertical markers, dark red
//   ─────────────────────────────────────────────
//   X-axis ticks      0, M:SS labels
//   Footer            session-level counts + "off-trial tab-aways" note
//
// X-axis unit: seconds elapsed since session start. Events recorded in
// performance.now() ms ("perfNow") are converted to session-relative seconds
// using a participant-specific sessionOffset estimator (see deriveSessionOffset
// below). For participants where the offset can't be estimated, the fallback
// is sessionOffset = 0 (assume page load == session start), which produces a
// small visualization drift (typically 10-60s, equal to the consent rendering
// + first click time). The drift only affects the X position of perfNow-based
// markers (sidebars, layout shifts, guard-friction); wall-clock-derived phase
// bands remain accurate.
//
// Edge cases handled gracefully (no crash, no silent failure):
//   * participant.session missing → render phase strip only, no integrity lanes
//   * trials missing → render integrity lanes only, no phase strip
//   * sidebar opened but never closed → render as unclosed span to session end
//   * malformed event objects → skipped with a debug log, render continues
//   * zero events of all kinds → render an "no integrity events" callout
//
// Backward compatibility:
//   * Works on payloads from any cyborg-hunter library version. Older payloads
//     without session-level event data simply lose those lanes (rendered empty).

import { writeFileSync } from 'fs';
import { join } from 'path';
import { countSidebarOpenings } from '../analyzers/summary.js';

// ── Layout constants ─────────────────────────────────────────────────────
const CANVAS_W = 1000;
const LEFT_PAD = 90;
const RIGHT_PAD = 30;
const TOP_PAD = 65;
const BOTTOM_PAD = 110;

const LANE_HEIGHT = 32;
const LANE_GAP = 6;
const LANE_NAMES = ['Tab-aways', 'Sidebars', 'Viewport shifts', 'Guard-friction'];
const N_LANES = LANE_NAMES.length;
const PHASE_STRIP_H = 24;

// ── Colors ───────────────────────────────────────────────────────────────
const C = {
  bg: '#ffffff',
  title: '#222',
  subtitle: '#666',
  border: '#999',
  laneBg: '#fafafa',
  laneBorder: '#e0e0e0',
  laneLabel: '#444',
  xAxis: '#666',
  xTick: '#aaa',

  // Phase bands
  phasePre: '#eceff1',         // bluish grey — framing (consent/tut/comp/transitions/post)
  phaseGallery: '#ffe0b2',     // peach — gallery viewing
  phaseTyping: '#e1bee7',      // light purple — typing prompt (explain only)
  phaseClass: '#bbdefb',       // light blue — classification trials
  phasePost: '#eceff1',        // same as phasePre — same logical class

  // Tab-away bins (match analyzer)
  tabFlicker: '#bdbdbd',       // < 3s — grey
  tabMedium: '#fb8c00',        // 3–10s — orange
  tabLong: '#e53935',          // ≥ 10s — red

  sidebarSpan: '#8e24aa',      // purple
  layoutShift: '#00897b',      // teal
  guardViolation: '#c62828',   // dark red
};

// ── Public API ───────────────────────────────────────────────────────────
export async function renderSessionTimelines(participants, config) {
  const { createCanvas } = await import('canvas');

  let rendered = 0;
  for (const p of participants) {
    try {
      const wrote = await renderOne(p, config, createCanvas);
      if (wrote) rendered++;
    } catch (err) {
      // Defensive: never let one bad payload kill the whole report.
      console.warn(`  [warn] session timeline failed for ${shortId(p.participantId)}: ${err.message}`);
    }
  }
  console.log(`  session timelines — rendered (${rendered}/${participants.length})`);
}

// ── Per-participant renderer ─────────────────────────────────────────────
async function renderOne(p, config, createCanvas) {
  const events = collectEvents(p, config);
  const phases = derivePhases(p);
  const xDomainSec = computeXDomain(p, events, phases);

  if (xDomainSec <= 0) {
    // No data anywhere. Skip silently.
    return false;
  }

  const canvasH = TOP_PAD + PHASE_STRIP_H + LANE_GAP + N_LANES * (LANE_HEIGHT + LANE_GAP) + BOTTOM_PAD;
  const canvas = createCanvas(CANVAS_W, canvasH);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CANVAS_W, canvasH);

  drawHeader(ctx, p, events);

  const chartW = CANVAS_W - LEFT_PAD - RIGHT_PAD;
  const xScale = chartW / xDomainSec;

  drawPhaseStrip(ctx, phases, xScale, xDomainSec, chartW);
  drawLanes(ctx, events, xScale, xDomainSec, chartW);
  // Dashed vertical guides at every rule boundary (= start of each gallery
  // phase). Drawn AFTER lanes so the markers sit on top of event bars and
  // it's easy to see "this event happened during rule N" by tracing the
  // line down through the lanes.
  const lanesTopY = TOP_PAD + PHASE_STRIP_H + LANE_GAP;
  const lanesBottomY = lanesTopY + N_LANES * (LANE_HEIGHT + LANE_GAP) - LANE_GAP;
  drawPhaseGuides(ctx, phases, xScale, xDomainSec, lanesTopY, lanesBottomY);
  drawXAxis(ctx, xDomainSec, chartW, canvasH);
  drawLegendAndFooter(ctx, p, events, canvasH);

  const buf = canvas.toBuffer('image/png');
  const filename = `session_timeline_${sanitize(p.participantId)}.png`;
  writeFileSync(join(config.outputDir, 'images', filename), buf);
  return true;
}

// ── Event collection ─────────────────────────────────────────────────────
// All events are normalized to a `t_sec` field (session-relative seconds)
// using the participant's sessionOffset (see computeXDomain).
export function collectEvents(p, config) {
  const session = p.session || {};

  // 1. Tab-away events. Libraries ≥0.6.1 record session-level
  //    session.tabAwayEvents — full {start, duration_ms, type} for EVERY
  //    tab-away, including off-trial ones (consent, tutorial, comprehension,
  //    gallery study) — so those are preferred and everything plots. Older
  //    payloads fall back to per-trial events; their off-trial tab-aways
  //    exist only as durations in tabAwaySums and can't be placed on the
  //    axis (the footer says so).
  const tabAways = [];
  const sessionTabEvents = Array.isArray(session.tabAwayEvents) ? session.tabAwayEvents : null;
  const tabAwaySource = (sessionTabEvents && sessionTabEvents.length > 0) ? 'session' : 'per-trial';
  if (tabAwaySource === 'session') {
    for (const e of sessionTabEvents) {
      if (!e || typeof e !== 'object') continue;
      if (typeof e.start !== 'number') continue;
      if (typeof e.duration_ms !== 'number') continue;
      tabAways.push({
        t_perfNow_ms: e.start,
        duration_ms: e.duration_ms,
        type: e.type || 'tab-away',
      });
    }
  } else {
    for (const t of (p.trials || [])) {
      // After ingest, events live at t.tabAwayEvents (top-level on the
      // post-ingest trial). The raw payload nests them under integrityTrial,
      // but Shape-1 ingest spreads that sub-object out so the field surfaces
      // at the top. Fall back to the nested path for any callers that bypass
      // the ingest layer.
      const ev = (Array.isArray(t?.tabAwayEvents) && t.tabAwayEvents)
        || (Array.isArray(t?.integrityTrial?.tabAwayEvents) && t.integrityTrial.tabAwayEvents)
        || [];
      for (const e of ev) {
        if (!e || typeof e !== 'object') continue;
        if (typeof e.start !== 'number') continue;
        if (typeof e.duration_ms !== 'number') continue;
        tabAways.push({
          t_perfNow_ms: e.start,
          duration_ms: e.duration_ms,
          type: e.type || 'tab-away',
        });
      }
    }
  }

  // 2. Session-level tab-away durations (no individual timestamps).
  //    Used only for the off-trial-count annotation in the footer.
  const sessionTabDurations = Array.isArray(session.tabAwaySums) ? session.tabAwaySums : [];
  const offTrialTabAwayCount = Math.max(0, sessionTabDurations.length - tabAways.length);
  const offTrialTabAwayDurMs = sessionTabDurations.reduce((s, d) => s + (Number(d) || 0), 0)
                              - tabAways.reduce((s, e) => s + e.duration_ms, 0);

  // 3. Sidebar spans (paired opened → closed entries; library records each as
  //    a separate array entry, both stamped with `t` perfNow ms).
  const sidebarSpans = pairSidebarEvents(session.sidebarEvents || []);

  // 4. Viewport-width shifts — each has `t` perfNow ms. Canonical key since
  //    0.6.1 is viewportWidthShifts; layoutShifts is the deprecated alias
  //    older payloads carry.
  const layoutShifts = (session.viewportWidthShifts || session.layoutShifts || [])
    .filter(e => e && typeof e.t === 'number')
    .map(e => ({ t_perfNow_ms: e.t, delta: e.delta }));

  // 5. Guard-friction violations. The ingest surfaces these as p.guardFriction;
  //    fall back to metadata/session mirrors for legacy payloads.
  const gfRoot = p.guardFriction ?? p.metadata?.guardFriction ?? p.session?.guardFriction ?? null;
  const guardViolations = (gfRoot?.violations || [])
    .filter(v => v && typeof v.t === 'number')
    .map(v => ({
      t_perfNow_ms: v.t,
      phase: v.phase || 'unknown',
      reason: v.reason || 'unknown',
    }));

  return {
    tabAways,
    tabAwaySource,
    sessionTabDurations,
    offTrialTabAwayCount,
    offTrialTabAwayDurMs,
    sidebarSpans,
    layoutShifts,
    guardViolations,
    // Per-participant tab-away "flicker vs meaningful" cutoff — the threshold the
    // library screened this participant with (e.g. 5s for strict), saved in
    // session.config. Keeps the timeline's bins and footer consistent with
    // summary.csv instead of a hardcoded 3s. Three-tier precedence mirrors
    // summary.js / typing-profile.js: the participant's saved threshold first,
    // then an analyst-side CLI override (for re-screening legacy cohorts that
    // predate persisted thresholds), then the default.
    tabFlickerCutoffMs: p.session?.config?.thresholds?.tabAwayDurationMs
      ?? config?.thresholds?.tabAwayDurationMs ?? 3000,
  };
}

// Pair {opened, closed} sidebarEvents entries into spans. Library writes both
// halves of a cycle as separate array entries — we reassemble them so the
// renderer can draw each cycle as one horizontal bar.
function pairSidebarEvents(arr) {
  const spans = [];
  let openT = null;
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'opened' && typeof e.t === 'number') {
      // Anchor to the FIRST open in a run of opens with no intervening close.
      // The two runtime detectors (innerWidth_delta + layout_compression) can
      // each emit an "opened" on different poll ticks for one physical sidebar;
      // overwriting here would start the drawn span at the later detector,
      // disagreeing with countSidebarOpenings (which anchors to the first
      // transition) and with the span's own duration_ms label.
      if (openT === null) openT = e.t;
    } else if (e.type === 'closed' && typeof e.t === 'number' && openT !== null) {
      spans.push({
        start_perfNow_ms: openT,
        end_perfNow_ms: e.t,
        duration_ms: e.duration_ms ?? (e.t - openT),
        closed: true,
      });
      openT = null;
    }
  }
  // Trailing unclosed open
  if (openT !== null) {
    spans.push({ start_perfNow_ms: openT, end_perfNow_ms: null, duration_ms: null, closed: false });
  }
  return spans;
}

// ── Phase derivation ─────────────────────────────────────────────────────
// Returns an array of phase bands, each with:
//   { type: 'pre'|'gallery'|'typing'|'class'|'post',
//     ruleIndex: number?, label: string,
//     startSec: number, endSec: number }
// Times are session-relative seconds (anchored to metadata.startTime).
function derivePhases(p) {
  const meta = p.metadata || {};
  const startIso = meta.startTime;
  const endIso = meta.endTime;
  if (!startIso) return [];
  const sessionStartMs = Date.parse(startIso);
  const sessionEndMs = endIso ? Date.parse(endIso) : null;
  if (!Number.isFinite(sessionStartMs)) return [];

  const trials = Array.isArray(p.trials) ? p.trials.slice() : [];
  if (trials.length === 0) {
    // Only the session-bounding "pre" band.
    const endSec = Number.isFinite(sessionEndMs)
      ? (sessionEndMs - sessionStartMs) / 1000
      : ((meta.totalDurationMs || 0) / 1000);
    return [{ type: 'pre', label: 'session', startSec: 0, endSec }];
  }

  // Sort trials by timestamp (defensive — usually already sorted)
  trials.sort((a, b) => {
    const aT = a?.timestamp ? Date.parse(a.timestamp) : 0;
    const bT = b?.timestamp ? Date.parse(b.timestamp) : 0;
    return aT - bT;
  });

  // Group by rule position. Use a fresh sentinel object as the "no current
  // group" marker so that an initial trial with rulePosition === null
  // doesn't accidentally match curPos.
  //
  // Phase trials (gallery, post_gallery_query, end_requery) are merged into
  // the trials array by the ingester but lack wall-clock `timestamp` — only
  // their integrityTrial.startTime (perfNow). Including them here would
  // corrupt the per-rule anchor (a phase trial sorting first within a group
  // makes classEndMs = NaN and the whole group drops). The phase BANDS
  // themselves are still computed below using galleryStudyMs anchoring; we
  // just don't need the phase trials inside the grouping.
  const NO_POS = Symbol('NO_POS');
  const groups = [];
  let cur = null;
  let curPos = NO_POS;
  for (const t of trials) {
    if (!t || typeof t !== 'object') continue;
    if (t.phase && t.phase !== 'classification') continue;
    const pos = t.rulePosition ?? null;
    if (cur === null || pos !== curPos) {
      if (cur) groups.push(cur);
      cur = { rulePosition: pos, ruleId: t.ruleId, trials: [] };
      curPos = pos;
    }
    cur.trials.push(t);
  }
  if (cur) groups.push(cur);

  // Gallery durations (per rule, in ms). May be a flat array.
  const galleryMs = Array.isArray(p.galleryStudyMs) ? p.galleryStudyMs : [];
  const typingMs = inferTypingDurations(p);

  // Build phase bands.
  //
  // Strategy: anchor each rule's gallery / typing windows BACKWARDS from
  // classStartMs (which we have exactly). For rule i:
  //     classification:  [classStartMs, classWindowEnd]
  //     typing:          [classStartMs - typDur, classStartMs]    (explain only)
  //     gallery:         [classStartMs - typDur - galDur, classStartMs - typDur]
  //     pre / transition: [cursorMs, galleryStartMs]
  // The pre band for i=0 is "consent / tutorial / comprehension"; for i≥1
  // it's an inter-rule transition (UI render time, brief pause). Pre band is
  // skipped if it would have zero or negative width (e.g., gallery+typing
  // overlap with the previous classification due to data noise).
  const phases = [];
  let cursorMs = sessionStartMs;

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.trials.length === 0) continue;

    // Classification window: from first trial's start to last trial's end
    const firstT = g.trials[0];
    const lastT = g.trials[g.trials.length - 1];
    const classEndMs = Date.parse(firstT.timestamp);
    if (!Number.isFinite(classEndMs)) continue;
    // Legacy Shape-2 trials carry `responseTime_ms` instead of `rt`; without the
    // fallback the classification window collapses to zero width and every
    // backwards-anchored band (gallery, typing) shifts right by the missing rt.
    const classStartMs = classEndMs - (firstT.rt ?? firstT.responseTime_ms ?? 0);
    const classWindowEnd = Date.parse(lastT.timestamp);

    const galDur = galleryMs[i] || 0;
    const typDur = typingMs[i] || 0;

    // Anchor gallery / typing backwards from classStartMs
    const typingEndMs = classStartMs;
    const typingStartMs = typingEndMs - typDur;
    const galleryEndMs = typingStartMs;
    const galleryStartMs = galleryEndMs - galDur;

    // Pre band (consent/tutorial/comprehension on i=0, transition otherwise).
    // Skip if width would be ≤ 0 (gallery/typing don't fit in the interlude —
    // happens with noisy data; better than overlap artefacts).
    if (galleryStartMs > cursorMs) {
      phases.push({
        type: 'pre',
        label: i === 0 ? 'consent / tutorial / comprehension' : 'transition',
        startSec: (cursorMs - sessionStartMs) / 1000,
        endSec: (galleryStartMs - sessionStartMs) / 1000,
      });
    }

    // Gallery band
    phases.push({
      type: 'gallery',
      ruleIndex: i,
      label: `gallery (${g.ruleId || `rule ${i + 1}`})`,
      startSec: (galleryStartMs - sessionStartMs) / 1000,
      endSec: (galleryEndMs - sessionStartMs) / 1000,
    });

    // Typing band (explain only)
    if (typDur > 0) {
      phases.push({
        type: 'typing',
        ruleIndex: i,
        label: 'type-explanation',
        startSec: (typingStartMs - sessionStartMs) / 1000,
        endSec: (typingEndMs - sessionStartMs) / 1000,
      });
    }

    // Classification band
    phases.push({
      type: 'class',
      ruleIndex: i,
      label: `classification ×${g.trials.length}`,
      startSec: (classStartMs - sessionStartMs) / 1000,
      endSec: (classWindowEnd - sessionStartMs) / 1000,
    });

    cursorMs = classWindowEnd;
  }

  // Post-final-rule band (re-query, demographics) up to session end
  const postEndMs = sessionEndMs || (sessionStartMs + (meta.totalDurationMs || 0));
  if (Number.isFinite(postEndMs) && postEndMs > cursorMs) {
    phases.push({
      type: 'post',
      label: 're-query / demographics',
      startSec: (cursorMs - sessionStartMs) / 1000,
      endSec: (postEndMs - sessionStartMs) / 1000,
    });
  }

  return phases;
}

function inferTypingDurations(p) {
  // postGalleryGuesses[i] = null for silent, or {rt, ruleId, response} for explain.
  // Use rt (ms) when present.
  const arr = Array.isArray(p.postGalleryGuesses) ? p.postGalleryGuesses : [];
  return arr.map(x => {
    if (x && typeof x.rt === 'number') return x.rt;
    return 0;
  });
}

// ── X-axis domain + perfNow → session-relative conversion ────────────────
// Determines the chart's X-axis maximum (in seconds) and stashes a
// session offset on the events object so all perfNow timestamps can be
// converted consistently.
function computeXDomain(p, events, phases) {
  const meta = p.metadata || {};

  // Session duration (seconds)
  let sessionDurSec = 0;
  if (Number.isFinite(meta.totalDurationMs)) {
    sessionDurSec = meta.totalDurationMs / 1000;
  } else if (meta.startTime && meta.endTime) {
    sessionDurSec = (Date.parse(meta.endTime) - Date.parse(meta.startTime)) / 1000;
  } else if (phases.length > 0) {
    sessionDurSec = phases[phases.length - 1].endSec;
  }

  // Estimate sessionOffset: the perfNow value (in ms) at session start.
  // This is the value to subtract from event.t_perfNow_ms to get session-rel ms.
  events.sessionOffsetMs = deriveSessionOffset(p, events);

  // Convert all event times to session-relative seconds in place
  for (const e of events.tabAways) {
    e.t_sec = (e.t_perfNow_ms - events.sessionOffsetMs) / 1000;
  }
  for (const s of events.sidebarSpans) {
    s.start_sec = (s.start_perfNow_ms - events.sessionOffsetMs) / 1000;
    s.end_sec = s.end_perfNow_ms != null
      ? (s.end_perfNow_ms - events.sessionOffsetMs) / 1000
      : sessionDurSec; // unclosed → extend to session end
  }
  for (const e of events.layoutShifts) {
    e.t_sec = (e.t_perfNow_ms - events.sessionOffsetMs) / 1000;
  }
  for (const v of events.guardViolations) {
    v.t_sec = (v.t_perfNow_ms - events.sessionOffsetMs) / 1000;
  }

  // Extend X-domain if any event lands beyond computed session duration
  // (rare — handles clock skew / late-saved data).
  let maxObserved = sessionDurSec;
  const consider = (sec) => {
    if (Number.isFinite(sec) && sec > maxObserved) maxObserved = sec;
  };
  for (const e of events.tabAways) consider(e.t_sec + e.duration_ms / 1000);
  for (const s of events.sidebarSpans) consider(s.end_sec);
  for (const e of events.layoutShifts) consider(e.t_sec);
  for (const v of events.guardViolations) consider(v.t_sec);

  return Math.max(maxObserved, sessionDurSec, 1);
}

// Derive (perfNow at session start) in ms.
// Strategy:
//   1. If any trial has trialStart_perfNow set, take the first trial's
//      perfNow anchor minus the trial's session-rel start (best — direct).
//   2. Else, if there's at least one per-trial tab-away with a `start`
//      perfNow value, use the same estimator as the ingest.
//   3. Else, fall back to 0 (assume page load == session start). This
//      drifts by ~20-60s for typical setups; flagged in the footer.
export function deriveSessionOffset(p, events) {
  const meta = p.metadata || {};
  const sessionStartMs = meta.startTime ? Date.parse(meta.startTime) : null;
  if (!Number.isFinite(sessionStartMs)) return 0;

  // Strategy 1: explicit per-trial perfNow anchors
  const trials = Array.isArray(p.trials) ? p.trials : [];
  for (const t of trials) {
    const anchor = t?.trialStart_perfNow ?? t?.startTime;
    if (typeof anchor !== 'number') continue;
    // Shape-2 (legacy) trials carry `responseTime_ms`, not `rt`
    // (ingest's LEGACY_FIELD_MAP only renames mouseTrack). Fall back so legacy
    // participants don't skip every candidate and drop to the offset-0 fallback.
    const rt = t?.rt ?? t?.responseTime_ms;
    if (!t?.timestamp || rt == null) continue;
    const trialEndWallMs = Date.parse(t.timestamp);
    const trialStartWallMs = trialEndWallMs - rt;
    if (!Number.isFinite(trialStartWallMs)) continue;
    // sessionOffset + (trialStartWall - sessionStartWall) = anchor
    // → sessionOffset = anchor - (trialStartWall - sessionStartWall)
    return anchor - (trialStartWallMs - sessionStartMs);
  }

  // Strategy 2: median across per-trial tab-aways (same approach as ingest)
  const candidates = [];
  for (let i = 0; i < trials.length; i++) {
    const t = trials[i];
    // After Shape-1 ingest, tab-aways live at the top-level t.tabAwayEvents
    // (the integrity sub-object is spread out). Fall back to the nested
    // integrityTrial path for callers that bypass ingest — same fallback
    // collectEvents() uses. Reading only the nested path made this strategy a
    // dead branch on ingested data, dropping every legacy participant to the
    // offset-0 fallback (Strategy 3) and drifting the timeline.
    const tabs = (Array.isArray(t?.tabAwayEvents) && t.tabAwayEvents)
      || (Array.isArray(t?.integrityTrial?.tabAwayEvents) && t.integrityTrial.tabAwayEvents)
      || [];
    if (tabs.length === 0) continue;
    const firstTabPerfNow = tabs[0]?.start;
    if (typeof firstTabPerfNow !== 'number') continue;
    // Legacy Shape-2 trials use `responseTime_ms`; see Strategy 1 above.
    const rt = t.rt ?? t.responseTime_ms;
    if (!t.timestamp || rt == null) continue;
    const trialEndWallMs = Date.parse(t.timestamp);
    const trialStartWallMs = trialEndWallMs - rt;
    if (!Number.isFinite(trialStartWallMs)) continue;
    const trialStartRelMs = trialStartWallMs - sessionStartMs;
    // Assume tab-away happened near trial midpoint (most conservative single-point estimate)
    candidates.push(firstTabPerfNow - trialStartRelMs - rt / 2);
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a - b);
    return candidates[Math.floor(candidates.length / 2)];
  }

  // Strategy 3: fallback. Returns 0 so perfNow values plot directly.
  return 0;
}

// ── Drawing primitives ───────────────────────────────────────────────────
function drawHeader(ctx, p, events) {
  ctx.fillStyle = C.title;
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText(`Session Timeline — ${shortId(p.participantId)}`, LEFT_PAD, 22);

  ctx.fillStyle = C.subtitle;
  ctx.font = '11px sans-serif';
  const cond = p.metadata?.condition || '?';
  const dur = p.metadata?.totalDurationMs ? `${(p.metadata.totalDurationMs / 60000).toFixed(1)} min` : '?';
  ctx.fillText(`condition=${cond}  duration=${dur}  trials=${(p.trials || []).length}`, LEFT_PAD, 38);

  // Sessionoffset note
  ctx.font = '10px sans-serif';
  if (!events.sessionOffsetMs) {
    ctx.fillStyle = '#999';
    ctx.fillText(`(perfNow→session-rel offset not derivable — perfNow events may drift ~20-60s)`, LEFT_PAD, 53);
  }
}

function drawPhaseStrip(ctx, phases, xScale, xDomain, chartW) {
  const y = TOP_PAD;
  // Background
  ctx.fillStyle = C.laneBg;
  ctx.fillRect(LEFT_PAD, y, chartW, PHASE_STRIP_H);

  for (const ph of phases) {
    const color = phaseColor(ph.type);
    const x0 = LEFT_PAD + Math.max(0, ph.startSec) * xScale;
    const x1 = LEFT_PAD + Math.min(xDomain, ph.endSec) * xScale;
    const w = Math.max(0, x1 - x0);
    if (w <= 0) continue;
    ctx.fillStyle = color;
    ctx.fillRect(x0, y + 1, w, PHASE_STRIP_H - 2);
  }

  // Border
  ctx.strokeStyle = C.laneBorder;
  ctx.lineWidth = 0.5;
  ctx.strokeRect(LEFT_PAD, y, chartW, PHASE_STRIP_H);

  // Label
  ctx.fillStyle = C.laneLabel;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Phases', LEFT_PAD - 6, y + PHASE_STRIP_H / 2 + 3);
  ctx.textAlign = 'left';
}

function phaseColor(type) {
  switch (type) {
    case 'pre': return C.phasePre;
    case 'gallery': return C.phaseGallery;
    case 'typing': return C.phaseTyping;
    case 'class': return C.phaseClass;
    case 'post': return C.phasePost;
    default: return C.laneBg;
  }
}

function drawLanes(ctx, events, xScale, xDomain, chartW) {
  const baseY = TOP_PAD + PHASE_STRIP_H + LANE_GAP;
  for (let i = 0; i < N_LANES; i++) {
    const y = baseY + i * (LANE_HEIGHT + LANE_GAP);
    drawLaneBackground(ctx, y, chartW);
    drawLaneLabel(ctx, y, LANE_NAMES[i]);
    switch (LANE_NAMES[i]) {
      case 'Tab-aways':       drawTabAways(ctx, y, events.tabAways, xScale, xDomain, events.tabFlickerCutoffMs); break;
      case 'Sidebars':        drawSidebars(ctx, y, events.sidebarSpans, xScale, xDomain); break;
      case 'Viewport shifts': drawLayoutShifts(ctx, y, events.layoutShifts, xScale, xDomain); break;
      case 'Guard-friction':  drawGuardViolations(ctx, y, events.guardViolations, xScale, xDomain); break;
    }
  }
}

function drawLaneBackground(ctx, y, chartW) {
  ctx.fillStyle = C.laneBg;
  ctx.fillRect(LEFT_PAD, y, chartW, LANE_HEIGHT);
  ctx.strokeStyle = C.laneBorder;
  ctx.lineWidth = 0.5;
  ctx.strokeRect(LEFT_PAD, y, chartW, LANE_HEIGHT);
}

function drawLaneLabel(ctx, y, text) {
  ctx.fillStyle = C.laneLabel;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(text, LEFT_PAD - 6, y + LANE_HEIGHT / 2 + 3);
  ctx.textAlign = 'left';
}

function tabColor(durationMs, flickerCutoffMs = 3000) {
  // Strict `<=` flicker boundary matches the runtime soft-scoring rule
  // (duration > cutoff counts) and summary.js's bins: a tab-away exactly at the
  // cutoff is a flicker, not a scored "meaningful" absence.
  if (durationMs <= flickerCutoffMs) return C.tabFlicker;
  if (durationMs < 10000) return C.tabMedium;
  return C.tabLong;
}

function drawTabAways(ctx, y, list, xScale, xDomain, flickerCutoffMs = 3000) {
  if (!Array.isArray(list)) return;
  for (const e of list) {
    if (!Number.isFinite(e.t_sec)) continue;
    // Allow events whose start is slightly negative if their end falls in-domain
    const endSec = e.t_sec + (e.duration_ms || 0) / 1000;
    if (endSec < 0 || e.t_sec > xDomain) continue;
    const clampedStart = Math.max(0, e.t_sec);
    const clampedEnd = Math.min(xDomain, endSec);
    const x = LEFT_PAD + clampedStart * xScale;
    // Bar width = duration clipped to domain (min 2px for visibility)
    const w = Math.max(2, (clampedEnd - clampedStart) * xScale);
    ctx.fillStyle = tabColor(e.duration_ms, flickerCutoffMs);
    ctx.fillRect(x, y + 4, w, LANE_HEIGHT - 8);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.4;
    ctx.strokeRect(x, y + 4, w, LANE_HEIGHT - 8);
  }
}

function drawSidebars(ctx, y, spans, xScale, xDomain) {
  if (!Array.isArray(spans)) return;
  for (const s of spans) {
    if (!Number.isFinite(s.start_sec)) continue;
    const startSec = clamp(s.start_sec, 0, xDomain);
    const endSec = clamp(s.end_sec, startSec, xDomain);
    const x = LEFT_PAD + startSec * xScale;
    const w = Math.max(3, (endSec - startSec) * xScale);
    ctx.fillStyle = C.sidebarSpan;
    ctx.fillRect(x, y + 6, w, LANE_HEIGHT - 12);
    if (!s.closed) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x + 0.5, y + 6.5, w - 1, LANE_HEIGHT - 13);
      ctx.setLineDash([]);
    }
  }
}

function drawLayoutShifts(ctx, y, list, xScale, xDomain) {
  if (!Array.isArray(list)) return;
  ctx.strokeStyle = C.layoutShift;
  ctx.lineWidth = 1.2;
  for (const e of list) {
    if (!Number.isFinite(e.t_sec)) continue;
    if (e.t_sec < 0 || e.t_sec > xDomain) continue;
    const x = LEFT_PAD + e.t_sec * xScale;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + 4);
    ctx.lineTo(x + 0.5, y + LANE_HEIGHT - 4);
    ctx.stroke();
  }
}

function drawGuardViolations(ctx, y, list, xScale, xDomain) {
  if (!Array.isArray(list)) return;
  // Cluster nearby polls visually — tamper events fire every ~300ms during
  // a violation period. Group consecutive events within 500ms into one tick
  // to keep the lane readable.
  const groups = [];
  let cur = null;
  for (const v of list) {
    if (!Number.isFinite(v.t_sec)) continue;
    if (v.t_sec < 0 || v.t_sec > xDomain) continue;
    if (cur && (v.t_sec - cur.lastSec) < 0.6) {
      cur.lastSec = v.t_sec;
      cur.count++;
    } else {
      if (cur) groups.push(cur);
      cur = { firstSec: v.t_sec, lastSec: v.t_sec, count: 1, reason: v.reason };
    }
  }
  if (cur) groups.push(cur);

  for (const g of groups) {
    const x0 = LEFT_PAD + g.firstSec * xScale;
    const x1 = LEFT_PAD + g.lastSec * xScale;
    const w = Math.max(2, x1 - x0);
    ctx.fillStyle = C.guardViolation;
    ctx.fillRect(x0, y + 6, w, LANE_HEIGHT - 12);
  }
}

// Dashed vertical guides at each rule boundary (= start of each gallery phase).
// Numbered at the top so it's easy to see which rule occupies which column.
// Skipped if there are < 2 galleries (e.g., trial-fields-stripped fallback).
function drawPhaseGuides(ctx, phases, xScale, xDomain, topY, bottomY) {
  const galleries = phases.filter(p => p.type === 'gallery'
    && Number.isFinite(p.startSec)
    && p.startSec >= 0
    && p.startSec <= xDomain);
  if (galleries.length < 2) return;

  ctx.save();
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 0.7;
  ctx.setLineDash([3, 3]);
  ctx.fillStyle = '#555';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';

  for (let i = 0; i < galleries.length; i++) {
    const g = galleries[i];
    const x = LEFT_PAD + g.startSec * xScale + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, bottomY);
    ctx.stroke();
    // Rule number label just above the lanes
    ctx.fillText(`r${i + 1}`, x, topY - 2);
  }

  ctx.restore();
  ctx.textAlign = 'left';
}

function drawXAxis(ctx, xDomain, chartW, canvasH) {
  const tickCount = 8;
  const yBase = canvasH - BOTTOM_PAD + 6;
  ctx.strokeStyle = C.xAxis;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(LEFT_PAD, yBase);
  ctx.lineTo(LEFT_PAD + chartW, yBase);
  ctx.stroke();

  ctx.fillStyle = C.xAxis;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i <= tickCount; i++) {
    const sec = (xDomain / tickCount) * i;
    const x = LEFT_PAD + sec * (chartW / xDomain);
    ctx.strokeStyle = C.xTick;
    ctx.beginPath();
    ctx.moveTo(x, yBase);
    ctx.lineTo(x, yBase + 4);
    ctx.stroke();
    ctx.fillText(formatSec(sec), x, yBase + 16);
  }
  ctx.textAlign = 'left';
}

function formatSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function drawLegendAndFooter(ctx, p, events, canvasH) {
  // Two-row legend: phases on the top row, event types on the bottom row.
  // Two rows is more readable than a 10-item single line and never silently
  // truncates (the old single-line version dropped the leftmost entries when
  // they overflowed, hiding the "gallery" label exactly when we needed it).
  const phaseItems = [
    { color: C.phasePre, label: 'framing (pre / transition / post)' },
    { color: C.phaseGallery, label: 'gallery' },
    { color: C.phaseTyping, label: 'typing' },
    { color: C.phaseClass, label: 'classification' },
  ];
  // Tab-away legend reflects THIS participant's cutoff (e.g. 5s for strict), not a
  // hardcoded 3s, matching the color bins and summary.csv counts.
  const cutoffS = Math.round((events.tabFlickerCutoffMs ?? 3000) / 1000);
  const eventItems = [
    { color: C.tabFlicker, label: `tab ≤${cutoffS}s` },
    { color: C.tabMedium, label: `tab ${cutoffS}–10s` },
    { color: C.tabLong, label: 'tab ≥10s' },
    { color: C.sidebarSpan, label: 'sidebar (open span)' },
    { color: C.layoutShift, label: 'viewport shift' },
    { color: C.guardViolation, label: 'guard-friction' },
  ];
  ctx.font = '9px sans-serif';
  drawLegendRow(ctx, phaseItems, 16);
  drawLegendRow(ctx, eventItems, 28);

  // Footer summary
  const fY = canvasH - BOTTOM_PAD + 38;
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#333';
  const tabSessTotal = events.sessionTabDurations.length;
  const flickerCutoffMs = events.tabFlickerCutoffMs ?? 3000;
  // "Meaningful" = scored = strictly longer than the cutoff (matches the runtime).
  const tabSessLong = events.sessionTabDurations.filter(d => d > flickerCutoffMs).length;
  const cutoffSecLabel = `${Math.round(flickerCutoffMs / 1000)}s`;
  const sb = events.sidebarSpans.length;
  const ls = events.layoutShifts.length;
  const gf = events.guardViolations.length;

  // Sidebar counts: the footer reports the OPENING count — the same
  // `countSidebarOpenings()` value summary.csv's `sidebar_event_count` and triage
  // use, so the timeline and the CSV agree. `sb` (sidebarSpans) is the number of
  // open→close spans actually DRAWN, which can exceed openings when one physical
  // sidebar is double-detected (innerWidth_delta + layout_compression).
  const sidebarOpenings = countSidebarOpenings(p.session?.sidebarEvents);
  const spanNote = sb !== sidebarOpenings ? ` (${sb} span${sb === 1 ? '' : 's'} drawn)` : '';
  // Tab-away note depends on what the payload could offer: libraries ≥0.6.1
  // save session-level tabAwayEvents so every tab-away (on-trial or off)
  // plots; older payloads keep off-trial tab-aways as durations only, and
  // the footer flags how many are unplaceable on the axis.
  const tabNote = events.tabAwaySource === 'session'
    ? `All ${events.tabAways.length} plotted from session-level events (incl. off-trial)`
    : `Per-trial events plotted: ${events.tabAways.length}    ` +
      `Off-trial events: ${events.offTrialTabAwayCount} (timing not preserved — pre-0.6.1 payload)`;
  const lines = [
    `Tab-aways  total=${tabSessTotal}  (> ${cutoffSecLabel}: ${tabSessLong})    ` + tabNote,
    `Sidebars  ${sidebarOpenings} opening${sidebarOpenings === 1 ? '' : 's'}${spanNote}    ` +
      `Viewport shifts  ${ls}    Guard-friction violations  ${gf}`,
  ];
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], LEFT_PAD, fY + i * 14);
  }
}

// Right-aligned legend row. Never truncates; if items overflow, they extend
// leftward past the chart midpoint rather than being silently dropped.
function drawLegendRow(ctx, items, yText) {
  let lx = CANVAS_W - RIGHT_PAD;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const w = ctx.measureText(it.label).width;
    lx -= w;
    ctx.fillStyle = '#333';
    ctx.fillText(it.label, lx, yText);
    lx -= 5;
    ctx.fillStyle = it.color;
    ctx.fillRect(lx - 9, yText - 7, 9, 8);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 0.4;
    ctx.strokeRect(lx - 9, yText - 7, 9, 8);
    lx -= 12;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
}
function shortId(name) {
  return String(name).slice(0, 8);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
