// src/replay/capture-trace.js
// Tier-1 ("trace") capture: pointer, keys, clipboard, input values, scroll,
// touch, focus/visibility, viewport. Attaches everything through the
// recorder's listener registry so destroy() tears it all down.
//
// Coordinate contract (cursor-alignment fix): every pointer event
// carries BOTH page coords (x/y — document space, survives any later scroll
// math) and client coords (cx/cy — viewport space, what the viewer actually
// draws). Discrete interactions additionally carry a target anchor and are
// preceded by a synchronous flush of pending camera state (scroll/resize),
// so the event order on the wire can never invert the state the interaction
// happened under.
//
// Testability: the environment (doc/win/now/raf) is injectable. In the
// browser, callers omit `env` and the real globals are used.
//
// Failure containment: every handler body runs inside guard() — a throwing
// capture channel logs one captureFailure and the experiment continues.

// Wrap a handler so an exception can never propagate into the host page.
function guard(rec, channel, fn) {
  return function (e) {
    try {
      fn(e);
    } catch (err) {
      rec.captureFailure(channel, err);
    }
  };
}

// Compact element descriptor for event payloads: "input#answer", "textarea".
function describeEl(el) {
  if (!el || !el.tagName) return null;
  var d = el.tagName.toLowerCase();
  if (el.id) d += '#' + el.id;
  return d;
}

function isPassword(el) {
  return !!(el && el.tagName === 'INPUT' && el.type === 'password');
}

function matchesRedact(el, selector) {
  if (isPassword(el)) return true;              // unconditional, not overridable
  if (!selector || !el || typeof el.matches !== 'function') return false;
  try { return el.matches(selector); } catch (e) { return false; }
}

// Subtree semantics, matching capture-dom's isInRedactedSubtree: a click on
// a descendant of a redacted container must not leak the descendant's
// identity or geometry through an anchor.
function inRedactedSubtree(el, selector) {
  var cur = el;
  while (cur) {
    if (matchesRedact(cur, selector)) return true;
    cur = cur.parentNode;
  }
  return false;
}

// Round to 0.1px — anchor rects feed pixel-tolerance checks; full float
// precision would just bloat the JSON.
function r10(v) { return Math.round(v * 10) / 10; }

export function attachTraceCapture(rec, env) {
  env = env || {};
  var doc = env.doc || document;
  var win = env.win || window;
  var now = env.now || function () { return performance.now(); };
  var raf = env.raf || (typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame.bind(null)
    : function (fn) { setTimeout(fn, 16); });
  var config = rec.config;

  function clientDims() {
    var de = doc.documentElement;
    return {
      cw: de && de.clientWidth ? de.clientWidth : (win.innerWidth || null),
      ch: de && de.clientHeight ? de.clientHeight : (win.innerHeight || null)
    };
  }

  // Client coords appended to a payload when the event carries them (real
  // browsers always do; duck-typed test events may not).
  function withClient(payload, e) {
    if (e.clientX != null) payload.cx = Math.round(e.clientX);
    if (e.clientY != null) payload.cy = Math.round(e.clientY);
    return payload;
  }

  // ── Interaction anchor ──
  // Identity + geometry of what a discrete interaction hit, captured at
  // CAPTURE PHASE (before page handlers can remove the target or stop the
  // recording — the smoke fixture's Finish click was lost to exactly that).
  // Client-space rect: raw getBoundingClientRect, no scroll math — the
  // viewer compares it against the reconstruction's own client-space rect.
  // Redacted targets expose only {redacted, tag}: no id, rect, or marker,
  // so redaction never gains new leakage through anchors.
  function anchorFor(e) {
    var el = e && e.target;
    if (!el || !el.tagName) return null;
    var tag = el.tagName.toLowerCase();
    // inRedactedSubtree → matchesRedact, whose FIRST check is isPassword():
    // password inputs are unconditionally anchor-redacted, selector or not,
    // and so is anything inside a redactSelector-matched container.
    if (inRedactedSubtree(el, config.redactSelector)) {
      return { redacted: true, tag: tag };
    }
    var a = { tag: tag };
    // Shadow retargeting, detected at EVENT time: for OPEN shadow roots the
    // composed path's first entry is the real (shadow-internal) target while
    // e.target is the retargeted host — regardless of when attachShadow()
    // ran (a post-snapshot attach leaves no mutation record). The viewer
    // refuses to "verify" such interactions against the hollow host.
    // CLOSED roots are undetectable from outside by design — documented
    // limitation, same class as CSSOM-only content changes.
    try {
      if (typeof e.composedPath === 'function') {
        var path0 = e.composedPath()[0];
        if (path0 && path0 !== el) a.shadow = true;
      }
    } catch (err) { /* composedPath unavailable — snapshot marking still applies */ }
    if (el.id) a.id = el.id;
    var markers = typeof rec.getMarkers === 'function' ? rec.getMarkers() : null;
    if (markers) a.n = markers.refFor(el);
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        var r = el.getBoundingClientRect();
        a.rect = [r10(r.left), r10(r.top), r10(r.width), r10(r.height)];
      }
    } catch (e) { /* rect stays absent — viewer treats as unverifiable */ }
    return a;
  }

  // ── Camera state: window/element scroll + viewport, RAF-coalesced ──
  // Two invariants the viewer's projection depends on:
  //  1. ORIGINAL timestamps: a coalesced event is stamped with the time of
  //     the last underlying DOM event, not the RAF flush — otherwise a click
  //     recorded between the scroll and its flush sorts BEFORE the scroll and
  //     plays back under the stale camera (full-scroll-jump error).
  //  2. Synchronous flush before discrete events: pending camera state is
  //     pushed BEFORE the interaction that follows it, in the same task.
  var pendingWindowScroll = null;        // { t } — values read at flush
  var pendingElementScrolls = new Map(); // target → { t } — per target, not last-wins
  var pendingResize = null;              // { t }
  var pendingVv = null;                  // { t }
  var scrollFlushQueued = false;
  var resizeFlushQueued = false;
  var vvFlushQueued = false;

  function flushScrolls() {
    scrollFlushQueued = false;
    if (pendingWindowScroll) {
      rec.pushEvent('scroll', withClientlessScroll({
        x: Math.round(win.scrollX || 0), y: Math.round(win.scrollY || 0)
      }), pendingWindowScroll.t);
      pendingWindowScroll = null;
    }
    if (pendingElementScrolls.size > 0) {
      pendingElementScrolls.forEach(function (state, target) {
        var payload;
        if (inRedactedSubtree(target, config.redactSelector)) {
          // Same contract as interaction anchors: a scroller inside a
          // redacted subtree exposes no id, descriptor, or marker. Offsets
          // alone stay (they carry no content), unresolvable by design.
          payload = {
            redacted: true,
            tag: target.tagName ? target.tagName.toLowerCase() : null,
            x: Math.round(target.scrollLeft || 0),
            y: Math.round(target.scrollTop || 0)
          };
        } else {
          payload = {
            el: describeEl(target),
            id: target.id || null,
            x: Math.round(target.scrollLeft || 0),
            y: Math.round(target.scrollTop || 0)
          };
          var markers = typeof rec.getMarkers === 'function' ? rec.getMarkers() : null;
          if (markers) payload.n = markers.refFor(target);
        }
        rec.pushEvent('scroll', payload, state.t);
      });
      pendingElementScrolls.clear();
    }
  }
  // Window-scroll payloads carry no element fields; tiny helper keeps the
  // shape explicit rather than relying on undefined-stripping.
  function withClientlessScroll(p) { return p; }

  function flushResize() {
    resizeFlushQueued = false;
    if (!pendingResize) return;
    var dims = clientDims();
    rec.pushEvent('resize', {
      w: win.innerWidth, h: win.innerHeight,
      cw: dims.cw, ch: dims.ch,
      dpr: win.devicePixelRatio || 1
    }, pendingResize.t);
    pendingResize = null;
  }

  function flushVv() {
    vvFlushQueued = false;
    if (!pendingVv) return;
    var vv = win.visualViewport;
    if (vv) {
      rec.pushEvent('vv', {
        w: r10(vv.width), h: r10(vv.height), scale: vv.scale,
        px: r10(vv.pageLeft || 0), py: r10(vv.pageTop || 0)
      }, pendingVv.t);
    }
    pendingVv = null;
  }

  // Synchronous camera flush — called at the top of every discrete-event
  // handler so pending state is IN THE BUFFER before the interaction lands.
  // Emission order within this function (and Map iteration order) is
  // deliberately irrelevant: every event carries its ORIGINAL timestamp and
  // the wire order is established by the serializer's stable sort on t
  // (serializer.js serialize(); replay-assets.js buildViewerModel() sorts
  // again defensively). The buffer has never been chronologically ordered —
  // RAF-coalesced input events pre-date this and flush late the same way.
  function flushCameraNow() {
    flushScrolls();
    flushResize();
    flushVv();
  }

  // Camera SNAPSHOT stamped onto every discrete interaction. Flushing alone
  // is not enough: browsers dispatch scroll/resize NOTIFICATIONS
  // asynchronously after programmatic scrolls (scrollIntoView, scrollTo,
  // anchor jumps), so a click can be recorded before the scroll event that
  // describes the state it happened under — with nothing pending to flush.
  // The snapshot reads the live state synchronously in the interaction's own
  // handler; the viewer treats it as an authoritative camera observation.
  function withCameraSnapshot(payload) {
    var dims = clientDims();
    payload.sx = Math.round(win.scrollX || 0);
    payload.sy = Math.round(win.scrollY || 0);
    payload.vw = win.innerWidth || null;
    payload.vh = win.innerHeight || null;
    payload.cw = dims.cw;
    payload.ch = dims.ch;
    return payload;
  }

  // ── Mouse ──
  // mousemove throttled to mouseHz; down/up/click are low-frequency and
  // carry adjudication weight, so they always record — with anchors.
  // All pointer listeners are CAPTURE-PHASE: page handlers may remove the
  // target, stopPropagation, or stop the recording before bubble reaches
  // the document.
  var minMoveGap = 1000 / (config.mouseHz || 30);
  var lastMove = -Infinity;
  rec.addListener(doc, 'mousemove', guard(rec, 'mouse', function (e) {
    var t = now();
    if (t - lastMove < minMoveGap) return;
    lastMove = t;
    rec.pushEvent('mousemove', withClient({
      x: Math.round(e.pageX), y: Math.round(e.pageY)
    }, e), t);
  }), { passive: true, capture: true });
  ['mousedown', 'mouseup', 'click'].forEach(function (kind) {
    rec.addListener(doc, kind, guard(rec, 'mouse', function (e) {
      flushCameraNow();
      var payload = withCameraSnapshot(withClient({
        x: Math.round(e.pageX), y: Math.round(e.pageY)
      }, e));
      var anchor = anchorFor(e);
      if (anchor) payload.target = anchor;
      rec.pushEvent(kind, payload, now());
    }), { passive: true, capture: true });
  });

  // ── Keys ──
  // keys:'off' attaches nothing. Password fields AND any field matching
  // redactSelector never record key identity (redacted flag only) — otherwise
  // a redacted field's text is reconstructable keystroke-by-keystroke, which
  // would defeat the same redactSelector the input-value capture already honors.
  if (config.keys !== 'off') {
    ['keydown', 'keyup'].forEach(function (kind) {
      rec.addListener(doc, kind, guard(rec, 'keys', function (e) {
        // SUBTREE semantics (same as anchors/DOM capture): typing into a
        // field INSIDE a redacted container must not leak key identity —
        // the direct-target check alone let descendants through.
        if (inRedactedSubtree(e.target, config.redactSelector)) {
          rec.pushEvent(kind, { redacted: true }, now());
          return;
        }
        rec.pushEvent(kind, { key: e.key, code: e.code }, now());
      }), true); // capture phase — before frameworks can stopPropagation
    });
  }

  // ── Clipboard ──
  // Lengths only. Content stays out of the replay stream by design; CH's own
  // pasteDropContent flag governs content capture in the integrity report.
  rec.addListener(doc, 'paste', guard(rec, 'clipboard', function (e) {
    flushCameraNow();
    var len = null;
    try { len = e.clipboardData.getData('text').length; } catch (err) { /* len stays null */ }
    rec.pushEvent('paste', { len: len }, now());
  }), true);
  rec.addListener(doc, 'copy', guard(rec, 'clipboard', function () {
    flushCameraNow();
    rec.pushEvent('copy', {}, now());
  }), true);
  rec.addListener(doc, 'cut', guard(rec, 'clipboard', function () {
    flushCameraNow();
    rec.pushEvent('cut', {}, now());
  }), true);
  rec.addListener(doc, 'drop', guard(rec, 'clipboard', function (e) {
    flushCameraNow();
    var len = null;
    try { len = e.dataTransfer.getData('text').length; } catch (err) { /* len stays null */ }
    rec.pushEvent('ch:drop', { len: len }, now());
  }), true);

  // ── Input values (RAF-coalesced per target) ──
  // Rapid typing produces one event per frame per field, holding the LAST
  // value — enough to reconstruct field state on scrub without recording
  // every intermediate keystroke twice (keydown already carries timing).
  var pendingInputs = new Map();   // target → latest event time
  var inputFlushQueued = false;
  function flushInputs() {
    inputFlushQueued = false;
    pendingInputs.forEach(function (t, target) {
      // el is a display descriptor; id is the RAW id for the viewer to
      // resolve via getElementById (ids like "a:b c" are not selector-safe).
      var payload = { el: describeEl(target), id: target.id || null };
      var value = target.value != null ? String(target.value)
        : (target.isContentEditable && target.textContent != null
          ? String(target.textContent) : '');
      // SUBTREE semantics: a field inside a redacted container leaks no
      // value. The id/el descriptor stays (the DOM snapshot already carries
      // redacted elements' ids; the viewer needs a target for the bullets).
      if (inRedactedSubtree(target, config.redactSelector)) {
        payload.redacted = true;
        payload.value_len = value.length;
      } else {
        payload.value = value;
        // Marker ref for duplicate-id-safe restore (non-redacted only:
        // redacted events gain no NEW identity fields).
        var inputMarkers = typeof rec.getMarkers === 'function' ? rec.getMarkers() : null;
        if (inputMarkers) payload.n = inputMarkers.refFor(target);
      }
      // checked is an element PROPERTY (never an attribute mutation), so
      // the DOM replay can only restore checkbox/radio state from here —
      // but a redacted field's checked state is still its VALUE: withhold it.
      if (!payload.redacted && (target.type === 'checkbox' || target.type === 'radio')) {
        payload.checked = !!target.checked;
      }
      rec.pushEvent('input', payload, t);
    });
    pendingInputs.clear();
  }
  rec.addListener(doc, 'input', guard(rec, 'input', function (e) {
    if (!e.target) return;
    pendingInputs.set(e.target, now());
    if (!inputFlushQueued) {
      inputFlushQueued = true;
      raf(guard(rec, 'input', flushInputs));
    }
  }), true);

  // ── Scrolled-element tracker (spec §3 initial_state.element_scroll) ──
  // Which inner scrollers a keyframe has to seed is not answerable from the
  // DOM: `overflow` says an element COULD scroll, not that it has, and the
  // participant's offsets are the state a fresh snapshot cannot carry. The one
  // place that knows is the scroll listener below, so it keeps the set.
  //
  // Lifetime is the RECORDING, not the trial: an element scrolled during trial
  // 2 still needs seeding at the keyframe of trial 7, so the Set lives in this
  // attachment (created once, at startSession) rather than on a trial.
  //
  // A strong Set, because the seed has to ENUMERATE it — which makes it a
  // retention leak by construction, one detached subtree per scrolled element
  // per trial over a long session. Pruning on read and once per trial bounds
  // it without a reaper: `isConnected === false` is the browser's own answer,
  // and reading it explicitly (rather than falsy) keeps duck-typed test nodes,
  // which claim nothing, in the Set.
  //
  // Deliberately dumb: every element that scrolls goes in, redacted or
  // excluded or outside the observed root. What may be SEEDED is one question
  // with one answer, and it lives in initial-state.js.
  var scrolledElements = new Set();
  function pruneScrolledElements() {
    scrolledElements.forEach(function (el) {
      if (el && el.isConnected === false) scrolledElements.delete(el);
    });
  }

  // ── Scroll (RAF-coalesced, per target, original timestamps) ──
  rec.addListener(win, 'scroll', guard(rec, 'scroll', function (e) {
    var target = e && e.target && e.target.tagName ? e.target : null;
    if (target) {
      pendingElementScrolls.set(target, { t: now() });
      scrolledElements.add(target);
    } else {
      pendingWindowScroll = { t: now() };
    }
    if (!scrollFlushQueued) {
      scrollFlushQueued = true;
      raf(guard(rec, 'scroll', flushScrolls));
    }
  }), { passive: true, capture: true });

  // ── Touch ──
  rec.addListener(doc, 'touchstart', guard(rec, 'touch', function (e) {
    flushCameraNow();
    var p = e.touches && e.touches[0];
    if (!p) return;
    var payload = withCameraSnapshot(
      withClient({ x: Math.round(p.pageX), y: Math.round(p.pageY) }, p));
    var anchor = anchorFor(e);
    if (anchor) payload.target = anchor;
    rec.pushEvent('touchstart', payload, now());
  }), { passive: true, capture: true });
  var touchPending = false;
  var lastTouch = null;
  var lastTouchT = 0;
  rec.addListener(doc, 'touchmove', guard(rec, 'touch', function (e) {
    lastTouch = e.touches && e.touches[0];
    lastTouchT = now();
    if (touchPending) return;
    touchPending = true;
    raf(guard(rec, 'touch', function () {
      touchPending = false;
      if (lastTouch) {
        rec.pushEvent('touchmove', withClient({
          x: Math.round(lastTouch.pageX), y: Math.round(lastTouch.pageY)
        }, lastTouch), lastTouchT);
      }
    }));
  }), { passive: true, capture: true });
  rec.addListener(doc, 'touchend', guard(rec, 'touch', function (e) {
    flushCameraNow();
    var p = e.changedTouches && e.changedTouches[0];
    if (!p) return;
    var payload = withCameraSnapshot(
      withClient({ x: Math.round(p.pageX), y: Math.round(p.pageY) }, p));
    var anchor = anchorFor(e);
    if (anchor) payload.target = anchor;
    rec.pushEvent('touchend', payload, now());
  }), { passive: true, capture: true });

  // ── Focus / visibility ──
  rec.addListener(win, 'blur', guard(rec, 'focus', function () {
    rec.pushEvent('blur', {}, now());
  }));
  rec.addListener(win, 'focus', guard(rec, 'focus', function () {
    rec.pushEvent('focus', {}, now());
  }));
  rec.addListener(doc, 'visibilitychange', guard(rec, 'focus', function () {
    rec.pushEvent('visibility', { hidden: !!doc.hidden }, now());
  }));

  // ── Viewport (RAF-coalesced resize; event-driven, no polling) ──
  rec.addListener(win, 'resize', guard(rec, 'viewport', function () {
    pendingResize = { t: now() };
    if (!resizeFlushQueued) {
      resizeFlushQueued = true;
      raf(guard(rec, 'viewport', flushResize));
    }
  }));
  // visualViewport: size/scale AND pan (scroll). Pinch-pan does not move the
  // pointer relative to the DOM (page/client coords are layout-viewport CSS
  // px), so vv is visible-region METADATA, not part of the cursor projection
  // — recorded so the viewer can later show what the participant could see.
  if (win.visualViewport && typeof win.visualViewport.addEventListener === 'function') {
    ['resize', 'scroll'].forEach(function (kind) {
      rec.addListener(win.visualViewport, kind, guard(rec, 'viewport', function () {
        pendingVv = { t: now() };
        if (!vvFlushQueued) {
          vvFlushQueued = true;
          raf(guard(rec, 'viewport', flushVv));
        }
      }));
    });
  }

  // ── Per-trial camera seed ──
  // Scroll + viewport state at trial start. Without this, a trial that
  // begins mid-scroll (the user's fixture, trial 2) replays from a wrong
  // camera until its first in-trial scroll/resize event.
  rec.onTrialStart(function (trial) {
    pruneScrolledElements();
    var dims = clientDims();
    trial.viewState = {
      x: Math.round(win.scrollX || 0), y: Math.round(win.scrollY || 0),
      w: win.innerWidth || null, h: win.innerHeight || null,
      cw: dims.cw, ch: dims.ch,
      dpr: win.devicePixelRatio || 1
    };
  });

  // The capture handle. v1 callers ignore the return value (index.js calls
  // this for its side effects), so the addition is invisible to them; the
  // keyframe path (Tasks 6/8) reads the scrolled-element set through it.
  return {
    // The LIVE Set, pruned of detached elements first. Read-only by contract:
    // buildInitialState iterates it and the tracker owns its contents.
    getScrolledElements: function () {
      pruneScrolledElements();
      return scrolledElements;
    },
  };
}
