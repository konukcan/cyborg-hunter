// src/cli/analyzers/summary.js
// Aggregates per-trial integrity signals into per-participant summaries.
// Produces one summary object per participant with columns for each signal category.
// These summaries feed into triage ranking and the summary CSV renderer.

export function computeSummary(participants, config) {
  return participants.map(p => computeParticipantSummary(p, config));
}

export function computeParticipantSummary(participant, config) {
  const trials = participant.trials;
  const n = trials.length;
  // Set by applyPhaseScope (config.phaseScope). Session-level aggregates
  // (tabAwaySums, the authoritative soft score, anyHardTriggered) cover the
  // WHOLE session, so a phase-scoped summary must ignore them and aggregate
  // from the scoped trials instead. Ambient environment signals (sidebar,
  // keyboard shortcuts, viewport shifts, zoom) stay session-wide by design —
  // see phase-scope.js.
  const phaseScoped = participant.phaseScoped === true;

  // Three-way tab-away duration bins for display. The 3s boundary matches
  // config.thresholds.tabAwayDurationMs — the scoring engine's soft-score cutoff.
  // The 10s boundary is the visual "substantive absence" line.
  //   flicker (<3s): OS/browser noise, notification glances — no scoring penalty
  //   medium (3-10s): deliberate brief checks — count toward soft score
  //   long   (≥10s): substantive absences — count toward soft score
  // Prefer the thresholds the LIBRARY actually screened this participant with
  // (persisted in session.config.thresholds by finalize) so the report bins their
  // data the same way the runtime did — e.g. a strict participant's 5s tab-away
  // cutoff. Fall back to an analyst-side CLI threshold, then the default.
  const savedThresholds = participant.session?.config?.thresholds || {};
  const scoringCutoff_ms =
    savedThresholds.tabAwayDurationMs ?? config?.thresholds?.tabAwayDurationMs ?? 3000;
  const longCutoff_ms = 10000;
  const typingCutoff_cps =
    savedThresholds.typingSpeedCps ?? config.typingSpeedThreshold_cps ?? 10;

  return {
    participantId: participant.participantId,
    trialCount: n,

    // Clipboard signals — paste is the strongest indicator of copy-paste from AI
    totalPasteEvents: sum(trials, t => (t.pasteEvents || []).length),
    totalCopyEvents: sum(trials, t => (t.copyEvents || []).length),
    totalDropEvents: sum(trials, t => (t.dropEvents || []).length),

    // Tab-away — leaving the experiment page (visibility change or blur).
    // Prefer session-level durations (cyborgHunter.tabAwaySums) which capture
    // events anywhere in the session, including between trials and during
    // gallery / consent / comprehension phases. Per-trial trials[*].tabAwayEvents
    // only covers intervals while a trial is active, so it misses anything
    // that happens during a study/learning phase — which is exactly where many
    // participants go off-task.
    ...computeTabAwayCounts(phaseScoped ? null : participant.session?.tabAwaySums, trials, scoringCutoff_ms, longCutoff_ms),

    // Typing speed — suspiciously fast typing may indicate paste or autocomplete
    meanTypingSpeed: avg(trials, t => t.charsPerSec || 0),
    trialsWithFastTyping: trials.filter(t =>
      (t.charsPerSec || 0) > typingCutoff_cps).length,

    // The runtime preset that screened this participant (when persisted).
    preset: participant.session?.config?.preset ?? null,
    // The resolved per-participant tab-away cutoff (ms) used for the bins above,
    // so the triage reason can describe the bins with this participant's actual
    // threshold (e.g. 5s for strict) instead of a hardcoded 3s.
    tabAwayCutoffMs: scoringCutoff_ms,

    // Mouse — low event count or very efficient paths can indicate bot activity
    meanMouseEvents: avg(trials, t => (t.mouseEvents || []).length),
    meanPathEfficiency: avg(trials, t => t.mouseMetrics?.pathEfficiency || 0),

    // Browser environment — AI extension or sidebar detection
    extensionsDetected: participant.trials[0]?.extensionsDetected || [],
    sidebarDetected: trials.some(t => (t.sidebarGapPx || 0) > 0),

    // Idle gaps — long pauses during a trial (could indicate working elsewhere)
    totalIdleGaps: sum(trials, t => (t.idleGaps || []).length),

    // Synthetic insertion — text appeared without corresponding keystrokes
    totalSyntheticInsertions: sum(trials, t => (t.syntheticInsertions || []).length),

    // Foreign input — typing detected outside the experiment's response field
    totalForeignInputEvents: sum(trials, t => (t.foreignInputEvents || []).length),

    // Scoring — accumulated soft score and whether any hard signal fired
    totalSoftScore: sum(trials, t => t.trialSoftScore || 0),

    // Session-level fields (preferred over per-trial aggregation when available).
    // Count sidebar OPENINGS, not raw log entries. The runtime records a separate
    // "opened" + "closed" entry per incident, and the innerWidth_delta and
    // layout_compression checks can BOTH fire for one physical sidebar (same poll
    // tick → same timestamp). countSidebarOpenings() collapses opens within one
    // poll window into a single incident, so sidebarEventCount matches the number
    // of times a sidebar actually appeared. The triage score weights "3 × sidebar"
    // off this, so over-counting here would over-score.
    sidebarEventCount: participant.session?.sidebarEvents
      ? countSidebarOpenings(participant.session.sidebarEvents)
      : trials.filter(t => (t.sidebarGapPx || 0) > 0).length,
    aiExtensionsFound: participant.session?.aiExtensionsFound || participant.trials[0]?.extensionsDetected || [],
    keyboardShortcutCount: participant.session?.keyboardShortcuts?.length || 0,
    // Canonical key since 0.6.1 is session.viewportWidthShifts (the signal
    // measures viewport-width changes, not Web-Vitals CLS); layoutShifts is
    // the deprecated alias older payloads carry. The summary field and the
    // layout_shift_count CSV column keep their names for pipeline stability.
    layoutShiftCount: (participant.session?.viewportWidthShifts ?? participant.session?.layoutShifts)?.length || 0,
    zoomChangeCount: participant.session?.zoomChanges?.length || 0,
    extensionInjectionCount: participant.session?.extensionInjections?.length || 0,
    devToolsEventCount: participant.session?.devToolsEvents?.length || 0,
    // Whole-session score — unusable for a phase-scoped verdict, so scoping
    // nulls it and the scoped per-trial totalSoftScore drives soft flagging.
    authoritativeSoftScore: phaseScoped ? null : (participant.score?.softScore ?? null),
    // The soft-score threshold the LIBRARY actually screened this participant
    // against (their preset's value, saved in the session report). Carried so the
    // CLI can flag using each participant's real threshold rather than a generic
    // analyst-side default.
    softScoreThreshold: participant.score?.softScoreThreshold ?? null,

    // Guard-honeypot self-disclosure (visible bait). null/'' when the honeypot
    // was not used or the participant left it untouched.
    honeypotAiUse: participant.honeypot?.aiUse ?? null,
    honeypotAiReport: participant.honeypot?.aiReport ?? '',

    // Authoritative hard-flag: prefer the session's anyHardTriggered. Fallback
    // (no session score available) must use the CUMULATIVE sessionTotal vs the
    // signal's countThreshold — NOT per-trial trialHits. A single paste
    // (trialHits=1) when the threshold is 2 is NOT a hard trigger; using
    // trialHits>0 fabricated hard flags and inflated the hard cohort whenever
    // finalize() was missed. trialSignals.hard.*.sessionTotal is the running
    // count at that trial, so any trial crossing its threshold = hard. When that
    // data is absent, the signal can't promote the participant to hard.
    // Phase-scoped verdicts recount raw hard-signal events within the scoped
    // trials (scopedHardTriggered) — both the session's anyHardTriggered and
    // trialSignals' sessionTotal accumulate across the whole session, so
    // either would leak out-of-scope events into the verdict.
    hardTriggered: phaseScoped
      ? scopedHardTriggered(trials)
      : participant.score?.anyHardTriggered
      ?? trials.some(t => {
        const hard = t.trialSignals?.hard;
        if (!hard) return false;
        return Object.values(hard).some(s =>
          s && typeof s.sessionTotal === 'number' && typeof s.countThreshold === 'number'
            && s.sessionTotal >= s.countThreshold);
      }),

    // Pass through metadata for downstream use
    metadata: participant.metadata || {}
  };
}

// Re-derives the hard-flag verdict from raw event counts within a phase-scoped
// trial set. The countThreshold is taken from the trialSignals snapshots (any
// trial's — the runtime records the same threshold on every trial); signals
// with no recorded threshold can't promote the participant to hard.
function scopedHardTriggered(trials) {
  const EVENT_FIELDS = { paste: 'pasteEvents', copy: 'copyEvents', drop: 'dropEvents' };
  const counts = { paste: 0, copy: 0, drop: 0 };
  const thresholds = {};
  for (const t of trials) {
    for (const [sig, field] of Object.entries(EVENT_FIELDS)) {
      counts[sig] += (t[field] || []).length;
      const th = t.trialSignals?.hard?.[sig]?.countThreshold;
      if (typeof th === 'number') thresholds[sig] = th;
    }
  }
  return Object.keys(counts).some(sig =>
    typeof thresholds[sig] === 'number' && counts[sig] >= thresholds[sig]);
}

// Counts distinct sidebar OPENINGS from the session sidebarEvents log. The
// runtime can emit two "opened" entries for one physical sidebar (the
// innerWidth_delta and layout_compression checks fire in the same poll tick), so
// counting raw "opened" entries over-counts. Walk the open/close events as a
// state machine: an "opened" starts a new incident ONLY when transitioning from
// the closed state, so coincident double-detection opens (no intervening close)
// collapse to one, while a genuine open→close→open reopen counts as two — even a
// fast one. Events are ordered by timestamp when present (double-detection opens
// share a t and sort adjacent), else by array (push) order.
export function countSidebarOpenings(sidebarEvents) {
  const events = (sidebarEvents || []).filter(e => e && (e.type === 'opened' || e.type === 'closed'));
  const ordered = events.every(e => typeof e.t === 'number')
    ? [...events].sort((a, b) => a.t - b.t)
    : events;
  let open = false;
  let count = 0;
  for (const e of ordered) {
    if (e.type === 'opened') {
      if (!open) { count++; open = true; }
    } else {
      open = false;
    }
  }
  return count;
}

// Helper: sum an array by applying fn to each element
function sum(arr, fn) { return arr.reduce((s, x) => s + fn(x), 0); }

// Helper: average an array by applying fn to each element
function avg(arr, fn) { return arr.length === 0 ? 0 : sum(arr, fn) / arr.length; }

// Helper: derive all tab-away count fields from a session-level durations
// array (preferred — covers the whole session including gaps between trials
// and during gallery / consent / comprehension phases) or fall back to
// per-trial trials[*].tabAwayEvents (legacy — only covers active trials).
function computeTabAwayCounts(sessionDurs, trials, scoringCutoff_ms, longCutoff_ms) {
  let durations;
  if (Array.isArray(sessionDurs)) {
    durations = sessionDurs.map(d => Number(d) || 0);
  } else {
    durations = [];
    for (const t of trials) {
      for (const e of (t.tabAwayEvents || [])) {
        durations.push(Number(e.duration_ms) || 0);
      }
    }
  }
  // "Meaningful" tab-aways (medium + long) are those that count toward the soft
  // score. The runtime soft-scoring rule is STRICT ( duration > cutoff — see
  // scoring.js and constants.js "longer than this counts" ), so the bins use the
  // same `>` boundary: a tab-away exactly at the cutoff is a flicker, not scored.
  // This keeps the report's tab-away count identical to what the library screened.
  return {
    totalTabAways: durations.length,
    tabAwayFlickerCount: durations.filter(d => d <= scoringCutoff_ms).length,
    tabAwayMediumCount: durations.filter(d => d > scoringCutoff_ms && d < longCutoff_ms).length,
    tabAwayLongCount: durations.filter(d => d >= longCutoff_ms).length,
    totalTabAwayDuration_ms: durations.reduce((s, d) => s + d, 0),
    // `trialsWithTabAway` is per-trial-defined; keep it tied to trials[*]
    trialsWithTabAway: trials.filter(t => (t.tabAwayEvents || []).length > 0).length,
  };
}
