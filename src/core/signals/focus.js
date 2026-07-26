// src/core/signals/focus.js
// Tab-away detection and idle gap monitoring.
//
// Tab-away uses two complementary mechanisms:
//   1. visibilitychange — fires when tab is fully hidden (tab switch, app switch)
//   2. window blur/focus — fires when window loses focus without tab hiding
//      (catches sidebar clicks, DevTools, browser menus)
//
// Both are logged with their type so downstream analysis can distinguish
// "left the tab entirely" from "clicked sidebar."

/**
 * Attaches session-scoped tab-away detection.
 * Called from monitor.js at startSession() time.
 */
export function attachFocusSignals(ctx) {
  var config = ctx.config;

  if (config.signals.tabAway) {
    var _tabAwayStart = null;
    var _tabAwayType = null;

    function _onLeave(type) {
      if (_tabAwayStart !== null) return; // already tracking
      _tabAwayStart = performance.now();
      _tabAwayType = type;
      ctx.fireSignal("tabAway", null, { type: type });
    }

    function _onReturn() {
      if (_tabAwayStart === null) return;
      var duration = performance.now() - _tabAwayStart;
      var event = {
        start: _tabAwayStart,
        duration_ms: Math.round(duration),
        type: _tabAwayType,
        // Wall-clock at the LEAVE moment (ISO 8601), reconstructed at return
        // time. Lets timelines place session-level events absolutely without
        // a perfNow→wall-clock offset estimator.
        timestamp: new Date(Date.now() - duration).toISOString()
      };
      // Push to current trial if one is active
      if (ctx.getTrialData()) ctx.getTrialData().tabAwayEvents.push(event);
      // Session-level record (0.6.1). tabAwaySums keeps only durations, so
      // events OUTSIDE startTrial/endTrial (consent, tutorial, comprehension,
      // gallery study) used to lose their timing entirely — timelines could
      // count them but not place them. tabAwayEvents preserves the full
      // {start, duration_ms, type, timestamp} for every tab-away in the
      // session, on-trial or off. tabAwaySums is kept alongside for backward
      // compatibility.
      ctx.sessionData.tabAwayEvents.push(event);
      ctx.sessionData.tabAwaySums.push(Math.round(duration));
      ctx.fireSignal("tabReturn", null, {
        duration_ms: Math.round(duration),
        type: _tabAwayType
      });
      _tabAwayStart = null;
      _tabAwayType = null;
    }

    // Mechanism 1: full tab hide (tab switch, app switch)
    ctx.addListener(document, "visibilitychange", function () {
      if (document.hidden) {
        _onLeave("tabHidden");
      } else {
        _onReturn();
      }
    });

    // Mechanism 2: window blur (sidebar click, devtools, browser chrome)
    ctx.addListener(window, "blur", function () {
      _onLeave("windowBlur");
    });
    ctx.addListener(window, "focus", function () {
      if (!document.hidden) _onReturn();
    });
  }
}

/**
 * Attaches trial-scoped idle gap detection.
 * Flags periods of >10s with no input activity within a trial.
 * Called from monitor.js at startTrial() time.
 */
export function attachIdleGapSignals(ctx) {
  var config = ctx.config;
  var trialData = ctx.trialData;

  if (config.signals.idleGaps) {
    var idleThreshold = config.thresholds.idleGapMs;
    var lastActivityTime = performance.now();

    // Any input event resets the activity timer
    ctx.addTrialListener(document, "keydown", function () {
      lastActivityTime = performance.now();
    });
    ctx.addTrialListener(document, "mousemove", function () {
      lastActivityTime = performance.now();
    }, { passive: true });

    var idleCheckId = setInterval(function () {
      if (!ctx.getTrialData()) return; // trial ended
      var gap = performance.now() - lastActivityTime;
      if (gap > idleThreshold) {
        trialData.idleGaps.push({
          duration_ms: Math.round(gap), t: performance.now()
        });
        lastActivityTime = performance.now();
      }
    }, config.thresholds.idleCheckIntervalMs);
    // Trial-scoped: cleared at endTrial. Registering session-scoped here
    // leaked one live interval per trial until destroy().
    ctx.addTrialInterval(idleCheckId);
  }
}
