// src/core/signals/browser.js
// Session-scoped browser environment signals:
//   - Sidebar gap detection (innerWidth delta + layout compression)
//   - AI extension DOM scanning (known selectors + MutationObserver)
//   - Keyboard shortcut detection (DevTools hotkeys)
//   - Window position tracking
//   - ResizeObserver for layout compression
//   - Zoom level change detection
//
// All signals are session-scoped: they start at startSession() and persist
// until destroy(). Trial-scoped scoring references session data to check
// which signals fired during the trial's time window.

import { AI_SELECTORS, BENIGN_TAGS } from '../../shared/constants.js';

/**
 * Attaches all session-scoped browser environment signals.
 * Called from monitor.js at startSession() time.
 */
export function attachBrowserSignals(ctx) {
  var config = ctx.config;
  var sessionData = ctx.sessionData;

  // ── Sidebar gap detection (2s polling) ──
  // Tracks state TRANSITIONS in innerWidth. A sidebar opening shrinks
  // innerWidth by 300-500px. Also checks layout compression (extension
  // padding/margin on <html> element) and zoom changes. None of these are
  // DevTools-related, so this interval is gated by `sidebarGap` alone — the
  // earlier `|| devTools` here was a mis-routed toggle (DevTools evidence comes
  // from the keyboard-shortcut listener below, not from viewport polling).
  if (config.signals.sidebarGap) {
    var _lastZoom = window.devicePixelRatio || 1;
    var _baselineIW = window.innerWidth;
    var _sidebarOpen = false;
    var _sidebarOpenedAt = null;
    var _sidebarMethod = null;
    var _sidebarDeltaIW = 0;
    // innerWidth observed while sidebar was open. Needed to compute the signed
    // close delta (currentIW at close - _openInnerWidth). Close shows as negative
    // because innerWidth grows back; pairs with the positive open delta.
    var _openInnerWidth = null;
    var _layoutCompressed = false;
    var _layoutOpenedAt = null;

    ctx.addInterval(setInterval(function () {
      var currentIW = window.innerWidth;
      var threshold = config.thresholds.sidebarGapPx;

      // Check 1: innerWidth delta (catches built-in sidebars)
      var deltaFromBaseline = _baselineIW - currentIW;

      if (!_sidebarOpen && deltaFromBaseline > threshold) {
        _sidebarOpen = true;
        _sidebarOpenedAt = performance.now();
        _sidebarMethod = "innerWidth_delta";
        _sidebarDeltaIW = deltaFromBaseline;
        _openInnerWidth = currentIW;
        sessionData.sidebarEvents.push({
          type: "opened", method: "innerWidth_delta",
          deltaIW: deltaFromBaseline,
          innerWidth: currentIW, baselineIW: _baselineIW,
          t: performance.now()
        });
        ctx.fireSignal("sidebarOpened", null, { deltaIW: deltaFromBaseline });
      } else if (_sidebarOpen && _sidebarMethod === "innerWidth_delta" && deltaFromBaseline < threshold / 2) {
        var duration = performance.now() - _sidebarOpenedAt;
        // Signed px delta at close: innerWidthDuringOpen - innerWidthAtClose.
        // Negative when the sidebar vanishes and innerWidth grows back (the
        // typical case), so the HTML renders "gap -312px" symmetrically to the
        // "gap +312px" emitted on open.
        var closeDeltaIW = _openInnerWidth != null ? (_openInnerWidth - currentIW) : null;
        sessionData.sidebarEvents.push({
          type: "closed", method: "innerWidth_delta",
          deltaIW: closeDeltaIW,
          duration_ms: Math.round(duration),
          t: performance.now()
        });
        ctx.fireSignal("sidebarClosed", null, { duration_ms: Math.round(duration), deltaIW: closeDeltaIW });
        _sidebarOpen = false;
        _sidebarOpenedAt = null;
        _openInnerWidth = null;
        _baselineIW = currentIW;
      } else if (!_sidebarOpen) {
        _baselineIW = currentIW;
      }

      // Check 2: layout compression (extension padding/margin)
      var layoutGap = currentIW - document.documentElement.clientWidth;
      var layoutThreshold = config.thresholds.layoutCompressionPx;

      if (!_layoutCompressed && layoutGap > layoutThreshold) {
        _layoutCompressed = true;
        _layoutOpenedAt = performance.now();
        sessionData.sidebarEvents.push({
          type: "opened", method: "layout_compression",
          gap: layoutGap, t: performance.now()
        });
      } else if (_layoutCompressed && layoutGap <= layoutThreshold) {
        var layoutDuration = performance.now() - _layoutOpenedAt;
        sessionData.sidebarEvents.push({
          type: "closed", method: "layout_compression",
          duration_ms: Math.round(layoutDuration),
          t: performance.now()
        });
        _layoutCompressed = false;
        _layoutOpenedAt = null;
      }

      // Check 3: zoom level changes
      var currentZoom = window.devicePixelRatio || 1;
      if (currentZoom !== _lastZoom) {
        sessionData.zoomChanges.push({
          from: _lastZoom, to: currentZoom,
          t: performance.now()
        });
        _baselineIW = currentIW;
        _lastZoom = currentZoom;
      }
    }, config.thresholds.sidebarPollMs));
  }

  // ── AI extension DOM scan ──
  // Scans for known AI extension DOM elements using CSS selectors.
  // Runs once immediately, then re-scans every 30s for lazy-loading extensions.
  if (config.signals.aiExtensions) {
    function scanExtensions() {
      AI_SELECTORS.forEach(function (sig) {
        if (document.querySelector(sig.sel)) {
          var already = sessionData.aiExtensionsFound.some(function (e) {
            return e.name === sig.name;
          });
          if (!already) {
            sessionData.aiExtensionsFound.push({
              name: sig.name, t: performance.now()
            });
          }
        }
      });
    }
    scanExtensions(); // immediate scan
    ctx.addInterval(setInterval(scanExtensions, config.thresholds.extensionScanMs));
  }

  // ── Keyboard shortcut / DevTools-hotkey detection ──
  // Catches DevTools shortcuts (Ctrl+Shift+I/J/C, F12). This listener IS the
  // "DevTools" detector, so EITHER the `keyboardShortcuts` or the `devTools`
  // signal enables it (the soft `devTools` weight then scores the captured
  // hotkeys). Records into sessionData.keyboardShortcuts.
  if (config.signals.keyboardShortcuts || config.signals.devTools) {
    ctx.addListener(document, "keydown", function (e) {
      var dominated = e.ctrlKey || e.metaKey;
      if (dominated && e.shiftKey && (e.key === "I" || e.key === "J" || e.key === "C")) {
        var combo = "Ctrl+Shift+" + e.key;
        sessionData.keyboardShortcuts.push({ combo: combo, t: performance.now() });
        ctx.fireSignal("keyboardShortcut", e, { combo: combo });
      }
      if (e.key === "F12") {
        sessionData.keyboardShortcuts.push({ combo: "F12", t: performance.now() });
        ctx.fireSignal("keyboardShortcut", e, { combo: "F12" });
      }
    });
  }

  // ── Window position tracking ──
  // Polls screenX/screenY every 2s for multi-monitor analysis.
  // Captures three coordinate systems so post-hoc plots can show the
  // browser nested inside the physical screen, plus zoom diagnostics so
  // the renderer can correctly scale mouse coords to the window outline:
  //   sw/sh:   physical screen dimensions (what monitor / how big)
  //   w/h:     browser window outer size (incl. tab bar, address bar, scrollbars)
  //   iw/ih:   viewport — the inner content area where mouse coords live
  //   x/y:     window position on screen (top-left corner)
  //   dpr:     devicePixelRatio (HIDPI / retina scaling)
  //   vvScale: visualViewport.scale (pinch zoom on touch devices,
  //            distinct from CSS-level browser zoom)
  // CSS-level browser zoom (Cmd-Plus/Minus) has no direct API, but is
  // inferable from the w/iw ratio: zoom = w / iw (≈ 1 at 100%, < 1 zoomed
  // out, > 1 zoomed in). The renderer uses this to scale mouse coords.
  if (config.signals.windowPosition && config.collectForPostHoc.windowPositionLog) {
    var captureWindowPosition = function () {
      sessionData.windowPositions.push({
        x: window.screenX, y: window.screenY,
        w: window.outerWidth, h: window.outerHeight,
        iw: window.innerWidth, ih: window.innerHeight,
        sw: window.screen.width, sh: window.screen.height,
        dpr: window.devicePixelRatio,
        vvScale: window.visualViewport ? window.visualViewport.scale : null,
        t: performance.now()
      });
    };
    ctx.addInterval(setInterval(captureWindowPosition, config.thresholds.windowPositionPollMs));

    // Resize-event capture (debounced). 2-second polling alone misses any
    // window/zoom state that exists for less than the poll interval — e.g.
    // a trial that straddles a resize gets a snapshot from before OR after,
    // not both. Mouse events made in the unsampled state then plot outside
    // the outline. Listening to 'resize' (which Chrome fires for both window
    // resize AND CSS-level browser zoom) and pushing a sample after 250ms
    // of inactivity captures the FINAL state of the change without
    // generating one sample per pixel during a drag.
    var resizeTimer = null;
    var onResize = function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        captureWindowPosition();
        resizeTimer = null;
      }, 250);
    };
    // Use ctx.addListener so the listener is tracked for cleanup on destroy().
    ctx.addListener(window, 'resize', onResize);
  }

  // ── MutationObserver for extension-injected DOM ──
  // Custom elements (tag names containing "-") are typically extension UI.
  // Filters out known benign extensions (Grammarly, password managers).
  if (config.signals.aiExtensions) {
    function isBenignTag(tagName) {
      var lower = tagName.toLowerCase();
      return BENIGN_TAGS.some(function (name) { return lower.indexOf(name) !== -1; });
    }

    var mutationObs = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var i = 0; i < added.length; i++) {
          var node = added[i];
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          var tag = node.tagName || "";
          if (tag.indexOf("-") !== -1 && !isBenignTag(tag)) {
            sessionData.extensionInjections.push({
              tag: tag.toLowerCase(),
              hasShadow: !!node.shadowRoot,
              t: performance.now()
            });
          }
        }
      }
    });
    mutationObs.observe(document.body, { childList: true, subtree: false });
    ctx.listeners.push({
      target: null, event: "mutation", handler: mutationObs,
      options: { _isMutationObserver: true }
    });
  }

  // ── ResizeObserver for viewport-width shifts ──
  // Fires when <html> element dimensions change. Catches extensions that
  // add margin-right/padding-right to <html> to make room for their panel.
  //
  // Renamed from "layoutShifts" in 0.6.1: the signal measures VIEWPORT-WIDTH
  // changes, not Web-Vitals CLS-style layout shift — the old name collided
  // with that semantics. Records go to sessionData.viewportWidthShifts
  // (canonical); sessionData.layoutShifts aliases the same array.
  //
  // Debounced (0.6.1): a drag-resize fires the observer once per frame, so a
  // single gesture used to log 5+ shift events. Now the shift is logged only
  // after viewportShiftDebounceMs of quiet, as ONE event carrying the net
  // old→new change of the whole gesture. A shift still settling when
  // destroy() runs is dropped (the debounce timer is cleared with the other
  // intervals) — acceptable, since destroy() means the session is over.
  if (config.signals.sidebarGap) {
    var baselineWidth = document.documentElement.clientWidth;
    var _pendingWidth = null;
    var _shiftTimer = null;
    var flushShift = function () {
      _shiftTimer = null;
      if (_pendingWidth === null) return;
      var settledWidth = _pendingWidth;
      _pendingWidth = null;
      var delta = baselineWidth - settledWidth;
      if (Math.abs(delta) > config.thresholds.layoutCompressionPx) {
        sessionData.viewportWidthShifts.push({
          oldWidth: Math.round(baselineWidth),
          newWidth: Math.round(settledWidth),
          delta: Math.round(delta),
          t: performance.now()
        });
        baselineWidth = settledWidth;
      }
    };
    var resizeObs = new ResizeObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        _pendingWidth = entries[i].contentRect.width;
      }
      if (_shiftTimer) clearTimeout(_shiftTimer);
      _shiftTimer = setTimeout(flushShift, config.thresholds.viewportShiftDebounceMs);
      // Tracked so destroy() clears a still-pending debounce (clearInterval
      // and clearTimeout are interchangeable per the HTML spec).
      ctx.addInterval(_shiftTimer);
    });
    resizeObs.observe(document.documentElement);
    ctx.listeners.push({
      target: null, event: "resize", handler: resizeObs,
      options: { _isResizeObserver: true }
    });
  }
}

/**
 * Attaches trial-scoped element hit testing (2Hz).
 * Checks what element is under the cursor using elementsFromPoint().
 * Only runs when elementTrace is enabled (default off, GDPR-sensitive).
 */
export function attachElementTrace(ctx) {
  var config = ctx.config;
  var trialData = ctx.trialData;

  if (config.collectForPostHoc.elementTrace) {
    trialData.elementTrace = [];
    var _etMouseX = 0, _etMouseY = 0;

    ctx.addTrialListener(document, "mousemove", function (e) {
      _etMouseX = e.clientX;
      _etMouseY = e.clientY;
    }, { passive: true });

    var elementTraceId = setInterval(function () {
      if (!ctx.getTrialData()) return;
      if (_etMouseX === 0 && _etMouseY === 0) return;
      try {
        var elements = document.elementsFromPoint(_etMouseX, _etMouseY);
        if (elements && elements.length > 0) {
          var top = elements[0];
          trialData.elementTrace.push({
            tag: top.tagName.toLowerCase(),
            id: top.id || null,
            t: Math.round(performance.now() - trialData.startTime)
          });
        }
      } catch (e) { /* elementsFromPoint not supported */ }
    }, config.thresholds.elementTraceHz);
    // Trial-scoped: cleared at endTrial. Registering session-scoped here
    // leaked one live interval per trial until destroy().
    ctx.addTrialInterval(elementTraceId);
  }
}
