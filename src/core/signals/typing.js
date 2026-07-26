// src/core/signals/typing.js
// Typing speed measurement and synthetic insertion detection.
//
// Synthetic insertion: text inserted without a preceding keydown event.
// This catches execCommand('insertText'), clipboard-manager pastes,
// and browser extension injections that bypass the paste event.
//
// Typing speed: computed at endTrial() from edit timestamps. The threshold
// (default 10 cps) flags unusually fast typing that suggests AI assistance.

/**
 * Attaches trial-scoped typing and synthetic insertion listeners.
 * Called from monitor.js at startTrial() time.
 *
 * Note: The clipboardManager signal handles both synthetic insertion
 * detection AND edit timestamp collection. When clipboardManager is off
 * but typingSpeed is on, a simpler input listener collects timestamps.
 */
export function attachTypingSignals(ctx) {
  var config = ctx.config;
  var trialData = ctx.trialData;

  // ── Synthetic insertion detection + edit timestamps ──
  if (config.signals.clipboardManager) {
    var _lastKeydownTime = 0;
    ctx.addTrialListener(document, "keydown", function () {
      _lastKeydownTime = performance.now();
    });
    ctx.addTrialListener(document, "input", function (e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) {
        // Record edit timestamp for typing speed computation
        trialData.editTimestamps.push(performance.now());

        // Check if this input arrived without a recent keydown
        if (performance.now() - _lastKeydownTime > config.thresholds.syntheticGapMs && e.inputType === "insertText") {
          var dataLen = (e.data || "").length;
          trialData.syntheticInsertions.push({
            type: "synthetic_insertion", t: performance.now(),
            dataLength: dataLen
          });
          ctx.fireSignal("syntheticInsertion", e, { dataLength: dataLen });
        }
      }
    }, true); // capture phase to catch before frameworks
  }

  // ── Fallback: keystroke timestamps for typing speed only ──
  // If clipboardManager isn't enabled, still collect edit timestamps
  // for typing speed computation via a simpler listener.
  if (config.signals.typingSpeed && !config.signals.clipboardManager) {
    ctx.addTrialListener(document, "input", function (e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) {
        trialData.editTimestamps.push(performance.now());
      }
    }, true);
  }
}

/**
 * Attaches trial-scoped foreign input detection.
 * When experimentContainer is set, tracks input events that land on
 * elements OUTSIDE the experiment's DOM. This catches participants
 * typing into AI extension sidebars, chatbot widgets, etc.
 */
export function attachForeignInputSignals(ctx) {
  var config = ctx.config;
  var trialData = ctx.trialData;

  ctx.addTrialListener(document, "input", function (e) {
    var target = e.target;
    if (!target) return;
    var isTextInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    if (!isTextInput) return;
    var known = ctx.isKnownInput(target);
    if (known === false) {
      var entry = {
        t: performance.now(),
        targetTag: target.tagName || "unknown",
        targetId: (target.id || "").slice(0, 50),
        targetClass: (target.className || "").toString().slice(0, 100),
        inputType: e.inputType || ""
      };
      if (config.collectForPostHoc.foreignInputContent) {
        entry.data = e.data || "";
      }
      trialData.foreignInputEvents.push(entry);
      ctx.fireSignal("typingOutsideExperiment", e, {
        targetTag: entry.targetTag,
        targetId: entry.targetId,
        targetClass: entry.targetClass,
        data: e.data || ""
      });
    }
  }, true);
}

/**
 * Computes typing speed (chars per second) from edit timestamps.
 * Called from monitor.js at endTrial() time.
 * Returns the computed charsPerSec or null if insufficient data.
 */
export function computeTypingSpeed(editTimestamps) {
  if (editTimestamps.length < 2) return null;
  var firstEdit = editTimestamps[0];
  var lastEdit = editTimestamps[editTimestamps.length - 1];
  var spanSec = (lastEdit - firstEdit) / 1000;
  if (spanSec <= 0) return null;
  var charCount = editTimestamps.length;
  return Math.round((charCount / spanSec) * 10) / 10;
}
