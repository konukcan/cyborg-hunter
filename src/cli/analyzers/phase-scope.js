// src/cli/analyzers/phase-scope.js
// Pre-registration phase scoping.
//
// Studies that pre-register integrity scoring over a subset of phases (e.g.
// counting only classification-phase signals, excluding a warm-up or
// debrief phase) previously had to enforce that in their own analysis
// pipeline — the CH triage scored the whole session and was misleading read
// in isolation. config.phaseScope filters which trials feed the ANALYZERS
// (summary, edge-exit, triage):
//
//   "phaseScope": { "include": ["classification"] }
//   "phaseScope": { "exclude": ["warmup", "post_task_query", "debrief"] }
//
// `include` (when non-empty) keeps only listed phases; `exclude` then removes
// its phases. A trial without a `phase` field counts as "default" — data whose
// trials carry no phase labels should scope with `exclude`, not `include`.
//
// What scoping does NOT touch:
//   * Renderers still receive the full participant — the evidence (timelines,
//     trajectories, paste texts) stays visible; only the scores are scoped.
//   * Ambient session-level environment signals with no phase attribution
//     (sidebar events, keyboard shortcuts, viewport-width shifts, zoom
//     changes) remain session-wide — they aren't tied to any one phase, so
//     scoping them wouldn't be meaningful. Response-level signals
//     (paste/copy/drop/tab-away/typing) are the ones that scope.
//
// Downstream, computeParticipantSummary sees `phaseScoped: true` and switches
// to per-trial aggregation: session-level tabAwaySums and the authoritative
// session soft score cover the WHOLE session, so they cannot be used for a
// scoped verdict.

export function applyPhaseScope(participants, phaseScope) {
  const inc = Array.isArray(phaseScope?.include) && phaseScope.include.length > 0
    ? new Set(phaseScope.include) : null;
  const exc = Array.isArray(phaseScope?.exclude) && phaseScope.exclude.length > 0
    ? new Set(phaseScope.exclude) : null;
  // No scope configured → hand back the SAME array (byte-identical pipeline).
  if (!inc && !exc) return participants;

  return participants.map(p => ({
    ...p,
    trials: (p.trials || []).filter(t => {
      const phase = (t && t.phase) ?? 'default';
      if (inc && !inc.has(phase)) return false;
      if (exc && exc.has(phase)) return false;
      return true;
    }),
    phaseScoped: true,
  }));
}

// Returns the configured phaseScope phase names (from include and exclude)
// that match NO trial anywhere in the cohort. A non-empty result almost always
// means a typo (e.g. include:["clasification"]) — which, for an `include`,
// silently filters EVERY trial from EVERY participant and reports the whole
// cohort clean. report.js warns on this so the misconfiguration is visible.
// Exported for testing.
export function findUnmatchedPhaseScopePhases(participants, phaseScope) {
  const configured = [
    ...(Array.isArray(phaseScope?.include) ? phaseScope.include : []),
    ...(Array.isArray(phaseScope?.exclude) ? phaseScope.exclude : []),
  ];
  if (configured.length === 0) return [];
  const present = new Set();
  for (const p of (participants || [])) {
    for (const t of (p.trials || [])) {
      present.add((t && t.phase) ?? 'default');
    }
  }
  return configured.filter(name => !present.has(name));
}

// Human-readable one-liner for the console summary.
export function describePhaseScope(phaseScope) {
  const parts = [];
  if (Array.isArray(phaseScope?.include) && phaseScope.include.length > 0) {
    parts.push(`include=[${phaseScope.include.join(', ')}]`);
  }
  if (Array.isArray(phaseScope?.exclude) && phaseScope.exclude.length > 0) {
    parts.push(`exclude=[${phaseScope.exclude.join(', ')}]`);
  }
  return parts.join(' ');
}
