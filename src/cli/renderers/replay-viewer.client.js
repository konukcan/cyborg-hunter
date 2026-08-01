// src/cli/renderers/replay-viewer.client.js
// Browser-side replay viewer, embedded verbatim into the HTML report by
// html-index.js (readFileSync at render time — file://-safe, no fetch).
//
// Contract: window.initChReplayViewer(mountEl, model) where model is the
// viewer model emitted by replay-assets.js (trial-relative event times,
// per-trial camera seeds, marker attribute name, legacy flag).
//
// Coordinate model (cursor-alignment fix):
//   The stage shows the RECORD-TIME VIEWPORT, not the document. A camera
//   state (window scroll + viewport size) is maintained at the playhead from
//   the trial's seed + its scroll/resize events; the iframe is sized to the
//   record-time layout (clientWidth/Height), scrolled to the record-time
//   scroll, and letterboxed into a fixed stage box. Cursor/trail draw in
//   CLIENT space: new recordings carry cx/cy per event; legacy recordings
//   re-project page coords minus the running scroll (reduced guarantees,
//   surfaced by a persistent banner).
//
//   Every anchored interaction runs an alignment self-check (marker
//   resolution + camera assertions + recorded-vs-replayed rect + containment
//   + hit-test). Failures NEVER stay silent: header status, lane marks, an
//   uncertain cursor glyph, and a terminated trail.
//
// Anatomy per mount:
//   header   tier badge · trial <select> · play/pause · speed · clock · status chips
//   stage    tier 'dom': sandboxed <iframe srcdoc> rebuilt per trial/seek
//            tier 'trace': neutral gray stage with a label
//            + <canvas> overlay (cursor trail, click ripples)
//   lane     per-trial marker lane (clipboard/mutations/bands/check marks)
//   scrub    <input type=range> in ms, wired both ways with the play loop
//   ticker   text line of the events nearest the playhead

(function () {
  'use strict';

  var MARKER_COLORS = {
    paste: '#d32f2f', 'ch:drop': '#7b1fa2', copy: '#f57c00', cut: '#f57c00',
    'ch:guard_violation': '#d32f2f', 'ch:capture_stopped': '#616161',
    mutation: '#1976d2', input: '#388e3c'
  };
  var UNCERTAIN_COLOR = '#b26a00';

  // Self-check tolerances (CSS px, unscaled): camera ±1; rect edges ±3
  // conjunctive with containment (2px allowance) AND hit-test; stage
  // transform ±2.
  var TOL_CAMERA = 1;
  var TOL_RECT = 3;
  var TOL_CONTAIN = 2;
  var TOL_STAGE = 2;

  // Keycast: how long a chip keeps fading after its keyup, in trial-relative
  // ms. Purely a function of playhead (like the click-ripple fade in
  // drawOverlay below), not real time, so seeking lands on the same visual
  // state playing to it would.
  var KEYCAST_FADE_MS = 500;

  var DISCRETE_KINDS = {
    mousedown: true, mouseup: true, click: true, touchstart: true, touchend: true
  };

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

  // Human label for a keycast chip. e.key already names special keys well
  // (Enter, Shift, Backspace, ArrowLeft…); the one gap is the space bar,
  // which arrives as a literal ' ' and would render as an invisible chip.
  function formatKeyLabel(key) {
    return key === ' ' ? 'Space' : key;
  }

  // ── DOM reconstruction (tier 'dom') ──
  // The recorded DOM is UNTRUSTED (an adversarial participant or extension
  // may have injected markup). sandbox="" already blocks scripts; the CSP
  // meta below additionally kills frames, form posts, fetch/XHR-carrying
  // elements, and plugin content, while still allowing images/media/styles
  // and fonts — the carriers of visual fidelity. Residual (documented):
  // a participant-injected <img src> can still fire a GET to its host when
  // the analyst loads the replay. no-referrer strips the analyst context.
  function srcdocCsp(allowExternalCss) {
    return "default-src 'none'; img-src * data: blob:; media-src * data: blob:; " +
      (allowExternalCss ? "style-src 'unsafe-inline' https: http:; " : "style-src 'unsafe-inline'; ") +
      "font-src * data:; " +
      "form-action 'none'; frame-src 'none'; connect-src 'none'; base-uri 'none';";
  }

  function attrEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function buildSrcdoc(model, trial, allowExternalCss) {
    var styles = '';
    (model.stylesheets || []).forEach(function (sheet) {
      if (sheet.css) {
        styles += '<style>' + sheet.css.replace(/<\//g, '<\\/') + '</style>';
      } else if (allowExternalCss && sheet.href && /^https?:/i.test(sheet.href)) {
        styles += '<link rel="stylesheet" href="' + attrEscape(sheet.href) + '">';
      }
    });
    // NOTE deliberately ABSENT: the old `html,body{margin:0}` override. It
    // came AFTER the captured CSS and silently overrode the page's own body
    // margins (including `margin:auto` centering) — the single largest
    // cursor-misalignment source on the acceptance fixture (~390px). The
    // reconstruction must lay out exactly as the recorded page did, UA
    // defaults included.
    // The frame is sized to the RECORD-TIME layout width (clientWidth =
    // innerWidth minus any classic scrollbar), so the frame's own root
    // scrollbar must not subtract a second gutter on classic-scrollbar
    // platforms. Hiding the ROOT scroller's bar (scrolling still works
    // programmatically) keeps layout width == camera width everywhere;
    // inner containers keep their bars.
    var gutterFix = '<style>html{scrollbar-width:none}' +
      'html::-webkit-scrollbar{width:0;height:0}</style>';
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + srcdocCsp(allowExternalCss) + '">' +
      '<meta name="referrer" content="no-referrer">' + gutterFix + styles +
      '</head><body>' + (trial.initialDom || '') + '</body></html>';
  }

  function resolvePath(root, path) {
    if (!path) return null;
    var cur = root;
    for (var i = 0; i < path.length; i++) {
      if (!cur || !cur.childNodes) return null;
      cur = cur.childNodes[path[i]];
    }
    return cur || null;
  }

  window.initChReplayViewer = function (mount, model) {
    if (!mount || !model) return;
    if (mount._chReplayInit) return;   // double-click guard
    mount._chReplayInit = true;
    mount.textContent = '';

    var trials = model.trials || [];
    if (trials.length === 0) {
      mount.appendChild(el('p', 'replay-note', 'Recording contains no trials.'));
      return;
    }
    // Session scrollbar delta for legacy resize events (see buildViewerModel).
    var sbW = (model.scrollbar && model.scrollbar.w) || 0;
    var sbH = (model.scrollbar && model.scrollbar.h) || 0;

    // ── State ──
    var trialIdx = 0;
    var playhead = 0;          // trial-relative ms
    var playing = false;
    var speed = 1;
    var appliedIdx = 0;        // events applied so far (in trial event order)
    var iframeGen = 0;         // increments per rebuild; stale onloads bail
    var domReady = false;
    var markerMap = new Map(); // marker id (string) → element, per frame gen
    var counters = { patchFailures: 0, scrollFailures: 0 };
    // Camera at the applied position: window scroll + viewport dims.
    var cam = null;            // {x, y, w, h, cw, ch}
    var pendingCamSize = false; // viewport dims changed since last flush
    var stageW = 0, stageH = 0; // stage box (fixed per trial)
    var k = 1, ox = 0, oy = 0;  // iframe scale + letterbox origin

    function trial() { return trials[trialIdx]; }

    function seedCamera() {
      var seed = trial().camera || {};
      cam = {
        x: seed.x || 0, y: seed.y || 0,
        w: seed.w || 1280, h: seed.h || 800,
        cw: seed.cw || seed.w || 1280, ch: seed.ch || seed.h || 800
      };
    }

    // ── Header ──
    var header = el('div', 'replay-header');
    var badge = el('span', 'replay-badge', model.tier === 'dom' ? 'DOM replay' : 'Trace replay');
    badge.setAttribute('data-tier', model.tier === 'dom' ? 'dom' : 'trace');
    badge.setAttribute('role', 'status');
    var trialSel = el('select', 'replay-trial-select');
    trials.forEach(function (t, i) {
      var opt = el('option', null,
        'Trial ' + (t.index != null ? t.index : i) + ' — ' + (t.id || '?') +
        ' (' + fmtClock(t.durMs) + ')');
      opt.value = String(i);
      trialSel.appendChild(opt);
    });
    var playBtn = el('button', 'replay-play', '▶');
    playBtn.setAttribute('aria-label', 'Play');
    var speedSel = el('select', 'replay-speed');
    [1, 2, 4, 8].forEach(function (s) {
      var o = el('option', null, s + '×'); o.value = String(s); speedSel.appendChild(o);
    });
    var clock = el('span', 'replay-clock', '0:00.0 / 0:00.0');
    header.appendChild(badge);
    header.appendChild(trialSel);
    header.appendChild(playBtn);
    header.appendChild(speedSel);
    header.appendChild(clock);
    if (!model.scoring) {
      header.appendChild(el('span', 'replay-note',
        'No integrity score attached (this recording was captured standalone)'));
    }
    if (model.captureStopped) {
      header.appendChild(el('span', 'replay-note replay-warn',
        'Capture stopped early (buffer cap)'));
    }
    // Alignment status chips — the "never fail silently" surface.
    var alignChip = el('span', 'replay-note', '');
    alignChip.setAttribute('role', 'status');
    alignChip.setAttribute('data-ch-align', '');
    header.appendChild(alignChip);
    if (model.legacy) {
      var legacyChip = el('span', 'replay-note replay-warn',
        'Legacy recording: alignment guarantees are reduced (coordinates re-projected, unverified)');
      legacyChip.setAttribute('data-ch-legacy', '');
      header.appendChild(legacyChip);
    }
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
    // viewer time. Both set per trial / model.
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
        if (iframe) rebuildFrame(playhead);
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
      // allow-same-origin WITHOUT allow-scripts: scripts stay blocked (both
      // by the sandbox and by the srcdoc CSP), but the document keeps a
      // reachable origin so the player can apply mutation/input state via
      // contentDocument. sandbox="" would make the origin opaque and freeze
      // every dom-tier replay at its first frame.
      iframe.setAttribute('sandbox', 'allow-same-origin');
      iframe.className = 'replay-frame';
      // Non-interactive: an analyst click inside the reconstruction would
      // act on live untrusted DOM (submit a form, navigate the frame).
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
    // the click-ripple/cursor-trail convention above (a pure function of
    // playhead, drawn alongside them — see drawKeycast). keys:'off'
    // recordings carry no keydown/keyup events, so this stays empty; that
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

    // ── Stage geometry ──
    // The stage BOX is fixed per trial (sized from the trial's seed camera
    // aspect) so playback never reflows the report page; camera changes
    // re-letterbox the iframe INSIDE the box.
    function sizeStage() {
      stageW = Math.min(mount.clientWidth || 720, 960);
      var seed = trial().camera || {};
      var scw = seed.cw || seed.w || 1280;
      var sch = seed.ch || seed.h || 800;
      stageH = Math.round(sch * (stageW / scw));
      stage.style.width = stageW + 'px';
      stage.style.height = stageH + 'px';
      overlay.width = stageW;
      overlay.height = stageH;
      lane.width = stageW;
      scrub.style.width = stageW + 'px';
    }

    // Apply the current camera's viewport dims to the iframe + transform.
    // Called lazily: before each anchored self-check and once per applied
    // batch — a 240-event resize storm costs a handful of real reflows, not
    // 240 (Sol round-1 finding 11).
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
      if (!iframe || !domReady) return;
      var doc = iframe.contentDocument;
      if (doc && doc.defaultView && typeof doc.defaultView.scrollTo === 'function') {
        try { doc.defaultView.scrollTo(cam.x, cam.y); } catch (e) { /* best-effort */ }
      }
    }

    // ── Marker harvesting ──
    // Markers arrive as data-chn-<nonce> attributes in the serialized HTML.
    // They are harvested into an out-of-band Map and REMOVED immediately, so
    // no marker attribute ever participates in a layout we measure and page
    // CSS/attributes can never hijack resolution.
    function harvestMarkers(scope) {
      if (!model.markerAttr || !scope || !scope.querySelectorAll) return;
      var found;
      try { found = scope.querySelectorAll('[' + model.markerAttr + ']'); }
      catch (e) { return; }
      for (var i = 0; i < found.length; i++) {
        var node = found[i];
        markerMap.set(node.getAttribute(model.markerAttr), node);
        node.removeAttribute(model.markerAttr);
      }
      if (scope.getAttribute && scope.getAttribute(model.markerAttr) != null) {
        markerMap.set(scope.getAttribute(model.markerAttr), scope);
        scope.removeAttribute(model.markerAttr);
      }
    }

    // LATCHED per trial selection: an iframe (or shadow host) that existed at
    // ANY point in the trial keeps its warning even after a removal patch —
    // the invisible interactions don't become visible because the frame left.
    var trialHadIframe = false;
    var trialHadShadow = false;
    function updateIframeWarning(doc) {
      try {
        if (doc && doc.querySelector('[data-ch-iframe]')) trialHadIframe = true;
        if (doc && doc.querySelector('[data-ch-shadow]')) trialHadShadow = true;
      } catch (e) { /* keep latches */ }
      iframeChip.style.display = trialHadIframe ? '' : 'none';
      shadowChip.style.display = trialHadShadow ? '' : 'none';
    }

    // Resolve a mutation/anchor reference: marker first (validated by tag +
    // connectedness), then the legacy child-index path, then raw id. The
    // path fallback is TAG-VALIDATED whenever the reference carries an
    // expected tag: a failed marker means the reconstruction diverged (e.g.
    // the parser dropped an invalid-but-real construct like nested forms),
    // and an unvalidated raw-index path would silently patch whatever node
    // now sits at those indices. Legacy references (no tag) keep the
    // original unvalidated behavior.
    function resolveRef(doc, ref) {
      if (ref.n != null) {
        var byMarker = markerMap.get(String(ref.n));
        if (byMarker && byMarker.isConnected &&
            (!ref.tag || byMarker.tagName.toLowerCase() === ref.tag)) {
          return byMarker;
        }
      }
      var byPath = resolvePath(doc.body, ref.path);
      if (byPath && (!ref.tag ||
          (byPath.tagName && byPath.tagName.toLowerCase() === ref.tag))) {
        return byPath;
      }
      if (ref.id && doc.getElementById) {
        var byId = doc.getElementById(ref.id);
        if (byId && (!ref.tag || byId.tagName.toLowerCase() === ref.tag)) return byId;
      }
      return null;
    }

    // ── DOM state at playhead ──
    function rebuildFrame(thenSeekTo, isRevalidation) {
      if (!iframe) return;
      iframeGen++;
      var gen = iframeGen;
      domReady = false;
      appliedIdx = 0;
      markerMap = new Map();
      counters.patchFailures = 0;
      counters.scrollFailures = 0;
      seedCamera();
      pendingCamSize = true;
      // Reset check caches — they are recomputed deterministically during
      // forward re-application.
      trial().events.forEach(function (e) { if (e.__chk) delete e.__chk; });
      iframe.onload = function () {
        if (gen !== iframeGen) return;   // superseded by a newer rebuild
        domReady = true;
        var doc = iframe.contentDocument;
        harvestMarkers(doc && doc.body);
        updateIframeWarning(doc);
        flushCamSize();
        applyCamScroll();
        applyDomUpTo(thenSeekTo);
        drawOverlay();
        drawKeycast();
        updateStatusChips();
        // Late-layout revalidation: web fonts settling after the first
        // layout can shift geometry and stale an initially-passing check.
        // One revalidation pass per user-initiated rebuild (guarded against
        // rebuild→fonts.ready→rebuild loops).
        if (!isRevalidation && doc && doc.fonts && doc.fonts.ready &&
            typeof doc.fonts.ready.then === 'function') {
          doc.fonts.ready.then(function () {
            if (gen === iframeGen) rebuildFrame(playhead, true);
          }).catch(function () { /* fonts API absent/failed — skip */ });
        }
      };
      iframe.srcdoc = buildSrcdoc(model, trial(), allowExternalCss);
    }

    // Restores form state from an 'input' event. Form values are element
    // PROPERTIES — mutation snapshots never carry them — so without this
    // step every replayed form would look untouched.
    function applyInput(doc, e) {
      var target = null;
      var wantTag = e.el ? String(e.el).split('#')[0].toUpperCase() : null;
      // Marker first: getElementById returns the FIRST duplicate, which can
      // restore the typed value into the wrong control silently.
      if (e.n != null) {
        target = resolveRef(doc, {
          n: e.n, tag: wantTag ? wantTag.toLowerCase() : null, path: null, id: null
        });
      }
      if (!target && e.id) {
        var byId = doc.getElementById(e.id);
        if (byId && (!wantTag || byId.tagName === wantTag)) target = byId;
      }
      if (!target && e.el) {
        try { target = doc.querySelector(e.el); } catch (err) { /* bad selector */ }
      }
      if (!target) return;
      if (e.redacted) {
        target.value = new Array((e.value_len || 0) + 1).join('•');
      } else if (e.value != null) {
        target.value = e.value;
      }
      if (e.checked != null) target.checked = e.checked;
    }

    function applyMutation(doc, patch) {
      var target = resolveRef(doc, patch);
      if (!target) { counters.patchFailures++; return; }
      if (patch.op === 'childList') {
        target.innerHTML = patch.html;
        harvestMarkers(target);
        updateIframeWarning(doc);
      } else if (patch.op === 'attributes') {
        // Refuse event-handler and malformed attribute names even if an
        // artifact (older recorder, third-party #3661 file) carries them.
        if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(patch.name) || /^on/i.test(patch.name)) return;
        if (patch.value === null) target.removeAttribute && target.removeAttribute(patch.name);
        else target.setAttribute && target.setAttribute(patch.name, patch.value);
      } else if (patch.op === 'characterData') {
        target.textContent = patch.value;
      }
    }

    // Element scroll restore (window scrolls are camera state, handled in
    // the application loop). Redacted scrolls are unresolvable BY DESIGN.
    function applyElementScroll(doc, e) {
      if (e.redacted) return;
      var target = null;
      if (e.n != null || e.id) {
        target = resolveRef(doc, { n: e.n, id: e.id, tag: null, path: null });
      }
      if (!target && e.el) {
        try { target = doc.querySelector(e.el); } catch (err) { /* bad selector */ }
      }
      if (!target) { counters.scrollFailures++; return; }
      try { target.scrollTop = e.y || 0; target.scrollLeft = e.x || 0; }
      catch (err) { counters.scrollFailures++; }
    }

    // ── Alignment self-check (per anchored discrete event) ──
    // Compares INDEPENDENT coordinate systems (Sol round-2 finding 10):
    //   camera assertions  — applied scroll/dims vs requested (±1px)
    //   rect               — recorded client rect vs replayed rect (±3px/edge)
    //   containment        — projected point inside replayed rect (2px)
    //   hit-test           — elementFromPoint resolves the anchor family
    //   stage transform    — iframe's REAL on-page offset vs computed (±2px)
    // Any failed predicate ⇒ status 'uncertain' with reasons, surfaced by
    // chips + lane + glyph. Redacted anchors are 'redacted' (unverifiable).
    function evaluateCheck(e) {
      if (!iframe || !domReady) return;
      var doc = iframe.contentDocument;
      if (!doc) return;
      var t = e.target;
      if (t.redacted) { e.__chk = { status: 'redacted', reasons: ['redacted target'] }; return; }
      var reasons = [];
      // Event-time shadow retargeting (recorder saw a composed path deeper
      // than e.target): the visible thing that was clicked is not in the
      // reconstruction, whatever the host's geometry says. Latches the
      // trial-level warning too — a post-snapshot attachShadow() leaves no
      // serialized marker for updateIframeWarning to find.
      if (t.shadow) {
        reasons.push('shadow content not captured');
        trialHadShadow = true;
        updateIframeWarning(doc);
      }

      // camera assertions
      var view = doc.defaultView;
      if (view) {
        if (Math.abs((view.scrollX || 0) - cam.x) > TOL_CAMERA ||
            Math.abs((view.scrollY || 0) - cam.y) > TOL_CAMERA) {
          reasons.push('applied scroll diverges (' +
            (view.scrollX || 0) + ',' + (view.scrollY || 0) + ' vs ' + cam.x + ',' + cam.y + ')');
        }
        var de = doc.documentElement;
        if (de && Math.abs(de.clientWidth - cam.cw) > TOL_CAMERA) {
          reasons.push('frame layout width ' + de.clientWidth + ' vs camera ' + cam.cw);
        }
      }

      // anchor resolution
      var target = null;
      if (t.n != null || t.id) {
        target = resolveRef(doc, { n: t.n, id: t.id, tag: t.tag, path: null });
      }
      if (!target) {
        reasons.push('anchor unresolved (' + (t.tag || '?') + (t.id ? '#' + t.id : '') + ')');
      } else if (target.hasAttribute && target.hasAttribute('data-ch-shadow')) {
        // The interaction retargeted to a shadow host whose content was not
        // captured — geometry would "verify" against a hollow box. Refuse.
        reasons.push('shadow content not captured');
      } else {
        var rr = null;
        try { rr = target.getBoundingClientRect(); } catch (err) { /* leave null */ }
        // recorded vs replayed rect, all four edges (conjunctive)
        if (rr && t.rect) {
          var dL = Math.abs(rr.left - t.rect[0]);
          var dT = Math.abs(rr.top - t.rect[1]);
          var dR = Math.abs((rr.left + rr.width) - (t.rect[0] + t.rect[2]));
          var dB = Math.abs((rr.top + rr.height) - (t.rect[1] + t.rect[3]));
          if (dL > TOL_RECT || dT > TOL_RECT || dR > TOL_RECT || dB > TOL_RECT) {
            reasons.push('target rect moved (Δ ' +
              Math.round(Math.max(dL, dT, dR, dB)) + 'px)');
          }
        }
        // containment of the projected point
        var px = e.cx, py = e.cy;
        if (px == null) { px = (e.x || 0) - cam.x; py = (e.y || 0) - cam.y; }
        if (rr && !(px >= rr.left - TOL_CONTAIN && px <= rr.left + rr.width + TOL_CONTAIN &&
                    py >= rr.top - TOL_CONTAIN && py <= rr.top + rr.height + TOL_CONTAIN)) {
          reasons.push('cursor outside target');
        }
        // independent hit-test
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

      // stage transform: the iframe's REAL rendered offset must match the
      // computed letterbox (catches viewer CSS/transform regressions).
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

    // Applies DOM patches AND folds camera state up to T. The camera fold
    // runs at BOTH tiers — trace-tier replays have no reconstruction but the
    // cursor projection still needs scroll/resize/snapshot state and the
    // stage transform. DOM operations are conditional on `doc`.
    function applyDomUpTo(T) {
      var doc = null;
      if (iframe) {
        if (!domReady) return;
        doc = iframe.contentDocument;
        if (!doc) return;
      }
      var events = trial().events;
      for (; appliedIdx < events.length; appliedIdx++) {
        var e = events[appliedIdx];
        if (e.t > T) break;
        if (e.kind === 'mutation') {
          if (doc) applyMutation(doc, e);
        } else if (e.kind === 'input') {
          if (doc) applyInput(doc, e);
        } else if (e.kind === 'scroll') {
          if (e.el != null || e.redacted) {
            if (doc) applyElementScroll(doc, e);
          } else {
            cam.x = e.x || 0; cam.y = e.y || 0;
            applyCamScroll();
          }
        } else if (e.kind === 'resize') {
          cam.w = e.w != null ? e.w : cam.w;
          cam.h = e.h != null ? e.h : cam.h;
          // Layout dims: recorded cw/ch when present; legacy events fall
          // back to the embedded visualViewport width, then to w minus the
          // session scrollbar delta — the SAME chain buildViewerModel uses
          // for cross-trial folding, so in-trial state can't diverge from
          // the seeds.
          cam.cw = e.cw != null ? e.cw
            : (e.vv && e.vv.width != null ? e.vv.width
              : (e.w != null ? e.w - sbW : cam.cw));
          cam.ch = e.ch != null ? e.ch
            : (e.vv && e.vv.height != null ? e.vv.height
              : (e.h != null ? e.h - sbH : cam.ch));
          pendingCamSize = true;   // folded — applied lazily, not per event
        } else if (DISCRETE_KINDS[e.kind]) {
          // Camera snapshot on the interaction is AUTHORITATIVE: scroll and
          // resize notifications dispatch asynchronously after programmatic
          // scrolls, so the snapshot may know state whose notification event
          // arrives later in the stream (which then applies as a no-op).
          if (e.sx != null) {
            if (e.sx !== cam.x || e.sy !== cam.y) {
              cam.x = e.sx; cam.y = e.sy;
              applyCamScroll();
            }
            if (e.cw != null && (e.cw !== cam.cw || e.ch !== cam.ch)) {
              cam.cw = e.cw; cam.ch = e.ch;
              cam.w = e.vw != null ? e.vw : cam.w;
              cam.h = e.vh != null ? e.vh : cam.h;
              pendingCamSize = true;
            }
          }
          if (doc && e.target && e.__chk == null) {
            if (pendingCamSize) { flushCamSize(); applyCamScroll(); }
            evaluateCheck(e);
          }
        }
      }
      if (pendingCamSize) { flushCamSize(); applyCamScroll(); }
    }

    function seek(T, fromScrub) {
      var wasBehind = T < playhead;
      playhead = Math.max(0, Math.min(T, trial().durMs));
      if (!fromScrub) scrub.value = String(playhead);
      if (iframe) {
        // Backward seek: patches are state snapshots but attribute /
        // characterData patches aren't reversible — rebuild from the
        // initial DOM and re-apply forward. Cheap for typical trials.
        if (wasBehind) rebuildFrame(playhead);
        else applyDomUpTo(playhead);
      } else {
        // Trace tier: no reconstruction, but the camera fold still runs so
        // the cursor projection tracks scroll/resize state.
        if (wasBehind) { seedCamera(); appliedIdx = 0; pendingCamSize = true; }
        applyDomUpTo(playhead);
      }
      drawOverlay();
      drawKeycast();
      drawLane();
      drawTicker();
      updateStatusChips();
      clock.textContent = fmtClock(playhead) + ' / ' + fmtClock(trial().durMs);
      scrub.setAttribute('aria-valuetext',
        fmtClock(playhead) + ' of ' + fmtClock(trial().durMs));
    }

    // ── Overlay drawing ──
    // Everything draws in CLIENT space then letterboxes onto the stage:
    // stagePt = (ox + clientX·k, oy + clientY·k). New recordings carry
    // cx/cy; legacy events re-project page − runningScroll at each point's
    // OWN timestamp (the scan folds scroll state as it walks). Trail
    // segments break at camera discontinuities (resize) and at uncertain
    // interactions — a confident-looking trail must never bridge a state
    // change it can't vouch for.
    function projectEvent(e, scroll) {
      var cx = e.cx != null ? e.cx : (e.x || 0) - scroll.x;
      var cy = e.cy != null ? e.cy : (e.y || 0) - scroll.y;
      return { x: ox + cx * k, y: oy + cy * k };
    }

    function drawOverlay() {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      var events = trial().events;
      var seed = trial().camera || {};
      var scroll = { x: seed.x || 0, y: seed.y || 0 };
      var segments = [[]];       // trail polyline segments (break on state change)
      var lastPos = null;
      var lastPosUncertain = false;
      var ripples = [];
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.t > playhead) break;
        if (e.kind === 'scroll' && e.el == null && !e.redacted) {
          scroll.x = e.x || 0; scroll.y = e.y || 0;
          if (e.cx == null) segments.push([]);   // legacy trail: camera jump
        } else if (DISCRETE_KINDS[e.kind] && e.sx != null &&
                   (e.sx !== scroll.x || e.sy !== scroll.y)) {
          // Interaction camera snapshots update the running scroll for the
          // legacy projection path too (async-notification gap).
          scroll.x = e.sx; scroll.y = e.sy;
        } else if (e.kind === 'resize') {
          segments.push([]);                     // camera discontinuity
        } else if (e.kind === 'mousemove' || e.kind === 'touchmove') {
          var p = projectEvent(e, scroll);
          p.t = e.t;
          if (e.t >= playhead - 2500) segments[segments.length - 1].push(p);
          lastPos = p;
        } else if (e.kind === 'click' || e.kind === 'mousedown' || e.kind === 'touchstart') {
          var q = projectEvent(e, scroll);
          q.t = e.t;
          lastPos = q;
          lastPosUncertain = !!(e.__chk && e.__chk.status !== 'ok');
          if (lastPosUncertain) segments.push([]);   // sever the trail
          if (e.t >= playhead - 600) ripples.push(q);
        }
      }
      // Cursor trail: fading polyline per segment
      segments.forEach(function (seg) {
        for (var s = 1; s < seg.length; s++) {
          var age = (playhead - seg[s].t) / 2500;
          ctx.strokeStyle = 'rgba(211,47,47,' + (0.85 * (1 - age)).toFixed(3) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(seg[s - 1].x, seg[s - 1].y);
          ctx.lineTo(seg[s].x, seg[s].y);
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
    // Pairs keydown with its keyup to get each key's [down, up] window, then
    // returns the ones "live" at T: down and not yet released, or released
    // within KEYCAST_FADE_MS. Non-redacted pairs match by e.code (handles
    // overlapping holds, e.g. Shift+A); redacted pairs carry no code (the
    // identity itself is withheld), so they match FIFO against each other —
    // an approximation that assumes redacted keystrokes don't overlap, true
    // for the single-field-typing case this exists to cover.
    function computeKeycastChips(T) {
      var events = trial().events;
      var openByCode = new Map();
      var redactedQueue = [];
      var tokens = [];
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.t > T) break;
        if (e.kind !== 'keydown' && e.kind !== 'keyup') continue;
        if (e.redacted) {
          if (e.kind === 'keydown') {
            var rtok = { redacted: true, downT: e.t, upT: null };
            redactedQueue.push(rtok);
            tokens.push(rtok);
          } else {
            var rt = redactedQueue.shift();
            if (rt) rt.upT = e.t;
          }
          continue;
        }
        if (e.kind === 'keydown') {
          // Auto-repeat sends keydown without an intervening keyup; keep the
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

    // ── Marker lane (per trial; redrawn per seek so check marks appear) ──
    function drawLane() {
      var lctx = lane.getContext('2d');
      lctx.clearRect(0, 0, lane.width, lane.height);
      lctx.fillStyle = '#f1efe9';
      lctx.fillRect(0, 0, lane.width, lane.height);
      var dur = Math.max(trial().durMs, 1);
      var events = trial().events;
      // Away-bands first (blur→focus, hidden→visible), then point markers.
      var awayStart = null;
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.kind === 'blur' || (e.kind === 'visibility' && e.hidden)) {
          if (awayStart === null) awayStart = e.t;
        } else if (e.kind === 'focus' || (e.kind === 'visibility' && !e.hidden)) {
          if (awayStart !== null) {
            lctx.fillStyle = 'rgba(245,124,0,0.45)';
            lctx.fillRect(awayStart / dur * lane.width, 0,
              Math.max(2, (e.t - awayStart) / dur * lane.width), lane.height);
            awayStart = null;
          }
        }
      }
      if (awayStart !== null) {   // still away at trial end
        lctx.fillStyle = 'rgba(245,124,0,0.45)';
        lctx.fillRect(awayStart / dur * lane.width, 0,
          lane.width - awayStart / dur * lane.width, lane.height);
      }
      events.forEach(function (e) {
        var color = MARKER_COLORS[e.kind];
        // Alignment-check marks: uncertain interactions paint amber so the
        // analyst can SCRUB TO the exact failing moment.
        if (e.__chk && e.__chk.status !== 'ok') color = UNCERTAIN_COLOR;
        if (!color) return;
        lctx.fillStyle = color;
        lctx.fillRect(e.t / dur * lane.width - 1, 2, 2, lane.height - 4);
      });
    }

    function checkSummary() {
      var events = trial().events;
      var ok = 0, uncertain = 0, redacted = 0;
      for (var i = 0; i < events.length; i++) {
        var c = events[i].__chk;
        if (!c) continue;
        if (c.status === 'ok') ok++;
        else if (c.status === 'redacted') redacted++;
        else uncertain++;
      }
      return { ok: ok, uncertain: uncertain, redacted: redacted };
    }

    function updateStatusChips() {
      var s = checkSummary();
      if (model.tier !== 'dom') {
        alignChip.textContent = '';
      } else if (model.legacy) {
        alignChip.textContent = '';   // the legacy chip already says it all
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
      var fails = counters.patchFailures + counters.scrollFailures;
      if (fails > 0) {
        failChip.textContent = '⚠ ' + fails + ' recorded change(s) could not be reapplied. Replay may diverge from the original session.';
        failChip.style.display = '';
      } else {
        failChip.style.display = 'none';
      }
    }

    function drawTicker() {
      var events = trial().events;
      var recent = [];
      for (var i = events.length - 1; i >= 0 && recent.length < 3; i--) {
        var e = events[i];
        if (e.t > playhead) continue;
        if (e.kind === 'mousemove' || e.kind === 'touchmove') continue;
        var label = e.kind;
        if (e.kind === 'paste' || e.kind === 'ch:drop') label += ' (' + (e.len == null ? '?' : e.len) + ' ch)';
        if (e.kind === 'keydown' && e.key) label += ' ' + JSON.stringify(e.key);
        if (e.kind === 'input') label += e.redacted ? ' [redacted, ' + e.value_len + ' ch]' : (' "' + String(e.value || '').slice(0, 24) + '"');
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
      if (playhead >= trial().durMs) {
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
      if (playhead >= trial().durMs) seek(0);
      playing = true;
      playBtn.textContent = '❚❚';
      playBtn.setAttribute('aria-label', 'Pause');
      lastFrame = null;
      requestAnimationFrame(tick);
    });
    speedSel.addEventListener('change', function () { speed = Number(speedSel.value) || 1; });
    scrub.addEventListener('input', function () { seek(Number(scrub.value), true); });
    scrub.addEventListener('keydown', function (ev) {
      var step = trial().durMs * 0.05;
      if (ev.key === 'PageUp') { seek(playhead + step); ev.preventDefault(); }
      else if (ev.key === 'PageDown') { seek(playhead - step); ev.preventDefault(); }
      else if (ev.key === 'Home') { seek(0); ev.preventDefault(); }
      else if (ev.key === 'End') { seek(trial().durMs); ev.preventDefault(); }
    });
    function selectTrial(i) {
      trialIdx = i;
      playing = false;
      playBtn.textContent = '▶';
      playBtn.setAttribute('aria-label', 'Play');
      scrub.max = String(trial().durMs);
      trialHadIframe = false;
      trialHadShadow = false;
      seedCamera();
      sizeStage();
      // DPR advisory: resolution-conditional CSS cannot be reproduced in an
      // iframe that inherits the analyst's DPR (declared limitation, loud).
      var recDpr = (trial().camera && trial().camera.dpr) ||
        (model.viewport && model.viewport.dpr) || null;
      if (recDpr && window.devicePixelRatio && recDpr !== window.devicePixelRatio) {
        dprChip.textContent = 'Recorded at DPR ' + recDpr + ', now viewing at DPR ' +
          window.devicePixelRatio + '. Resolution-dependent styling may differ.';
        dprChip.style.display = '';
      } else {
        dprChip.style.display = 'none';
      }
      if (iframe) {
        rebuildFrame(0);
      } else {
        appliedIdx = 0;
        pendingCamSize = true;
        flushCamSize();   // trace tier: transform initializes from the seed
      }
      seek(0);
    }
    trialSel.addEventListener('change', function () {
      selectTrial(Number(trialSel.value) || 0);
    });

    // Analyst-side resizes (report sidebar, browser zoom, window resize)
    // re-derive the stage box and transform — the reconstruction must track
    // its container, not just the recording (Sol round-1 finding 11).
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

    // Test/debug surface (used by the alignment battery; not a public API).
    mount._chReplayDebug = {
      seek: function (t) { seek(t); },
      selectTrial: selectTrial,
      getChecks: function () {
        return trial().events
          .filter(function (e) { return e.__chk; })
          .map(function (e) {
            return { t: e.t, kind: e.kind, status: e.__chk.status, reasons: e.__chk.reasons };
          });
      },
      getCamera: function () { return { x: cam.x, y: cam.y, cw: cam.cw, ch: cam.ch, k: k, ox: ox, oy: oy }; },
      getCounters: function () { return { patchFailures: counters.patchFailures, scrollFailures: counters.scrollFailures }; },
      frameReady: function () { return iframe ? domReady : true; }
    };

    // ── Boot ──
    selectTrial(0);
  };
})();
