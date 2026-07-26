// src/cli/analyzers/triage.js
// Ranks participants by suspiciousness and generates one-line reasons.
// This is the "start here" document for manual review — the researcher
// reads the triage list top-to-bottom, inspecting the most suspicious first.
//
// Ranking has two parts (see rankTriage + decomposeScore below):
//   - tier:  hard-triggered → soft-flagged → clean (primary sort key)
//   - score: 5×paste + 5×copy + 3×sidebar-open + 1×tab-away (within a tier),
//            where a "tab-away" is one longer than the participant's tab-away
//            threshold (3s by default, 5s for the strict preset)
// Other signals (AI extensions, keyboard shortcuts, layout/zoom, edge-exits,
// synthetic insertions, foreign inputs, honeypot disclosure) are surfaced in the
// reason and detail panes but do NOT contribute to the score.

export function rankTriage(summaries, edgeExits, config) {
  const triageList = summaries.map((s, i) => {
    const ee = edgeExits[i];
    const totalEdgeExits = ee.edgeExits.reduce((sum, t) => sum + t.edgeExitCount, 0);

    const score = computeTriageScore(s, totalEdgeExits);
    const reason = generateTriageReason(s, totalEdgeExits);

    return {
      participantId: s.participantId,
      score,
      reason,
      hardTriggered: s.hardTriggered,
      // Threshold precedence: an explicit analyst-side CLI override
      // (config.scoring.softScoreThreshold) wins for deliberate re-screening;
      // otherwise use the participant's OWN saved threshold (what the library
      // screened them against — e.g. 4 for the strict preset); else default 6.
      // Using a hardcoded 6 here would mislabel strict-preset participants clean.
      softFlagged: (s.authoritativeSoftScore ?? s.totalSoftScore) >=
        (config.scoring?.softScoreThreshold ?? s.softScoreThreshold ?? 6),
      summary: s,
      edgeExitCount: totalEdgeExits
    };
  });

  // Sort tier-first (hard, then soft, then clean), and by score descending
  // within a tier. A hard-triggered participant (paste/drop over its count
  // threshold) is categorically more actionable than a high soft-signal count,
  // so they must lead the "start here" triage.md even though the four-term
  // score (paste/copy/sidebar/tab-away) no longer includes a hard-trigger term.
  // This matches the HTML index's "Tier" sort (hard:0, soft:1, clean:2; score
  // desc within tier).
  const tierRank = (t) => (t.hardTriggered ? 0 : t.softFlagged ? 1 : 2);
  triageList.sort((a, b) => {
    const dt = tierRank(a) - tierRank(b);
    if (dt !== 0) return dt;
    return b.score - a.score;
  });
  return triageList;
}

// Decomposes the composite triage score into [label, contribution] pairs.
// Used by both computeTriageScore (sums them) and the HTML renderer (displays them
// with bars). Keeping the formula here means the score breakdown in the report can
// never silently disagree with the ranked score it explains.
//
// Scoring policy (fixed 2026-06-01): only four signals contribute to the
// score —
//   5 × paste events
//   5 × copy events
//   3 × sidebar events (open cycles)
//   1 × tab-aways longer than the participant's tab-away threshold (3s default,
//       5s strict) — excludes at-or-below-cutoff flickers, which are mostly noise
//       from brief URL-bar focus / window edge clicks
// Hard-trigger, AI extensions, layout shifts, zoom changes, keyboard shortcuts,
// edge exits, synthetic insertions, and foreign inputs no longer affect the
// *score*. They are NOT hidden from review: every event list still renders in
// the per-participant detail panes, and hard-triggered participants are still
// surfaced via the hard/soft/clean tier (which is independent of this score).
// edgeExitCount and hardTriggered remain in the signature for the renderer's
// call site but are unused under this policy.
export function decomposeScore(summary, edgeExitCount, hardTriggered) {
  const sidebarCount = summary.sidebarEventCount ?? (summary.sidebarDetected ? 1 : 0);
  const tabAwayMeaningful =
    (summary.tabAwayLongCount || 0) + (summary.tabAwayMediumCount || 0);
  return [
    ['paste',    (summary.totalPasteEvents || 0) * 5],
    ['copy',     (summary.totalCopyEvents  || 0) * 5],
    ['sidebar',  sidebarCount * 3],
    ['tabaway',  tabAwayMeaningful],
  ];
}

// computeTriageScore stays an internal helper. It accumulates the decomposition
// in the original iteration order, starting from the soft base directly (NOT
// from a defensive 0) — same `let score = base; score += hardTerm; score +=
// edgeTerm; …` behaviour as the pre-refactor inline version. For malformed data
// where `base` is a non-number (e.g. an object), every subsequent `+=` becomes
// a string concat — exactly as it did before this refactor.
function computeTriageScore(summary, edgeExitCount) {
  const terms = decomposeScore(summary, edgeExitCount, summary.hardTriggered);
  let score = terms[0][1];
  for (let i = 1; i < terms.length; i++) score += terms[i][1];
  return score;
}

// Generates a human-readable one-line summary of why this participant was flagged.
// Each contributing signal is listed with its count.
export function generateTriageReason(summary, edgeExitCount = 0) {
  const parts = [];
  if (summary.totalPasteEvents > 0) parts.push(`${summary.totalPasteEvents} paste events`);
  if (summary.totalDropEvents > 0) parts.push(`${summary.totalDropEvents} drop events`);
  if (summary.totalCopyEvents > 0) parts.push(`${summary.totalCopyEvents} copy events`);
  // Three-way tab-away split when the analyzer produced it. The ≥3s bins feed the
  // soft score and lead the reason; flickers are surfaced separately so researchers
  // can see the noise floor without it inflating the apparent severity.
  if (summary.tabAwayLongCount != null || summary.tabAwayMediumCount != null ||
      summary.tabAwayFlickerCount != null) {
    const longN = summary.tabAwayLongCount || 0;
    const midN = summary.tabAwayMediumCount || 0;
    const flickN = summary.tabAwayFlickerCount || 0;
    // Bin boundaries follow THIS participant's tab-away cutoff (3s by default, 5s
    // for strict) so the reason matches the counts/score, which are now computed
    // against that same per-participant cutoff. Flicker is at-or-below the cutoff
    // (not scored); medium is above the cutoff and under 10s.
    const cutoffS = Math.round((summary.tabAwayCutoffMs ?? 3000) / 1000);
    if (longN > 0) parts.push(`${longN} tab-away${longN === 1 ? '' : 's'} ≥10s`);
    if (midN > 0) parts.push(`${midN} tab-away${midN === 1 ? '' : 's'} ${cutoffS}–10s`);
    if (flickN > 0) parts.push(`${flickN} flicker${flickN === 1 ? '' : 's'} ≤${cutoffS}s`);
  } else if (summary.totalTabAways > 0) {
    parts.push(`${summary.totalTabAways} tab-aways`);
  }
  if (summary.trialsWithFastTyping > 0) parts.push(`fast typing on ${summary.trialsWithFastTyping} trials`);
  // Prefer canonical aiExtensionsFound; fall back to legacy extensionsDetected for tests.
  const aiExtensions = summary.aiExtensionsFound || summary.extensionsDetected || [];
  if (aiExtensions.length > 0) {
    const names = aiExtensions.map(e => typeof e === 'string' ? e : (e.name || 'unknown'));
    parts.push(names.join(', ') + ' detected');
  }
  const sidebarCount = summary.sidebarEventCount ?? (summary.sidebarDetected ? 1 : 0);
  if (sidebarCount > 0) parts.push(`${sidebarCount} sidebar event${sidebarCount === 1 ? '' : 's'}`);
  if (summary.keyboardShortcutCount > 0) parts.push(`${summary.keyboardShortcutCount} keyboard shortcuts`);
  if (summary.layoutShiftCount > 0) parts.push(`${summary.layoutShiftCount} layout shifts`);
  if (summary.zoomChangeCount > 0) parts.push(`${summary.zoomChangeCount} zoom changes`);
  if (summary.devToolsEventCount > 0) parts.push(`${summary.devToolsEventCount} devtools events`);
  if (edgeExitCount > 0) parts.push(`${edgeExitCount} edge-exit patterns`);
  if (summary.totalSyntheticInsertions > 0) parts.push(`${summary.totalSyntheticInsertions} synthetic insertions`);
  if (summary.totalForeignInputEvents > 0) parts.push(`${summary.totalForeignInputEvents} foreign inputs`);
  // Guard-honeypot self-disclosure — a strong corroborating signal, surfaced in
  // the reason though it does not feed the four-term score.
  if (summary.honeypotAiUse) parts.push('self-reported AI use (honeypot)');
  if (parts.length === 0) parts.push('clean');
  return parts.join('; ');
}
