// demo/lifecycle.js
// Idempotent trial lifecycle helper. Every navigation (advance, Back, skip)
// routes through transitionTo(): close any open trial, then optionally open
// the next. monitor.startTrial() throws on double-open (src/core/monitor.js
// transition(), ~line 179-192: "cannot transition from 'trial' to 'trial'"),
// so this is the single place that enforces one-open-trial-at-a-time across
// the tour engine — callers never call monitor.startTrial/endTrial directly.

export function makeLifecycle(monitor) {
  var openTrialId = null;

  function transitionTo(trialId) {
    if (openTrialId !== null) {
      monitor.endTrial();
      openTrialId = null;
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
