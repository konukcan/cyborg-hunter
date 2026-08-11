// src/replay/capture-trace.js
// Tier-1 ("trace") capture: pointer, keys, clipboard, input values, scroll,
// touch, focus/visibility, viewport — in the SessionRecording v2 event
// vocabulary (spec §5). Everything attaches through the recorder's listener
// registry so destroy() tears it all down.
//
// What v2 changed here, and why it is one change rather than a rename pass:
//
//   - **Dotted `type` names** (spec §5) replace v1's flat `kind`, and the
//     payload under each name is that type's own shape, not a bag of fields
//     merged onto an event. Hence `rec.pushRecord(record, t)` instead of
//     `pushEvent(kind, payload, t)`.
//   - **Client-frame coordinates only** (spec §7 makes the client frame
//     normative). v1 carried both frames — page in `x`/`y`, client in
//     `cx`/`cy` — because its viewer did the projection itself; page positions
//     now derive from the scroll state that `scroll.window`, `initial_state`
//     and the camera block already carry.
//   - **Integer node ids** (spec §4/§7) replace the nonce-marker refs. An
//     element is addressable only if the FILE contains it, which is a question
//     about the recording and not about the live DOM — so it is answered by the
//     capture span's delivery model (delivery.js), the same source the mutation
//     mapper and the keyframe seed use.
//   - **Alignment blocks** (spec §6): the camera state and the target anchor
//     move from flat `sx/sy/vw/vh/cw/ch` + `{tag,id,rect,n}` into complete
//     `camera` and `anchor` objects, with the `dpr`/`vv_*` fields v1 never had.
//   - **Viewport changes leave the event stream**: spec §2 keeps resize and
//     pinch state in the session-level `viewport_changes` array, so those two
//     channels push to the recorder's session sink instead of a trial.
//
// Three floors decide what a payload may say about an element. Every channel
// asks all three, which is the point of stating them once:
//
//   1. REDACTION (spec §8) is a property of the FILE, not of one channel: a
//      redacted subtree's content appears nowhere, so key identity, input
//      values, clipboard payloads and anchor ids collapse to the spec's
//      redacted variants. Where §5 defines no redacted variant for a type
//      (input.checked, input.select, scroll.element), the event is dropped
//      instead — the same subtraction initial-state.js makes for the same
//      reason.
//   2. EXCLUSION (spec §4) is stronger and was MISSING in v1: the file holds a
//      placeholder with no attributes, children or content, so no channel may
//      report the element's STATE either — not a typed value, not its length,
//      not a scroll offset. v1's input handler checked redaction and never
//      exclusion, which shipped the typed contents of CH's own guard bait as
//      plaintext `input` events (the honeypot stamps its marker on the bait
//      INPUT itself, so the whole subtree is one element).
//   3. ADDRESSABILITY: `input.*` and `scroll.element` are typed with a REQUIRED
//      `node` (spec §5.2/§5.6). An event naming a node the player never
//      received is worse than a missing event — it either does nothing or
//      lands on the wrong element — so those types are emitted only when the
//      target resolves. On trace tier (no DOM capture at all) nothing resolves,
//      and the recording is honestly node-free.
//
// Testability: the environment (doc/win/now/raf) is injectable, and so is the
// capture span. In the browser, callers omit `env` and the real globals are
// used.
//
// Failure containment: every handler body runs inside guard() — a throwing
// capture channel logs one captureFailure and the experiment continues.

import {
  isInRedactedSubtree, isRedactionTainted, markRedacted,
} from './redaction.js';
import { isInExcludedSubtree } from './snapshot.js';

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

// Round to 0.1px — anchor rects feed pixel-tolerance checks; full float
// precision would just bloat the JSON.
function r10(v) { return Math.round(v * 10) / 10; }

// Spec §5/§6 type every coordinate and camera field as a number. Real events
// and real windows always supply them; a duck-typed fixture may not, and a
// NaN or null on the wire fails strict validation instead of degrading.
function intOr0(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : 0; }
// Same reason for the string fields spec §5.2 requires: an absent `key` is
// better said as "" than as the word "undefined".
function strOrEmpty(v) { return v == null ? '' : String(v); }

// Vendor namespace for event-level extensions (spec §9): CH-specific facts
// about a standard event, which may not ride as unknown top-level fields.
var CH_VENDOR = 'cyborg-hunter';
function withVendorExtension(record, data) {
  var ext = record.extensions || (record.extensions = {});
  ext[CH_VENDOR] = Object.assign({}, ext[CH_VENDOR], data);
  return record;
}

export function attachTraceCapture(rec, env) {
  env = env || {};
  var doc = env.doc || document;
  var win = env.win || window;
  var now = env.now || function () { return performance.now(); };
  var raf = env.raf || (typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame.bind(null)
    : function (fn) { setTimeout(fn, 16); });
  var config = rec.config;

  // The capture span (span.js): node ids plus the file's own record of what it
  // contains. THE SEAM — capture wiring (index.js) creates one span per
  // recording and hands the same object to this module and to the DOM capture,
  // so both speak about the file in the same ids. Absent (trace tier, or any
  // caller that never took a keyframe) means nothing is addressable, which is
  // exactly true of a recording with no DOM in it.
  var span = env.span || null;

  // The predicates' configuration, read once: config is fixed for the life of
  // an attachment, and re-reading it per event bought nothing.
  var opts = {
    keepBait: config.keepBait,
    redactSelector: config.redactSelector,
    taint: env.taint,
  };

  // ── The three floors ──

  // Content withheld by redaction (spec §8). Marking on the way out is what
  // keeps it withheld after the page moves the element out of the redacted
  // container: the taint set outlives any keyframe (redaction.js).
  function isRedactedTarget(el) {
    if (!el) return false;
    if (isInRedactedSubtree(el, opts.redactSelector) || isRedactionTainted(el, opts.taint)) {
      markRedacted(el, opts.taint);
      return true;
    }
    return false;
  }

  // State withheld by exclusion (spec §4). Not a special case of redaction: an
  // excluded element keeps its content out of the file entirely, so even the
  // length of what was typed into it, and the offset it was scrolled to, stay
  // out. `keepBait` still turns the LEGACY markers off, as everywhere.
  function isExcludedTarget(el) {
    return !!el && isInExcludedSubtree(el, opts);
  }

  // The node id to address this element by, or null when the file holds
  // nothing on its ancestor path.
  //
  // The walk answers spec §7's three cases in one pass: a normal target
  // resolves to itself; a target inside an excluded subtree resolves to the
  // PLACEHOLDER, which is the node the file actually has; a target outside the
  // observed root resolves to null. Membership comes from the span's delivery
  // model rather than from re-deriving it off the live DOM, for the reason
  // initial-state.js gives: the DOM can have moved since the walk that produced
  // the file, and the file is what the player holds.
  function nodeIdFor(el) {
    if (!span) return null;
    var cur = el;
    while (cur) {
      if (span.delivery.holds(cur)) {
        var id = span.registry.peekId(cur);
        return id == null ? null : id;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  function clientDims() {
    var de = doc.documentElement;
    return {
      cw: de && de.clientWidth ? de.clientWidth : win.innerWidth,
      ch: de && de.clientHeight ? de.clientHeight : win.innerHeight
    };
  }

  // Client-frame coordinates of a mouse event or a Touch point (spec §7).
  function clientX(p) { return intOr0(p && p.clientX); }
  function clientY(p) { return intOr0(p && p.clientY); }

  // ── Alignment: camera (spec §6) ──
  // Flushing pending camera state is not enough on its own: browsers dispatch
  // scroll/resize NOTIFICATIONS asynchronously after programmatic scrolls
  // (scrollIntoView, scrollTo, anchor jumps), so an interaction can be recorded
  // before the scroll event that describes the state it happened under — with
  // nothing pending to flush. The camera block reads the live state
  // synchronously in the interaction's own handler.
  //
  // `dpr` and the `vv_*` fields complete the block per spec §6: zoom and pinch
  // states become classifiable per event, independent of the coalesced
  // viewport_changes stream.
  function cameraBlock() {
    var dims = clientDims();
    var vv = win.visualViewport;
    return {
      scroll_x: intOr0(win.scrollX),
      scroll_y: intOr0(win.scrollY),
      viewport_w: intOr0(win.innerWidth),
      viewport_h: intOr0(win.innerHeight),
      client_w: intOr0(dims.cw),
      client_h: intOr0(dims.ch),
      dpr: typeof win.devicePixelRatio === 'number' ? win.devicePixelRatio : 1,
      vv_scale: vv && typeof vv.scale === 'number' ? vv.scale : 1,
      vv_offset_x: vv ? r10(vv.offsetLeft || 0) : 0,
      vv_offset_y: vv ? r10(vv.offsetTop || 0) : 0
    };
  }

  // ── Alignment: anchor (spec §6) ──
  // Identity + geometry of what a discrete interaction hit, captured at CAPTURE
  // PHASE (before page handlers can remove the target or stop the recording —
  // the smoke fixture's Finish click was lost to exactly that).
  //
  // `tag` and `rect` describe the EVENT TARGET, `node` names the nearest node
  // the file holds. They can differ (a click inside an excluded subtree names
  // the placeholder), and the target's own geometry is still the truthful
  // answer to "what was under the pointer" — the player's cross-check is free
  // to read the disagreement as uncertainty, which is what it is for. The
  // alternative, describing the resolved node instead, would misreport a click
  // on an element inserted and clicked within one task, before the observer
  // flushed.
  //
  // `id` is OMITTED (not nulled) when identity is withheld — spec §6 says
  // omitted for redacted targets, §4 says events inside an excluded subtree
  // carry no anchor identity — so "no id attribute" (null) stays
  // distinguishable from "withheld" (absent).
  function anchorFor(e) {
    var el = e && e.target;
    if (!el || !el.tagName) return null;
    var a = { tag: el.tagName.toLowerCase() };
    if (!isRedactedTarget(el) && !isExcludedTarget(el)) a.id = el.id || null;
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        var r = el.getBoundingClientRect();
        a.rect = { x: r10(r.left), y: r10(r.top), w: r10(r.width), h: r10(r.height) };
      }
    } catch (err) { /* rect stays absent — viewer treats as unverifiable */ }
    a.node = nodeIdFor(el);
    return a;
  }

  // Shadow retargeting, detected at EVENT time: for OPEN shadow roots the
  // composed path's first entry is the real (shadow-internal) target while
  // e.target is the retargeted host — regardless of when attachShadow() ran (a
  // post-snapshot attach leaves no mutation record). Shadow content is a known
  // capture limit (spec §13), and "this interaction hit something the file
  // cannot contain" is CH's own note about a standard event, so it rides in the
  // vendor namespace (spec §9) rather than as an extra anchor field. CLOSED
  // roots are undetectable from outside by design.
  function noteShadowRetarget(record, e) {
    try {
      if (typeof e.composedPath !== 'function') return record;
      var path0 = e.composedPath()[0];
      if (path0 && path0 !== e.target) withVendorExtension(record, { shadow_retarget: true });
    } catch (err) { /* composedPath unavailable — nothing to note */ }
    return record;
  }

  // ── Camera state: window/element scroll + viewport, RAF-coalesced ──
  // Two invariants the player's projection depends on:
  //  1. ORIGINAL timestamps: a coalesced event is stamped with the time of the
  //     last underlying DOM event, not the RAF flush — otherwise a click
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
      rec.pushRecord({
        type: 'scroll.window',
        x: intOr0(win.scrollX), y: intOr0(win.scrollY)
      }, pendingWindowScroll.t);
      pendingWindowScroll = null;
    }
    if (pendingElementScrolls.size > 0) {
      pendingElementScrolls.forEach(function (state, target) {
        // An excluded element's scroll offset is part of the state spec §4
        // withholds — the same call initial-state.js makes for the same
        // element. A REDACTED one keeps its offsets: §8 withholds content, and
        // an offset is not content; §5.6 defines no redacted variant to put it
        // in; and the node reference is one spec §7 explicitly keeps.
        if (isExcludedTarget(target)) return;
        var node = nodeIdFor(target);
        if (node == null) return;   // spec §5.6 requires a node id
        rec.pushRecord({
          type: 'scroll.element', node: node,
          x: intOr0(target.scrollLeft), y: intOr0(target.scrollTop)
        }, state.t);
      });
      pendingElementScrolls.clear();
    }
  }

  // Spec §2's ViewportState, complete: one shape for both channels, because
  // `viewport_changes` entries are full states, not deltas, and a resize
  // changes what pinch offsets mean as surely as a pinch does.
  function viewportState() {
    var vv = win.visualViewport;
    return {
      w: intOr0(win.innerWidth),
      h: intOr0(win.innerHeight),
      dpr: typeof win.devicePixelRatio === 'number' ? win.devicePixelRatio : 1,
      scale: vv && typeof vv.scale === 'number' ? vv.scale : 1,
      offset_x: vv ? r10(vv.offsetLeft || 0) : 0,
      offset_y: vv ? r10(vv.offsetTop || 0) : 0
    };
  }

  function flushResize() {
    resizeFlushQueued = false;
    if (!pendingResize) return;
    rec.pushViewportChange(viewportState(), pendingResize.t);
    pendingResize = null;
  }

  function flushVv() {
    vvFlushQueued = false;
    if (!pendingVv) return;
    rec.pushViewportChange(viewportState(), pendingVv.t);
    pendingVv = null;
  }

  // Synchronous camera flush — called at the top of every discrete-event
  // handler so pending state is IN THE BUFFER before the interaction lands.
  // Emission order within this function (and Map iteration order) is
  // deliberately irrelevant: every event carries its ORIGINAL timestamp and the
  // wire order is established by the serializer's stable sort on t. The buffer
  // has never been chronologically ordered — RAF-coalesced input events pre-date
  // this and flush late the same way.
  function flushCameraNow() {
    flushScrolls();
    flushResize();
    flushVv();
  }

  // Every discrete interaction carries both alignment blocks or neither (spec
  // §6: complete blocks, no delta encoding).
  function withAlignment(record, e) {
    record.camera = cameraBlock();
    var anchor = anchorFor(e);
    if (anchor) record.anchor = anchor;
    return record;
  }

  // ── Mouse ──
  // mouse.move is throttled to mouseHz; down/up/click are low-frequency and
  // carry adjudication weight, so they always record — with alignment blocks.
  // All pointer listeners are CAPTURE-PHASE: page handlers may remove the
  // target, stopPropagation, or stop the recording before bubble reaches the
  // document.
  var minMoveGap = 1000 / (config.mouseHz || 30);
  var lastMove = -Infinity;
  rec.addListener(doc, 'mousemove', guard(rec, 'mouse', function (e) {
    var t = now();
    if (t - lastMove < minMoveGap) return;
    lastMove = t;
    rec.pushRecord({ type: 'mouse.move', x: clientX(e), y: clientY(e) }, t);
  }), { passive: true, capture: true });
  [['mousedown', 'mouse.down'], ['mouseup', 'mouse.up'], ['click', 'mouse.click']]
    .forEach(function (pair) {
      rec.addListener(doc, pair[0], guard(rec, 'mouse', function (e) {
        flushCameraNow();
        var record = withAlignment({
          type: pair[1],
          x: clientX(e), y: clientY(e),
          button: typeof e.button === 'number' ? e.button : 0,
          target: nodeIdFor(e.target)
        }, e);
        rec.pushRecord(noteShadowRetarget(record, e), now());
      }), { passive: true, capture: true });
    });

  // ── Keys ──
  // keys:'off' attaches nothing. A redacted OR excluded target records the
  // spec §5.2 redacted variant — type and time, nothing else — because a
  // field's text is reconstructable keystroke-by-keystroke otherwise, which
  // would defeat the same withholding the input-value channel honours.
  //
  // Alignment fields ride key.down only, and not on auto-repeats: spec §6's
  // cost rule, taken up deliberately because CH's studies are typing-heavy and
  // each block costs a layout read.
  if (config.keys !== 'off') {
    [['keydown', 'key.down'], ['keyup', 'key.up']].forEach(function (pair) {
      rec.addListener(doc, pair[0], guard(rec, 'keys', function (e) {
        var el = e.target;
        if (isRedactedTarget(el) || isExcludedTarget(el)) {
          rec.pushRecord({ type: pair[1], redacted: true }, now());
          return;
        }
        var aligned = pair[1] === 'key.down' && !e.repeat;
        if (aligned) flushCameraNow();
        var record = {
          type: pair[1],
          key: strOrEmpty(e.key), code: strOrEmpty(e.code),
          mods: {
            ctrl: !!e.ctrlKey, shift: !!e.shiftKey,
            alt: !!e.altKey, meta: !!e.metaKey
          },
          repeat: !!e.repeat,
          target: nodeIdFor(el)
        };
        if (aligned) withAlignment(record, e);
        rec.pushRecord(record, now());
      }), true); // capture phase — before frameworks can stopPropagation
    });
  }

  // ── Clipboard (spec §5.3) ──
  // CH's default is LENGTH-ONLY: pasted text routinely contains identifying
  // material from outside the page, so the content stays out of the replay
  // stream by design (CH's own pasteDropContent flag governs content capture in
  // the integrity report, separately). `clipboardContent: true` selects the
  // content mode the spec also defines.
  //
  // copy/cut carry no length: the clipboard is not populated yet when they
  // fire, so any number read there would be a fiction about the selection.
  function readClipboard(getData) {
    var text = null, html = null;
    try { text = getData('text'); } catch (err) { /* stays null */ }
    if (config.clipboardContent) {
      try { html = getData('text/html') || null; } catch (err) { /* stays null */ }
    }
    return { text: typeof text === 'string' ? text : null, html: html };
  }

  function clipboardRecord(type, target, read) {
    var record = {
      type: type,
      target: nodeIdFor(target),
      text: null, html: null,
      len: read && read.text != null ? read.text.length : null
    };
    // Redacted target: content withheld, length allowed (spec §5.3). An
    // EXCLUDED target reaches the same wire shape without the marker — §5.3's
    // marker names redaction, and length-only is a conforming mode in its own
    // right, so content mode simply degrades there.
    var redacted = isRedactedTarget(target);
    if (redacted) record.redacted = true;
    var withheld = redacted || isExcludedTarget(target);
    if (config.clipboardContent && !withheld && read) {
      record.text = read.text;
      record.html = read.html;
      record.len = null;
    }
    return record;
  }

  rec.addListener(doc, 'paste', guard(rec, 'clipboard', function (e) {
    flushCameraNow();
    var data = e.clipboardData;
    var read = readClipboard(function (fmt) { return data.getData(fmt); });
    rec.pushRecord(clipboardRecord('clipboard.paste', e.target, read), now());
  }), true);
  rec.addListener(doc, 'copy', guard(rec, 'clipboard', function (e) {
    flushCameraNow();
    rec.pushRecord(clipboardRecord('clipboard.copy', e && e.target, null), now());
  }), true);
  rec.addListener(doc, 'cut', guard(rec, 'clipboard', function (e) {
    flushCameraNow();
    rec.pushRecord(clipboardRecord('clipboard.cut', e && e.target, null), now());
  }), true);
  rec.addListener(doc, 'drop', guard(rec, 'clipboard', function (e) {
    flushCameraNow();
    var data = e.dataTransfer;
    var read = readClipboard(function (fmt) { return data.getData(fmt); });
    rec.pushRecord(clipboardRecord('clipboard.drop', e.target, read), now());
  }), true);

  // ── Input values (RAF-coalesced per target) ──
  // Rapid typing produces one event per frame per field, holding the LAST value
  // — enough to reconstruct field state on scrub without recording every
  // intermediate keystroke twice (key.down already carries timing).
  //
  // v2 splits v1's single `input` event into the three types spec §5.2 defines,
  // by what the control's state IS: a select's selection, a box's checkedness,
  // everything else's value. The same three shapes initial-state.js seeds.
  var pendingInputs = new Map();   // target → latest event time
  var inputFlushQueued = false;

  function readValue(target) {
    if (target.value != null) return String(target.value);
    if (target.isContentEditable && target.textContent != null) return String(target.textContent);
    return '';
  }

  function selectedValues(target) {
    var out = [];
    var options = target.options || [];
    for (var i = 0; i < options.length; i++) {
      if (options[i].selected) {
        out.push(typeof options[i].value === 'string'
          ? options[i].value : String(options[i].textContent || ''));
      }
    }
    return out;
  }

  function inputRecordFor(target) {
    // Spec §4: nothing about an excluded element's state, not even a length.
    if (isExcludedTarget(target)) return null;
    var node = nodeIdFor(target);
    if (node == null) return null;              // spec §5.2 requires a node id
    var redacted = isRedactedTarget(target);
    var type = String(target.type || '').toLowerCase();
    if (target.tagName === 'SELECT') {
      // No redacted variant exists for input.select or input.checked (spec
      // §5.2 defines one for input.value only), so a withheld control emits
      // nothing at all rather than a shape the format does not have.
      return redacted ? null
        : { type: 'input.select', node: node, values: selectedValues(target) };
    }
    if (target.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
      // checked is an element PROPERTY (never an attribute mutation), so the
      // DOM replay can only restore box state from here — but a redacted
      // field's checked state is still its value: withhold it.
      return redacted ? null
        : { type: 'input.checked', node: node, checked: !!target.checked };
    }
    var value = readValue(target);
    if (redacted) {
      return { type: 'input.value', node: node, redacted: true, value_len: value.length };
    }
    return { type: 'input.value', node: node, value: value };
  }

  function flushInputs() {
    inputFlushQueued = false;
    pendingInputs.forEach(function (t, target) {
      var record = inputRecordFor(target);
      if (record) rec.pushRecord(record, t);
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
  // per trial over a long session. Pruning on read and once per trial bounds it
  // without a reaper: `isConnected === false` is the browser's own answer, and
  // reading it explicitly (rather than falsy) keeps duck-typed test nodes,
  // which claim nothing, in the Set.
  //
  // Deliberately dumb: every element that scrolls goes in, redacted or excluded
  // or outside the observed root. What may be SEEDED is one question with one
  // answer, and it lives in initial-state.js.
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
  // Spec §5.2 records the whole touch list, not one point: multi-touch is what
  // distinguishes a pinch from a drag. touch.end reports `changedTouches` (the
  // points that ended) — `touches` at that moment holds the fingers still down,
  // which says nothing about the gesture that just finished.
  function touchList(list) {
    var out = [];
    for (var i = 0; i < (list ? list.length : 0); i++) {
      var p = list[i];
      out.push({
        id: typeof p.identifier === 'number' ? p.identifier : i,
        x: clientX(p), y: clientY(p)
      });
    }
    return out;
  }

  rec.addListener(doc, 'touchstart', guard(rec, 'touch', function (e) {
    flushCameraNow();
    var record = withAlignment(
      { type: 'touch.start', touches: touchList(e.touches) }, e);
    rec.pushRecord(noteShadowRetarget(record, e), now());
  }), { passive: true, capture: true });
  var touchPending = false;
  var lastTouches = null;
  var lastTouchT = 0;
  rec.addListener(doc, 'touchmove', guard(rec, 'touch', function (e) {
    // Converted eagerly: a Touch is only meaningful for its own event, so the
    // coalescing window must hold the numbers, not the objects.
    lastTouches = touchList(e.touches);
    lastTouchT = now();
    if (touchPending) return;
    touchPending = true;
    raf(guard(rec, 'touch', function () {
      touchPending = false;
      if (lastTouches) {
        rec.pushRecord({ type: 'touch.move', touches: lastTouches }, lastTouchT);
      }
    }));
  }), { passive: true, capture: true });
  rec.addListener(doc, 'touchend', guard(rec, 'touch', function (e) {
    flushCameraNow();
    var record = withAlignment(
      { type: 'touch.end', touches: touchList(e.changedTouches) }, e);
    rec.pushRecord(noteShadowRetarget(record, e), now());
  }), { passive: true, capture: true });

  // ── Focus / visibility ──
  // visibility.* records Page Visibility transitions (spec §5.5) — tab-away,
  // distinct from window blur, and now distinct on the wire too: v1 folded both
  // directions into one `visibility` event with a boolean.
  rec.addListener(win, 'blur', guard(rec, 'focus', function () {
    rec.pushRecord({ type: 'blur' }, now());
  }));
  rec.addListener(win, 'focus', guard(rec, 'focus', function () {
    rec.pushRecord({ type: 'focus' }, now());
  }));
  rec.addListener(doc, 'visibilitychange', guard(rec, 'focus', function () {
    rec.pushRecord({
      type: doc.hidden ? 'visibility.hidden' : 'visibility.visible'
    }, now());
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
  // pointer relative to the DOM (client coords are layout-viewport CSS px), so
  // vv is visible-region METADATA, not part of the cursor projection — recorded
  // so the viewer can later show what the participant could see.
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

  // ── Per-trial upkeep ──
  // v1 stamped `trial.viewState` here — a window-scroll + viewport seed, added
  // for a real mid-scroll alignment bug. Spec §14 names `initial_state` its v2
  // successor, and that seed is taken at the KEYFRAME (initial-state.js), after
  // the snapshot walk that gives it node ids to name. So this hook keeps only
  // the tracker upkeep the seed depends on; the call site is the capture
  // wiring's (Task 6).
  rec.onTrialStart(function () {
    pruneScrolledElements();
  });

  // The capture handle. v1 callers ignore the return value (index.js calls this
  // for its side effects), so it stays invisible to them; the keyframe path
  // reads the scrolled-element set through it. The span is NOT echoed back: it
  // comes IN through `env`, so its owner already has it.
  return {
    // The LIVE Set, pruned of detached elements first. Read-only by contract:
    // buildInitialState iterates it and the tracker owns its contents.
    getScrolledElements: function () {
      pruneScrolledElements();
      return scrolledElements;
    },
  };
}
