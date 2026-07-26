// src/core/scoring.js
// Two-tier scoring engine:
//   Hard signals: count-based, any one crossing its threshold = immediate screenout
//   Soft signals: weighted accumulation with a grace period
//
// This module is stateless — it receives trial and session data and returns
// updated scores. The monitor.js orchestrator manages the actual state.

/**
 * Computes trial-level scores from trial data and session counts.
 * Returns { trialSoftScore, trialSignals, updatedHardScore }.
 *
 * @param {Object} trialData - The raw trial data (pasteEvents, copyEvents, etc.)
 * @param {Object} sessionData - Session-level accumulators (pasteCount, softScore, etc.)
 * @param {Object} config - The merged config (scoring, thresholds)
 * @param {Object} report - The trial report being built (may have charsPerSec from typing)
 */
export function computeTrialScores(trialData, sessionData, config, report) {
  var scoring = config.scoring;
  var trialSignals = { hard: {}, soft: {} };
  var trialSoftScore = 0;

  // ── Hard signal: paste ──
  if (scoring.hard.paste) {
    var pasteHits = (trialData.pasteEvents || []).length;
    trialSignals.hard.paste = {
      trialHits: pasteHits, sessionTotal: sessionData.pasteCount,
      countThreshold: scoring.hard.paste.countThreshold
    };
  }

  // ── Hard signal: copy ──
  if (scoring.hard.copy) {
    var copyHits = (trialData.copyEvents || []).length;
    trialSignals.hard.copy = {
      trialHits: copyHits, sessionTotal: sessionData.copyCount,
      countThreshold: scoring.hard.copy.countThreshold
    };
  }

  // ── Hard signal: drop ──
  if (scoring.hard.drop) {
    var dropHits = (trialData.dropEvents || []).length;
    trialSignals.hard.drop = {
      trialHits: dropHits, sessionTotal: sessionData.dropCount,
      countThreshold: scoring.hard.drop.countThreshold
    };
  }

  // ── Soft signal: copy (can be both hard AND soft) ──
  if (scoring.soft.copy) {
    var softCopyHits = (trialData.copyEvents || []).length;
    var softCopyCapped = scoring.soft.copy.maxPerTrial != null
      ? Math.min(softCopyHits, scoring.soft.copy.maxPerTrial) : softCopyHits;
    var softCopyScore = softCopyCapped * scoring.soft.copy.weight;
    trialSoftScore += softCopyScore;
    trialSignals.soft.copy = { hits: softCopyHits, capped: softCopyCapped, score: softCopyScore };
  }

  // ── Soft signal: tabAway ──
  if (scoring.soft.tabAway) {
    var tabHits = (trialData.tabAwayEvents || []).filter(function (e) {
      return (e.duration_ms || 0) > config.thresholds.tabAwayDurationMs;
    }).length;
    var tabCapped = scoring.soft.tabAway.maxPerTrial != null
      ? Math.min(tabHits, scoring.soft.tabAway.maxPerTrial) : tabHits;
    var tabScore = tabCapped * scoring.soft.tabAway.weight;
    trialSoftScore += tabScore;
    trialSignals.soft.tabAway = { hits: tabHits, capped: tabCapped, score: tabScore };
  }

  // ── Soft signal: typingSpeed ──
  if (scoring.soft.typingSpeed && report.charsPerSec != null) {
    var speedThreshold = config.thresholds.typingSpeedCps;
    var speedHit = report.charsPerSec > speedThreshold ? 1 : 0;
    var speedScore = speedHit * scoring.soft.typingSpeed.weight;
    trialSoftScore += speedScore;
    trialSignals.soft.typingSpeed = {
      charsPerSec: report.charsPerSec, threshold: speedThreshold,
      hit: speedHit, score: speedScore
    };
  }

  // ── Trial window upper bound ──
  // Session-scoped events (sidebar, devTools shortcuts) count toward this
  // trial only if they fall inside [startTime, startTime + duration]. Using
  // performance.now() here would silently widen the window if scoring were
  // ever deferred past endTrial.
  var trialEnd = trialData.startTime + (report && report.duration_ms != null
    ? report.duration_ms
    : performance.now() - trialData.startTime);

  // ── Soft signal: sidebarEvent ──
  // Counts sidebar events that occurred during this trial's time window.
  if (scoring.soft.sidebarEvent) {
    var trialSidebarHits = sessionData.sidebarEvents.filter(function (e) {
      return e.t >= trialData.startTime && e.t <= trialEnd;
    }).length;
    if (trialSidebarHits > 0) {
      var sidebarScore = scoring.soft.sidebarEvent.weight;
      trialSoftScore += sidebarScore;
      trialSignals.soft.sidebarEvent = { hits: trialSidebarHits, score: sidebarScore };
    }
  }

  // ── Soft signal: devTools ──
  // Counts keyboard shortcuts detected during this trial's time window.
  if (scoring.soft.devTools) {
    var trialDevToolsHits = sessionData.keyboardShortcuts.filter(function (e) {
      return e.t >= trialData.startTime && e.t <= trialEnd;
    }).length;
    if (trialDevToolsHits > 0) {
      var devToolsScore = scoring.soft.devTools.weight;
      trialSoftScore += devToolsScore;
      trialSignals.soft.devTools = { hits: trialDevToolsHits, score: devToolsScore };
    }
  }

  // ── Soft signal: foreignInput ──
  if (scoring.soft.foreignInput && trialData.foreignInputEvents.length > 0) {
    var foreignHits = trialData.foreignInputEvents.length;
    var foreignScore = scoring.soft.foreignInput.weight;
    trialSoftScore += foreignScore;
    trialSignals.soft.foreignInput = { hits: foreignHits, score: foreignScore };
  }

  // Update hard signal session totals
  var updatedHardScore = {};
  var hardKeys = Object.keys(scoring.hard);
  for (var hk = 0; hk < hardKeys.length; hk++) {
    var key = hardKeys[hk];
    var counter = key === "paste" ? sessionData.pasteCount
      : key === "copy" ? sessionData.copyCount
      : key === "drop" ? sessionData.dropCount : 0;
    updatedHardScore[key] = {
      count: counter, threshold: scoring.hard[key].countThreshold,
      triggered: counter >= scoring.hard[key].countThreshold
    };
  }

  return { trialSoftScore, trialSignals, updatedHardScore };
}

/**
 * Checks whether the participant should be screened out.
 * Two-tier logic:
 *   1. Hard signals: ANY triggered = immediate screenout (no grace period)
 *   2. Soft signals: accumulated softScore >= threshold after grace period
 */
export function shouldScreenout(sessionData, config) {
  if (!config.screenout.enabled) return false;

  // Hard signals: any one triggered = screenout (no grace period)
  var hardTriggered = Object.keys(sessionData.hardScore).some(function (k) {
    return sessionData.hardScore[k].triggered;
  });
  if (hardTriggered) return true;

  // Soft signals: check after grace period
  if (sessionData.trialsCompleted < config.screenout.gracePeriodTrials) return false;
  return sessionData.softScore >= config.scoring.softScoreThreshold;
}
