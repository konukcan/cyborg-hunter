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
    'input.value': '#388e3c', 'input.checked': '#388e3c', 'input.select': '#388e3c'
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

  // Keycast: how long a chip keeps fading after its key.up, in segment-relative
  // ms. Purely a function of playhead (like the click-ripple fade in
  // drawOverlay below), not real time, so seeking lands on the same visual
  // state playing to it would.
  var KEYCAST_FADE_MS = 500;

  // Buffer-cap explanation fallback: recorder.js's REPLAY_DEFAULTS. v2 moves
  // the configured limits into `extensions['cyborg-hunter']`, which the viewer
  // model does not carry today, so the note quotes the library defaults and
  // says so. Re-pointing it at the recording's own limits is Task 5's §5.7 row.
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
  function buildShell(allowExternalCss) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + srcdocCsp(allowExternalCss) + '">' +
      '<meta name="referrer" content="no-referrer">' +
      '<meta name="' + SHELL_META + '" content="1">' +
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
    var span = null;           // mountTree's live state for the mounted span
    var spanStart = -1;        // index of the keyframe the mounted span opens at
    var spanEnd = -1;
    var walk = [];             // merged span entries, in application order
    var appliedIdx = 0;
    var stats = { shellWrites: 0, mounts: 0 };

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
    if (model.captureStopped || model.truncated) {
      var capDetails = document.createElement('details');
      capDetails.className = 'replay-note replay-warn replay-cap';
      capDetails.setAttribute('data-ch-cap-note', '');
      var capSummary = document.createElement('summary');
      capSummary.textContent = 'Capture stopped before the session ended (details)';
      var capBody = el('p', null,
        'The recorder stopped capturing before this session finished, so the replay ends ' +
        'earlier than the participant\'s session did. The usual cause is a buffer cap: the ' +
        'recorder caps each segment at about ' + fmtCount(CAP_DEFAULTS.events) + ' events or ' +
        fmtCount(CAP_DEFAULTS.chars) + ' characters (library defaults — both are configurable ' +
        'when the recorder is attached), and the segment that crosses either cap stops ' +
        'recording. Absence of evidence after this point is not evidence of absence.');
      capDetails.appendChild(capSummary);
      capDetails.appendChild(capBody);
      header.appendChild(capDetails);
    }
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

    function shellPresent() {
      var doc = iframe && iframe.contentDocument;
      try {
        return !!(doc && doc.querySelector('meta[name="' + SHELL_META + '"]'));
      } catch (e) { return false; }
    }

    // Browsers navigate the frame asynchronously and fire `load`; happy-dom
    // parses `srcdoc` synchronously and fires `load` afterwards, twice. One
    // idempotent boot covers all of it: try immediately, and again on load.
    function writeShell() {
      shellReady = false;
      stats.shellWrites++;
      iframe.onload = onShellLoad;
      iframe.srcdoc = buildShell(allowExternalCss);
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
    function insertSheet(doc, sheet) {
      var node = sheetNode(doc, sheet);
      if (!node) return;
      var anchor = doc.querySelector('style[data-ch-shell-rules]');
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
        var node = doc.querySelector('[data-ch-sheet="' + ev.id + '"]');
        if (node && node.tagName.toLowerCase() === 'style') node.textContent = ev.css == null ? '' : ev.css;
        else insertSheet(doc, { id: ev.id, kind: 'inline', css: ev.css, media: null });
      }
    }

    function removeSheet(doc, id) {
      var node = doc.querySelector('[data-ch-sheet="' + id + '"]');
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    function deriveSheets(doc, originT) {
      var live = doc.querySelectorAll('[data-ch-sheet]');
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
    // seed `initial_state` (design §6). Types this task does not render —
    // canvas composites, media badges, clipboard, fullscreen, and §5.8's
    // unknown-type counting — fall through to Task 5's vocabulary work; the
    // lane and ticker already read them out of the event stream.
    function applyEvent(e) {
      if (!e || typeof e.type !== 'string') return;
      if (e.camera) foldEventCamera(e.camera);
      // `applyPatch` returns false for anything that is not one of §5.1's four
      // verbs, so the vocabulary dispatch below needs no list of its own.
      if (span && applyPatch(e, span)) return;
      var type = e.type;
      if (type === 'input.value' || type === 'input.checked' || type === 'input.select') {
        if (span) applyInput(e);
      } else if (type === 'scroll.window') {
        cam.x = num(e.x) || 0; cam.y = num(e.y) || 0;
        applyCamScroll();
      } else if (type === 'scroll.element') {
        if (span) applyElementScroll(e);
      } else if (DISCRETE_TYPES[type] === true) {
        // Every non-move input event is OFFERED to the check; the §6 MAY-omit
        // rule is decided inside it, in one place, because "no camera block
        // means no check" is a statement about the check and not about the
        // dispatch.
        if (e.__chk == null) {
          if (pendingCamSize) { flushCamSize(); applyCamScroll(); }
          evaluateCheck(e);
        }
      }
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
      // so the seed's playback positions ride the same synthetic-event path and
      // land wherever Task 5 takes them.
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
        if (doc) mountTree(null, doc.body, doc);
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

      // 1. mount the span keyframe, fresh id map
      if (doc) {
        span = mountTree(start >= 0 ? segments[start].initialDom : null, doc.body, doc);
        stats.mounts++;
      } else {
        span = null;
      }
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
    // and the cursor glyph.
    //
    // Anchor resolution changed completely: `anchor.node` is an integer id
    // resolved through the span id map. No markers, no child-index path, no
    // getElementById guess. Alignment blocks are OPTIONAL (§6 cost rule), and
    // absence is NOT failure — no camera block means no check.
    //
    // TASK 6 OWNS THE SEMANTICS TESTS: the five predicates each failing on
    // their own injected corruption, the three distinguishable anchor
    // outcomes, and the redacted bucket. What lands here is the re-point the
    // rewrite could not leave behind, since v1's version read markers and a
    // `resize`-folded camera that no longer exist.
    function evaluateCheck(e) {
      var doc = frameDoc();
      if (!doc || !span) return;
      // §8's redacted bucket narrows to events carrying `redacted: true` at the
      // EVENT level — a redacted key.* has no other fields at all (§5.2), so
      // there is nothing to verify and nothing to report as misaligned. A
      // redacted ANCHOR is a different thing and is CHECKED: §8 omits
      // `anchor.id` but keeps `anchor.node` and `anchor.rect`, which is
      // strictly more than v1 could verify.
      if (e.redacted) { e.__chk = { status: 'redacted', reasons: ['redacted event'] }; return; }
      var camera = e.camera;
      var anchor = e.anchor;
      // §6 alignment fields are OPTIONAL and MAY be omitted on key.up and on
      // repeats. Absence is not failure: no blocks means NO CHECK, not an
      // uncertain one. v1 conflated the two, which is how key.up omissions
      // read as misalignment.
      if (!camera && !anchor) return;
      var reasons = [];

      if (camera) {
        var view = doc.defaultView;
        if (view && (Math.abs((view.scrollX || 0) - cam.x) > TOL_CAMERA ||
                     Math.abs((view.scrollY || 0) - cam.y) > TOL_CAMERA)) {
          reasons.push('applied scroll diverges (' +
            (view.scrollX || 0) + ',' + (view.scrollY || 0) + ' vs ' + cam.x + ',' + cam.y + ')');
        }
        var de = doc.documentElement;
        if (de && num(camera.client_w) != null &&
            Math.abs(de.clientWidth - camera.client_w) > TOL_CAMERA) {
          reasons.push('frame layout width ' + de.clientWidth + ' vs camera ' + camera.client_w);
        }
      }

      if (anchor && anchor.node == null) {
        // §7: null means "no applicable target node" — not a failure, and
        // distinguishable from an id the span could not hold.
        e.__chk = { status: 'no-anchor', reasons: reasons };
        return;
      }

      var target = anchor ? resolveNode(anchor.node) : null;
      if (anchor && !target) {
        reasons.push('anchor node ' + anchor.node + ' not held by this span (' +
          (anchor.tag || '?') + (anchor.id ? '#' + anchor.id : '') + ')');
      } else if (target) {
        if (target.hasAttribute && target.hasAttribute('data-ch-shadow')) {
          // The interaction retargeted to a shadow host whose content was not
          // captured — geometry would "verify" against a hollow box. Refuse.
          reasons.push('shadow content not captured');
        }
        var rr = null;
        try { rr = target.getBoundingClientRect(); } catch (err) { /* leave null */ }
        var rect = anchor.rect;
        if (rr && rect && num(rect.x) != null) {
          var dL = Math.abs(rr.left - rect.x);
          var dT = Math.abs(rr.top - rect.y);
          var dR = Math.abs((rr.left + rr.width) - (rect.x + rect.w));
          var dB = Math.abs((rr.top + rr.height) - (rect.y + rect.h));
          if (dL > TOL_RECT || dT > TOL_RECT || dR > TOL_RECT || dB > TOL_RECT) {
            reasons.push('target rect moved (Δ ' + Math.round(Math.max(dL, dT, dR, dB)) + 'px)');
          }
        }
        var px = eventX(e), py = eventY(e);
        if (rr && px != null &&
            !(px >= rr.left - TOL_CONTAIN && px <= rr.left + rr.width + TOL_CONTAIN &&
              py >= rr.top - TOL_CONTAIN && py <= rr.top + rr.height + TOL_CONTAIN)) {
          reasons.push('cursor outside target');
        }
        if (doc.elementFromPoint && px != null) {
          var under = null;
          try { under = doc.elementFromPoint(px, py); } catch (err) { /* skip */ }
          if (under && under !== target &&
              !(target.contains && target.contains(under)) &&
              !(under.contains && under.contains(target))) {
            reasons.push('hit-test resolves ' +
              (under.id ? under.tagName.toLowerCase() + '#' + under.id : under.tagName.toLowerCase()));
          }
        }
      }

      try {
        var ir = iframe.getBoundingClientRect();
        var sr = stage.getBoundingClientRect();
        if (Math.abs(ir.left - sr.left - ox) > TOL_STAGE ||
            Math.abs(ir.top - sr.top - oy) > TOL_STAGE) {
          reasons.push('stage transform drift');
        }
      } catch (err) { /* measuring failed — not evidence of misalignment */ }

      e.__chk = reasons.length > 0
        ? { status: 'uncertain', reasons: reasons }
        : { status: 'ok', reasons: [] };
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
      if (model.tier !== 'dom') {
        alignChip.textContent = '';
      } else if (s.uncertain > 0) {
        alignChip.textContent = '⚠ ' + s.uncertain + ' interaction(s) failed the alignment self-check';
        alignChip.className = 'replay-note replay-warn';
      } else if (s.redacted > 0 && s.ok === 0) {
        alignChip.textContent = 'alignment unverified (redacted interactions)';
        alignChip.className = 'replay-note';
      } else if (s.ok > 0) {
        alignChip.textContent = 'alignment verified (' + s.ok + ' check' + (s.ok === 1 ? '' : 's') +
          (s.redacted > 0 ? ', ' + s.redacted + ' redacted' : '') + ')';
        alignChip.className = 'replay-note';
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

    function drawTicker() {
      var events = seg().events;
      var recent = [];
      for (var i = events.length - 1; i >= 0 && recent.length < 3; i--) {
        var e = events[i];
        if (e.t > playhead) continue;
        if (e.type === 'mouse.move' || e.type === 'touch.move') continue;
        var label = e.type;
        if (e.type.indexOf('clipboard.') === 0) {
          label += ' (' + (e.len == null ? (e.text == null ? '?' : e.text.length) : e.len) + ' ch)';
        }
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
      // Check caches are recomputed deterministically during the span walk.
      seg().events.forEach(function (e) { if (e.__chk) delete e.__chk; });
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
            return { t: e.t, type: e.type, status: e.__chk.status, reasons: e.__chk.reasons };
          });
      },
      getCamera: function () { return { x: cam.x, y: cam.y, w: cam.w, h: cam.h, cw: cam.cw, ch: cam.ch, k: k, ox: ox, oy: oy }; },
      getCounters: function () {
        return {
          patchFailures: span ? span.patchFailures : 0,
          skipped: span ? span.skipped : 0
        };
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
