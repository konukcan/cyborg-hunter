// src/cli/renderers/html-index-core.js
// Pure string-returning core of the cohort-triage HTML report page — no
// Node APIs, so a browser demo can bundle it directly (0.7.2 extraction from
// cli/renderers/html-index.js, which is now a thin fs wrapper around this
// module: it reads the replay viewer client from disk, calls renderIndexHtml,
// and writes the result to outputDir/index.html).
//
// The replay client source and the "visuals not rendered" fallback note are
// both caller-supplied via `opts` (see renderIndexHtml below) rather than
// read from disk or hardcoded, so this module has no filesystem dependency.
//
// Layout (Task 3 — left rail filled in; Tasks 4-7 will fill the detail pane):
//   - Two-column grid: 360px sidebar rail + flexible detail pane
//   - Both columns scroll independently; full-viewport height
//   - Topbar carries title, "{N} participants · v{VERSION}" metadata, Legend button
//   - Left rail: search, filter chips, sort selector, scrolling cohort rows,
//     sticky totals footer (interactivity is wired in Tasks 9–10)
//   - Empty placeholders for: legend modal, lightbox, IIFE script
//
// References linked images in images/ (not base64-embedded). Works offline.

import { VERSION, sanitizeId } from '../../shared/constants.js';
import { decomposeScore } from '../analyzers/triage.js';
import { getByPath } from '../../shared/paths.js';

/**
 * Renders the report's index.html as a string. `opts.replayClientSrc` is the
 * replay-viewer.client.js source to embed verbatim (defaults to '' — callers
 * that don't pass it get a page with an empty replay <script> block, not a
 * crash); `opts.visualsUnavailableNote` is the fallback message shown in each
 * detail pane when visualsRendered is false (defaults to the CLI wrapper's
 * historical string, so a caller that omits it sees the same text the
 * pre-split renderHtmlIndex always rendered).
 */
export async function renderIndexHtml(summaries, triage, participants, config, visualsRendered, opts = {}) {
  const replayClientSrc = opts.replayClientSrc ?? '';
  const visualsUnavailableNote = opts.visualsUnavailableNote
    ?? 'Visual renderers not available (install the canvas package).';

  // Cohort counts for filter chips and totals footer. The triage array is
  // already sorted tier-first (hard → soft → clean, score-desc within tier) by
  // triage.js — we don't re-sort here; the default "Tier" sort matches it.
  const hard  = triage.filter(t => t.hardTriggered).length;
  const soft  = triage.filter(t => !t.hardTriggered && t.softFlagged).length;
  const clean = triage.length - hard - soft;
  const cohortCounts = { hard, soft, clean };
  const railHtml = renderCohortList(triage, cohortCounts);

  // Detail panes: one <section class="participant"> per triage entry. Only the
  // first is visible by default; Tasks 9–11 wire row clicks to toggle the
  // `hidden` attribute on the others. Each pane carries its own
  // `visualsRendered=false` fallback note inline (see renderDetail), so we no
  // longer need a top-level swap — the per-participant fallback is the contract
  // exercised by html-index.test.js (wrapper default) and
  // html-index-core.test.js (injected override).
  const detailHtml = triage.map((t, i) => {
    const participant = participants.find(p => p.participantId === t.participantId);
    return renderDetail(t, participant, config, visualsRendered, visualsUnavailableNote, /* defaultVisible */ i === 0);
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cyborg Hunter Report</title>
  <style>
    :root {
      --bg: #fafafa; --surface: #fff; --ink: #1a1814;
      --dim: #706a5c; --line: #e2ddd1;
      --hard: #d32f2f; --soft: #f57c00; --clean: #388e3c;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           color: var(--ink); background: var(--bg); display: grid; grid-template-rows: auto 1fr; height: 100vh; }
    .topbar { display: flex; align-items: center; gap: 16px; padding: 12px 20px;
              background: var(--surface); border-bottom: 1px solid var(--line); }
    .topbar h1 { font-size: 18px; font-weight: 600; }
    .topbar .meta { color: var(--dim); font-size: 13px; flex: 1; }
    .topbar button { padding: 6px 12px; border: 1px solid var(--line); background: var(--surface);
                     color: var(--ink); border-radius: 4px; cursor: pointer; font-size: 13px; }
    .topbar button:hover { background: var(--bg); }
    .layout { display: grid; grid-template-columns: 360px 1fr; height: 100%; overflow: hidden; }
    .rail { background: var(--surface); border-right: 1px solid var(--line); overflow-y: auto; }
    .detail { overflow-y: auto; padding: 20px; }
    .note { color: var(--dim); font-style: italic; font-size: 13px; }
    .mono {
      font: 13px/1.3 ui-monospace, SFMono-Regular, 'IBM Plex Mono', monospace;
      font-variant-numeric: tabular-nums;
    }
    [hidden] { display: none !important; }

    /* Rail layout — fixed top band, scrolling middle, sticky footer */
    .rail { display: flex; flex-direction: column; }
    .rail-top {
      padding: 12px; border-bottom: 1px solid var(--line);
      display: flex; flex-direction: column; gap: 8px;
    }
    .rail-list { flex: 1; overflow-y: auto; }
    .rail-footer {
      padding: 10px 12px; border-top: 1px solid var(--line);
      background: var(--surface); font-size: 12px;
    }
    .totals-title { color: var(--dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
    .totals-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
    .totals-row .count { margin-left: auto; }

    /* Search */
    .search-wrap input {
      width: 100%; padding: 6px 8px; border: 1px solid var(--line);
      border-radius: 4px; font-size: 13px; background: var(--bg);
      color: var(--ink);
    }
    .search-wrap input:focus { outline: 1px solid var(--ink); border-color: var(--ink); }

    /* Filter chips */
    .filter-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .filter-chip {
      padding: 3px 8px; border: 1px solid var(--line); background: var(--surface);
      color: var(--ink); border-radius: 12px; cursor: pointer; font-size: 12px;
    }
    .filter-chip:hover { background: var(--bg); }
    .filter-chip.active {
      background: var(--ink); color: var(--surface); border-color: var(--ink);
    }

    /* Sort selector */
    .sort-wrap { font-size: 12px; color: var(--dim); }
    .sort-wrap select {
      background: var(--surface); color: var(--ink); border: 1px solid var(--line);
      border-radius: 4px; padding: 2px 4px; font-size: 12px;
    }

    /* Cohort rows */
    .cohort-row {
      padding: 10px 12px; border-bottom: 1px solid var(--line);
      cursor: pointer;
    }
    .cohort-row:hover { background: var(--bg); }
    .cohort-row.selected {
      border-left: 4px solid var(--ink);
      padding-left: 8px;  /* compensate for the 4px left border */
      background: var(--bg);
    }
    .cohort-row-top { display: flex; align-items: center; gap: 8px; }
    .cohort-row-top .pid {
      flex: 1; min-width: 0; color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cohort-row-top .score { color: var(--dim); flex-shrink: 0; }
    .cohort-row.selected .cohort-row-top .score { color: var(--ink); font-weight: 600; }
    .cohort-row-bot {
      display: flex; align-items: flex-start; gap: 8px;
      margin-top: 4px;
    }
    .reason-excerpt {
      flex: 1; color: var(--dim); font-size: 12px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; text-overflow: ellipsis;
    }

    /* Tier dot — small filled circle, color from tier */
    .tier-dot {
      width: 8px; height: 8px; border-radius: 50%;
      flex-shrink: 0;
    }
    .tier-dot[data-tier="hard"]  { background: var(--hard); }
    .tier-dot[data-tier="soft"]  { background: var(--soft); }
    .tier-dot[data-tier="clean"] { background: var(--clean); }

    /* Tier badge — small pill, filled for hard/soft, outline for clean */
    .tier-badge {
      font-size: 10px; padding: 2px 6px; border-radius: 3px;
      font-weight: 600; letter-spacing: 0.04em; flex-shrink: 0;
    }
    .tier-badge[data-tier="hard"]  { background: var(--hard);  color: white; }
    .tier-badge[data-tier="soft"]  { background: var(--soft);  color: white; }
    .tier-badge[data-tier="clean"] {
      background: transparent; color: var(--dim);
      border: 1px solid var(--line); font-weight: 400;
    }

    /* Detail pane base */
    .detail .participant { max-width: 800px; }

    /* Empty-state hint when filter+search combine to hide every row.
       Shown by reconcileSelection() via [data-empty="true"] on .detail. */
    .detail[data-empty="true"]::before {
      content: "No participants match. Try clearing the filter or search.";
      display: block;
      padding: 40px 0;
      color: var(--dim);
      font-size: 14px;
      text-align: center;
    }

    /* Filter chip selectors — pure CSS hiding via body[data-filter] attribute.
       JS just flips the data attribute; the actual hiding lives here so
       interactivity degrades gracefully (rows still show with JS disabled). */
    body[data-filter="hard"]  .cohort-row:not([data-tier="hard"])  { display: none; }
    body[data-filter="soft"]  .cohort-row:not([data-tier="soft"])  { display: none; }
    body[data-filter="clean"] .cohort-row:not([data-tier="clean"]) { display: none; }
    .cohort-row.search-hidden { display: none; }

    /* Header strip */
    .detail-header {
      border-bottom: 1px solid var(--line);
      padding-bottom: 12px; margin-bottom: 16px;
    }
    .detail-header-top { display: flex; align-items: center; gap: 12px; }
    .detail-header-top .pid-full { flex: 1; font-size: 13px; color: var(--ink); }
    .detail-header-top .score-big { font-size: 36px; font-weight: 600; color: var(--ink); }
    .detail-header-sub { color: var(--dim); font-size: 12px; margin-top: 4px; }

    /* Tier pill — bigger version of the tier badge in the rail */
    .tier-pill {
      font-size: 11px; padding: 3px 8px; border-radius: 4px;
      font-weight: 600; letter-spacing: 0.04em;
    }
    .tier-pill[data-tier="hard"]  { background: var(--hard); color: white; }
    .tier-pill[data-tier="soft"]  { background: var(--soft); color: white; }
    .tier-pill[data-tier="clean"] {
      background: transparent; color: var(--dim);
      border: 1px solid var(--line); font-weight: 400;
    }

    /* Signal grid — colour-coded tiles, one per tracked signal in SIGNALS taxonomy.
       Every tile renders for every participant (hits and misses), so the layout
       is stable across panes. Only firing signals light up; misses fade to muted. */
    .signal-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 6px;
      margin: 12px 0 16px;
    }
    .signal-tile {
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      background: transparent;
      color: var(--dim);
      font-variant-numeric: tabular-nums;
      cursor: help;
    }
    .signal-tile.tone-critical { color: var(--hard); border-color: var(--hard); background: rgba(211, 47,  47, 0.04); }
    .signal-tile.tone-warn     { color: var(--soft); border-color: var(--soft); background: rgba(245, 124,  0, 0.04); }
    .signal-tile.tone-muted    { color: var(--ink);  border-color: var(--ink);  background: rgba(26,  24, 20, 0.03); }
    .signal-tile.tone-zero     { color: #b8b1a0; border-color: #ebe6d8; background: transparent; }
    .signal-value { font-size: 18px; font-weight: 700; line-height: 1; }
    .signal-label { font-size: 10px; letter-spacing: 0.4px; text-transform: uppercase; opacity: 0.85; }

    /* Score breakdown — horizontal flex of weighted contributions to t.score,
       ending in "Total: N". Only non-zero terms render; the bar widths are
       proportional to each term's share of the total. */
    .score-breakdown {
      display: flex; flex-wrap: wrap; gap: 10px 16px;
      align-items: center; margin-bottom: 16px;
    }
    .score-term {
      display: inline-flex; gap: 6px; align-items: center;
      font-size: 12px;
    }
    .score-term .label { color: var(--dim); }
    .score-term .contrib { color: var(--ink); }
    .score-term .bar {
      height: 6px; background: var(--ink); opacity: 0.4; border-radius: 3px;
    }
    .score-total { margin-left: auto; font-weight: 600; color: var(--ink); }

    /* Reason pull-quote — warm-tinted block-quote with a left rule. The bg
       color is picked by hand from --bg's family rather than computed, so
       it shifts cleanly when the palette changes. */
    .reason {
      border-left: 3px solid var(--ink);
      background: #f5f1e8;
      padding: 10px 14px;
      margin: 0 0 16px;
      font-size: 14px;
      color: var(--ink);
    }

    /* Session-level signals — small cards in a responsive grid. The grid
       collapses from 3 cells to 1 in narrow detail panes via auto-fit. */
    .section-heading {
      font-size: 13px; color: var(--dim);
      text-transform: uppercase; letter-spacing: 0.04em;
      margin: 18px 0 8px;
    }
    .session-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .sig-cell {
      background: var(--surface); border: 1px solid var(--line);
      border-radius: 6px; padding: 10px;
    }
    .sig-cell-title {
      font-size: 11px; color: var(--dim);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .sig-cell ul { list-style: none; margin-top: 4px; font-size: 12px; padding: 0; }
    .sig-cell li { padding: 2px 0; word-break: break-word; }
    .muted { color: var(--dim); }

    /* Paste evidence — list of expandable entries */
    .paste-list { display: flex; flex-direction: column; gap: 6px; }
    .paste-entry {
      display: flex; gap: 8px; align-items: flex-start;
    }
    .paste-toggle {
      background: none; border: none; color: var(--dim);
      cursor: pointer; font-size: 14px; line-height: 1.2;
      padding: 0 4px; flex-shrink: 0;
    }
    .paste-toggle:disabled { cursor: default; }
    .paste-toggle:hover:not(:disabled) { color: var(--ink); }
    .paste-trial { color: var(--dim); flex-shrink: 0; }
    .paste-preview, .paste-full {
      background: #f5f1e8;  /* warm tinted bg, same as the reason pull-quote */
      padding: 4px 8px; border-radius: 3px;
      font-size: 12px;
      word-break: break-word; white-space: pre-wrap;
      flex: 1; min-width: 0;  /* allow flex item to shrink and wrap correctly */
    }
    /* When expanded by Task 11's JS: hide preview, show full text */
    .paste-entry.expanded .paste-preview { display: none; }
    .paste-entry:not(.expanded) .paste-full { display: none; }
    .paste-overflow { font-size: 12px; margin-top: 4px; }

    /* Image blocks — wrapper containers so a missing PNG hides its heading too.
       Each .image-block contains a <h4 class="section-heading"> + a zoomable
       <a> wrapping an <img>; if the image fails to load, onerror hides the
       whole block (no orphan heading). */
    .image-block { margin: 18px 0; }
    .image-block:first-of-type { margin-top: 0; }  /* tighten when image is the first thing in the pane */
    /* Override .section-heading's default top margin inside .image-block, so
       the wrapper's margin: 18px 0 doesn't stack with the heading's own margin. */
    .image-block .section-heading { margin: 0 0 6px; }
    .detail img {
      max-width: 100%; display: block; margin: 6px 0 0;
      border: 1px solid var(--line); border-radius: 4px;
    }
    .zoomable {
      display: block; cursor: zoom-in;
      text-decoration: none;
    }
    .zoomable:hover img { opacity: 0.92; }

    /* Lightbox overlay — hidden by default; Task 11's JS adds .open to show it. */
    .lightbox-overlay {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.85);
      z-index: 1000; display: none;
      align-items: center; justify-content: center;
      cursor: zoom-out; padding: 20px;
    }
    .lightbox-overlay.open { display: flex; }
    .lightbox-overlay img {
      max-width: 100%; max-height: 100%; border-radius: 4px;
    }
    .lightbox-close {
      position: fixed; top: 16px; right: 24px;
      color: white; font-size: 32px; cursor: pointer;
      background: rgba(0, 0, 0, 0.4); border-radius: 50%;
      width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center; line-height: 1;
    }

    /* Legend modal — opens via Task 11's JS by removing the [hidden] attribute. */
    #legend-modal {
      position: fixed; inset: 0; z-index: 900;
    }
    .modal-backdrop {
      position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45);
    }
    .modal-card {
      position: relative;
      background: var(--surface);
      max-width: 560px; max-height: calc(100vh - 16vh);
      margin: 8vh auto 0;
      padding: 20px 24px;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      overflow-y: auto;
    }
    .modal-close {
      position: absolute; top: 8px; right: 12px;
      background: none; border: none;
      font-size: 24px; line-height: 1;
      cursor: pointer; color: var(--dim);
      padding: 4px 8px;
    }
    .modal-close:hover { color: var(--ink); }
    .modal-card h3 {
      font-size: 16px; margin-bottom: 12px;
    }
    .legend-table {
      width: 100%; border-collapse: collapse;
      font-size: 13px;
    }
    .legend-table th, .legend-table td {
      text-align: left; padding: 6px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .legend-table th {
      color: var(--dim); font-weight: 500; font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .legend-table td:first-child {
      color: var(--ink); font-weight: 500;
      white-space: nowrap;
    }
  </style>
</head>
<body data-filter="all">
  <header class="topbar">
    <h1>Cyborg Hunter Report</h1>
    <span class="meta">${triage.length} participants &middot; v${VERSION}</span>
    <button class="legend-btn" type="button" aria-haspopup="dialog" aria-controls="legend-modal">Legend &#9432;</button>
  </header>
  <div class="layout">
    <aside class="rail">${railHtml}</aside>
    <section class="detail">${detailHtml}</section>
  </div>

  <div id="legend-modal" hidden role="dialog" aria-label="Signal legend">
    <div class="modal-backdrop"></div>
    <div class="modal-card">
      <button class="modal-close" type="button" aria-label="Close">&times;</button>
      <h3>Signal reference</h3>
      <table class="legend-table">
        <thead>
          <tr><th>Signal</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td>paste</td>             <td>Clipboard paste into the response field (hard signal).</td></tr>
          <tr><td>copy</td>              <td>Clipboard copy from the page (soft signal).</td></tr>
          <tr><td>drop</td>              <td>Drag-and-drop into the response field (hard signal).</td></tr>
          <tr><td>tab-away &ge;10s</td>  <td>Left the page for &ge;10 seconds; counts toward soft score.</td></tr>
          <tr><td>tab-away (mid)</td>    <td>Longer than the participant's tab-away threshold (3s by default, 5s strict) and under 10s; counts toward soft score.</td></tr>
          <tr><td>flicker</td>           <td>At or below the tab-away threshold (3s by default); reported but not scored.</td></tr>
          <tr><td>sidebar event</td>     <td>Viewport width shrank suddenly &mdash; likely AI sidebar opened.</td></tr>
          <tr><td>AI extension</td>      <td>Browser extension known for AI assistance detected.</td></tr>
          <tr><td>kb shortcut</td>       <td>DevTools-adjacent keyboard shortcut used.</td></tr>
          <tr><td>viewport shift</td>    <td>Viewport width changed substantially (recorded as "layout shift" before 0.6.1).</td></tr>
          <tr><td>zoom change</td>       <td>Browser zoom level changed.</td></tr>
          <tr><td>synthetic insertion</td><td>Text appeared without matching keystrokes.</td></tr>
          <tr><td>foreign input</td>     <td>Keystroke outside the response field.</td></tr>
          <tr><td>edge exit</td>         <td>Mouse exited the viewport edge &mdash; pattern often seen with sidebar use.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <div id="lightbox" class="lightbox-overlay" role="dialog" aria-label="Enlarged image">
    <span class="lightbox-close" aria-label="Close">&times;</span>
    <img id="lightbox-img" alt="">
  </div>

  <script>
    // Tasks 4-7 will wire interactivity (cohort selection, lightbox, legend modal).
    (function() {
      // DOM refs — captured once on load. Cohort rows and detail panes were emitted
      // server-side, so these collections stay valid for the page's lifetime.
      const rail   = document.querySelector('.rail');
      const detail = document.querySelector('.detail');
      const rows   = [...document.querySelectorAll('.cohort-row')];
      const panes  = [...document.querySelectorAll('.participant')];

      // --- Modal & lightbox refs (Task 11) ---
      const legend     = document.getElementById('legend-modal');
      const legendBtn  = document.querySelector('.legend-btn');
      const legendClose = legend.querySelector('.modal-close');
      const legendBack  = legend.querySelector('.modal-backdrop');
      const overlay     = document.getElementById('lightbox');
      const overlayImg  = document.getElementById('lightbox-img');

      // Module-scoped current selection, indexed by participantId. Tasks 10/11 read it.
      let currentId = null;

      function isVisible(row) {
        // CSS hides via either:
        //   - data-filter rule (display: none from body[data-filter] not matching tier)
        //   - .search-hidden class (display: none from CSS)
        // Both resolve to display: none, so getComputedStyle catches the union.
        return !row.classList.contains('search-hidden')
            && getComputedStyle(row).display !== 'none';
      }

      function reconcileSelection() {
        const visible = rows.filter(isVisible);
        if (visible.length === 0) {
          // No matches — clear panes and show empty-state hint in the detail column.
          for (const p of panes) p.setAttribute('hidden', '');
          for (const r of rows) r.classList.remove('selected');
          detail.dataset.empty = 'true';
          currentId = null;
          return;
        }
        delete detail.dataset.empty;
        // Keep current selection if still visible; otherwise pick the top visible row.
        const stillVisible = visible.find(r => r.dataset.pid === currentId);
        if (!stillVisible) selectById(visible[0].dataset.pid);
      }

      function selectById(pid, opts = {}) {
        const row = rows.find(r => r.dataset.pid === pid);
        if (!row) return;
        const sanitized = row.dataset.sanitized;

        // Toggle [hidden] on detail panes — only one visible at a time.
        for (const p of panes) {
          if (p.id === \`p-\${sanitized}\`) p.removeAttribute('hidden');
          else p.setAttribute('hidden', '');
        }

        // Update .selected on rows.
        for (const r of rows) r.classList.toggle('selected', r === row);

        currentId = pid;
        detail.scrollTop = 0;

        // Persist selection in the URL hash so a reload restores the same participant.
        // Tasks that mutate visibility (filter/search) reuse selectById so the hash
        // stays consistent with the visible pane.
        if (!opts.skipHash) {
          history.replaceState(null, '', \`#p-\${sanitized}\`);
        }
      }

      // --- Overlay open/close helpers (Task 11) ---
      function openLegend()    { legend.removeAttribute('hidden'); }
      function closeLegend()   { legend.setAttribute('hidden', ''); }
      function closeLightbox() { overlay.classList.remove('open'); overlayImg.src = ''; }

      // --- Legend modal wiring ---
      legendBtn.addEventListener('click', openLegend);
      legendClose.addEventListener('click', closeLegend);
      legendBack.addEventListener('click', closeLegend);

      // --- Lightbox wiring ---
      // Delegate via existing a.zoomable elements. They're emitted server-side
      // around each image, so a fresh querySelectorAll at IIFE init time is fine.
      document.querySelectorAll('a.zoomable').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          overlayImg.src = a.getAttribute('href');
          overlay.classList.add('open');
        });
      });
      overlay.addEventListener('click', closeLightbox);

      // --- Paste-toggle wiring ---
      // Delegated handler for paste-toggle buttons. Only "long" pastes have a
      // .paste-full element; short pastes have a disabled toggle and we exit early.
      document.addEventListener('click', e => {
        const btn = e.target.closest('.paste-toggle');
        if (!btn || btn.disabled) return;
        const entry = btn.closest('.paste-entry');
        if (!entry || !entry.querySelector('.paste-full')) return;
        const expanded = entry.classList.toggle('expanded');
        btn.textContent = expanded ? '▾' : '▸';
        btn.setAttribute('aria-expanded', String(expanded));
      });

      // Delegated click handler — one listener on the rail catches all row clicks.
      rail.addEventListener('click', e => {
        const row = e.target.closest('.cohort-row');
        if (row) selectById(row.dataset.pid);
      });

      // Initial selection on page load. Priority:
      //   1. URL hash matches a participant — restore it.
      //   2. Default to first row (most-suspicious, since triage is sorted desc).
      //   3. No rows at all — do nothing (defensive).
      (function initSelection() {
        const match = location.hash.match(/^#p-(.+)$/);
        if (match) {
          const row = rows.find(r => r.dataset.sanitized === match[1]);
          if (row) {
            selectById(row.dataset.pid, { skipHash: true });
            return;
          }
        }
        if (rows[0]) selectById(rows[0].dataset.pid, { skipHash: true });
      })();

      // --- Filter chips ---
      // CSS does the actual hiding via body[data-filter] selectors. JS just sets
      // the data attribute and updates which chip is .active.
      const chips = [...document.querySelectorAll('.filter-chip')];
      chips.forEach(chip => {
        chip.addEventListener('click', () => {
          document.body.dataset.filter = chip.dataset.filter;
          chips.forEach(c => c.classList.toggle('active', c === chip));
          reconcileSelection();
        });
      });

      // --- Search ---
      const searchEl = document.querySelector('.search-wrap input');
      searchEl.addEventListener('input', () => {
        const q = searchEl.value.trim().toLowerCase();
        for (const r of rows) {
          // data-pid is mixed case; data-reason is pre-lowercased server-side (Task 3).
          const hit = !q
            || r.dataset.pid.toLowerCase().includes(q)
            || r.dataset.reason.includes(q);
          r.classList.toggle('search-hidden', !hit);
        }
        reconcileSelection();
      });

      // --- Sort ---
      const sortEl = document.querySelector('.sort-wrap select');
      sortEl.addEventListener('change', () => {
        const key = sortEl.value;  // 'score' | 'id' | 'tier'
        const tierRank = { hard: 0, soft: 1, clean: 2 };
        const parent = rows[0]?.parentNode;
        if (!parent) return;
        const sorted = [...rows].sort((a, b) => {
          if (key === 'score') return parseFloat(b.dataset.score) - parseFloat(a.dataset.score);
          if (key === 'id')    return a.dataset.pid.localeCompare(b.dataset.pid);
          // 'tier': hard first, then soft, then clean; within tier, score desc.
          const dt = tierRank[a.dataset.tier] - tierRank[b.dataset.tier];
          if (dt !== 0) return dt;
          return parseFloat(b.dataset.score) - parseFloat(a.dataset.score);
        });
        for (const r of sorted) parent.appendChild(r);
        // Sort doesn't change visibility, but the call is cheap and protects against
        // future filter+sort interactions from getting out of sync.
        reconcileSelection();
      });

      // --- Keyboard nav ---
      // Single document.keydown listener handles ESC (close overlays), '/' (focus
      // search), and arrow nav. Keeping it as one listener avoids cross-browser
      // ordering races between two registered listeners.
      document.addEventListener('keydown', e => {
        // ESC closes whichever overlay is open. Lightbox first, then legend modal.
        // Returning here prevents arrow nav from also firing when the user is just
        // dismissing an overlay.
        if (e.key === 'Escape') {
          if (overlay.classList.contains('open')) { closeLightbox(); return; }
          if (!legend.hasAttribute('hidden'))     { closeLegend();   return; }
        }

        const inInput = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

        if (e.key === '/' && !inInput) {
          e.preventDefault();
          searchEl.focus();
          return;
        }

        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !inInput) {
          const visible = rows.filter(isVisible);
          if (visible.length === 0) return;

          const currentIdx = visible.findIndex(r => r.classList.contains('selected'));

          // No current selection within the visible set (e.g. selection was filtered
          // out and reconciliation hasn't run, or URL hash didn't match anything).
          // Pick the first visible row deterministically rather than relying on
          // Math.max(0, -1 - 1) clamping.
          if (currentIdx === -1) {
            e.preventDefault();
            visible[0].scrollIntoView({ block: 'nearest' });
            selectById(visible[0].dataset.pid);
            return;
          }

          const nextIdx = e.key === 'ArrowDown'
            ? Math.min(visible.length - 1, currentIdx + 1)
            : Math.max(0, currentIdx - 1);
          if (nextIdx !== currentIdx) {
            e.preventDefault();
            const target = visible[nextIdx];
            target.scrollIntoView({ block: 'nearest' });
            selectById(target.dataset.pid);
          }
        }
      });
    })();
  </script>
  <style>
    /* Replay viewer (see replay-viewer.client.js) — matches report house style */
    .replay-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
    .replay-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px;
                    background: var(--ink); color: var(--surface); }
    .replay-badge[data-tier="trace"] { background: var(--surface); color: var(--ink);
                    border: 1px solid var(--line); }
    .replay-stage { position: relative; overflow: hidden; background: var(--surface);
                    border: 1px solid var(--line); border-radius: 4px; }
    .replay-frame { position: absolute; top: 0; left: 0; border: 0; }
    .replay-overlay { position: absolute; top: 0; left: 0; pointer-events: none; }
    .replay-neutral { background: #e8e6e0; }
    .replay-neutral-label { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
                            color: var(--dim); font-size: 13px; }
    .replay-lane { display: block; margin-top: 6px; border-radius: 2px; }
    .replay-scrub { display: block; margin: 2px 0 4px; }
    .replay-ticker { font: 12px/1.3 ui-monospace, SFMono-Regular, 'IBM Plex Mono', monospace;
                     color: var(--dim); font-variant-numeric: tabular-nums;
                     height: 1.4em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .replay-note { font-size: 12px; color: var(--dim); }
    .replay-warn { color: var(--hard); }
    /* Controls share the report's flat, line-bordered button style */
    .replay-play, .replay-load-btn, .replay-css-btn, .replay-trial-select, .replay-speed {
      padding: 4px 10px; border: 1px solid var(--line); background: var(--surface);
      color: var(--ink); border-radius: 4px; cursor: pointer; font-size: 13px; }
    .replay-play:hover, .replay-load-btn:hover, .replay-css-btn:hover { background: var(--bg); }
    .replay-play:disabled, .replay-load-btn:disabled { opacity: 0.6; cursor: default; }
    .replay-css-btn { font-size: 12px; padding: 2px 8px; }
    .replay-clock { font: 12px/1.3 ui-monospace, SFMono-Regular, 'IBM Plex Mono', monospace;
                    font-variant-numeric: tabular-nums; }
  </style>
  <script>
${replayClientSrc}
  </script>
  <script>
    // Lazy loader: replay models are heavy (dom tier ≈ MBs), so each
    // participant's model script loads only when the analyst asks for it.
    // Script-tag injection works under file:// where fetch() is blocked.
    (function () {
      document.addEventListener('click', function (e) {
        const btn = e.target.closest('.replay-load-btn');
        if (!btn) return;
        const block = btn.closest('.replay-block');
        const src = block.dataset.replaySrc;
        const pid = block.dataset.pid;
        const mount = block.querySelector('.replay-mount');
        btn.disabled = true;
        btn.textContent = 'Loading…';
        mount.setAttribute('aria-busy', 'true');
        const fail = function (msg) {
          mount.removeAttribute('aria-busy');
          const p = document.createElement('p');
          p.className = 'replay-note replay-warn';
          p.textContent = msg;
          mount.textContent = '';
          mount.appendChild(p);
        };
        const s = document.createElement('script');
        s.src = src;
        s.onload = function () {
          mount.removeAttribute('aria-busy');
          const model = (window.__chReplay || {})[pid];
          if (!model) { fail('Replay data failed to load (' + src + ').'); return; }
          mount.textContent = '';
          window.initChReplayViewer(mount, model);
        };
        s.onerror = function () {
          fail('Replay asset missing (' + src + ') — was the report generated with the replay artifacts present?');
        };
        document.body.appendChild(s);
      });
    })();
  </script>
</body>
</html>`;

  return html;
}

// Tier classification used by the rail rows, totals, and (later) the detail pane.
// Hard takes precedence over soft; anything else is clean.
function tierOf(t) {
  return t.hardTriggered ? 'hard' : t.softFlagged ? 'soft' : 'clean';
}

// Canonical signal taxonomy for the detail-pane "signal grid" section.
// Order matters — render in this order. `tone` controls colour when value > 0:
//   critical — signals that can hard-flag a participant on their own (paste,
//              drop, long tab-aways, AI extensions detected).
//   warn     — soft-score-contributing signals that compound with others.
//   muted    — diagnostic signals that are noise alone but corroborate.
// Tone classes track scoring weights; if computeTriageScore changes, audit this.
// `aiExtensionsCount` and `edgeExitCount` are derived (not on summary directly);
// renderSignalGrid handles that mapping.
const SIGNALS = [
  { key: 'totalPasteEvents',         label: 'Paste',           tone: 'critical', hint: 'Clipboard paste events into the input' },
  { key: 'totalCopyEvents',          label: 'Copy',            tone: 'warn',     hint: 'Clipboard copy events from the task' },
  { key: 'totalDropEvents',          label: 'Drop',            tone: 'critical', hint: 'Drag-and-drop into inputs' },
  { key: 'tabAwayLongCount',         label: 'Tab-away ≥10s',   tone: 'critical', hint: 'Window blurred for 10+ seconds' },
  { key: 'tabAwayMediumCount',       label: 'Tab-away (mid)',  tone: 'warn',     hint: 'Above the tab-away threshold (3s default, 5s strict), under 10s' },
  { key: 'tabAwayFlickerCount',      label: 'Flicker',         tone: 'muted',    hint: 'At or below the tab-away threshold (3s default) — not scored' },
  { key: 'trialsWithFastTyping',     label: 'Fast typing',     tone: 'warn',     hint: 'Trials typed faster than the preset cps threshold' },
  { key: 'totalSyntheticInsertions', label: 'Synthetic',       tone: 'warn',     hint: 'Text appeared without preceding keystrokes' },
  { key: 'totalForeignInputEvents',  label: 'Foreign input',   tone: 'warn',     hint: 'Typing landed outside the experiment container' },
  { key: 'sidebarEventCount',        label: 'Sidebar',         tone: 'warn',     hint: 'innerWidth shrank — side panel opened' },
  { key: 'aiExtensionsCount',        label: 'AI extensions',   tone: 'critical', hint: 'Known AI extension selectors found in DOM' },
  { key: 'keyboardShortcutCount',    label: 'Kb shortcuts',    tone: 'warn',     hint: 'DevTools hotkeys: Ctrl/Cmd+Shift+I/J/C, F12' },
  { key: 'layoutShiftCount',         label: 'Viewport shifts', tone: 'muted',    hint: 'Viewport-width change events (recorded as layoutShifts before 0.6.1)' },
  { key: 'zoomChangeCount',          label: 'Zoom changes',    tone: 'muted',    hint: 'Browser zoom level changed during task' },
  { key: 'devToolsEventCount',       label: 'DevTools',        tone: 'muted',    hint: 'Reserved (always 0) — DevTools opens are counted under Kb shortcuts' },
  { key: 'edgeExitCount',            label: 'Edge exits',      tone: 'muted',    hint: 'Mouse exited window through a screen edge' }
];

// Renders all 16 SIGNALS as a colour-coded tile grid. Every signal renders
// (hits AND misses) so the layout is stable across participants — only firing
// signals light up. Misses share the same footprint as hits, in the muted
// "tone-zero" style. Cleans show all-zero, suspicious shows a few lit cells.
function renderSignalGrid(summary, triageRow) {
  const aiExt = (summary.aiExtensionsFound || summary.extensionsDetected || []).length;
  const edgeExits = triageRow?.edgeExitCount ?? 0;

  const tiles = SIGNALS.map(sig => {
    let v;
    if (sig.key === 'aiExtensionsCount')   v = aiExt;
    else if (sig.key === 'edgeExitCount')  v = edgeExits;
    else                                   v = summary[sig.key] ?? 0;
    return { ...sig, value: Number(v) || 0 };
  });

  return `<div class="signal-grid" role="list">
    ${tiles.map(t => `
      <div class="signal-tile ${t.value > 0 ? 'tone-' + t.tone : 'tone-zero'}"
           role="listitem"
           title="${esc(t.hint)}">
        <span class="signal-value">${t.value}</span>
        <span class="signal-label">${esc(t.label)}</span>
      </div>
    `).join('')}
  </div>`;
}

// Build the entire left rail HTML: top band (search/filters/sort), scrolling
// list of cohort rows, and the sticky cohort totals footer. Rendering is
// pure HTML — no client-side handlers here; Tasks 9–10 wire up interactivity.
function renderCohortList(triage, cohortCounts) {
  const rowsHtml = triage.map(renderCohortRow).join('');

  return `<div class="rail-top">
  <div class="search-wrap">
    <input type="search" placeholder="Search (press / to focus)" aria-label="Search participants">
  </div>
  <div class="filter-chips">
    <button class="filter-chip active" data-filter="all">All ${triage.length}</button>
    <button class="filter-chip" data-filter="hard">Hard ${cohortCounts.hard}</button>
    <button class="filter-chip" data-filter="soft">Soft ${cohortCounts.soft}</button>
    <button class="filter-chip" data-filter="clean">Clean ${cohortCounts.clean}</button>
  </div>
  <div class="sort-wrap">
    <label>Sort:
      <select name="sort">
        <option value="tier" selected>Tier (hard first)</option>
        <option value="score">Score &darr;</option>
        <option value="id">ID</option>
      </select>
    </label>
  </div>
</div>

<div class="rail-list">
  ${rowsHtml}
</div>

<div class="rail-footer">
  <div class="totals-title">Cohort totals</div>
  <div class="totals-row" data-tier="hard"><span class="tier-dot" data-tier="hard"></span> Hard <span class="mono count">${cohortCounts.hard}</span></div>
  <div class="totals-row" data-tier="soft"><span class="tier-dot" data-tier="soft"></span> Soft <span class="mono count">${cohortCounts.soft}</span></div>
  <div class="totals-row" data-tier="clean"><span class="tier-dot" data-tier="clean"></span> Clean <span class="mono count">${cohortCounts.clean}</span></div>
</div>`;
}

// Single cohort row. The data-* attributes are the contract Tasks 9–10 read
// from the client-side JS to filter/sort/search — don't omit any.
//   data-pid:       full participant id (raw, esc'd for HTML)
//   data-sanitized: filename-safe id (used to look up image filenames)
//   data-tier:      'hard' | 'soft' | 'clean'
//   data-score:     numeric score (defaulted to 0 if null/undefined)
//   data-reason:    pre-lowercased reason string (search reads this so the
//                   handler doesn't need to lowercase per keystroke)
function renderCohortRow(t) {
  const tier = tierOf(t);
  const pid = String(t.participantId || '');
  const sanitized = sanitize(pid);
  const score = t.score ?? 0;
  // triage.js → generateTriageReason returns 'clean' for clean rows, but real
  // data may slip an empty string through; normalise to 'clean' for display.
  const reason = String(t.reason || 'clean');
  const reasonLower = reason.toLowerCase();
  return `<div class="cohort-row" data-pid="${esc(pid)}"
       data-sanitized="${esc(sanitized)}"
       data-tier="${tier}"
       data-score="${score}"
       data-reason="${esc(reasonLower)}">
    <div class="cohort-row-top">
      <span class="tier-dot" data-tier="${tier}"></span>
      <span class="mono pid" title="${esc(pid)}">${esc(pid)}</span>
      <span class="mono score">${score}</span>
    </div>
    <div class="cohort-row-bot">
      <span class="reason-excerpt">${esc(reason)}</span>
      <span class="tier-badge" data-tier="${tier}">${tier === 'clean' ? 'clean' : tier.toUpperCase()}</span>
    </div>
  </div>`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitize(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
}

// Renders a single participant detail pane. For Task 4 this is just the header
// strip + score breakdown — Tasks 5-7 will append reason pull-quote, session
// signals, paste evidence, and images. The `hidden` attribute is omitted on the
// first pane so the report has a default selection on load; client JS toggles
// `hidden` on the others when the user clicks a different cohort row.
function renderDetail(t, participant, config, visualsRendered, visualsUnavailableNote, defaultVisible) {
  const sanitized = sanitize(t.participantId);
  const tier = tierOf(t);
  const s = t.summary || {};

  // Image sections — three .image-block wrappers (session timeline, typing
  // profile, mouse trajectories). The renderers in session-timeline.js /
  // typing-profile.js /
  // trajectories.js skip participants under various conditions, so not every
  // participant has every image. The wrapper exists so onerror can hide both
  // the heading and the image together — without it, a missing PNG would leave
  // an orphan section heading floating above nothing.
  let imagesHtml;
  if (visualsRendered) {
    // Order: typing profile → tab timeline → mouse trajectories. Typing speed
    // first because it's the most directly comparable across participants
    // (one bar per trial, threshold line).
    imagesHtml = `
    <div class="image-block">
      <h4 class="section-heading">Typing profile</h4>
      <a href="images/typing_profile_${sanitized}.png" class="zoomable">
        <img src="images/typing_profile_${sanitized}.png" alt="Typing profile"
             onerror="this.closest('.image-block').style.display='none'">
      </a>
    </div>
    <div class="image-block">
      <h4 class="section-heading">Session timeline</h4>
      <a href="images/session_timeline_${sanitized}.png" class="zoomable">
        <img src="images/session_timeline_${sanitized}.png" alt="Session timeline"
             onerror="this.closest('.image-block').style.display='none'">
      </a>
    </div>
    <div class="image-block">
      <h4 class="section-heading">Mouse trajectories</h4>
      <a href="images/trajectories_${sanitized}.png" class="zoomable">
        <img src="images/trajectories_${sanitized}.png" alt="Mouse trajectories"
             onerror="this.closest('.image-block').style.display='none'">
      </a>
    </div>`;
  } else {
    imagesHtml = `<p class="muted note">${esc(visualsUnavailableNote)}</p>`;
  }

  return `<section class="participant" id="p-${sanitized}"${defaultVisible ? '' : ' hidden'}>
    ${renderDetailHeader(t, tier, participant, config)}
    ${renderSignalGrid(s, t)}
    ${renderScoreBreakdown(t)}
    ${renderReasonQuote(t)}
    ${renderSessionBlock(s, participant)}
    ${renderPasteEvidence(participant)}
    ${imagesHtml}
    ${renderReplaySection(participant, sanitized)}
  </section>`;
}

// Renders the per-participant "Session replay" section in one of three
// states: loadable (artifact attached), corrupted, or absent (with the
// saved_to reason from integrityReplayMeta when one exists, so the analyst
// can tell "never recorded" from "went to the participant's Downloads").
function renderReplaySection(participant, sanitized) {
  const replay = participant?.replay;
  if (replay && replay.recording) {
    const tier = replay.recording.metadata?.tier || 'trace';
    // assetPath is stamped by replay-assets.js (collision-deduped filename)
    // and must be preferred — recomputing from the sanitized pid here would
    // resurrect the lossy-name collision the assets renderer just resolved.
    // Fallback uses the SHARED sanitizer (persistence/ingest/assets),
    // not this file's image-oriented sanitize (which truncates + strips
    // dots and would miss the asset filename for long/dotted pids).
    const assetPath = replay.assetPath || `replay/${sanitizeId(participant.participantId)}.replay.js`;
    return `<div class="image-block replay-block" data-pid="${esc(participant.participantId)}"
         data-replay-src="${esc(assetPath)}">
      <h4 class="section-heading">Session replay <span class="replay-note">(${esc(tier)} tier)</span></h4>
      <div class="replay-mount">
        <button class="replay-load-btn" type="button">Load replay</button>
      </div>
    </div>`;
  }
  if (replay && replay.error) {
    return `<div class="image-block replay-block">
      <h4 class="section-heading">Session replay</h4>
      <p class="replay-note replay-warn">Replay artifact corrupted (${esc(replay.reason || replay.error)}) — file: ${esc(replay.file || 'unknown')}</p>
    </div>`;
  }
  const meta = participant?.trials?.[0]?.integrityReplayMeta;
  if (meta) {
    return `<div class="image-block replay-block">
      <h4 class="section-heading">Session replay</h4>
      <p class="replay-note">No replay artifact on disk. The session reported saved_to: <strong>${esc(String(meta.saved_to))}</strong>${meta.saved_to === 'download' ? ' — the file went to the participant’s machine and is not recoverable' : ''}.</p>
    </div>`;
  }
  return `<div class="image-block replay-block">
      <h4 class="section-heading">Session replay</h4>
      <p class="replay-note">No replay artifact (recording was not enabled for this session).</p>
    </div>`;
}

// Renders the participant's screenout reason as a left-bordered pull-quote.
// `t.reason` is set by triage.js; falls back to "clean" when absent. Always
// renders a quote (even for clean participants) so the visual rhythm is consistent.
function renderReasonQuote(t) {
  return `<blockquote class="reason">${esc(t.reason || 'clean')}</blockquote>`;
}

// Renders the session-level event-detail block: cells for AI extensions
// (names), sidebar events (signed gap + timestamp + duration), and keyboard
// shortcuts (combos). Counts are NOT shown here — the signal grid above
// already carries the at-a-glance count for every signal type. This block
// adds the precision the grid can't: which specific events fired and what
// they looked like. Pure-count signals (layout shifts, zoom changes, devtools)
// are not rendered here because they have no per-event detail to add.
//
// Returns '' when no detail-bearing signals fired, so clean panes don't show
// an empty "Session-level signals" heading.
function renderSessionBlock(s, participant) {
  const aiExt   = s.aiExtensionsFound || [];
  const sidebar = participant?.session?.sidebarEvents || [];
  const kb      = participant?.session?.keyboardShortcuts || [];

  if (!aiExt.length && !sidebar.length && !kb.length) {
    return '';
  }

  const cells = [];
  if (aiExt.length) {
    // AI extensions can be strings or {name: '...'} objects (legacy convention).
    const lines = aiExt.slice(0, 3).map(e => esc(typeof e === 'string' ? e : (e?.name || 'unknown')));
    cells.push(cellHtml('AI extensions', aiExt.length, lines));
  }
  if (sidebar.length) {
    cells.push(cellHtml('Sidebar events', sidebar.length, sidebar.slice(0, 3).map(formatSidebar)));
  }
  if (kb.length) {
    cells.push(cellHtml('Kb shortcuts', kb.length, kb.slice(0, 3).map(ev =>
      esc(String(ev?.combo || ev?.key || 'unknown')))));
  }

  return `
    <h4 class="section-heading">Session-level signals</h4>
    <div class="session-grid">${cells.join('')}</div>
  `;
}

// One signal cell: uppercase title + up to 3 preview lines + an overflow line
// when the underlying count exceeds previewLines.length. Caller is responsible
// for esc'ing entries in previewLines (we trust the caller here so callers can
// embed safe markup like the muted span in formatSidebar).
function cellHtml(title, count, previewLines) {
  const overflow = count > previewLines.length
    ? `<li class="muted">… +${count - previewLines.length} more</li>`
    : '';
  return `<div class="sig-cell">
    <div class="sig-cell-title">${title}</div>
    <ul>${previewLines.map(l => `<li>${l}</li>`).join('')}${overflow}</ul>
  </div>`;
}

// Format one sidebar event row, e.g. "+312px · 00:12" or "−308px · 00:45 (33.0s open)".
// `deltaIW` is the signed innerWidth change at the event boundary — positive on
// open (viewport shrank), negative on close. Falls back to `gap` / `gapPx` for
// older fixtures. Timestamp is rendered as MM:SS from start-of-trial.
function formatSidebar(ev) {
  const gap = ev?.deltaIW ?? ev?.gap ?? ev?.gapPx ?? '?';
  const gapStr = typeof gap === 'number' ? (gap > 0 ? `+${gap}` : String(gap)) : String(gap);
  const ts = ev?.t ?? ev?.timestamp ?? 0;
  const mm = Math.floor(ts / 60000).toString().padStart(2, '0');
  const ss = Math.floor((ts % 60000) / 1000).toString().padStart(2, '0');
  // Only "closed" events carry duration_ms; render it as the trailing parenthetical.
  const dur = (ev?.type === 'closed' && ev?.duration_ms != null)
    ? ` <span class="muted">(${(ev.duration_ms / 1000).toFixed(1)}s open)</span>`
    : '';
  return `${esc(gapStr)}px · ${mm}:${ss}${dur}`;
}

// Header strip: full participant id (mono), tier pill, big score number on the
// top row; "{n} trials · {cps} cps · {off-task}" subline below. When BOTH
// config.platformIdField is mapped AND config.showPlatformId is true, a
// second subline shows the platform (Prolific/MTurk) ID — OFF by default
// because reports circulate among collaborators more freely than raw data,
// and the platform ID is the piece that re-identifies a participant.
function renderDetailHeader(t, tier, participant, config) {
  const s = t.summary || {};
  const cps = (s.meanTypingSpeed || 0).toFixed(1);
  const offTask = formatDuration(s.totalTabAwayDuration_ms || 0);
  const tierLabel = tier === 'clean' ? 'clean' : tier.toUpperCase();
  let platformLine = '';
  if (config?.showPlatformId && config?.platformIdField) {
    const value = getByPath(participant?.metadata, config.platformIdField)
      ?? getByPath(participant, config.platformIdField)
      ?? getByPath(participant?.trials?.[0], config.platformIdField);
    if (value != null && value !== '') {
      platformLine = `
    <div class="detail-header-sub mono">platform ID: ${esc(String(value))}</div>`;
    }
  }
  return `<div class="detail-header">
    <div class="detail-header-top">
      <span class="mono pid-full">${esc(t.participantId)}</span>
      <span class="tier-pill" data-tier="${tier}">${tierLabel}</span>
      <span class="mono score-big">${t.score}</span>
    </div>
    <div class="detail-header-sub">
      ${s.trialCount ?? 0} trials · ${cps} cps · ${offTask} off-task
    </div>${platformLine}
  </div>`;
}

// Horizontal score breakdown — only non-zero contributions, ending in Total:N.
// Sourced from decomposeScore so the displayed terms always sum to t.score.
function renderScoreBreakdown(t) {
  const terms = decomposeScore(t.summary || {}, t.edgeExitCount, t.hardTriggered)
    .filter(([, n]) => n > 0);

  const total = t.score;
  const maxBar = 100;  // px
  const barFor = n => Math.max(2, Math.round((n / Math.max(total, 1)) * maxBar));

  const termHtml = terms.map(([label, n]) =>
    `<span class="score-term">
       <span class="label">${label}</span>
       <span class="mono contrib">+${n}</span>
       <span class="bar" style="width:${barFor(n)}px"></span>
     </span>`
  ).join('');

  return `<div class="score-breakdown">
    ${termHtml}
    <span class="score-total mono">Total: ${total}</span>
  </div>`;
}

// Format milliseconds as "Xs" / "Xm Ys".
function formatDuration(ms) {
  if (!ms || ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Renders a "Paste evidence (N)" section listing actual pasted texts grouped by
// trial. Pulls from participant.trials[*].pasteEvents — same source the CSV
// renderer uses. Returns '' when there are no pastes so we don't emit an empty
// heading. Long pastes are previewed with an ellipsis and a ▸ toggle that
// Task 11's client JS will wire up to swap the preview for the full text.
function renderPasteEvidence(participant) {
  // Flatten across trials, keeping [trialId] context for each paste. Match the
  // event-log.csv convention: prefer trialId, fall back to ruleId (Shape-2
  // legacy data), then to '?' as a last resort. Paste text is coerced to string
  // because some malformed sources have non-string values.
  const pastes = [];
  for (const trial of (participant?.trials || [])) {
    const id = trial?.trialId || trial?.ruleId || '?';
    for (const ev of (trial?.pasteEvents || [])) {
      pastes.push({ trialId: id, text: String(ev?.text ?? '') });
    }
  }
  if (pastes.length === 0) return '';

  const PREVIEW_LEN = 150;
  const MAX = 10;
  const shown = pastes.slice(0, MAX);

  const items = shown.map(p => {
    const isLong = p.text.length > PREVIEW_LEN;
    const preview = isLong ? p.text.slice(0, PREVIEW_LEN) + '…' : p.text;
    // Glyph: ▸ (collapsed) toggles to ▾ (expanded) via Task 11's JS.
    // For short pastes we render a static · marker — nothing to expand.
    const toggleGlyph = isLong ? '▸' : '·';
    const toggleAttr = isLong ? '' : ' disabled aria-label="No expansion needed"';
    return `<div class="paste-entry">
      <button class="paste-toggle" type="button" aria-expanded="false"${toggleAttr}>${toggleGlyph}</button>
      <span class="mono paste-trial">[${esc(p.trialId)}]</span>
      <span class="paste-preview mono">${esc(preview)}</span>
      ${isLong ? `<span class="paste-full mono" hidden>${esc(p.text)}</span>` : ''}
    </div>`;
  }).join('');

  const overflow = pastes.length > MAX
    ? `<div class="muted paste-overflow">… and ${pastes.length - MAX} more; see event-log.csv for the full list.</div>`
    : '';

  return `
    <h4 class="section-heading">Paste evidence (${pastes.length})</h4>
    <div class="paste-list">${items}${overflow}</div>
  `;
}
