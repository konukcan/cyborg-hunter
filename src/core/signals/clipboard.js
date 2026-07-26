// src/core/signals/clipboard.js
// Handles paste, copy, cut, and drop detection.
//
// Paste and drop are "hard" signals (count-based screenout).
// Copy is both hard (in strict preset) and soft (weighted).
//
// ctx.knownInputs is a shared array. dom-protection.js pushes injected decoy
// text here. clipboard.js checks against it when detecting pastes. This avoids
// circular imports — modules communicate through ctx, not through each other.

/**
 * Attaches clipboard-related trial listeners (paste, copy, cut, drop).
 * Called from monitor.js at startTrial() time.
 *
 * @param {Object} ctx - Shared context with config, trialData, addTrialListener,
 *                        fireSignal, isKnownInput, sessionData
 */
export function attachClipboardSignals(ctx) {
  var config = ctx.config;
  var trialData = ctx.trialData;

  // ── Paste detection ──
  if (config.signals.paste) {
    ctx.addTrialListener(document, "paste", function (e) {
      var text = "";
      try { text = (e.clipboardData || window.clipboardData).getData("text"); } catch (err) {}
      var pastedLength = text.length;
      if (pastedLength >= config.thresholds.pasteMinChars) {
        var known = ctx.isKnownInput(e.target);
        var entry = {
          type: "paste", t: performance.now(),
          pastedLength: pastedLength,
          isKnownInput: known
        };
        if (config.collectForPostHoc.pasteDropContent) {
          entry.text = text;
        }
        trialData.pasteEvents.push(entry);
        ctx.sessionData.pasteCount++;
        ctx.fireSignal("paste", e, { pastedLength: pastedLength, isKnownInput: known, text: text });
      }
    });
  }

  // ── Copy detection ──
  if (config.signals.copy) {
    ctx.addTrialListener(document, "copy", function (e) {
      var sel = window.getSelection();
      var selectedText = sel ? sel.toString() : "";
      var selectedLength = selectedText.length;
      trialData.copyEvents.push({
        type: "copy", t: performance.now(),
        selectedLength: selectedLength
      });
      ctx.sessionData.copyCount++;
      ctx.fireSignal("copy", e, { selectedLength: selectedLength });
    });

    // Cut is logged under the copy signal (same data concern — text leaving
    // the page). Stored in copyEvents alongside copy entries, and — like copy —
    // increments the session copyCount so the hard-copy screenout counts cuts
    // too. Without this, a cut showed up in the per-trial hard `trialHits` and
    // in the soft-copy score but never in the session total that actually
    // triggers, so strict-preset hard-copy could not fire on cuts.
    ctx.addTrialListener(document, "cut", function (e) {
      trialData.copyEvents.push({
        type: "cut", t: performance.now()
      });
      ctx.sessionData.copyCount++;
      ctx.fireSignal("cut", e, {});
    });
  }

  // ── Drop detection ──
  // Gated on its own signal flag (presets declare drop explicitly). Was
  // previously gated on paste by copy-paste error, so disabling paste
  // silently disabled drop — a separately hard-scored signal.
  if (config.signals.drop) {
    ctx.addTrialListener(document, "drop", function (e) {
      var text = "";
      try { text = e.dataTransfer.getData("text"); } catch (err) {}
      var droppedLength = text.length;
      if (droppedLength >= config.thresholds.dropMinChars) {
        var known = ctx.isKnownInput(e.target);
        var entry = {
          type: "drop", t: performance.now(),
          droppedLength: droppedLength,
          isKnownInput: known
        };
        if (config.collectForPostHoc.pasteDropContent) {
          entry.text = text;
        }
        trialData.dropEvents.push(entry);
        ctx.sessionData.dropCount++;
        ctx.fireSignal("drop", e, { droppedLength: droppedLength, isKnownInput: known, text: text });
      }
    });
  }
}
