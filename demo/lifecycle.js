// demo/lifecycle.js
// Idempotent trial lifecycle helper. Every navigation (advance, Back, skip)
// routes through transitionTo(): close any open trial, then optionally open
// the next. monitor.startTrial() throws on double-open (src/core/monitor.js
// transition(), ~line 179-192: "cannot transition from 'trial' to 'trial'"),
// so this is the single place that enforces one-open-trial-at-a-time across
// the tour engine — callers never call monitor.startTrial/endTrial directly.
//
// Optional opts.onTrialReport(report) is invoked with monitor.endTrial()'s
// return value whenever transitionTo() actually closes a trial — this is
// the only place fast-typing is observable (endTrial() computes it; there's
// no onSignal event for it), so the rail aggregates it here rather than
// polling.

export function makeLifecycle(monitor, opts) {
  var onTrialReport = opts && typeof opts.onTrialReport === 'function' ? opts.onTrialReport : null;
  var openTrialId = null;

  function transitionTo(trialId) {
    if (openTrialId !== null) {
      var report = monitor.endTrial();
      openTrialId = null;
      if (report && onTrialReport) onTrialReport(report);
    }
    if (trialId != null) {
      monitor.startTrial({ trialId: trialId });
      openTrialId = trialId;
    }
  }

  function isOpen() {
    return openTrialId !== null;
  }

  return { transitionTo: transitionTo, isOpen: isOpen };
}
