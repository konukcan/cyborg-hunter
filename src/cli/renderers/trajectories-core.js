// src/cli/renderers/trajectories-core.js
//
// Pure drawing core for per-participant mouse-trajectory grid images — no
// Node APIs, so a browser demo can bundle it directly (0.7.2-style
// extraction from cli/renderers/trajectories.js, which is now a thin fs
// wrapper around this module: it acquires node-canvas, calls
// drawTrajectoryGrid per participant, and writes the returned canvas to a
// PNG). Mirrors the session-timeline-core.js split.
//
// drawTrajectoryGrid(p, triageEntry, config, createCanvas) draws the full
// grid of per-trial panels for one participant and returns the drawn canvas
// (or null if the participant has no trials to plot). createCanvas is
// injected so this module never imports the `canvas` package directly — a
// browser caller can pass a document-canvas-backed factory instead.
//
// Per-panel visual elements:
//   - Time-colored path (blue → red gradient over the trial's duration)
//   - Start marker (blue circle), end marker (red square)
//   - Mousedown (green ▼), mouseup (magenta ▲)
//   - Tab-away pairs (yellow ◆ at the leave point, cyan ◆ at return, size ∝
//     duration), connected by a dashed line
//   - Pause circles (grey ○) for >3s gaps that don't overlap a tab-away
//   - Browser-window outline (purple, dashed); screen outline (teal, solid)
//     when geometry data is present and internally consistent
//   - Red panel border if any hard signal fired on this trial
//   - Title with trial ID, RT, mouse count, tab-away count + total duration

import { ruleChronologicalCompare } from '../extract-core.js';

// Panel dimensions (pixels).
const PANEL_W = 400;
const PANEL_H = 300;
const PANEL_PAD = 40;
const TITLE_HEIGHT = 40;
const HEADER_HEIGHT = 96;   // accommodates 3-line legend
const PANEL_MARGIN = 15;    // inset between panel border and content area

// Color palette. Hoisted from inline string literals to give the rendering
// style one place to look. Names match the visual element they style.
const COLORS = {
  bg: '#ffffff',
  panelBg: '#fafafa',
  panelBorder: '#ccc',
  panelBorderHardHit: '#ff0000',
  headerText: '#333',
  legendText: '#666',
  zoomTag: '#a06000',
  noData: '#999',
  screenRect: '#26a69a',
  windowRect: '#7e57c2',
  pathStart: '#0000ff',
  pathEnd: '#ff0000',
  pathEndStroke: '#000',
  mousedown: '#00cc00',
  mouseup: '#ff00ff',
  tabAwayLeftFill: '#ffff00',
  tabAwayLeftStroke: '#ff8c00',
  tabAwayReturnFill: '#00ffff',
  tabAwayReturnStroke: '#008b8b',
  pauseCircle: '#ccc',
};

// Panel-background tints by trial phase (0.6.1, retro item 9) — same palette
// as the session-timeline phase strip (session-timeline.js C.phase*), so a
// panel's tint and the timeline band for the same phase read as one system.
// Trials without a recognized phase keep the neutral panelBg.
const PHASE_TINTS = {
  gallery: '#ffe0b2',             // peach — matches C.phaseGallery
  post_gallery_query: '#e1bee7',  // light purple — matches C.phaseTyping
  typing: '#e1bee7',
  classification: '#bbdefb',      // light blue — matches C.phaseClass
  end_requery: '#eceff1',         // bluish grey — matches C.phasePre/Post
};

// Orders a participant's trials for the panel grid (0.6.1, retro item 3).
// config.trajectoryDisplayOrder:
//   'rule'      (default) chronological by rule — (rulePosition, phase-rank,
//               trialNumber), the order each rule was actually experienced.
//               Same comparator the ingest uses when merging phaseTrials, so
//               already-sorted data keeps its order (stable sort).
//   'time'      wall-clock trial timestamps (fallback: trialNumber)
//   'insertion' raw ingest order (pre-0.6.1 behavior)
// Exported for tests.
export function orderTrials(trials, config) {
  const mode = config.trajectoryDisplayOrder || 'rule';
  if (mode === 'insertion') return trials;
  const ordered = trials.slice();
  if (mode === 'time') {
    ordered.sort((a, b) => {
      const at = a?.timestamp ? Date.parse(a.timestamp) : NaN;
      const bt = b?.timestamp ? Date.parse(b.timestamp) : NaN;
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return (a.trialNumber ?? 0) - (b.trialNumber ?? 0);
    });
  } else {
    ordered.sort(ruleChronologicalCompare);
  }
  return ordered;
}

// Draws one participant's full trajectory grid (all per-trial panels) onto a
// canvas obtained from the injected createCanvas factory. Returns the drawn
// canvas, or null when the participant has no trials to plot — mirrors the
// `continue` in the pre-extraction renderTrajectories loop; the fs wrapper
// skips the PNG write in that case.
export function drawTrajectoryGrid(p, triageEntry, config, createCanvas) {
  const trials = orderTrials(p.trials, config);
  if (trials.length === 0) return null;

  // Compute grid layout
  const cols = Math.min(5, trials.length);
  const rows = Math.ceil(trials.length / cols);

  const canvasW = cols * (PANEL_W + PANEL_PAD) + PANEL_PAD;
  const canvasH = HEADER_HEIGHT + rows * (PANEL_H + TITLE_HEIGHT + PANEL_PAD) + PANEL_PAD;
  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Header
  const headerText = `${p.participantId} — Score: ${triageEntry?.score ?? '?'} — ${triageEntry?.reason ?? ''}`;
  ctx.fillStyle = COLORS.headerText;
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(headerText, PANEL_PAD, 30);

  // Two-line legend — splitting keeps the panel-frame meaning visible rather
  // than buried at the end of a wrap.
  ctx.font = '11px sans-serif';
  ctx.fillStyle = COLORS.legendText;
  ctx.fillText(
    'Blue●=start  Red■=end  Green▼=mousedown  Magenta▲=mouseup  Yellow◆=tab-away (left)  Cyan◆=tab-away (returned)  Grey○=pause',
    PANEL_PAD, 48
  );
  ctx.fillText(
    'Teal outer rect=screen  Purple dashed rect=browser window  Red panel frame=hard signal triggered on this trial',
    PANEL_PAD, 64
  );
  ctx.fillText(
    'Panel tint=phase: peach gallery, purple typing/query, blue classification, grey re-query (neutral = unphased) — matches the session-timeline strip',
    PANEL_PAD, 80
  );

  // session.windowPositions is the 2-second-poll-plus-resize-event record
  // from core/signals/browser.js. Per-trial geometry uses the sample whose
  // timestamp best fits the trial's mouse extent (see
  // pickWindowGeometryForTrial). Older recordings without sw/sh fields
  // yield a window-only geometry; chooseScreenFrame degrades gracefully.
  const windowPositions = p.session?.windowPositions || [];

  for (let i = 0; i < trials.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = PANEL_PAD + col * (PANEL_W + PANEL_PAD);
    const y0 = HEADER_HEIGHT + PANEL_PAD + row * (PANEL_H + TITLE_HEIGHT + PANEL_PAD);

    // Geometry resolution priority: explicit per-trial > session-end > polled.
    // Per-trial wins because it was captured AT trial render time and can't
    // be stale; session-end can drift if the participant resized between
    // last sample and end-of-experiment. Polled fills in for jsPsych
    // extension data, which has no explicit per-trial geometry field.
    const sessionMeta = p.metadata || {};
    const sessionGeom = sessionMeta.geometry || {};
    const trialGeom = trials[i].geometry || {};
    const polledGeom = pickWindowGeometryForTrial(trials[i], windowPositions) || {};
    const effectiveMeta = { ...sessionMeta, ...sessionGeom, ...polledGeom, ...trialGeom };
    renderTrialPanel(ctx, trials[i], x0, y0, config, effectiveMeta);
  }

  return canvas;
}

function renderTrialPanel(ctx, trial, x0, y0, config, metadata) {
  const mouse = trial.mouseEvents || [];
  const tabAways = trial.tabAwayEvents || [];
  // String() guard: a numeric trialId/ruleId (from a hand-edited payload or a
  // dynamicTyping CSV) would otherwise throw on .substring() below and, with no
  // per-participant boundary, abort every remaining visual.
  const trialId = String(trial.trialId || trial.ruleId || '?');
  const rt = (trial.duration_ms || trial.responseTime_ms || 0) / 1000;
  const moves = mouse.filter(e => e.type === 'move');
  const downs = mouse.filter(e => e.type === 'down');
  const ups = mouse.filter(e => e.type === 'up');

  // Panel border — red if any hard-signal trialHits fired on this trial.
  const anyHardHit = trial.trialSignals?.hard &&
    Object.values(trial.trialSignals.hard).some(s => (s.trialHits || 0) > 0);
  ctx.strokeStyle = anyHardHit ? COLORS.panelBorderHardHit : COLORS.panelBorder;
  ctx.lineWidth = anyHardHit ? 3 : 1;
  ctx.strokeRect(x0, y0 + TITLE_HEIGHT, PANEL_W, PANEL_H);

  // Panel background — tinted by trial phase (see PHASE_TINTS), neutral for
  // unphased trials.
  ctx.fillStyle = PHASE_TINTS[trial.phase] || COLORS.panelBg;
  ctx.fillRect(x0 + 1, y0 + TITLE_HEIGHT + 1, PANEL_W - 2, PANEL_H - 2);

  // Title
  const nTabs = tabAways.length;
  const tabDur = tabAways.reduce((s, e) => s + (e.duration_ms || 0), 0) / 1000;
  ctx.fillStyle = COLORS.headerText;
  ctx.font = '11px sans-serif';
  ctx.fillText(`${trialId.substring(0, 20)} — ${rt.toFixed(0)}s, ${moves.length} mv, ${nTabs} tabs (${tabDur.toFixed(0)}s)`,
    x0, y0 + TITLE_HEIGHT - 8);

  if (moves.length === 0) {
    ctx.fillStyle = COLORS.noData;
    ctx.font = '12px sans-serif';
    ctx.fillText('No mouse data', x0 + PANEL_W / 2 - 40, y0 + TITLE_HEIGHT + PANEL_H / 2);
    return;
  }

  // Choose a geometry frame and decide which rectangles can be drawn honestly.
  // Four cases, in priority order:
  //   1. SCREEN-API   — metadata.screens (Window Management API) present.
  //                     Multi-monitor layout known; render in true screen space
  //                     and draw both rectangles.
  //   2. LEGACY       — screenWidth/screenHeight present. Draw both rects when
  //                     the window geometry doesn't paradoxically exceed the
  //                     screen (zoom-out, multi-monitor). When it does, drop
  //                     the outer rect — drawing a "screen" smaller than the
  //                     "window" it supposedly contains is dishonest.
  //   3. WINDOW-ONLY  — window geometry but no screen size. Fit canvas to the
  //                     window outline and draw it alone.
  //   4. AUTO-FIT     — no geometry at all; auto-fit to mouse path.
  const screenFrame = chooseScreenFrame(metadata);
  let minX, maxX, minY, maxY, offsetX, offsetY;
  if (screenFrame.mode === 'screen-api' || screenFrame.mode === 'legacy') {
    const { screenW, screenH, winX, winY, winW, winH } = screenFrame;
    minX = 0;
    minY = 0;
    maxX = Math.max(screenW, winX + winW);
    maxY = Math.max(screenH, winY + winH);
    offsetX = winX;
    offsetY = winY;
  } else if (screenFrame.mode === 'window-only') {
    // Frame the canvas around the window itself. Mouse coords are
    // viewport-relative (0..innerWidth), so adding offsetX=winX places the
    // trajectory inside the window outline at roughly the right spot. The
    // chrome offset isn't accounted for, but for a no-screen visualization
    // this is honest enough — the window outline shows scale and position.
    const { winX, winY, winW, winH } = screenFrame;
    minX = winX;
    minY = winY;
    maxX = winX + winW;
    maxY = winY + winH;
    offsetX = winX;
    offsetY = winY;
  } else {
    // Auto-fit fallback
    const allX = moves.map(m => m.x);
    const allY = moves.map(m => m.y);
    minX = Math.min(...allX) - 20;
    maxX = Math.max(...allX) + 20;
    minY = Math.min(...allY) - 20;
    maxY = Math.max(...allY) + 20;
    offsetX = 0;
    offsetY = 0;
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Zoom-robust mouse plotting. Mouse coords (clientX/Y) are in viewport CSS
  // pixels; the window outline is in screen CSS pixels. At non-100% browser
  // zoom these scales differ — clicks would plot outside the outline.
  // Scaling mouse coords by outer/inner ratio aligns them with the outline.
  // Critically, X and Y scales are computed separately because chrome
  // geometry isn't symmetric (top tabs+address bar vs ~zero left/right).
  // Skipped in auto-fit mode (no outline → no alignment needed).
  const zoom = (screenFrame.mode === 'auto-fit') ? { x: 1, y: 1 } : computeZoomScale(metadata);

  const mapX = (px) => x0 + PANEL_MARGIN + ((px * zoom.x + offsetX - minX) / rangeX) * (PANEL_W - 2 * PANEL_MARGIN);
  const mapY = (py) => y0 + TITLE_HEIGHT + PANEL_MARGIN + ((py * zoom.y + offsetY - minY) / rangeY) * (PANEL_H - 2 * PANEL_MARGIN);

  // Screen + browser-window rectangles. The frame chooser above decides which
  // rectangles are safe to draw. `drawOuter` is false for legacy data with a
  // window/screen paradox (zoom-out, multi-monitor) — we'd rather show nothing
  // than a screen rect smaller than the window it supposedly contains. It's
  // also false for window-only mode (no screen data at all).
  if (screenFrame.mode === 'screen-api' || screenFrame.mode === 'legacy' || screenFrame.mode === 'window-only') {
    const { screenW, screenH, winX, winY, winW, winH, drawOuter } = screenFrame;
    const rectMapX = (px) => x0 + PANEL_MARGIN + ((px - minX) / rangeX) * (PANEL_W - 2 * PANEL_MARGIN);
    const rectMapY = (py) => y0 + TITLE_HEIGHT + PANEL_MARGIN + ((py - minY) / rangeY) * (PANEL_H - 2 * PANEL_MARGIN);
    ctx.save();
    ctx.lineWidth = 1;
    if (drawOuter) {
      ctx.strokeStyle = COLORS.screenRect;
      ctx.strokeRect(
        rectMapX(0), rectMapY(0),
        rectMapX(screenW) - rectMapX(0),
        rectMapY(screenH) - rectMapY(0)
      );
    }
    ctx.strokeStyle = COLORS.windowRect;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      rectMapX(winX), rectMapY(winY),
      rectMapX(winX + winW) - rectMapX(winX),
      rectMapY(winY + winH) - rectMapY(winY)
    );
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Zoom indicator — appended to the title. Honest signal that the viewport
  // is scaled, so the viewer doesn't try to compare px counts across panels
  // with different effective scales. Detected from visualViewport.scale or
  // from outerWidth/innerWidth deviation.
  const zoomTag = computeZoomTag(metadata);
  if (zoomTag) {
    ctx.fillStyle = COLORS.zoomTag;
    ctx.font = 'italic 10px sans-serif';
    ctx.fillText(zoomTag, x0 + PANEL_W - 60, y0 + TITLE_HEIGHT - 8);
  }

  // Time normalization for color gradient
  const ts = moves.map(m => m.t);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const tRange = tMax - tMin || 1;

  // Draw path segments with time-based color (blue→red)
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;
  for (let j = 1; j < moves.length; j++) {
    const tNorm = (moves[j].t - tMin) / tRange;
    ctx.strokeStyle = timeColor(tNorm);
    ctx.beginPath();
    ctx.moveTo(mapX(moves[j - 1].x), mapY(moves[j - 1].y));
    ctx.lineTo(mapX(moves[j].x), mapY(moves[j].y));
    ctx.stroke();

    // Pause markers (>3s gap with no movement).
    // Both moves[j].t and ta.startRel_ms are trial-relative ms (normalized in
    // ingest). Find the tab-away (if any) whose [start, start+duration] window
    // overlaps the gap. If we find one, draw the leave/return diamond pair;
    // otherwise drop a grey pause circle.
    const gap = moves[j].t - moves[j - 1].t;
    if (gap > 3000) {
      const taStart = (ta) => (ta.startRel_ms != null ? ta.startRel_ms : ta.start);
      const overlappingTab = tabAways.find(ta =>
        taStart(ta) < moves[j].t + 1000 &&
        (taStart(ta) + (ta.duration_ms || 0)) > moves[j - 1].t - 1000
      );
      if (overlappingTab) {
        // Diamond size scales with √duration (square root keeps very long
        // tab-aways from drawing as huge blobs that obscure the trajectory).
        const dur = overlappingTab.duration_ms || gap;
        const size = Math.min(20, Math.max(4, 4 + Math.sqrt(dur / 1000) * 3));

        drawDiamond(ctx, mapX(moves[j - 1].x), mapY(moves[j - 1].y), size,
          COLORS.tabAwayLeftFill, COLORS.tabAwayLeftStroke);
        drawDiamond(ctx, mapX(moves[j].x), mapY(moves[j].y), size,
          COLORS.tabAwayReturnFill, COLORS.tabAwayReturnStroke);

        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = COLORS.tabAwayLeftStroke;
        ctx.beginPath();
        ctx.moveTo(mapX(moves[j - 1].x), mapY(moves[j - 1].y));
        ctx.lineTo(mapX(moves[j].x), mapY(moves[j].y));
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = COLORS.pauseCircle;
        ctx.beginPath();
        ctx.arc(mapX(moves[j - 1].x), mapY(moves[j - 1].y), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  // Start marker (blue circle)
  ctx.fillStyle = COLORS.pathStart;
  ctx.strokeStyle = COLORS.pathEndStroke;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.arc(mapX(moves[0].x), mapY(moves[0].y), 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // End marker (red square)
  const ex = mapX(moves[moves.length - 1].x);
  const ey = mapY(moves[moves.length - 1].y);
  ctx.fillStyle = COLORS.pathEnd;
  ctx.fillRect(ex - 4, ey - 4, 8, 8);
  ctx.strokeRect(ex - 4, ey - 4, 8, 8);

  // Mousedown markers (green ▼)
  ctx.fillStyle = COLORS.mousedown;
  for (const d of downs) {
    drawTriangle(ctx, mapX(d.x), mapY(d.y), 5, 'down');
  }

  // Mouseup markers (magenta ▲)
  ctx.fillStyle = COLORS.mouseup;
  for (const u of ups) {
    drawTriangle(ctx, mapX(u.x), mapY(u.y), 5, 'up');
  }
}

// Interpolates blue→red based on normalized time (0→1)
function timeColor(t) {
  const r = Math.round(t * 255);
  const b = Math.round((1 - t) * 255);
  return `rgb(${r}, 50, ${b})`;
}

function drawDiamond(ctx, x, y, size, fill, stroke) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawTriangle(ctx, x, y, size, direction) {
  ctx.beginPath();
  if (direction === 'down') {
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y - size);
    ctx.lineTo(x, y + size);
  } else {
    ctx.moveTo(x - size, y + size);
    ctx.lineTo(x + size, y + size);
    ctx.lineTo(x, y - size);
  }
  ctx.closePath();
  ctx.fill();
}

// Used by the fs wrapper to build the per-participant PNG filename. Exported
// (rather than kept private) to match session-timeline-core.js's sanitize,
// which the browser demo plot adapter is also expected to reuse.
export function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
}

// Picks the windowPositions sample closest in time to the trial's start
// anchor and translates it into the field shape chooseScreenFrame() expects.
//
// Returns null when:
//   - windowPositions is empty (e.g. signal disabled, or pre-tracking data)
//   - the trial has no trialStart_perfNow (no time anchor → can't pick)
//
// Translation: monitor stores compact field names (x/y/w/h/iw/ih/sw/sh) for
// terse JSON; the renderer's chooseScreenFrame reads expanded names. Doing
// the rename here keeps both sides clean.
//
// The screenWidth/screenHeight fields are conditionally included — the
// April 2026 monitor change added sw/sh capture, but older recordings
// won't have it. Omitting (rather than zero-filling) lets chooseScreenFrame
// fall through its compatibility/auto-fit branches honestly.
export function pickWindowGeometryForTrial(trial, windowPositions) {
  if (!Array.isArray(windowPositions) || windowPositions.length === 0) return null;
  // Time anchor for matching the right windowPositions sample.
  //
  // jsPsych extension data carries `trialStart_perfNow` (set by the wrapper's
  // on_load). Raw-DOM extension users save
  // `startTime` directly from `performance.now()` at trial start. Both are in
  // the same reference frame as `windowPositions[].t` (performance.now()), so
  // either works.
  //
  // Without this fallback, raw-DOM users see auto-fit or stale session-level
  // window dimensions — symptom: the dashed "window" box in the trajectory
  // PNG is sized for the pre-fullscreen viewport even when the trial happened
  // in fullscreen, so mouse dots plot outside the box.
  const anchor = (typeof trial?.trialStart_perfNow === 'number')
    ? trial.trialStart_perfNow
    : (typeof trial?.startTime === 'number' ? trial.startTime : null);
  if (typeof anchor !== 'number') return null;

  // Selection strategy (in priority order):
  //   1. Among samples within the trial's time range, prefer ones whose
  //      viewport (after zoom-scaling) contains the trial's max mouse extent.
  //      This handles trials that span a window resize — the trial's mouse
  //      events may live in different viewport states, so we pick the one
  //      that best contains them visually. Closest-in-time among fitting
  //      candidates.
  //   2. If no in-range sample fits, pick the in-range sample with the
  //      largest viewport (best chance of mouse showing inside outline).
  //   3. If nothing in range at all, fall back to the global closest-in-time.
  //
  // Without this, a trial that spanned a resize would get an arbitrary
  // snapshot and mouse plotted outside the outline — visually misleading.

  const duration = trial.duration_ms || 0;
  const trialEnd = anchor + duration;
  const moves = (trial.mouseEvents || []).filter(e => e.type === 'move');
  const maxX = moves.length ? Math.max(...moves.map(m => m.x)) : 0;
  const maxY = moves.length ? Math.max(...moves.map(m => m.y)) : 0;

  function fits(s) {
    if (!s.w || !s.iw || !s.h || !s.ih) return false;
    return (maxX * s.w / s.iw) <= s.w && (maxY * s.h / s.ih) <= s.h;
  }
  function viewportArea(s) { return (s.iw || 0) * (s.ih || 0); }
  function timeDelta(s) { return Math.abs(s.t - anchor); }

  // Allow a 1-second slop on each end of the trial to account for resize
  // event debouncing (samples may land slightly outside the trial window).
  const inRange = duration > 0
    ? windowPositions.filter(s => s.t >= anchor - 1000 && s.t <= trialEnd + 1000)
    : windowPositions;

  let best;
  const fitting = inRange.filter(fits);
  if (fitting.length > 0) {
    best = fitting.reduce((a, b) => timeDelta(a) <= timeDelta(b) ? a : b);
  } else if (inRange.length > 0) {
    best = inRange.reduce((a, b) => viewportArea(a) >= viewportArea(b) ? a : b);
  } else {
    best = windowPositions.reduce((a, b) => timeDelta(a) <= timeDelta(b) ? a : b);
  }

  const out = {
    windowX: best.x,
    windowY: best.y,
    windowWidth: best.w,
    windowHeight: best.h,
    // Both outer and inner dimensions on BOTH axes are needed by
    // computeZoomScale — chrome asymmetry means the X and Y zoom factors
    // genuinely differ. Earlier versions of this function dropped the
    // height fields, which silently zeroed out the Y scale and plotted
    // mouse Y way outside the outline at non-100% zoom.
    outerWidth: best.w,
    outerHeight: best.h,
    innerWidth: best.iw,
    innerHeight: best.ih,
  };
  if (typeof best.sw === 'number' && typeof best.sh === 'number') {
    out.screenWidth = best.sw;
    out.screenHeight = best.sh;
  }
  // Zoom diagnostics added April 2026. Optional — older recordings won't
  // have these fields. devicePixelRatio captures HIDPI/retina scaling;
  // visualViewportScale captures pinch zoom (touch devices, distinct
  // from CSS-level browser zoom which we infer from outerWidth/innerWidth).
  if (typeof best.dpr === 'number') out.devicePixelRatio = best.dpr;
  if (typeof best.vvScale === 'number') out.visualViewportScale = best.vvScale;
  return out;
}

// CSS-level browser zoom (Cmd-Plus / Cmd-Minus on desktop) has no direct JS
// API. We infer it from the ratio of outer (window frame, fixed in screen
// pixels) to inner (viewport, in CSS pixels that scale with zoom):
//   zoom_factor ≈ outerWidth / innerWidth
//   - ≈ 1 at 100% zoom
//   - < 1 zoomed out (viewport reports MORE CSS pixels than outer frame)
//   - > 1 zoomed in  (viewport reports FEWER CSS pixels than outer frame)
//
// Critically, X and Y zoom factors can differ because chrome geometry isn't
// symmetric: most browsers have ~0px left/right chrome but ~80px top chrome
// (tabs + address bar). On macOS retina especially, this asymmetry creates
// significantly different x and y ratios, so a single uniform scale plots
// mouse outside the outline on one axis. Returning {x, y} fixes this.
//
// Both fields default to 1 (identity, no scaling) when either dimension is
// missing or non-positive — keeps callers honest without per-call null checks.
export function computeZoomScale(metadata) {
  if (!metadata) return { x: 1, y: 1 };
  const ow = metadata.outerWidth, iw = metadata.innerWidth;
  const oh = metadata.outerHeight, ih = metadata.innerHeight;
  return {
    x: (typeof ow === 'number' && typeof iw === 'number' && ow > 0 && iw > 0) ? ow / iw : 1,
    y: (typeof oh === 'number' && typeof ih === 'number' && oh > 0 && ih > 0) ? oh / ih : 1,
  };
}

// Picks the geometry frame and decides which rectangles are safe to draw.
// Returns one of FOUR shapes:
//   { mode: 'screen-api',  screenW, screenH, winX, winY, winW, winH, drawOuter: true }
//   { mode: 'legacy',      screenW, screenH, winX, winY, winW, winH, drawOuter }
//   { mode: 'window-only', winX, winY, winW, winH, drawOuter: false }
//   { mode: 'auto-fit' }
//
// The 'screen-api' branch trusts metadata.screens (Window Management API) and
// uses the screen the window currently sits on (currentScreenLabel-matched)
// rather than the primary monitor — eliminates multi-monitor paradoxes.
//
// The 'legacy' branch covers data with screenWidth/screenHeight: draw both
// rects when the geometry is internally consistent, drop the outer rect when
// the window paradoxically exceeds the (primary-only) screen.
//
// The 'window-only' branch is for jsPsych extension data captured before
// the April 2026 monitor change added window.screen.width/height to its
// polled samples.
//
// The 'auto-fit' branch is the catch-all: no usable geometry, fit canvas to
// the mouse path.
export function chooseScreenFrame(metadata) {
  if (!metadata) return { mode: 'auto-fit' };

  // Branch 1: Window Management API data present.
  if (Array.isArray(metadata.screens) && metadata.screens.length > 0) {
    // Pick the screen the window lives on. If currentScreenLabel matches a
    // labeled entry, use it; otherwise prefer the screen whose bounds contain
    // the window origin; otherwise fall back to the primary.
    const current = pickCurrentScreen(metadata);
    const winX = metadata.windowX ?? 0;
    const winY = metadata.windowY ?? 0;
    const winW = metadata.windowWidth || current.width;
    const winH = metadata.windowHeight || current.height;
    return {
      mode: 'screen-api',
      screenW: current.width,
      screenH: current.height,
      winX, winY, winW, winH,
      drawOuter: true
    };
  }

  // Branch 2: legacy data — primaryScreenWidth or screenWidth.
  const screenW = metadata.primaryScreenWidth ?? metadata.screenWidth;
  const screenH = metadata.primaryScreenHeight ?? metadata.screenHeight;
  if (screenW > 0 && screenH > 0) {
    const winX = metadata.windowX ?? 0;
    const winY = metadata.windowY ?? 0;
    const winW = metadata.windowWidth || screenW;
    const winH = metadata.windowHeight || screenH;
    // Paradox check: window must fit inside screen for the outer rect to be
    // honest. A 1px tolerance accommodates rounding. If the window exceeds
    // the screen on any side, drop the outer rect — the participant likely
    // zoomed out, used a secondary monitor, or has DPR scaling weirdness.
    const tol = 1;
    const fits =
      winX >= -tol && winY >= -tol &&
      (winX + winW) <= (screenW + tol) &&
      (winY + winH) <= (screenH + tol);
    return {
      mode: 'legacy',
      screenW, screenH, winX, winY, winW, winH,
      drawOuter: fits
    };
  }

  // Branch 3: window-only — we have window geometry but no screen size.
  // Recordings made before the April 2026 monitor change (which added
  // window.screen.width/height capture) hit this path. Draw just the
  // browser-window rectangle; the screen rectangle is omitted because we
  // genuinely don't know the screen dimensions.
  if (metadata.windowWidth > 0 && metadata.windowHeight > 0) {
    return {
      mode: 'window-only',
      winX: metadata.windowX ?? 0,
      winY: metadata.windowY ?? 0,
      winW: metadata.windowWidth,
      winH: metadata.windowHeight,
      drawOuter: false,
    };
  }

  return { mode: 'auto-fit' };
}

function pickCurrentScreen(metadata) {
  const screens = metadata.screens;
  if (metadata.currentScreenLabel) {
    const match = screens.find(s => s.label === metadata.currentScreenLabel);
    if (match) return match;
  }
  // Prefer the screen whose availLeft/availTop bound the window origin.
  if (typeof metadata.windowX === 'number' && typeof metadata.windowY === 'number') {
    const containing = screens.find(s =>
      metadata.windowX >= (s.availLeft ?? 0) &&
      metadata.windowX < (s.availLeft ?? 0) + s.width &&
      metadata.windowY >= (s.availTop ?? 0) &&
      metadata.windowY < (s.availTop ?? 0) + s.height
    );
    if (containing) return containing;
  }
  return screens.find(s => s.isPrimary) || screens[0];
}

// Compute a "zoom × N" tag for the panel title when the participant has
// adjusted browser zoom away from 100%. Returns a string like "zoom × 0.75"
// or null when zoom is within tolerance.
//
// Two heuristics, in order of directness:
//   1. visualViewport.scale — direct API value, exact for pinch zoom on touch
//      devices. Doesn't catch CSS-level browser zoom (Cmd-Plus / Cmd-Minus on
//      desktop), which has no JS API.
//   2. outerWidth / innerWidth ratio — proxy for CSS-level zoom. outer stays
//      fixed in screen pixels; inner scales with zoom. Ratio ≈ 1 at 100%,
//      < 1 zoomed out, > 1 zoomed in.
//
// Threshold of 10% (0.9 < ratio < 1.1) absorbs the typical chrome offset and
// scrollbar width; only flags clear deviation from 100%.
export function computeZoomTag(metadata) {
  if (!metadata) return null;
  const tol = 0.05;
  const vvScale = metadata.visualViewportScale;
  if (typeof vvScale === 'number' && Math.abs(vvScale - 1) > tol) {
    return `zoom × ${vvScale.toFixed(2)}`;
  }
  // Read innerWidth directly. Earlier versions fell back to windowWidth here
  // — but in the polled-geometry pipeline, windowWidth is an alias for
  // outerWidth, so the fallback gave outerWidth/outerWidth = 1 and the tag
  // never fired. Use innerWidth strictly.
  const ow = metadata.outerWidth;
  const iw = metadata.innerWidth;
  if (typeof ow === 'number' && typeof iw === 'number' && iw > 0) {
    const ratio = ow / iw;
    if (Math.abs(ratio - 1) > 0.1) {
      const zoomEstimate = 1 / ratio;
      return `zoom × ${zoomEstimate.toFixed(2)}`;
    }
  }
  return null;
}
