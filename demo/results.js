// demo/results.js
// Step 11's payoff: builds the visitor's own report in-browser from THEIR
// session and renders it into a sandboxed iframe, with a truthful-tier
// walkthrough above it. Pipeline (mirrors src/cli/report.js, minus visuals —
// see src/cli/preview-entry.js, the pure subset bundled into preview-core.js
// by tools/build-preview-core.mjs):
//   buildPayload (same Shape-1 shape buildDownloadFile('sessionData') in
//   demo.js builds) -> extractIntegrityData -> computeSummary ->
//   detectEdgeExits -> rankTriage -> renderIndexHtml -> <iframe sandbox srcdoc>.
//
// .results-mode (full-width) is toggled by demo.js's goTo(), not here — this
// module only owns the mount element goTo() hands it as `container`.
//
// preview-core.js is loaded lazily (dynamic import) with a "Building your
// report…" state visible while it loads; a 5s timeout falls back to a
// CLI-instructions card built from steps.js's TRANSCRIPT copy, so the payoff
// is never a blank screen (spec: "Never a blank payoff").

import { buildPayload } from './payload.js';
import { FINISH_VARIANTS, TRANSCRIPT } from './steps.js';

var BUILD_TIMEOUT_MS = 5000;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tplVersion(str) {
  var version = (window.CyborgHunter && window.CyborgHunter.VERSION) || 'unknown';
  return str.replace('{{version}}', version);
}

// Picks the FINISH_VARIANTS branch: zeroLamp when no lamp ever lit this
// session, act2Skipped when Act 2 was skipped (fullscreen fallback or a
// "skip to finale" link/Alt+S), otherwise the full walkthrough.
function pickVariant(state) {
  if (Object.keys(state.lampCounts).length === 0) return FINISH_VARIANTS.zeroLamp;
  if (state.act2Skipped) return FINISH_VARIANTS.act2Skipped;
  return FINISH_VARIANTS.full;
}

// tierHtml is omitted (undefined) in the build-failed path, where there's no
// computed tier to report truthfully — the rest of the walkthrough (variant
// copy, driven only by state) still holds regardless of whether preview-core
// loaded.
function renderWalkthrough(variant, tierHtml) {
  return (
    '<div class="yourreport">' +
    '<h3>' + escHtml(variant.headline) + '</h3>' +
    '<p>' + escHtml(variant.body) + '</p>' +
    (tierHtml || '') +
    '<ul>' + variant.bullets.map(function (b) { return '<li>' + escHtml(b) + '</li>'; }).join('') + '</ul>' +
    '</div>'
  );
}

function renderTierLine(triageEntry, manifest) {
  var tierLabel = triageEntry.hardTriggered ? 'hard' : (triageEntry.softFlagged ? 'soft' : 'clean');
  return (
    '<p>Your tier: <b class="t-' + tierLabel + '">' + tierLabel.toUpperCase() + '</b> — ' +
    escHtml(triageEntry.reason || '') +
    ' <span class="hint">(' + escHtml(manifest.preset || 'standard') + ' preset)</span></p>'
  );
}

function renderFallbackCard() {
  return (
    '<div class="task">' +
    '<p class="label">couldn’t build your report in the browser</p>' +
    '<p>That\'s fine — the CLI builds the exact same report locally:</p>' +
    '<pre><code>' + TRANSCRIPT.lines.map(function (l) { return escHtml(tplVersion(l)); }).join('\n') + '</code></pre>' +
    '<p class="hint">' + escHtml(TRANSCRIPT.nodeNote) + '</p>' +
    '</div>'
  );
}

// Builds the Shape-1 payload the same way demo.js's buildDownloadFile
// ('sessionData') does, from the same state fields.
function buildResultsPayload(state) {
  var trials = state.trialReports.map(function (r) {
    return { trialId: r.trialId, integrity: r };
  });
  return buildPayload({
    pid: state.participantId,
    trials: trials,
    sessionReport: state.sessionReport,
    violations: state.violations
  });
}

export function buildResults(container, state, manifest) {
  if (!container) return;
  container.innerHTML = '<p class="hint" data-role="results-status">Building your report…</p>';

  var settled = false;
  var timeoutId = setTimeout(function () {
    if (settled) return;
    settled = true;
    container.innerHTML = renderWalkthrough(pickVariant(state)) + renderFallbackCard();
  }, BUILD_TIMEOUT_MS);

  import('./preview-core.js').then(function (core) {
    if (settled) return;
    var payload = buildResultsPayload(state);
    var participant = core.extractIntegrityData(payload, {});
    var summaries = core.computeSummary([participant], {});
    var edgeExits = core.detectEdgeExits([participant], {});
    var triage = core.rankTriage(summaries, edgeExits, {});

    return core.renderIndexHtml(
      summaries, triage, [participant],
      { outputDir: '.', participantIdField: 'participantId' },
      false,
      {
        replayClientSrc: '',
        visualsUnavailableNote: 'Plots are produced by the CLI replication step below.'
      }
    ).then(function (html) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      var t = triage[0] || { hardTriggered: false, softFlagged: false, reason: 'no trials this session' };
      container.innerHTML =
        renderWalkthrough(pickVariant(state), renderTierLine(t, manifest)) +
        // Bare `sandbox` (no allow-scripts/allow-same-origin): the report's
        // own row-click/legend/lightbox JS won't run inside the iframe, but
        // with exactly one participant (the visitor) its detail pane is
        // already visible by default (html-index-core.js's defaultVisible),
        // so nothing load-bearing is lost — and the report string embeds
        // arbitrary visitor-triggered text (pasted content, etc.), so the
        // most restrictive sandbox is the right default.
        '<iframe class="results-frame" sandbox srcdoc="' + escHtml(html) + '" ' +
        'title="Your cyborg-hunter report"></iframe>';
    });
  }).catch(function (err) {
    console.warn('cyborg-hunter demo: results build failed, showing CLI-instructions fallback', err);
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    container.innerHTML = renderWalkthrough(pickVariant(state)) + renderFallbackCard();
  });
}
