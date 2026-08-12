// src/cli/renderers/replay-viewer.client.js
// Browser-side replay viewer for SessionRecording v2 (spec r2), embedded
// verbatim into the HTML report.
//
// IT IS NOT INLINED ALONE. `replay-client-source.js` concatenates
// `src/replay/dom-instantiate.js` ahead of it inside one strict IIFE, so
// `mountTree`, `applyPatch` and `applyPatches` — the single reading of spec §4
// this repo holds — are in scope here. Reading this file on its own will show
// three undefined functions; that is the concatenation contract, not a bug
// (T5 Task 2's recorded decision, machine-checked in
// tests/replay/dom-instantiate.test.js).
//
// Contract: window.initChReplayViewer(mountEl, model), where model is
// `buildViewerModel`'s v2 output (design §9): segments with segment-relative
// event times and a folded camera seed, session-level `viewportChanges` /
// `stylesheetEvents` in ABSOLUTE wire time, and no CH-specific panel data
// unless the file's own field is present.
//
// ── What v2 changed here, and why each thing went ──
//
// THE RECONSTRUCTION IS INSTANTIATED, NEVER PARSED. v1 interpolated a captured
// HTML string into `srcdoc` and applied child-list patches with `innerHTML`.
// Both are gone: a keyframe is a DomNode tree mounted node by node through
// `mountTree`, and the four `dom.*` patches address integer ids through the
// span's id map. `</script>` breakouts, attribute-escaping bugs and
// parser-normalisation drift stop being defended against and start being
// impossible — which is why the whole nonce-marker apparatus (the harvested
// attribute map, the child-index path fallback and the reference resolver that
// tried both) left with it.
//
// THE SHELL IS WRITTEN ONCE. `srcdoc` carries the CSP, the no-referrer meta,
// the viewer's own shell rules and nothing else; everything after boot is
// synchronous DOM work through `contentDocument`. v1 rebuilt the whole frame
// through `srcdoc` + `onload` on every backward seek, which is why it needed a
// generation counter to drop stale loads and why a seek could not be read back
// synchronously. A restore is now `mountTree` plus a walk. The one
// remaining async path is the analyst's "Load external CSS" button, which
// changes the CSP string itself and therefore genuinely needs a new document.
//
// KEYFRAME SPANS REPLACE SELF-CONTAINED TRIALS. A segment with `initialDom` is
// a keyframe; the ones after it are continuations that carry on from its end
// state. Restoring segment i means mounting `segments[spanStart].initialDom`,
// deriving stylesheet state, seeding `initial_state`, and replaying every
// event from the keyframe origin to the playhead — merged with the session
// streams at spec §7's tie precedence.
//
// Coordinate model: unchanged in spirit, simpler in fact. The stage shows the
// RECORD-TIME VIEWPORT; the iframe is sized to the record-time layout box and
// letterboxed into a fixed stage. v2's coordinates are normative CLIENT
// coordinates, so v1's page-coordinate re-projection — and the reduced-
// guarantees banner that flagged it — is deleted rather than ported.
//
// Anatomy per mount:
//   header   tier badge · segment <select> · play/pause · speed · clock · chips
//   stage    tier 'dom': ONE sandboxed <iframe>, mounted and patched in place
//            tier 'trace': neutral gray stage with a label
//            + <canvas> overlay (cursor trail, click ripples)
//   lane     per-segment marker lane (clipboard/mutations/bands/check marks)
//   scrub    <input type=range> in ms, rAF-coalesced into the span walk
//   ticker   text line of the events nearest the playhead

(function () {
  'use strict';

  // Lane colours, keyed by spec §5's dotted types. `dom.*` share one colour:
  // the lane answers "was the page changing here", not which verb ran.
  var MARKER_COLORS = {
    'clipboard.paste': '#d32f2f', 'clipboard.drop': '#7b1fa2',
    'clipboard.copy': '#f57c00', 'clipboard.cut': '#f57c00',
    'recording.capture_stopped': '#616161',
    'dom.add': '#1976d2', 'dom.remove': '#1976d2',
    'dom.attr': '#1976d2', 'dom.text': '#1976d2',
    'input.value': '#388e3c', 'input.checked': '#388e3c', 'input.select': '#388e3c',
    // Adopted vocabulary (design §7). Media and fullscreen are STATE changes
    // the viewer reports rather than reproduces, so the lane is where they
    // land: a badge says what the state is now, a marker says when it changed.
    'fullscreen.enter': '#00838f', 'fullscreen.exit': '#00838f',
    'canvas.snapshot': '#5e35b1',
    'media.play': '#00897b', 'media.pause': '#00897b', 'media.ended': '#00897b',
    'media.seeked': '#00897b', 'media.time': '#00897b'
  };
  var GUARD_COLOR = '#d32f2f';
  var UNCERTAIN_COLOR = '#b26a00';

  // Self-check tolerances (CSS px, unscaled): camera ±1; rect edges ±3
  // conjunctive with containment (2px allowance) AND hit-test; stage
  // transform ±2.
  var TOL_CAMERA = 1;
  var TOL_RECT = 3;
  var TOL_CONTAIN = 2;
  var TOL_STAGE = 2;

  // The §8 comparisons, by name, for the `skipped` array every check carries:
  // which of them could not RUN on this event, because the recording did not
  // state the data or the reconstruction could not be measured. SIX names for
  // five predicates — check 1 is two comparisons over independent fields.
  //
  // A skip is NOT a failure and never reaches the chip, the lane or the glyph.
  // It exists so that `status === 'ok' && skipped.length === 0` is the only
  // combination meaning every comparison was made and every one held: without
  // it, an event whose rect the recording never carried counts in the same
  // "alignment verified (N checks)" numerator as one that was verified in full.
  var ALL_PREDICATES = ['camera.scroll', 'camera.client_w', 'rect', 'containment',
    'hit-test', 'stage'];

  // Keycast: how long a chip keeps fading after its key.up, in segment-relative
  // ms. Purely a function of playhead (like the click-ripple fade in
  // drawOverlay below), not real time, so seeking lands on the same visual
  // state playing to it would.
  var KEYCAST_FADE_MS = 500;

  // Buffer-cap explanation FALLBACK: recorder.js's REPLAY_DEFAULTS, quoted only
  // when the recording states no limit of its own.
  //
  // It usually does state one. The configured cap that was actually crossed is
  // CH's own diagnostic rather than a standard field, so it rides in the §5.7
  // event's vendor namespace — `recording.capture_stopped.extensions
  // ['cyborg-hunter'] = {limit_events}` or `{limit_chars}` (recorder.js), which
  // `serializer.js` and `buildViewerModel` both copy through whole. So the
  // §5.7 re-point reads the RECORDING's numbers out of the event stream this
  // viewer already walks; it needs no new model field, and the defaults below
  // survive only for a file that carries no such event (a foreign producer, or
  // `reason: "error"`). See `findCaptureStop` / `captureStopLimit` below.
  var CAP_DEFAULTS = { events: 50000, chars: 8000000 };

  // Non-move input events: the ones that MAY carry §6 alignment blocks and the
  // ones the overlay draws as discrete marks.
  var DISCRETE_TYPES = {
    'mouse.down': true, 'mouse.up': true, 'mouse.click': true,
    'touch.start': true, 'touch.end': true,
    'key.down': true, 'key.up': true
  };

  // §7's total event order: at equal `t`, precedence is stylesheet_events →
  // viewport_changes → segment events. The ranks ARE that rule; the merge sorts
  // on (t, rank) and JS sorts are stable, so array order decides within a
  // stream, which is the other half of §7.
  // The rank is ONLY an ordering key: every walk entry also carries the name of
  // the stream it came from, set where it is built. Deriving the name from the
  // rank instead would make a test of the precedence circular — swapping the
  // two constants would swap the labels with them and read as correct.
  var RANK_SHEET = 0;
  var RANK_VIEWPORT = 1;
  var RANK_EVENT = 2;

  // How the viewer recognises its own shell after writing it. The parser drops
  // attributes on a re-parsed <html>, so the sentinel is a <meta>.
  var SHELL_META = 'ch-replay-shell';

  // Spec §5's WHOLE vocabulary, not CH's capture subset (design §7): the
  // conformance moment is this viewer playing a foreign conforming file, and
  // `jspsych-full` carries canvas snapshots, fullscreen transitions and
  // content-mode clipboard payloads CH's recorder will never produce.
  //
  // The set exists so §5.8's "skip and count" has a definition of KNOWN that is
  // one list rather than the shape of an if/else chain. A type in here is
  // handled or deliberately left to the overlay/lane/ticker; a type not in here
  // is counted and warned about once.
  var KNOWN_TYPES = {};
  ('dom.add dom.remove dom.attr dom.text ' +
   'mouse.move mouse.down mouse.up mouse.click ' +
   'touch.start touch.move touch.end key.down key.up ' +
   'input.value input.checked input.select ' +
   'clipboard.copy clipboard.cut clipboard.paste clipboard.drop ' +
   'canvas.snapshot ' +
   'media.play media.pause media.ended media.seeked media.time ' +
   'focus blur visibility.hidden visibility.visible ' +
   'fullscreen.enter fullscreen.exit ' +
   'scroll.window scroll.element ' +
   'recording.capture_stopped').split(' ').forEach(function (t) { KNOWN_TYPES[t] = true; });

  // Canvas presentation (design §3.1). MUST match dom-instantiate.js's
  // VIEWER_OWNED_ATTRS entries — the module refuses both names on both verbs,
  // which is what stops a recording from stripping the selector its own
  // composite is presented through.
  var CANVAS_ATTR = 'data-ch-canvas';
  var CANVAS_RULE_ATTR = 'data-ch-canvas-rule';
  // Nothing but our own encoder writes this string, and it goes inside a CSS
  // `url("…")`, so the shape is checked rather than trusted: a realm without
  // canvas support returns '' from toDataURL (happy-dom does), and a stray
  // quote would end the declaration early.
  var DATA_URL_RE = /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]*$/;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtClock(ms) {
    var s = Math.max(0, ms) / 1000;
    var m = Math.floor(s / 60);
    var rem = (s - m * 60).toFixed(1);
    return m + ':' + (rem < 10 ? '0' : '') + rem;
  }

  // Human label for a keycast chip. `key` already names special keys well
  // (Enter, Shift, Backspace, ArrowLeft…); the one gap is the space bar,
  // which arrives as a literal ' ' and would render as an invisible chip.
  function formatKeyLabel(key) {
    return key === ' ' ? 'Space' : key;
  }

  function fmtCount(n) {
    return n.toLocaleString('en-US');
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  // The wire rounds to 0.1 ms (spec §7) and `buildViewerModel` rebases every
  // segment event with `round1(t − origin)`. Session-level streams keep
  // absolute times, so this file rebases them into a segment's frame with the
  // SAME formula — forward, never reverse. That makes an equal-`t` tie between
  // a session stream and a segment event exact by construction, which is what
  // §7's precedence rule needs to mean anything. (Reversing instead —
  // `origin + tRel` — is inexact by up to ~2e-7 ms and would decide ties by
  // float noise; viewer-model.js's conversion comment measures it.)
  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  // ── The reconstruction shell (tier 'dom') ──
  // The recorded DOM is UNTRUSTED (an adversarial participant or extension may
  // have injected markup, and a foreign v2 file is not bound by CH's capture
  // rules at all). sandbox="allow-same-origin" without allow-scripts already
  // blocks scripts; the CSP meta additionally kills frames, form posts,
  // fetch/XHR-carrying elements, and plugin content, while still allowing
  // images/media/styles and fonts — the carriers of visual fidelity. Residual
  // (documented): a participant-injected <img src> can still fire a GET to its
  // host when the analyst loads the replay. no-referrer strips the analyst
  // context.
  function srcdocCsp(allowExternalCss) {
    return "default-src 'none'; img-src * data: blob:; media-src * data: blob:; " +
      (allowExternalCss ? "style-src 'unsafe-inline' https: http:; " : "style-src 'unsafe-inline'; ") +
      "font-src * data:; " +
      "form-action 'none'; frame-src 'none'; connect-src 'none'; base-uri 'none';";
  }

  function attrEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // The viewer's OWN rules, kept in one <style> that is always the last child
  // of the shell head so the recording's stylesheets cannot override them.
  //
  // NOTE deliberately ABSENT: the old `html,body{margin:0}` override. It came
  // AFTER the captured CSS and silently overrode the page's own body margins
  // (including `margin:auto` centering) — the single largest cursor-
  // misalignment source on the acceptance fixture (~390px). The reconstruction
  // must lay out exactly as the recorded page did, UA defaults included.
  //
  // The frame is sized to the RECORD-TIME layout width (clientWidth =
  // innerWidth minus any classic scrollbar), so the frame's own root scrollbar
  // must not subtract a second gutter on classic-scrollbar platforms. Hiding
  // the ROOT scroller's bar (scrolling still works programmatically) keeps
  // layout width == camera width everywhere; inner containers keep their bars.
  //
  // The placeholder rule is spec §12's player duty made visible: an element the
  // format cannot carry the content of (an iframe today) reads as "something
  // was here" rather than as blank page. It is an OUTLINE, not a border,
  // deliberately — a border participates in layout, and the §8 rect check
  // compares the replayed box against the capture-time one, so a viewer that
  // grew the box would report a misalignment it caused itself.
  function shellRules() {
    return 'html{scrollbar-width:none}' +
      'html::-webkit-scrollbar{width:0;height:0}' +
      '[data-ch-placeholder]{outline:2px dashed #b26a00;outline-offset:-2px;' +
      'background:repeating-linear-gradient(45deg,rgba(178,106,0,.06),' +
      'rgba(178,106,0,.06) 6px,transparent 6px,transparent 12px)}';
  }

  // Written ONCE per mount. It carries no recorded content at all: the
  // stylesheets are inserted by resetSheets() so that one function owns sheet
  // state, and the body is filled by mountTree().
  function buildShell(allowExternalCss, gen) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + srcdocCsp(allowExternalCss) + '">' +
      '<meta name="referrer" content="no-referrer">' +
      '<meta name="' + SHELL_META + '" content="' + gen + '">' +
      '<style data-ch-shell-rules>' + shellRules() + '</style>' +
      '</head><body></body></html>';
  }

  window.initChReplayViewer = function (mount, model) {
    if (!mount || !model) return;
    if (mount._chReplayInit) return;   // double-click guard
    mount._chReplayInit = true;
    mount.textContent = '';

    var segments = model.segments || [];
    if (segments.length === 0) {
      mount.appendChild(el('p', 'replay-note', 'Recording contains no segments.'));
      return;
    }
    // Session-level streams: ABSOLUTE wire times, rebased per segment at use.
    var sheetEvents = model.stylesheetEvents || [];
    var viewportChanges = model.viewportChanges || [];
    var scrollbar = model.scrollbar || { w: 0, h: 0 };

    // ── State ──
    var segIdx = 0;
    var playhead = 0;          // segment-relative ms
    var playing = false;
    var speed = 1;
    // Continuous whole-session playback, default ON: at a segment's end while
    // playing, load the next segment and keep going, so an analyst watches a
    // full session as one video instead of stopping at every boundary. The
    // 'pause at segment boundaries' toggle flips this off.
    var autoAdvance = true;

    var shellReady = false;
    var shellGen = 0;          // stamped into each shell; see shellPresent()
    var span = null;           // mountTree's live state for the mounted span
    var spanStart = -1;        // index of the keyframe the mounted span opens at
    var spanEnd = -1;
    var walk = [];             // merged span entries, in application order
    var appliedIdx = 0;
    var stats = { shellWrites: 0, mounts: 0 };

    // Adopted-vocabulary state (design §7). All three are rebuilt by a restore,
    // because all three are functions of the playhead — except `unknownTypes`,
    // which describes the FILE and therefore outlives any walk.
    var canvasNodes = new Map();   // node id -> {off, chain, w, h, dirty, sized, sizeCss}
    var mediaState = new Map();    // node id -> {tag, state, time}
    var unknownTypes = new Map();  // §5.8: type -> true, one entry per type

    // Camera at the applied position: window scroll + viewport dims.
    var cam = null;            // {x, y, w, h, cw, ch}
    var pendingCamSize = false;
    var stageW = 0, stageH = 0;
    var k = 1, ox = 0, oy = 0;  // iframe scale + letterbox origin

    // Scrub coalescing: at most one restore per animation frame, targeting the
    // latest requested time. Without it a drag across a deep span queues one
    // full span replay per `input` event (v1 seeked synchronously per event,
    // which was affordable only because a v1 trial was self-contained).
    var pendingSeek = null;
    var frameQueued = false;

    function seg() { return segments[segIdx]; }

    // ── Header ──
    var header = el('div', 'replay-header');
    var badge = el('span', 'replay-badge', model.tier === 'dom' ? 'DOM replay' : 'Trace replay');
    badge.setAttribute('data-tier', model.tier === 'dom' ? 'dom' : 'trace');
    badge.setAttribute('role', 'status');
    var segSel = el('select', 'replay-segment-select');
    segments.forEach(function (s, i) {
      var opt = el('option', null,
        'Segment ' + (s.index != null ? s.index : i) +
        ' — ' + (s.label || (s.plugin ? s.plugin : '?')) +
        ' (' + fmtClock(s.durMs) + ')');
      opt.value = String(i);
      segSel.appendChild(opt);
    });
    var playBtn = el('button', 'replay-play', '▶');
    playBtn.setAttribute('aria-label', 'Play');
    var speedSel = el('select', 'replay-speed');
    [1, 2, 4, 8].forEach(function (s) {
      var o = el('option', null, s + '×'); o.value = String(s); speedSel.appendChild(o);
    });
    var clock = el('span', 'replay-clock', '0:00.0 / 0:00.0');
    var sessionPos = el('span', 'replay-note replay-session-pos', '');
    var pauseLabel = el('label', 'replay-pause-toggle');
    var pauseCheckbox = document.createElement('input');
    pauseCheckbox.type = 'checkbox';
    pauseCheckbox.className = 'replay-pause-checkbox';
    pauseCheckbox.checked = false;   // default: continuous playback ON
    pauseCheckbox.addEventListener('change', function () {
      autoAdvance = !pauseCheckbox.checked;
    });
    pauseLabel.appendChild(pauseCheckbox);
    pauseLabel.appendChild(document.createTextNode(' Pause at segment boundaries'));
    header.appendChild(badge);
    header.appendChild(segSel);
    header.appendChild(playBtn);
    header.appendChild(speedSel);
    header.appendChild(clock);
    header.appendChild(sessionPos);
    if (segments.length > 1) header.appendChild(pauseLabel);
    // Every CH panel is guarded on its OWN field, never on `foreign`: a
    // converted file carries the CH namespace without CH's data, and a CH file
    // captured standalone carries no score.
    if (!model.scoring) {
      header.appendChild(el('span', 'replay-note',
        'No integrity score attached (this recording was captured standalone)'));
    }
    // ── §5.7: truncation, with the recording's own numbers ──
    // The stop signal is an EVENT, emitted once into the segment open at stop
    // time, and it carries `reason` — plus, when CH produced it, the configured
    // cap it crossed, in the event's vendor namespace. It is found by one scan
    // here rather than during a walk, because the banner is a property of the
    // RECORDING and must be visible before the analyst seeks anywhere near the
    // point where capture went dark.
    function findCaptureStop() {
      for (var si = 0; si < segments.length; si++) {
        var evs = segments[si].events || [];
        for (var ei = 0; ei < evs.length; ei++) {
          if (evs[ei].type === 'recording.capture_stopped') return { seg: si, ev: evs[ei] };
        }
      }
      return null;
    }
    var captureStop = findCaptureStop();

    function captureStopReason() {
      var r = captureStop && captureStop.ev.reason;
      if (r === 'buffer_limit') return 'buffer limit';
      if (r === 'error') return 'capture error';
      return null;
    }

    // The cap the recording says it crossed, or null. CH stamps it as
    // `{limit_events}` / `{limit_chars}`.
    //
    // The READ is deliberately NOT gated on `model.foreign`: §9 is where vendor
    // data belongs, the read is guarded on its own presence, and a player that
    // declines to read a namespace it understands is being fastidious at the
    // analyst's expense. What IS gated on `foreign` is the FALLBACK below.
    function captureStopLimit() {
      var ext = captureStop && captureStop.ev.extensions;
      var ch = ext && ext['cyborg-hunter'];
      if (!ch) return null;
      if (num(ch.limit_events) != null) return fmtCount(ch.limit_events) + ' events';
      if (num(ch.limit_chars) != null) return fmtCount(ch.limit_chars) + ' characters';
      return null;
    }

    if (model.captureStopped || model.truncated || captureStop) {
      var capDetails = document.createElement('details');
      capDetails.className = 'replay-note replay-warn replay-cap';
      capDetails.setAttribute('data-ch-cap-note', '');
      var capSummary = document.createElement('summary');
      var reason = captureStopReason();
      capSummary.textContent = 'Capture stopped before the session ended' +
        (reason ? ' (' + reason + ')' : '') + ' (details)';
      var capText = 'The recorder stopped capturing before this session finished, so the replay ' +
        'ends earlier than the participant\'s session did. ';
      if (captureStop) {
        capText += 'It stopped during segment ' +
          (segments[captureStop.seg].index != null ? segments[captureStop.seg].index : captureStop.seg) +
          ' at ' + fmtClock(num(captureStop.ev.t) || 0) + '. ';
      }
      // What the banner may say about the CAUSE, in the order the recording
      // constrains it. Every branch below says only what this file supports:
      // a banner that surfaces truncation with the wrong cause is a worse
      // failure than the interim wording it replaced.
      var limit = captureStopLimit();
      var reasonRaw = captureStop ? captureStop.ev.reason : null;
      if (limit) {
        capText += 'This recording states the cap it crossed: the recorder was configured to stop ' +
          'a segment after ' + limit + '. ';
      } else if (reasonRaw === 'error') {
        // The recording DENIES the buffer cap. Naming "capture error" in the
        // summary and then explaining it as a cap in the body — quoting two
        // numbers with nothing to do with what happened — is the banner
        // contradicting itself inside one <details>.
        capText += 'The recording attributes the stop to a capture error rather than a buffer cap, ' +
          'and says nothing further about it. ';
      } else if (model.foreign) {
        // CAP_DEFAULTS are THIS library's REPLAY_DEFAULTS. Quoting them in the
        // sentence that explains another producer's stop describes a recorder
        // that did not make the file. `model.foreign` keys on producer identity
        // (viewer-model.js) and exists for exactly this.
        capText += 'This file does not state the cap it crossed, and it was not produced by this ' +
          'library, so no configured limit can be quoted for it. ';
      } else {
        capText += 'The usual cause is a buffer cap: the recorder caps each segment at about ' +
          fmtCount(CAP_DEFAULTS.events) + ' events or ' + fmtCount(CAP_DEFAULTS.chars) +
          ' characters (library defaults — both are configurable when the recorder is attached, ' +
          'and this file does not state which cap it crossed). ';
      }
      capText += 'Absence of evidence after this point is not evidence of absence.';
      capDetails.appendChild(capSummary);
      capDetails.appendChild(el('p', null, capText));
      header.appendChild(capDetails);
    }

    // A capture CHANNEL that threw is spec §13's absence-of-evidence case in
    // its sharpest form: the session looks clean in exactly the dimension that
    // stopped being observed. `buildViewerModel` reduces the recorder's
    // `{channel, message, t}` records to channel names, which is what a chip
    // can say; the messages are recorder diagnostics with no analyst-facing
    // reading. (T5.1 M-3: this field had no consumer until here.)
    var captureFailChip = el('span', 'replay-note replay-warn', '');
    captureFailChip.setAttribute('data-ch-capture-failures', '');
    captureFailChip.style.display = 'none';
    var failedChannels = (model.captureFailures || []).filter(function (c) { return !!c; });
    if (failedChannels.length > 0) {
      captureFailChip.textContent = '⚠ ' + failedChannels.length + ' capture channel(s) failed ' +
        'during recording (' + failedChannels.join(', ') + '). Evidence those channels would have ' +
        'carried is missing from this replay.';
      captureFailChip.style.display = '';
    }
    header.appendChild(captureFailChip);
    // Alignment status chips — the "never fail silently" surface.
    var alignChip = el('span', 'replay-note', '');
    alignChip.setAttribute('role', 'status');
    alignChip.setAttribute('data-ch-align', '');
    header.appendChild(alignChip);
    var defectChip = el('span', 'replay-note replay-warn', '');
    defectChip.setAttribute('data-ch-defect', '');
    defectChip.style.display = 'none';
    header.appendChild(defectChip);
    var iframeChip = el('span', 'replay-note replay-warn',
      'This recording contains iframe content that was not captured. Interactions inside it are not visible here.');
    iframeChip.setAttribute('data-ch-iframe-warn', '');
    iframeChip.style.display = 'none';
    header.appendChild(iframeChip);
    var shadowChip = el('span', 'replay-note replay-warn',
      'This recording contains shadow DOM content that was not captured. Those areas replay empty.');
    shadowChip.setAttribute('data-ch-shadow-warn', '');
    shadowChip.style.display = 'none';
    header.appendChild(shadowChip);
    var failChip = el('span', 'replay-note replay-warn', '');
    failChip.setAttribute('data-ch-apply-failures', '');
    failChip.style.display = 'none';
    header.appendChild(failChip);
    // Declared-limitation advisories (loud, not blocking): DPR-conditional
    // styling cannot be reproduced inside an iframe; CSS animations run on
    // viewer time.
    var dprChip = el('span', 'replay-note', '');
    dprChip.setAttribute('data-ch-dpr-note', '');
    dprChip.style.display = 'none';
    header.appendChild(dprChip);
    // Media is rendered as STATE, never played (design §7) — the forensic
    // posture, and the fork's too. Saying so is part of the rendering: a badge
    // reading "paused at 4.0s" over a silent element would otherwise read as a
    // viewer that failed rather than one that declined.
    var mediaChip = el('span', 'replay-note', '');
    mediaChip.setAttribute('data-ch-media-note', '');
    mediaChip.style.display = 'none';
    var hasMedia = segments.some(function (s) {
      return (s.events || []).some(function (e) { return e.type && e.type.indexOf('media.') === 0; }) ||
        !!(s.initialState && (s.initialState.media || []).length > 0);
    });
    if (hasMedia) {
      mediaChip.textContent = 'This recording contains audio/video state. The viewer shows play state and position as badges; it does not play back media.';
      mediaChip.style.display = '';
    }
    header.appendChild(mediaChip);
    // §5.8: a type this viewer does not know is SKIPPED, never guessed at, and
    // never silently. Counted once per type — the walk replays on every
    // restore, so an occurrence count would climb with the analyst's scrubbing
    // rather than describe the file.
    var unknownChip = el('span', 'replay-note', '');
    unknownChip.setAttribute('data-ch-unknown-types', '');
    unknownChip.style.display = 'none';
    header.appendChild(unknownChip);
    var animChip = el('span', 'replay-note', '');
    animChip.setAttribute('data-ch-anim-note', '');
    animChip.style.display = 'none';
    var hasKeyframes = (model.stylesheets || []).some(function (sh) {
      return sh.css && /@keyframes/i.test(sh.css);
    });
    if (hasKeyframes) {
      animChip.textContent = 'This page uses CSS animations. They replay on the viewer’s own clock, so animated positions are approximate.';
      animChip.style.display = '';
    }
    header.appendChild(animChip);

    var allowExternalCss = false;
    var omittedSheets = (model.stylesheets || []).filter(function (sh) { return !sh.css; }).length;
    if (omittedSheets > 0) {
      var cssNote = el('span', 'replay-note',
        omittedSheets + ' external stylesheet(s) were not loaded. Layout may differ. ');
      var cssBtn = el('button', 'replay-css-btn', 'Load external CSS');
      cssBtn.title = 'Fetches the recorded stylesheet URLs from their origins (network requests leave this machine).';
      cssBtn.addEventListener('click', function () {
        allowExternalCss = true;
        cssBtn.remove();
        cssNote.textContent = omittedSheets + ' external stylesheet(s) loaded from their origins.';
        // The CSP string itself changes, so this is the one path that still
        // needs a new document — and the one place `onload` survives.
        if (iframe) writeShell();
      });
      cssNote.appendChild(cssBtn);
      header.appendChild(cssNote);
    }
    mount.appendChild(header);

    // ── Stage ──
    var stage = el('div', 'replay-stage');
    var iframe = null;
    if (model.tier === 'dom') {
      iframe = document.createElement('iframe');
      // allow-same-origin WITHOUT allow-scripts: scripts stay blocked (both by
      // the sandbox and by the srcdoc CSP), but the document keeps a reachable
      // origin so the player can instantiate and patch through contentDocument.
      // sandbox="" would make the origin opaque and freeze every dom-tier
      // replay at its first frame. allow-scripts is rejected outright: with
      // allow-same-origin it lets framed content remove its own sandbox
      // attribute, which is not a sandbox.
      iframe.setAttribute('sandbox', 'allow-same-origin');
      iframe.className = 'replay-frame';
      // Non-interactive: an analyst click inside the reconstruction would act
      // on live untrusted DOM (submit a form, navigate the frame).
      iframe.style.pointerEvents = 'none';
      iframe.setAttribute('tabindex', '-1');
      iframe.style.transformOrigin = '0 0';
      stage.appendChild(iframe);
    } else {
      stage.classList.add('replay-neutral');
      stage.appendChild(el('div', 'replay-neutral-label',
        'Trace-only recording: DOM was not captured at this tier'));
    }

    var overlay = document.createElement('canvas');
    overlay.className = 'replay-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    stage.appendChild(overlay);
    // Keycast: chips for keys currently down or recently released, mirroring
    // the click-ripple/cursor-trail convention (a pure function of playhead).
    // keys:'off' recordings carry no key events, so this stays empty; that
    // absence IS the honest signal, no separate note needed.
    var keycast = el('div', 'replay-keycast');
    keycast.setAttribute('aria-hidden', 'true');
    stage.appendChild(keycast);
    // Media badges: one per element with recorded state, top-left of the stage,
    // the same "pure function of playhead" convention as the keycast chips.
    var mediaLayer = el('div', 'replay-media');
    mediaLayer.setAttribute('aria-hidden', 'true');
    stage.appendChild(mediaLayer);
    mount.appendChild(stage);
    var ctx = overlay.getContext('2d');

    // ── Marker lane + scrub ──
    var lane = document.createElement('canvas');
    lane.className = 'replay-lane';
    lane.height = 18;
    lane.setAttribute('aria-hidden', 'true');
    mount.appendChild(lane);

    var scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.min = '0';
    scrub.step = '10';
    scrub.className = 'replay-scrub';
    scrub.setAttribute('aria-label', 'Playhead position');
    mount.appendChild(scrub);

    var ticker = el('div', 'replay-ticker', '');
    mount.appendChild(ticker);

    // ── The shell, written once ──
    function frameDoc() {
      return iframe && shellReady ? iframe.contentDocument : null;
    }

    // The sentinel carries the GENERATION of the write that produced it, and
    // that is what makes the boot document-scoped rather than merely
    // idempotent. Existence alone is not enough: every shell carries an
    // identical sentinel, so on a SECOND write the immediate probe below finds
    // the PREVIOUS document (browsers navigate `srcdoc` asynchronously, so
    // `contentDocument` still holds the old one) and would boot into a
    // document the browser is about to discard. That blanks the
    // reconstruction, leaves every id in the span map pointing into a detached
    // tree, and leaves `frameReady()` reporting true over an empty frame —
    // measured in chromium, and the reason v1 carried a generation counter at
    // all. The counter left with the per-seek rebuild; the external-CSS
    // rewrite that still needs one stayed.
    function shellPresent() {
      var doc = iframe && iframe.contentDocument;
      try {
        var meta = doc && doc.querySelector('meta[name="' + SHELL_META + '"]');
        return !!meta && meta.getAttribute('content') === String(shellGen);
      } catch (e) { return false; }
    }

    // Browsers navigate the frame asynchronously and fire `load`; happy-dom
    // parses `srcdoc` synchronously and fires `load` afterwards, twice. One
    // idempotent boot covers all of it: try immediately, and again on load.
    // The immediate try is what keeps the node suite synchronous; the `onload`
    // install is what carries every real browser, and only the generation
    // check above keeps the two from disagreeing about which document is live.
    function writeShell() {
      shellReady = false;
      stats.shellWrites++;
      shellGen++;
      iframe.onload = onShellLoad;
      iframe.srcdoc = buildShell(allowExternalCss, shellGen);
      bootShell();
    }

    function onShellLoad() { bootShell(); }

    function bootShell() {
      if (shellReady || !shellPresent()) return;
      shellReady = true;
      restore(segIdx, playhead);
      redraw();
    }

    // ── Stylesheet state (spec §2 / design §5 step 2) ──
    // Stylesheet state at a keyframe is DERIVED, never seeded: the session
    // baseline plus every `stylesheet_events` entry up to the keyframe origin.
    // Rebuilding from the baseline on each restore is what makes a backward
    // seek across a `stylesheet.remove` bring the sheet back; a running
    // mutation would not.
    function sheetNode(doc, sheet) {
      var node;
      if (sheet.css != null) {
        node = doc.createElement('style');
        node.textContent = sheet.css;
      } else if (allowExternalCss && sheet.href && /^https?:/i.test(sheet.href)) {
        node = doc.createElement('link');
        node.setAttribute('rel', 'stylesheet');
        node.setAttribute('href', sheet.href);
      } else {
        return null;   // external sheet, opt-in not taken
      }
      node.setAttribute('data-ch-sheet', String(sheet.id));
      if (sheet.media) node.setAttribute('media', sheet.media);
      return node;
    }

    // Sheets go BEFORE the viewer's own rules so a recording's CSS can never
    // override the gutter fix or the placeholder outline.
    //
    // EVERY SHEET QUERY IN THIS SECTION IS HEAD-SCOPED, and that scoping is
    // load-bearing rather than tidiness. `data-ch-sheet` is a name the viewer
    // stamps and then reads back, which puts it in the same class as the two
    // the §12 predicate protects — but a recording can carry it too, and a
    // document-wide read cannot tell the viewer's sheet from a page element.
    // Measured consequence of the unscoped version: `deriveSheets`'s reset loop
    // DELETED a keyframe element carrying the attribute, on every restore, with
    // both counters at zero, so the reconstruction diverged silently while
    // `resolveNode` still resolved the id. Recorded content only ever mounts
    // into <body> and sheets only ever live in <head>, so scoping the read is
    // what closes it — and unlike widening the attribute ban, it deletes
    // nothing the page really had.
    function insertSheet(doc, sheet) {
      var node = sheetNode(doc, sheet);
      if (!node) return;
      var anchor = doc.head.querySelector('style[data-ch-shell-rules]');
      doc.head.insertBefore(node, anchor || null);
    }

    function applySheetEvent(doc, ev) {
      if (ev.type === 'stylesheet.add') {
        if (ev.sheet && ev.sheet.id != null) {
          removeSheet(doc, ev.sheet.id);
          insertSheet(doc, ev.sheet);
        }
      } else if (ev.type === 'stylesheet.remove') {
        removeSheet(doc, ev.id);
      } else if (ev.type === 'stylesheet.update') {
        var node = doc.head.querySelector('[data-ch-sheet="' + ev.id + '"]');
        if (node && node.tagName.toLowerCase() === 'style') node.textContent = ev.css == null ? '' : ev.css;
        else insertSheet(doc, { id: ev.id, kind: 'inline', css: ev.css, media: null });
      }
    }

    function removeSheet(doc, id) {
      var node = doc.head.querySelector('[data-ch-sheet="' + id + '"]');
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    function deriveSheets(doc, originT) {
      var live = doc.head.querySelectorAll('[data-ch-sheet]');
      for (var i = live.length - 1; i >= 0; i--) {
        if (live[i].parentNode) live[i].parentNode.removeChild(live[i]);
      }
      (model.stylesheets || []).forEach(function (sheet) {
        if (sheet && sheet.id != null) insertSheet(doc, sheet);
      });
      for (var j = 0; j < sheetEvents.length; j++) {
        var ev = sheetEvents[j];
        if ((num(ev.t) || 0) > originT) break;
        applySheetEvent(doc, ev);
      }
    }

    // ── Span geometry ──
    function spanStartOf(i) {
      var s = segments[i].spanStart;
      return s == null ? -1 : s;
    }

    function spanEndOf(start) {
      var i = start + 1;
      while (i < segments.length && !segments[i].keyframe) i++;
      return i - 1;
    }

    // The merged, ordered entry list for one span (design §5 step 4). Session
    // streams are assigned to the segment whose window contains them —
    // segments are ordered and non-overlapping (§3), so `[origin_i,
    // origin_{i+1})` is a partition — and rebased into that segment's frame
    // with the same forward formula the model used for its events.
    function buildWalk(start, end) {
      var spanOrigin = segments[start].origin;
      var out = [];
      for (var i = start; i <= end; i++) {
        var s = segments[i];
        var from = s.origin;
        var to = i + 1 < segments.length ? segments[i + 1].origin : Infinity;
        var rows = [];
        var pushStream = function (list, rank, stream) {
          for (var n = 0; n < list.length; n++) {
            var t = num(list[n].t) || 0;
            // `> spanOrigin` is the derivation boundary: everything at or
            // before the keyframe origin is already folded into the mounted
            // state, so replaying it here would apply it twice.
            if (t <= spanOrigin || t < from || t >= to) continue;
            rows.push({ t: round1(t - from), rank: rank, stream: stream, seg: i, payload: list[n] });
          }
        };
        pushStream(sheetEvents, RANK_SHEET, 'stylesheet');
        pushStream(viewportChanges, RANK_VIEWPORT, 'viewport');
        for (var e = 0; e < s.events.length; e++) {
          rows.push({
            t: num(s.events[e].t) || 0, rank: RANK_EVENT, stream: 'event',
            seg: i, payload: s.events[e]
          });
        }
        rows.sort(function (a, b) { return a.t - b.t || a.rank - b.rank; });
        for (var r = 0; r < rows.length; r++) out.push(rows[r]);
      }
      return out;
    }

    // ── Camera ──
    // v1 folded a per-trial view-state seed plus in-stream `resize` events. v2
    // has neither: the seed is the model's per-segment camera (session
    // `viewport_changes` folded to the segment origin, window scroll from the
    // span keyframe's `initial_state`), and the in-stream updates are session
    // `viewport_changes` inside the walk plus per-event §6 camera blocks.
    function seedCamera(i) {
      var seed = segments[i].camera || {};
      var w = num(seed.w) != null ? seed.w : 1280;
      var h = num(seed.h) != null ? seed.h : 800;
      cam = {
        x: num(seed.scroll_x) || 0, y: num(seed.scroll_y) || 0,
        w: w, h: h,
        cw: num(seed.client_w) != null ? seed.client_w : w,
        ch: num(seed.client_h) != null ? seed.client_h : h
      };
    }

    function foldViewport(c) {
      if (num(c.w) != null) { cam.w = c.w; cam.cw = c.w - (scrollbar.w || 0); }
      if (num(c.h) != null) { cam.h = c.h; cam.ch = c.h - (scrollbar.h || 0); }
      pendingCamSize = true;
    }

    // A §6 camera block on the interaction is AUTHORITATIVE, for the reason v1
    // documented: scroll and resize notifications dispatch after the
    // programmatic change, so the snapshot on the interaction can know state
    // whose notification arrives later in the stream (and then applies as a
    // no-op). `client_w`/`client_h` are level 1 of design §8's client-box
    // chain — the only level that is per-event.
    function foldEventCamera(c) {
      if (num(c.scroll_x) != null && (c.scroll_x !== cam.x || c.scroll_y !== cam.y)) {
        cam.x = c.scroll_x; cam.y = num(c.scroll_y) || 0;
        applyCamScroll();
      }
      if (num(c.viewport_w) != null) cam.w = c.viewport_w;
      if (num(c.viewport_h) != null) cam.h = c.viewport_h;
      if (num(c.client_w) != null && (c.client_w !== cam.cw || c.client_h !== cam.ch)) {
        cam.cw = c.client_w;
        cam.ch = num(c.client_h) != null ? c.client_h : cam.ch;
        pendingCamSize = true;
      }
    }

    // The stage BOX is fixed per segment (sized from the seed camera's aspect)
    // so playback never reflows the report page; camera changes re-letterbox
    // the iframe INSIDE the box.
    function sizeStage() {
      stageW = Math.min(mount.clientWidth || 720, 960);
      var seed = seg().camera || {};
      var scw = num(seed.client_w) || num(seed.w) || 1280;
      var sch = num(seed.client_h) || num(seed.h) || 800;
      stageH = Math.round(sch * (stageW / scw));
      stage.style.width = stageW + 'px';
      stage.style.height = stageH + 'px';
      overlay.width = stageW;
      overlay.height = stageH;
      lane.width = stageW;
      scrub.style.width = stageW + 'px';
    }

    // Applied lazily: before each anchored self-check and once per applied
    // batch, so a viewport-change storm costs a handful of real reflows.
    function flushCamSize() {
      pendingCamSize = false;
      // Scale + letterbox apply to the OVERLAY too — trace-tier replays have
      // no iframe but still project the cursor onto the scaled stage.
      k = Math.min(stageW / cam.cw, stageH / cam.ch);
      ox = Math.round((stageW - cam.cw * k) / 2);
      oy = Math.round((stageH - cam.ch * k) / 2);
      if (!iframe) return;
      var wpx = cam.cw + 'px', hpx = cam.ch + 'px';
      if (iframe.style.width !== wpx) iframe.style.width = wpx;
      if (iframe.style.height !== hpx) iframe.style.height = hpx;
      var tf = 'translate(' + ox + 'px,' + oy + 'px) scale(' + k + ')';
      if (iframe.style.transform !== tf) iframe.style.transform = tf;
    }

    function applyCamScroll() {
      var doc = frameDoc();
      if (!doc) return;
      if (doc.defaultView && typeof doc.defaultView.scrollTo === 'function') {
        try { doc.defaultView.scrollTo(cam.x, cam.y); } catch (e) { /* best-effort */ }
      }
    }

    // ── Placeholders and unrecordable regions (spec §12/§13) ──
    // LATCHED per segment selection: an iframe or shadow host that existed at
    // ANY point keeps its warning even after a removal patch — the invisible
    // interactions do not become visible because the element left.
    //
    // The query is sound because the `data-ch-*` names the viewer stamps are
    // viewer-owned in BOTH directions (dom-instantiate.js): a recording can
    // neither forge one nor strip one. Hiding the shadow chip would be a §13
    // "absence of evidence" signal going dark, which is a worse outcome than
    // any forged outline.
    var segHadIframe = false;
    var segHadShadow = false;
    function updatePlaceholderChips() {
      var doc = frameDoc();
      try {
        if (doc && doc.querySelector('iframe, [data-ch-placeholder="iframe"]')) segHadIframe = true;
        if (doc && doc.querySelector('[data-ch-shadow]')) segHadShadow = true;
      } catch (e) { /* keep latches */ }
      iframeChip.style.display = segHadIframe ? '' : 'none';
      shadowChip.style.display = segHadShadow ? '' : 'none';
    }

    // ── Canvas compositing and presentation (design §3) ──
    //
    // THE MEASURED FACT THIS IS BUILT AROUND (Task 0, tri-engine): a canvas in a
    // frame sandboxed WITHOUT allow-scripts accepts `getContext('2d')`, accepts
    // the draw calls, holds correct pixels — and never paints them. So the
    // composite happens in an offscreen canvas owned by the REPORT document,
    // where painting is unrestricted, and the result is PRESENTED as a
    // background image on the in-frame canvas. Nothing about the recorded tree
    // changes: same tag, same id, same attributes, same CSS match.
    //
    // ROUTE 2 OF DESIGN §3.1, taken deliberately over route 1 (re-present after
    // the clobber). The presentation is a rule in the SHELL HEAD keyed on a
    // viewer-owned attribute, not a declaration in the element's inline style.
    // Per CSSOM `setAttribute('style', …)` replaces the whole inline
    // declaration block, so a recorded `dom.attr` naming `style` — or removing
    // it with `value: null` — erases anything the viewer put there; measured on
    // all three engines, and mandated by the spec rather than produced by it.
    // Presenting through the head makes the hazard structurally absent instead
    // of repaired after the fact, and it covers the removal case for free. It
    // costs one stamped attribute and one <style> per composited canvas; the
    // attribute is viewer-owned in dom-instantiate.js, so a recording can
    // neither forge the selector nor strip it.
    //
    // COST. Compositing is per-event and cheap (`drawImage`); PRESENTATION is a
    // PNG re-encode and is deferred to once per applied batch, per canvas a
    // snapshot actually touched — Task 0 measured that presented SIZE, not
    // snapshot count, is what the cost tracks (ten composites presented cheaper
    // than one 189 KB baseline).
    function resetCanvases(doc) {
      canvasNodes = new Map();
      if (!doc) return;
      // HEAD-scoped, like every other read of a name the viewer stamps: the
      // recording mounts into <body>, and an unscoped query cannot tell the
      // viewer's own element from a page element carrying the same attribute
      // (the failure T5.4's I-1 found for `data-ch-sheet`).
      var live = doc.head.querySelectorAll('[' + CANVAS_RULE_ATTR + ']');
      for (var i = live.length - 1; i >= 0; i--) {
        if (live[i].parentNode) live[i].parentNode.removeChild(live[i]);
      }
    }

    // The bitmap size is §4's `canvas_size` annotation, recorded at
    // instantiation because no live DOM read can recover it (a canvas's
    // `width`/`height` properties are the bitmap size, but only while the
    // element still has them). The element's own properties are the fallback
    // for a producer that omits the annotation.
    function canvasEntry(id, el) {
      var entry = canvasNodes.get(id);
      if (entry) return entry;
      var size = span ? span.canvases.get(id) : null;
      var w = size && num(size.w) ? size.w : (num(el && el.width) || 300);
      var h = size && num(size.h) ? size.h : (num(el && el.height) || 150);
      entry = { off: null, chain: Promise.resolve(), w: w, h: h, dirty: false, sized: false, sizeCss: '' };
      canvasNodes.set(id, entry);
      return entry;
    }

    // Allocated on the first snapshot, not on the first sight of a canvas: a
    // page can hold canvases nobody ever draws into, and each offscreen buffer
    // is w×h×4 bytes in the report page.
    function offscreenFor(entry) {
      if (!entry.off) {
        entry.off = document.createElement('canvas');
        entry.off.width = entry.w;
        entry.off.height = entry.h;
      }
      return entry.off;
    }

    function applyCanvasSnapshot(e) {
      var el = resolveNode(e.node);
      if (!el || String(el.tagName || '').toLowerCase() !== 'canvas'
          || typeof e.data_url !== 'string' || !e.data_url) {
        if (span) span.patchFailures++;
        return;
      }
      var entry = canvasEntry(e.node, el);
      var region = e.region && num(e.region.x) != null && num(e.region.y) != null ? e.region : null;
      // Decoding STARTS now, in parallel; the DRAW is what the per-canvas chain
      // serialises. Region patches therefore composite in EVENT order however
      // their images finish decoding — the fork's bare `img.onload` handlers
      // have no such guarantee and would apply two patches in decode order.
      var img = document.createElement('img');
      img.src = e.data_url;
      var decoded = img.decode
        ? img.decode()
        : new Promise(function (res, rej) { img.onload = res; img.onerror = rej; });
      entry.chain = entry.chain
        .then(function () { return decoded; })
        .then(function () {
          var c2 = offscreenFor(entry).getContext('2d');
          if (!c2) return;   // a realm with no painting at all (the node suite)
          if (region) {
            c2.drawImage(img, region.x, region.y);
          } else {
            // No region = full baseline: clear, then draw at (0,0). A region
            // patch must preserve the surrounding pixels; a baseline must not.
            c2.clearRect(0, 0, entry.off.width, entry.off.height);
            c2.drawImage(img, 0, 0);
          }
        }, function () {
          // A payload that will not decode is a recorded change that cannot be
          // reapplied. Counted, and the chain stays RESOLVED so the snapshots
          // after it still land.
          if (span) span.patchFailures++;
        })
        // …and the same for a throw inside the DRAW, which the handler above
        // cannot see: it is the previous link's rejection handler, not this
        // one's. Both links end resolved or the canvas stops compositing.
        .catch(chainFailed);
      entry.dirty = true;
    }

    // Design §3.3, measured tri-engine by Task 0: a canvas in this sandbox has
    // NO intrinsic size, so one with no CSS size collapses and takes the
    // surrounding layout with it, while `width:50%` measures 150 in a 300px box
    // and `width:50%` with auto height honours the intrinsic ratio. The repair
    // therefore fires only where the box collapsed and can never override
    // responsive CSS — unlike the fork's unconditional pin, which turns a
    // percentage width into a fixed pixel width and then makes CH's own
    // alignment check report a divergence the viewer caused.
    //
    // MEASURED ON THE CONTENT BOX, not on `getBoundingClientRect()`, and that
    // is a correction to §3.3 rather than a detail. `jspsych-full` segment 9's
    // sketchpad canvas carries a 2px border, so the collapse reads as a 4×28
    // BORDER box — non-zero, so a rect-based guard passes it by and the
    // composite is presented into a 4-pixel-wide element. `clientWidth` /
    // `clientHeight` are the padding box, which is both where the collapse
    // lands and what `background-origin: padding-box` sizes the presentation
    // against. Task 0's probe could not see this: its canvases had no border.
    function canvasSizeCss(el, entry) {
      if (entry.sized) return entry.sizeCss;
      var w = el.clientWidth;
      var h = el.clientHeight;
      if (typeof w !== 'number' || typeof h !== 'number') {
        var r = null;
        try { r = el.getBoundingClientRect(); } catch (err) { return ''; }
        if (!r) return '';
        w = r.width; h = r.height;
      }
      entry.sized = true;
      entry.sizeCss = (w === 0 || h === 0)
        ? 'display:inline-block;width:' + entry.w + 'px;height:' + entry.h + 'px;'
        : '';
      return entry.sizeCss;
    }

    function writeCanvasRule(doc, id, entry, css) {
      var style = doc.head.querySelector('[' + CANVAS_RULE_ATTR + '="' + id + '"]');
      if (!css) {
        if (style && style.parentNode) style.parentNode.removeChild(style);
        return;
      }
      if (!style) {
        style = doc.createElement('style');
        style.setAttribute(CANVAS_RULE_ATTR, String(id));
        // Appended AFTER the shell rules, which are themselves after the
        // recording's sheets, so nothing the recording carries outranks it.
        doc.head.appendChild(style);
      }
      style.textContent = '[' + CANVAS_ATTR + '="' + id + '"]{' + css + '}';
    }

    function presentCanvas(doc, id, entry) {
      var el = resolveNode(id);
      if (!el || !el.setAttribute) { dropCanvas(doc, id); return; }
      el.setAttribute(CANVAS_ATTR, String(id));
      var css = canvasSizeCss(el, entry);
      var url = entry.off && entry.off.toDataURL ? String(entry.off.toDataURL('image/png')) : '';
      if (DATA_URL_RE.test(url)) {
        // `!important` on the background only: the composite IS what was on
        // screen, so the recording's own background must not outrank it. The
        // SIZE carries none, because §3.3 leaves page CSS authoritative.
        css += 'background-image:url("' + url + '") !important;' +
          'background-size:100% 100% !important;background-repeat:no-repeat !important';
      }
      writeCanvasRule(doc, id, entry, css);
    }

    function dropCanvas(doc, id) {
      canvasNodes.delete(id);
      var style = doc && doc.head.querySelector('[' + CANVAS_RULE_ATTR + '="' + id + '"]');
      if (style && style.parentNode) style.parentNode.removeChild(style);
    }

    // The once-per-applied-batch boundary (design §3.1). Only canvases a
    // snapshot touched in THIS batch are re-encoded; the rest keep the rule
    // they already have, which is the cheap follow-on Task 0's measurement
    // pointed at.
    function presentCanvases() {
      var doc = frameDoc();
      if (!doc) return;
      // §3.3's repair is owed to every canvas in the span, not only to the ones
      // that were drawn into: a collapsed canvas nobody snapshots still takes
      // the layout around it down. Measured once per canvas per mount.
      if (span) {
        span.canvases.forEach(function (size, id) {
          var el = resolveNode(id);
          if (!el || !el.getBoundingClientRect) return;
          var entry = canvasEntry(id, el);
          if (entry.sized || entry.dirty) return;   // a dirty one presents below
          if (canvasSizeCss(el, entry)) {
            el.setAttribute(CANVAS_ATTR, String(id));
            writeCanvasRule(doc, id, entry, entry.sizeCss);
          }
        });
      }
      var ids = [];
      var gone = [];
      canvasNodes.forEach(function (entry, id) {
        // A canvas the span no longer holds (`dom.remove` purged it, id map and
        // all) must lose its rule with it, or the head keeps presenting pixels
        // for a node nothing can resolve — and a later `dom.add` re-binding the
        // id would inherit them.
        if (!resolveNode(id)) gone.push(id);
        else if (entry.dirty) ids.push(id);
      });
      for (var g = 0; g < gone.length; g++) dropCanvas(doc, gone[g]);
      for (var i = 0; i < ids.length; i++) {
        var entry = canvasNodes.get(ids[i]);
        entry.dirty = false;
        // A rejected chain is PERMANENT: one throw here (a torn-down head, a
        // `setAttribute` on a node that just left the document) would silently
        // skip every later composite for this canvas AND reject
        // `canvasSettled()` — the one call Task 7's executor is told to await.
        // The composite link had a rejection handler and this one did not; note
        // that a trailing `catch` is what actually closes it, since a `then`'s
        // second argument sees the PREVIOUS link's rejection and not a throw
        // inside its own callback. No reachable throw is known.
        entry.chain = entry.chain.then(present(doc, ids[i], entry)).catch(chainFailed);
      }
    }

    // Absorbs anything either link throws, counts it where the analyst can see
    // it, and leaves the chain RESOLVED so the snapshots after it still land.
    function chainFailed() {
      if (span) span.patchFailures++;
    }

    // A named factory rather than a closure inside the loop: `var` has no block
    // scope, and capturing the loop variable directly is the classic way to
    // present every canvas as the last one.
    function present(doc, id, entry) {
      return function () { presentCanvas(doc, id, entry); };
    }

    // What a caller awaits when it must observe a SETTLED canvas — the
    // checkpoint executor (Task 7) and the visual batteries. Everything else
    // about a restore is synchronous; this is the one part that is not, because
    // image decoding is.
    function canvasSettled() {
      presentCanvases();
      var chains = [];
      canvasNodes.forEach(function (entry) { chains.push(entry.chain); });
      return Promise.all(chains).then(function () { return true; });
    }

    // ── Media: state, never playback (design §7) ──
    // The forensic posture, and the fork's. `media_src` is honoured at
    // instantiation so the element has its shape, `autoplay` is stripped there,
    // and nothing here ever calls play() or writes currentTime: a replay that
    // started making noise on the analyst's machine would be a different
    // product, and a seeked <video> would claim frame-accuracy the format does
    // not carry.
    function applyMedia(e) {
      var target = resolveNode(e.node);
      if (!target) { if (span) span.patchFailures++; return; }
      var st = mediaState.get(e.node) ||
        { tag: String(target.tagName || 'media').toLowerCase(), state: 'paused', time: 0 };
      if (e.type === 'media.play') st.state = 'playing';
      else if (e.type === 'media.pause') st.state = 'paused';
      else if (e.type === 'media.ended') st.state = 'ended';
      if (num(e.current_time) != null) st.time = e.current_time;
      mediaState.set(e.node, st);
    }

    function drawMediaBadges() {
      mediaLayer.textContent = '';
      mediaState.forEach(function (st) {
        var glyph = st.state === 'playing' ? '▶' : (st.state === 'ended' ? '■' : '❚❚');
        mediaLayer.appendChild(el('span', 'replay-media-badge',
          glyph + ' ' + st.tag + ' ' + st.state + ' ' + (Math.round(st.time * 100) / 100) + 's'));
      });
    }

    // ── §5.8: unknown types ──
    // SCANNED ONCE AT INIT, for the same reason `findCaptureStop` is: the chip
    // says "in this recording", which is a claim about the FILE, and a claim
    // about the file cannot be assembled from wherever the playhead has been.
    // Computed during the walk it stayed empty until the analyst happened to
    // scrub into the segment carrying the unknown type — the "never fail
    // silently" rule failing silently.
    //
    // The scan also makes the OCCURRENCE count restore-stable for free: it
    // counts what the file holds, not how many times the walk replayed it,
    // which is what made a per-occurrence count untenable when this was lazy.
    function noteUnknownType(type, count) {
      if (unknownTypes.has(type)) return;
      unknownTypes.set(type, count || 1);
      if (typeof console !== 'undefined' && console && console.warn) {
        console.warn('[cyborg-hunter-replay] event type "' + type +
          '" is not in this viewer\'s vocabulary; skipping it (spec §5.8)');
      }
      var names = [];
      var events = 0;
      unknownTypes.forEach(function (n, k) { names.push(k); events += n; });
      unknownChip.textContent = names.length + ' event type(s) in this recording are not ' +
        'recognised by this viewer and were skipped, ' + events + ' event(s) in total: ' +
        names.join(', ') + '.';
      unknownChip.style.display = '';
    }

    function scanUnknownTypes() {
      var counts = new Map();
      for (var si = 0; si < segments.length; si++) {
        var evs = segments[si].events || [];
        for (var ei = 0; ei < evs.length; ei++) {
          var t = evs[ei] && evs[ei].type;
          if (typeof t !== 'string' || KNOWN_TYPES[t] === true) continue;
          counts.set(t, (counts.get(t) || 0) + 1);
        }
      }
      // Sorted so the chip reads the same way twice over one file.
      var types = [];
      counts.forEach(function (_n, k) { types.push(k); });
      types.sort();
      for (var i = 0; i < types.length; i++) noteUnknownType(types[i], counts.get(types[i]));
    }
    scanUnknownTypes();

    // ── Event application ──
    function resolveNode(id) {
      return span && num(id) != null ? span.idMap.get(id) : undefined;
    }

    // Form state lives in element PROPERTIES, which no DOM snapshot carries, so
    // without this every replayed form would look untouched. The seed and the
    // recorded stream reach it through THIS function — design §6's whole point.
    function applyInput(e) {
      var target = resolveNode(e.node);
      if (!target) { if (span) span.patchFailures++; return; }
      if (e.type === 'input.checked') {
        target.checked = !!e.checked;
        return;
      }
      if (e.type === 'input.select') {
        var values = e.values || [];
        var opts = target.options || [];
        for (var i = 0; i < opts.length; i++) {
          opts[i].selected = values.indexOf(opts[i].value) !== -1;
        }
        return;
      }
      if (e.redacted) {
        // The identity is withheld by design (spec §8); the LENGTH is not, and
        // showing it as bullets is the honest reconstruction.
        target.value = new Array((num(e.value_len) || 0) + 1).join('•');
      } else if (e.value != null) {
        target.value = e.value;
      }
    }

    function applyElementScroll(e) {
      if (e.redacted) return;   // unresolvable BY DESIGN
      var target = resolveNode(e.node);
      if (!target) { if (span) span.patchFailures++; return; }
      try { target.scrollTop = num(e.y) || 0; target.scrollLeft = num(e.x) || 0; }
      catch (err) { if (span) span.patchFailures++; }
    }

    // One dispatch for recorded events AND for the synthetic t=0 events that
    // seed `initial_state` (design §6). It implements spec §5 IN FULL rather
    // than CH's capture subset (design §7): the conformance moment is this
    // viewer playing a foreign conforming file, and a viewer that renders only
    // what CH captures cannot play one.
    //
    // Types with no state to apply — `mouse.*`/`touch.*`/`key.*`,
    // `clipboard.*`, `focus`/`blur`, `visibility.*`, `fullscreen.*` — are
    // rendered by the overlay, the keycast, the lane and the ticker, which read
    // the event stream directly. They are listed in KNOWN_TYPES so §5.8's
    // counter can tell "handled elsewhere" from "not understood".
    function applyEvent(e) {
      if (!e || typeof e.type !== 'string') return;
      if (e.camera) foldEventCamera(e.camera);
      // `applyPatch` returns false for anything that is not one of §5.1's four
      // verbs, so the vocabulary dispatch below needs no list of its own.
      if (span && applyPatch(e, span)) return;
      var type = e.type;
      if (type === 'input.value' || type === 'input.checked' || type === 'input.select') {
        if (span) applyInput(e);
        // Spec §5.2 puts these three in the same non-move input union as
        // mouse/key/touch, so a producer MAY carry §6 blocks on them. CH's own
        // `withAlignment` does not (capture-trace.js:505-551 covers
        // mouse.down/up/click, non-repeat key.down and touch.start/end), but
        // the conformance moment is this viewer playing a FOREIGN file
        // (design §7): geometry the viewer receives and ignores is geometry it
        // declined to check while the chip says "verified". (T5.6 fix)
        //
        // Offered only when the blocks are THERE, unlike the discrete branch
        // below. A redacted `input.value` carries `{node, redacted, value_len}`
        // and no alignment fields (§5.2): that is a VALUE withholding, and
        // bucketing it as `redacted` would count it in a chip about geometry
        // — `key.*`'s redacted variant is the one that withholds a target.
        if (e.camera || e.anchor) offerToCheck(e);
      } else if (type === 'scroll.window') {
        cam.x = num(e.x) || 0; cam.y = num(e.y) || 0;
        applyCamScroll();
      } else if (type === 'scroll.element') {
        if (span) applyElementScroll(e);
      } else if (type === 'canvas.snapshot') {
        if (span) applyCanvasSnapshot(e);
      } else if (type.indexOf('media.') === 0 && KNOWN_TYPES[type] === true) {
        if (span) applyMedia(e);
      } else if (KNOWN_TYPES[type] !== true) {
        noteUnknownType(type);
      } else if (DISCRETE_TYPES[type] === true) {
        offerToCheck(e);
      }
    }

    // Every non-move input event is OFFERED to the check; the §6 MAY-omit rule
    // is decided inside `evaluateCheck`, in one place, because "no camera block
    // means no check" is a statement about the check and not about the
    // dispatch. The camera size is flushed first: the check reads the frame's
    // layout box, and a pending resize would have it measure the previous one.
    function offerToCheck(e) {
      if (e.__chk != null) return;
      if (pendingCamSize) { flushCamSize(); applyCamScroll(); }
      evaluateCheck(e);
    }

    function applyEntry(w) {
      if (w.stream === 'stylesheet') {
        var doc = frameDoc();
        if (doc) applySheetEvent(doc, w.payload);
      } else if (w.stream === 'viewport') {
        foldViewport(w.payload);
      } else {
        applyEvent(w.payload);
      }
    }

    // ── initial_state seeding (design §6) ──
    // Synthetic events at t=0 through the same handlers, so "scrub to 0
    // restores the seed" and "play from 0 reaches the seed" cannot drift.
    // Direct-DOM writes were rejected: they would need their own redaction
    // handling, their own <select multiple> handling and their own element
    // dispatch — a second implementation of the input cases.
    function seedInitialState(start) {
      var st = start >= 0 ? segments[start].initialState : null;
      // With NO initial_state, window scroll still resets to (0,0): the frame
      // survives segment changes, so a segment that scrolled would otherwise
      // leak its offset into the next one. Element scroll and form state need
      // no reset — their nodes were just rebuilt.
      var scroll = st && st.scroll ? st.scroll : { x: 0, y: 0 };
      applyEvent({ type: 'scroll.window', t: 0, x: num(scroll.x) || 0, y: num(scroll.y) || 0 });
      if (!st) return;
      (st.element_scroll || []).forEach(function (s) {
        applyEvent({ type: 'scroll.element', t: 0, node: s.node, x: s.x, y: s.y });
      });
      (st.form || []).forEach(function (f) {
        if (f.value !== undefined) applyEvent({ type: 'input.value', t: 0, node: f.node, value: f.value });
        else if (f.checked !== undefined) applyEvent({ type: 'input.checked', t: 0, node: f.node, checked: f.checked });
        else if (f.selected !== undefined) applyEvent({ type: 'input.select', t: 0, node: f.node, values: f.selected });
      });
      // Media is rendered as badges and lane markers, never played (design §7),
      // so the seed's playback positions ride the same synthetic-event path as
      // the recorded ones and reach the same badge.
      (st.media || []).forEach(function (m) {
        applyEvent({ type: 'media.time', t: 0, node: m.node, current_time: m.current_time });
      });
    }

    // ── Restore (design §5) ──
    function restore(targetSeg, targetT) {
      var doc = frameDoc();
      segIdx = targetSeg;
      var s = segments[targetSeg];

      // A continuation with `dom.*` events and no keyframe before it is a §3
      // violation. The model marks it; the viewer refuses to play it with a
      // visible reason rather than mounting an empty body and letting the
      // analyst read absence as evidence.
      if (s.defect) {
        defectChip.textContent = 'Segment ' + s.index + ' cannot be reconstructed: ' +
          'it records DOM changes but no keyframe precedes it (' + s.defect + ').';
        defectChip.style.display = '';
        span = null; walk = []; appliedIdx = 0; spanStart = -1; spanEnd = -1;
        resetCanvases(doc);
        mediaState = new Map();
        if (doc) { mountTree(null, doc.body, doc); stats.mounts++; }
        seedCamera(targetSeg);
        pendingCamSize = true;
        flushCamSize();
        // The previous segment's placeholder chips must not survive into a
        // segment that shows nothing: the latches were cleared by loadSegment,
        // and this is what puts the chips back in step with them.
        updatePlaceholderChips();
        return;
      }
      defectChip.style.display = 'none';

      var start = spanStartOf(targetSeg);
      // Trace-only recordings have no span at all: each segment is walked on
      // its own so the camera fold still runs (design §10 keeps that path).
      spanStart = start;
      spanEnd = start >= 0 ? spanEndOf(start) : targetSeg;
      var walkStart = start >= 0 ? start : targetSeg;
      var walkEnd = start >= 0 ? spanEnd : targetSeg;

      // The check memo belongs to the SPAN, not to the current segment.
      // `evaluateCheck` caches on the event object and the walk replays every
      // segment from the keyframe forward, so clearing only the selected
      // segment (which is where `loadSegment` used to do it) left the earlier
      // segments of the same span holding checks computed against a stage
      // transform and a reconstruction this restore is about to replace. The
      // clear goes where the state it describes is rebuilt.
      for (var c = walkStart; c <= walkEnd; c++) {
        var evs = segments[c].events;
        for (var d = 0; d < evs.length; d++) if (evs[d].__chk) delete evs[d].__chk;
      }

      // 1. mount the span keyframe, fresh id map
      if (doc) {
        span = mountTree(start >= 0 ? segments[start].initialDom : null, doc.body, doc);
        stats.mounts++;
      } else {
        span = null;
      }
      // Canvas composites and media state are span state, and both are
      // functions of the playhead: the walk below re-composites every snapshot
      // it passes, so carrying either across a restore would show the analyst
      // pixels from a position they have left. (Design §5 lists caching them
      // as optimisation (a), NOT taken up front.) The rule elements go with
      // them, or the shell head accumulates one per restore.
      resetCanvases(doc);
      mediaState = new Map();
      // 2. derive stylesheet state at the keyframe origin
      if (doc) deriveSheets(doc, segments[walkStart].origin);
      // camera seed comes from the span keyframe: that is the state a restore
      // actually opens with.
      seedCamera(walkStart);
      pendingCamSize = true;
      flushCamSize();
      // 3. seed initial_state — AFTER the mount (a form write on a node the
      //    tree has not created yet is a silent no-op) and BEFORE the events.
      seedInitialState(start);
      // 4. walk the span, merged with the session streams at §7 precedence
      walk = buildWalk(walkStart, walkEnd);
      appliedIdx = 0;
      applyUpTo(targetSeg, targetT);
    }

    function applyUpTo(targetSeg, targetT) {
      for (; appliedIdx < walk.length; appliedIdx++) {
        var w = walk[appliedIdx];
        if (w.seg > targetSeg || (w.seg === targetSeg && w.t > targetT)) break;
        applyEntry(w);
      }
      if (pendingCamSize) { flushCamSize(); applyCamScroll(); }
      // The batch boundary design §3.1 defers presentation to — AFTER the
      // camera flush, because the repair measures a used size and the iframe
      // was just resized. One PNG re-encode per canvas a snapshot touched,
      // rather than one per snapshot.
      presentCanvases();
      updatePlaceholderChips();
    }

    // ── Alignment self-check (per anchored event) ──
    // Compares INDEPENDENT coordinate systems:
    //   camera assertions  — applied scroll/layout width vs §6 camera (±1px)
    //   rect               — recorded anchor.rect vs replayed rect (±3px/edge)
    //   containment        — event client point inside the replayed rect (2px)
    //   hit-test           — elementFromPoint resolves the anchor family
    //   stage transform    — the iframe's REAL on-page offset vs the computed
    //                        letterbox (±2px); this one tests the viewer
    // Any failed predicate ⇒ 'uncertain' with reasons, surfaced by chips, lane
    // and the cursor glyph. Any predicate that could not RUN — the recording
    // did not state the field, the event has no point, the box could not be
    // measured — is named in `skipped` (see ALL_PREDICATES) and surfaced in
    // `getChecks()` alone: a skip is not a failure, but a check with one is not
    // a full verification either, and both of those have to stay sayable.
    //
    // Anchor resolution changed completely: `anchor.node` is an integer id
    // resolved through the span id map. No markers, no child-index path, no
    // getElementById guess. Alignment blocks are OPTIONAL (§6 cost rule), and
    // absence is NOT failure — no camera block means no check.
    //
    // THE SEMANTICS ARE PINNED IN `tests/replay/alignment-viewer-model.test.js`
    // (T5.6): each predicate — and each conjunct inside it — failing on its own
    // injected corruption and passing otherwise, the three §7 anchor outcomes,
    // both redaction buckets, and the §6 MAY-omit rule. That file models layout
    // over the frame realm to do it; REAL geometry (fonts, reflow, zoom, pinch,
    // transforms) is the Playwright battery's, and neither substitutes for the
    // other.
    function evaluateCheck(e) {
      var doc = frameDoc();
      if (!doc || !span) return;
      // §8's redacted bucket narrows to events carrying `redacted: true` at the
      // EVENT level — a redacted key.* has no other fields at all (§5.2), so
      // there is nothing to verify and nothing to report as misaligned. A
      // redacted ANCHOR is a different thing and is CHECKED: §8 omits
      // `anchor.id` but keeps `anchor.node` and `anchor.rect`, which is
      // strictly more than v1 could verify.
      if (e.redacted) {
        e.__chk = { status: 'redacted', reasons: ['redacted event'], skipped: ALL_PREDICATES.slice() };
        return;
      }
      var camera = e.camera;
      var anchor = e.anchor;
      // §6 alignment fields are OPTIONAL and MAY be omitted on key.up and on
      // repeats. Absence is not failure: no blocks means NO CHECK, not an
      // uncertain one. v1 conflated the two, which is how key.up omissions
      // read as misalignment.
      if (!camera && !anchor) return;
      var reasons = [];
      var skipped = [];

      // Check 1a's comparand is the RECORDING's scroll, not `cam` — the fold is
      // the viewer's own reading of it, so comparing the applied scroll against
      // `cam.x/cam.y` compares a value against itself whenever the fold did not
      // run. It does not always run: `foldEventCamera` requires a non-null
      // `scroll_x` before it touches anything, so a block stating only
      // `scroll_y` was folded nowhere, applied nowhere, and read `ok` over a
      // frame 300px from where the recording put the page. Design §8 says
      // "applied scrollX/scrollY vs camera.scroll_x/scroll_y"; this is that.
      // An axis the recording does not state falls back to the fold rather than
      // to 0, which would invent a divergence out of an absent field. (T5.6 fix)
      var view = doc.defaultView;
      var recX = camera && num(camera.scroll_x) != null ? camera.scroll_x : null;
      var recY = camera && num(camera.scroll_y) != null ? camera.scroll_y : null;
      if (view && (recX != null || recY != null)) {
        var wantX = recX != null ? recX : cam.x;
        var wantY = recY != null ? recY : cam.y;
        if (Math.abs((view.scrollX || 0) - wantX) > TOL_CAMERA ||
            Math.abs((view.scrollY || 0) - wantY) > TOL_CAMERA) {
          reasons.push('applied scroll diverges (' +
            (view.scrollX || 0) + ',' + (view.scrollY || 0) + ' vs ' + wantX + ',' + wantY + ')');
        }
      } else {
        skipped.push('camera.scroll');
      }
      var de = doc.documentElement;
      if (de && camera && num(camera.client_w) != null) {
        if (Math.abs(de.clientWidth - camera.client_w) > TOL_CAMERA) {
          reasons.push('frame layout width ' + de.clientWidth + ' vs camera ' + camera.client_w);
        }
      } else {
        skipped.push('camera.client_w');
      }

      // §7: null means "no applicable target node" — not a failure, and
      // distinguishable from an id the span could not hold. It suppresses the
      // three ANCHOR predicates and NOTHING ELSE: returning here bucketed the
      // whole event as "no anchor" and carried any camera reason into a bucket
      // the chip counts as clean, while skipping the stage check entirely. A
      // divergence the viewer can still see is still a divergence, and
      // `node: null` is the shape every interaction outside the observed root
      // carries, so the hole was not a corner. (T5.6)
      var noAnchor = !!(anchor && anchor.node == null);
      var target = anchor && !noAnchor ? resolveNode(anchor.node) : null;
      if (target) {
        if (target.hasAttribute && target.hasAttribute('data-ch-shadow')) {
          // The interaction retargeted to a shadow host whose content was not
          // captured — geometry would "verify" against a hollow box. Refuse.
          reasons.push('shadow content not captured');
        }
        var rr = null;
        try { rr = target.getBoundingClientRect(); } catch (err) { /* leave null */ }
        var rect = anchor.rect;
        // All FOUR edges or none: three of the deltas are NaN for a partial
        // rect and `NaN > TOL` is false, so a half-stated rect used to run a
        // comparison that could decide nothing and still counted as verified.
        var full = !!(rect && num(rect.x) != null && num(rect.y) != null &&
          num(rect.w) != null && num(rect.h) != null);
        if (rr && full) {
          var dL = Math.abs(rr.left - rect.x);
          var dT = Math.abs(rr.top - rect.y);
          var dR = Math.abs((rr.left + rr.width) - (rect.x + rect.w));
          var dB = Math.abs((rr.top + rr.height) - (rect.y + rect.h));
          if (dL > TOL_RECT || dT > TOL_RECT || dR > TOL_RECT || dB > TOL_RECT) {
            reasons.push('target rect moved (Δ ' + Math.round(Math.max(dL, dT, dR, dB)) + 'px)');
          }
        } else {
          skipped.push('rect');
        }
        var px = eventX(e), py = eventY(e);
        var havePoint = px != null && py != null;
        if (rr && havePoint) {
          if (!(px >= rr.left - TOL_CONTAIN && px <= rr.left + rr.width + TOL_CONTAIN &&
                py >= rr.top - TOL_CONTAIN && py <= rr.top + rr.height + TOL_CONTAIN)) {
            reasons.push('cursor outside target');
          }
        } else {
          skipped.push('containment');
        }
        var under;
        if (doc.elementFromPoint && havePoint) {
          try { under = doc.elementFromPoint(px, py); } catch (err) { under = undefined; }
        }
        // A point that resolves to NOTHING (outside the frame's own viewport)
        // is not evidence either way, so it is a skip rather than silence.
        if (under == null) {
          skipped.push('hit-test');
        } else if (under !== target &&
            !(target.contains && target.contains(under)) &&
            !(under.contains && under.contains(target))) {
          reasons.push('hit-test resolves ' +
            (under.id ? under.tagName.toLowerCase() + '#' + under.id : under.tagName.toLowerCase()));
        }
      } else {
        if (anchor && !noAnchor) {
          reasons.push('anchor node ' + anchor.node + ' not held by this span (' +
            (anchor.tag || '?') + (anchor.id ? '#' + anchor.id : '') + ')');
        }
        skipped.push('rect', 'containment', 'hit-test');
      }

      try {
        var ir = iframe.getBoundingClientRect();
        var sr = stage.getBoundingClientRect();
        if (Math.abs(ir.left - sr.left - ox) > TOL_STAGE ||
            Math.abs(ir.top - sr.top - oy) > TOL_STAGE) {
          reasons.push('stage transform drift');
        }
      } catch (err) {
        skipped.push('stage');   // measuring failed — not evidence of misalignment
      }

      e.__chk = reasons.length > 0
        ? { status: 'uncertain', reasons: reasons, skipped: skipped }
        : { status: noAnchor ? 'no-anchor' : 'ok', reasons: [], skipped: skipped };
    }

    // Client coordinates are normative in v2 (§7), so there is no re-projection
    // step: an event's x/y IS the client point. Touch events carry the point
    // inside `touches[]`.
    function eventX(e) {
      if (num(e.x) != null) return e.x;
      var t = e.touches && e.touches[0];
      return t && num(t.x) != null ? t.x : null;
    }
    function eventY(e) {
      if (num(e.y) != null) return e.y;
      var t = e.touches && e.touches[0];
      return t && num(t.y) != null ? t.y : null;
    }

    // ── Seeking ──
    function seek(T, fromScrub) {
      var target = Math.max(0, Math.min(T, seg().durMs));
      var wasBehind = target < playhead;
      playhead = target;
      if (!fromScrub) scrub.value = String(playhead);
      if (!shellReady && iframe) { redraw(); return; }
      if (wasBehind) {
        // Backward: patches are state transitions, not reversible snapshots.
        // The restore is synchronous now, so this no longer round-trips
        // through srcdoc + onload the way v1's rebuildFrame did.
        restore(segIdx, playhead);
      } else {
        applyUpTo(segIdx, playhead);
      }
      redraw();
    }

    // The scrub's own path: at most one restore per animation frame, targeting
    // the LATEST requested time (design §5 — a drag across a deep span would
    // otherwise queue one span replay per input event).
    function requestSeek(T) {
      pendingSeek = T;
      if (frameQueued) return;
      frameQueued = true;
      requestAnimationFrame(function () {
        frameQueued = false;
        var t = pendingSeek;
        pendingSeek = null;
        if (t != null) seek(t, true);
      });
    }

    function redraw() {
      drawOverlay();
      drawKeycast();
      drawMediaBadges();
      drawLane();
      drawTicker();
      updateStatusChips();
      clock.textContent = fmtClock(playhead) + ' / ' + fmtClock(seg().durMs);
      scrub.setAttribute('aria-valuetext',
        fmtClock(playhead) + ' of ' + fmtClock(seg().durMs));
    }

    // ── Overlay drawing ──
    // Everything draws in CLIENT space then letterboxes onto the stage:
    // stagePt = (ox + clientX·k, oy + clientY·k). Trail segments break at
    // camera discontinuities (a viewport change inside this segment) and at
    // uncertain interactions — a confident-looking trail must never bridge a
    // state change it cannot vouch for.
    function projectEvent(e) {
      var cx = eventX(e), cy = eventY(e);
      if (cx == null) return null;
      return { x: ox + cx * k, y: oy + cy * k };
    }

    // Viewport-change times inside the current segment, in segment-relative ms
    // — the camera discontinuities the trail must not cross.
    function segmentCameraBreaks() {
      var s = seg();
      var to = segIdx + 1 < segments.length ? segments[segIdx + 1].origin : Infinity;
      var out = [];
      for (var i = 0; i < viewportChanges.length; i++) {
        var t = num(viewportChanges[i].t) || 0;
        if (t < s.origin) continue;
        if (t >= to) break;
        out.push(round1(t - s.origin));
      }
      return out;
    }

    function drawOverlay() {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      var events = seg().events;
      var breaks = segmentCameraBreaks();
      var breakIdx = 0;
      var segs = [[]];           // trail polyline segments
      var lastPos = null;
      var lastPosUncertain = false;
      var ripples = [];
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.t > playhead) break;
        while (breakIdx < breaks.length && breaks[breakIdx] <= e.t) {
          segs.push([]); breakIdx++;
        }
        if (e.type === 'mouse.move' || e.type === 'touch.move') {
          var p = projectEvent(e);
          if (!p) continue;
          p.t = e.t;
          if (e.t >= playhead - 2500) segs[segs.length - 1].push(p);
          lastPos = p;
        } else if (e.type === 'mouse.click' || e.type === 'mouse.down' || e.type === 'touch.start') {
          var q = projectEvent(e);
          if (!q) continue;
          q.t = e.t;
          lastPos = q;
          lastPosUncertain = !!(e.__chk && e.__chk.status === 'uncertain');
          if (lastPosUncertain) segs.push([]);   // sever the trail
          if (e.t >= playhead - 600) ripples.push(q);
        }
      }
      // Cursor trail: fading polyline per segment
      segs.forEach(function (line) {
        for (var s = 1; s < line.length; s++) {
          var age = (playhead - line[s].t) / 2500;
          ctx.strokeStyle = 'rgba(211,47,47,' + (0.85 * (1 - age)).toFixed(3) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(line[s - 1].x, line[s - 1].y);
          ctx.lineTo(line[s].x, line[s].y);
          ctx.stroke();
        }
      });
      // Click ripples: expanding rings over 600ms
      ripples.forEach(function (r) {
        var frac = (playhead - r.t) / 600;
        ctx.strokeStyle = 'rgba(25,118,210,' + (1 - frac).toFixed(3) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 4 + frac * 22, 0, Math.PI * 2);
        ctx.stroke();
      });
      // Cursor: confident filled dot, or the uncertain glyph (dashed amber
      // ring + hollow center) when the latest interaction failed its check.
      if (lastPos) {
        if (lastPosUncertain) {
          ctx.strokeStyle = UNCERTAIN_COLOR;
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.arc(lastPos.x, lastPos.y, 7, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = UNCERTAIN_COLOR;
          ctx.beginPath();
          ctx.arc(lastPos.x, lastPos.y, 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#d32f2f';
          ctx.beginPath();
          ctx.arc(lastPos.x, lastPos.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // ── Keycast (bottom-of-stage chips) ──
    // Pairs key.down with its key.up to get each key's [down, up] window, then
    // returns the ones "live" at T: down and not yet released, or released
    // within KEYCAST_FADE_MS. Non-redacted pairs match by `code` (handles
    // overlapping holds, e.g. Shift+A); the redacted variant carries NO other
    // fields (§5.2), so those match FIFO against each other — an approximation
    // that assumes redacted keystrokes do not overlap, true for the
    // single-field-typing case this exists to cover.
    function computeKeycastChips(T) {
      var events = seg().events;
      var openByCode = new Map();
      var redactedQueue = [];
      var tokens = [];
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.t > T) break;
        if (e.type !== 'key.down' && e.type !== 'key.up') continue;
        if (e.redacted) {
          if (e.type === 'key.down') {
            var rtok = { redacted: true, downT: e.t, upT: null };
            redactedQueue.push(rtok);
            tokens.push(rtok);
          } else {
            var rt = redactedQueue.shift();
            if (rt) rt.upT = e.t;
          }
          continue;
        }
        if (e.type === 'key.down') {
          // Auto-repeat sends key.down without an intervening key.up; keep the
          // original token open rather than starting a new one.
          if (!openByCode.has(e.code)) {
            var tok = { key: e.key, downT: e.t, upT: null };
            openByCode.set(e.code, tok);
            tokens.push(tok);
          }
        } else {
          var open = openByCode.get(e.code);
          if (open) { open.upT = e.t; openByCode.delete(e.code); }
        }
      }
      return tokens.filter(function (tok) {
        return tok.upT == null || T <= tok.upT + KEYCAST_FADE_MS;
      });
    }

    function drawKeycast() {
      var chips = computeKeycastChips(playhead);
      keycast.textContent = '';
      chips.forEach(function (tok) {
        var chip = el('span', 'replay-key-chip' + (tok.redacted ? ' replay-key-chip--redacted' : ''),
          tok.redacted ? '•' : formatKeyLabel(tok.key));
        if (tok.upT != null && playhead > tok.upT) {
          var frac = Math.min(1, (playhead - tok.upT) / KEYCAST_FADE_MS);
          chip.style.opacity = String(1 - frac);
        }
        keycast.appendChild(chip);
      });
    }

    // ── Marker lane (per segment; redrawn per seek so check marks appear) ──
    function drawLane() {
      var lctx = lane.getContext('2d');
      lctx.clearRect(0, 0, lane.width, lane.height);
      lctx.fillStyle = '#f1efe9';
      lctx.fillRect(0, 0, lane.width, lane.height);
      var s = seg();
      var dur = Math.max(s.durMs, 1);
      var events = s.events;
      // Away-bands first (blur→focus, hidden→visible), then point markers.
      var awayStart = null;
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.type === 'blur' || e.type === 'visibility.hidden') {
          if (awayStart === null) awayStart = e.t;
        } else if (e.type === 'focus' || e.type === 'visibility.visible') {
          if (awayStart !== null) {
            lctx.fillStyle = 'rgba(245,124,0,0.45)';
            lctx.fillRect(awayStart / dur * lane.width, 0,
              Math.max(2, (e.t - awayStart) / dur * lane.width), lane.height);
            awayStart = null;
          }
        }
      }
      if (awayStart !== null) {   // still away at segment end
        lctx.fillStyle = 'rgba(245,124,0,0.45)';
        lctx.fillRect(awayStart / dur * lane.width, 0,
          lane.width - awayStart / dur * lane.width, lane.height);
      }
      events.forEach(function (e) {
        var color = MARKER_COLORS[e.type];
        // Alignment-check marks: uncertain interactions paint amber so the
        // analyst can SCRUB TO the exact failing moment.
        if (e.__chk && e.__chk.status === 'uncertain') color = UNCERTAIN_COLOR;
        if (!color) return;
        lctx.fillStyle = color;
        lctx.fillRect(e.t / dur * lane.width - 1, 2, 2, lane.height - 4);
      });
      // Guard-friction violations are CH events with no standard type (§5.8
      // forbids vendor events in the stream), so v2 carries them in the
      // extension with session-absolute times. They are still integrity
      // evidence and still belong in the lane.
      (model.guardViolations || []).forEach(function (g) {
        var t = num(g && g.t);
        if (t == null) return;
        var rel = round1(t - s.origin);
        if (rel < 0 || rel > dur) return;
        lctx.fillStyle = GUARD_COLOR;
        lctx.fillRect(rel / dur * lane.width - 1, 0, 2, lane.height);
      });
    }

    function checkSummary() {
      var events = seg().events;
      var ok = 0, uncertain = 0, redacted = 0, noAnchor = 0;
      for (var i = 0; i < events.length; i++) {
        var c = events[i].__chk;
        if (!c) continue;
        if (c.status === 'ok') ok++;
        else if (c.status === 'redacted') redacted++;
        else if (c.status === 'no-anchor') noAnchor++;
        else uncertain++;
      }
      return { ok: ok, uncertain: uncertain, redacted: redacted, noAnchor: noAnchor };
    }

    function updateStatusChips() {
      var s = checkSummary();
      // Reset the class every time, not only the text: without this the chip
      // keeps `replay-warn` from whichever segment last held an uncertain
      // check, so a clean segment renders an empty chip styled as a warning.
      alignChip.className = 'replay-note';
      // FOUR buckets, one sentence. `no-anchor` was counted here and said by
      // nothing until T5.6: a segment whose interactions all landed outside the
      // observed root read as a segment with no interactions, and a mixed one
      // read as fully verified. Neither is a failure — which is why they are
      // not the warning — but both are the silence this chip exists to prevent.
      var qual = [];
      if (s.redacted > 0) qual.push(s.redacted + ' redacted');
      if (s.noAnchor > 0) qual.push(s.noAnchor + ' with no target');
      if (model.tier !== 'dom') {
        alignChip.textContent = '';
      } else if (s.uncertain > 0) {
        // The qualifier rides the WARNING branch too. It is the branch an
        // analyst is most likely to be reading, and dropping it there hid three
        // unverifiable interactions behind one failed one — the same over-claim
        // as on the verified branch, one `else if` away. (T5.6 fix)
        alignChip.textContent = '⚠ ' + s.uncertain + ' interaction(s) failed the alignment self-check' +
          (qual.length ? ' (' + qual.join(', ') + ')' : '');
        alignChip.className = 'replay-note replay-warn';
      } else if (s.ok > 0) {
        alignChip.textContent = 'alignment verified (' + s.ok + ' check' + (s.ok === 1 ? '' : 's') +
          (qual.length ? '; ' + qual.join(', ') : '') + ')';
      } else if (qual.length) {
        alignChip.textContent = 'alignment unverified (' + qual.join(', ') + ')';
      } else {
        alignChip.textContent = '';
      }
      // ONE chip, TWO counters, different questions (design §4): `skipped` is
      // "the file said something no DOM here could hold" (a tag or attribute
      // name outside the XML Name production, a null child); `patchFailures` is
      // "a reference the span could not honour" (an id the map does not hold, a
      // `before` that is not a child, a target of the wrong kind). They stay
      // separate so a miss is diagnosable and fold here so an analyst reads one
      // sentence. Read as live properties — the span state keeps counting.
      var fails = span ? (span.patchFailures + span.skipped) : 0;
      if (fails > 0) {
        failChip.textContent = '⚠ ' + fails + ' recorded change(s) could not be reapplied. Replay may diverge from the original session.';
        failChip.style.display = '';
      } else {
        failChip.style.display = 'none';
      }
    }

    // §5.3 has TWO conforming producer modes and a redacted variant, and the
    // viewer renders all three because it must play foreign files: jsPsych
    // writes `text`/`html` (content), CH writes `len` (length-only, on privacy
    // grounds), and a target inside a redacted subtree carries neither. The
    // redacted case shows the FACT and no measurement — a character count the
    // file withheld must not be reconstructed from anywhere else.
    function clipboardLabel(e) {
      if (e.redacted) return ' [redacted]' + (num(e.len) != null ? ', ' + e.len + ' ch' : '');
      if (typeof e.text === 'string') {
        return ' "' + e.text.slice(0, 32) + (e.text.length > 32 ? '…' : '') + '" (' + e.text.length + ' ch)';
      }
      if (typeof e.html === 'string') return ' [html] (' + e.html.length + ' ch)';
      if (num(e.len) != null) return ' (' + e.len + ' ch)';
      return ' (length not recorded)';
    }

    function drawTicker() {
      var events = seg().events;
      var recent = [];
      for (var i = events.length - 1; i >= 0 && recent.length < 3; i--) {
        var e = events[i];
        if (e.t > playhead) continue;
        if (e.type === 'mouse.move' || e.type === 'touch.move') continue;
        var label = e.type;
        if (e.type.indexOf('clipboard.') === 0) label += clipboardLabel(e);
        if (e.type === 'key.down' && e.key) label += ' ' + JSON.stringify(e.key);
        if (e.type === 'input.value') {
          label += e.redacted ? ' [redacted, ' + e.value_len + ' ch]'
            : (' "' + String(e.value == null ? '' : e.value).slice(0, 24) + '"');
        }
        if (e.__chk && e.__chk.status === 'uncertain') label += ' ⚠(' + e.__chk.reasons[0] + ')';
        recent.unshift('[' + fmtClock(e.t) + '] ' + label);
      }
      ticker.textContent = recent.join('   ·   ') || '—';
    }

    // ── Playback loop ──
    var lastFrame = null;
    function tick(ts) {
      if (!playing) return;
      if (lastFrame != null) {
        seek(playhead + (ts - lastFrame) * speed);
      }
      lastFrame = ts;
      if (playhead >= seg().durMs) {
        if (autoAdvance && segIdx < segments.length - 1) {
          loadSegment(segIdx + 1);   // continue playing into the next segment
          requestAnimationFrame(tick);
          return;
        }
        playing = false;
        playBtn.textContent = '▶';
        playBtn.setAttribute('aria-label', 'Play');
        return;
      }
      requestAnimationFrame(tick);
    }

    playBtn.addEventListener('click', function () {
      if (playing) {
        playing = false;
        playBtn.textContent = '▶';
        playBtn.setAttribute('aria-label', 'Play');
        return;
      }
      if (playhead >= seg().durMs) seek(0);
      playing = true;
      playBtn.textContent = '❚❚';
      playBtn.setAttribute('aria-label', 'Pause');
      lastFrame = null;
      requestAnimationFrame(tick);
    });
    speedSel.addEventListener('change', function () { speed = Number(speedSel.value) || 1; });
    scrub.addEventListener('input', function () { requestSeek(Number(scrub.value)); });
    scrub.addEventListener('keydown', function (ev) {
      var step = seg().durMs * 0.05;
      if (ev.key === 'PageUp') { seek(playhead + step); ev.preventDefault(); }
      else if (ev.key === 'PageDown') { seek(playhead - step); ev.preventDefault(); }
      else if (ev.key === 'Home') { seek(0); ev.preventDefault(); }
      else if (ev.key === 'End') { seek(seg().durMs); ev.preventDefault(); }
    });
    function updateSessionPos() {
      sessionPos.textContent = 'Segment ' + (segIdx + 1) + ' of ' + segments.length;
    }

    // Loads segment i's reconstruction/camera/scrub state WITHOUT touching
    // playing/playBtn — the continuous-playback boundary in tick() calls this
    // directly so play keeps running across the cut; selectSegment() (manual
    // pick and boot) wraps it with the playing=false reset a user-driven jump
    // should have.
    function loadSegment(i) {
      segIdx = i;
      segSel.value = String(i);
      scrub.max = String(seg().durMs);
      playhead = 0;
      segHadIframe = false;
      segHadShadow = false;
      // Check caches are cleared by `restore()`, span-wide — see there.
      seedCamera(seg().spanStart != null ? seg().spanStart : i);
      sizeStage();
      // DPR advisory: resolution-conditional CSS cannot be reproduced in an
      // iframe that inherits the analyst's DPR (declared limitation, loud).
      var recDpr = (seg().camera && seg().camera.dpr) ||
        (model.viewport && model.viewport.dpr) || null;
      if (recDpr && window.devicePixelRatio && recDpr !== window.devicePixelRatio) {
        dprChip.textContent = 'Recorded at DPR ' + recDpr + ', now viewing at DPR ' +
          window.devicePixelRatio + '. Resolution-dependent styling may differ.';
        dprChip.style.display = '';
      } else {
        dprChip.style.display = 'none';
      }
      if (shellReady || !iframe) restore(i, 0);
      scrub.value = '0';
      redraw();
      updateSessionPos();
    }
    function selectSegment(i) {
      playing = false;
      playBtn.textContent = '▶';
      playBtn.setAttribute('aria-label', 'Play');
      loadSegment(i);
    }
    segSel.addEventListener('change', function () {
      selectSegment(Number(segSel.value) || 0);
    });

    // Analyst-side resizes (report sidebar, browser zoom, window resize)
    // re-derive the stage box and transform — the reconstruction must track
    // its container, not just the recording.
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        var newW = Math.min(mount.clientWidth || 720, 960);
        if (newW === stageW) return;
        sizeStage();
        pendingCamSize = true;
        flushCamSize();
        drawOverlay();
        drawLane();
      });
      ro.observe(mount);
    }

    // Test/debug surface (used by the alignment battery and, from Task 7, the
    // checkpoint executor; not a public API).
    mount._chReplayDebug = {
      seek: function (t) { seek(t); },
      requestSeek: requestSeek,
      selectSegment: selectSegment,
      getPlayhead: function () { return playhead; },
      getSegment: function () { return segIdx; },
      getSpanStart: function () { return spanStart; },
      // Spec §4 id → live node, through the span map the patches resolve
      // against. `exists` is `getNode(id) !== undefined`.
      getNode: function (id) { return resolveNode(id); },
      getChecks: function () {
        return seg().events
          .filter(function (e) { return e.__chk; })
          .map(function (e) {
            return {
              t: e.t, type: e.type, status: e.__chk.status, reasons: e.__chk.reasons,
              // Which §8 comparisons could not run. Diagnostic only — see
              // ALL_PREDICATES. `ok` with an empty array is full verification.
              skipped: e.__chk.skipped || []
            };
          });
      },
      getCamera: function () { return { x: cam.x, y: cam.y, w: cam.w, h: cam.h, cw: cam.cw, ch: cam.ch, k: k, ox: ox, oy: oy }; },
      getCounters: function () {
        var unknown = [];
        unknownTypes.forEach(function (_v, k) { unknown.push(k); });
        return {
          patchFailures: span ? span.patchFailures : 0,
          skipped: span ? span.skipped : 0,
          // §5.8: one entry per unrecognised TYPE. Not per occurrence — the
          // walk replays on every restore, so occurrences would count the
          // analyst's scrubbing rather than the file.
          unknownTypes: unknown
        };
      },
      // Awaits the per-canvas decode chains, presenting anything still dirty
      // first. The one asynchronous part of a restore (design §3.1).
      canvasSettled: canvasSettled,
      getMediaState: function () {
        var out = [];
        mediaState.forEach(function (st, id) { out.push({ node: id, state: st.state, time: st.time }); });
        return out;
      },
      // The merged span list, in application order — the §7 tie precedence is
      // this array's order, so it is what a test asserts against.
      getWalk: function () {
        return walk.map(function (w) {
          return { seg: w.seg, t: w.t, stream: w.stream, type: w.payload.type };
        });
      },
      getStats: function () { return { shellWrites: stats.shellWrites, mounts: stats.mounts }; },
      frameReady: function () { return iframe ? shellReady : true; }
    };

    // ── Boot ──
    // The shell is the only asynchronous step, and only in a real browser
    // (happy-dom parses srcdoc synchronously). loadSegment sizes the stage and
    // draws immediately either way; the reconstruction lands when the document
    // does.
    if (iframe) writeShell();
    selectSegment(0);
  };
})();
