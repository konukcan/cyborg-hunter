// src/replay/recorder.js
// Recorder engine: lifecycle state, event buffer, caps, listener registry.
//
// Deliberately DOM-free: it never touches document/window except to read
// viewport geometry (guarded), so it unit-tests in plain node. Capture
// modules (capture-trace.js, capture-dom.js) own all DOM listeners and
// register them here via addListener/addInterval so destroy() can tear
// everything down in one place. Assembly (singleton + capture wiring +
// window global) lives in index.js.
//
// Time base: every event carries an ABSOLUTE performance.now() `t`. This is
// the same clock CH core uses, so CH-derived data merges with no conversion;
// serializer.js converts to ms-since-session-start on the wire.

export const REPLAY_DEFAULTS = {
  participantId: 'unknown',
  tier: 'trace',               // 'trace' | 'dom'  (canvas reserved for v0.8)
  keys: 'full',                // 'full' | 'off'
  mouseHz: 30,                 // mousemove sampling ceiling
  redactSelector: '[data-ch-redact]',
  keepBait: false,             // keep honeypot/decoy nodes in DOM snapshots
  // Clipboard capture mode (spec §5.3). CH's default is LENGTH-ONLY on privacy
  // grounds: pasted text routinely carries identifying material from outside
  // the page. Set true for content mode (jsPsych-recorder behaviour).
  clipboardContent: false,
  root: null,                  // capture root; resolved at startSession (default document.body)
  autoSave: { mode: 'none' },  // 'datapipe' | 'download' | 'none'
  maxEventsPerTrial: 50000,
  // Size ceiling per trial, measured in CHARACTERS (JS string length / UTF-16
  // code units) — an approximate, monotonic proxy for payload size, deliberately
  // not called "bytes" since UTF-8 byte size can exceed it for non-ASCII content.
  // The event-count cap alone can't bound a recording that stays under 50k events
  // but stores multi-megabyte values (a giant textarea edited repeatedly, a large
  // DOM subtree). The budget covers events AND the initial DOM snapshot. ~8M chars
  // is far above any normal trial yet bounds a runaway before it breaks the tab or
  // the DataPipe/localStorage upload. Set null to disable.
  maxCharsPerTrial: 8000000,
  // Ceiling for the SESSION-level viewport stream (spec §2 `viewport_changes`).
  // Both caps above are per-trial, so the one stream that outlives trials is the
  // one they never see: a desktop drag-resize, or a mobile scroll with URL-bar
  // chrome, yields up to two entries per frame per channel for as long as it
  // lasts (measured: 5000 coalesced resizes → 365 KB while the trial buffer held
  // one event). Consecutive-identical states are dropped before this counts, so
  // 2000 distinct geometries (~150 KB) is far past any real session.
  maxViewportChanges: 2000
};

// States: created → session ⇄ trial → stopped; destroyed is terminal.
const VALID = {
  created:   ['session', 'destroyed'],
  session:   ['trial', 'stopped', 'destroyed'],
  trial:     ['session', 'stopped', 'destroyed'],
  stopped:   ['destroyed'],
  destroyed: []
};

export function createRecorder(userConfig) {
  var config = Object.assign({}, REPLAY_DEFAULTS, userConfig || {});
  config.autoSave = Object.assign({}, REPLAY_DEFAULTS.autoSave, (userConfig || {}).autoSave || {});

  var state = 'created';
  var listeners = [];
  var intervals = [];
  var trialCounter = 0;
  var trialStartHooks = [];   // capture modules subscribe (e.g. DOM snapshot)
  // Running byte estimate for the OPEN trial (reset per trial). Kept off the
  // serialized trial object (a WeakMap) so it never pollutes the wire payload.
  var trialChars = new WeakMap();
  // Trials that hit a per-trial cap. Tracking this per-trial (not via the
  // session-wide captureStopped flag) means one oversized trial stops only
  // itself; a subsequent trial captures fresh. captureStopped remains as a
  // session-level "something was truncated somewhere" signal for the meta.
  var stoppedTrials = new WeakSet();
  function estimateEventChars(o) {
    try { return JSON.stringify(o).length; } catch (e) { return 0; }
  }

  // The in-memory session buffer. Serialized by serializer.js at the end.
  var session = {
    participantId: config.participantId,
    tier: config.tier,
    keys: config.keys,
    sessionStart: null,        // performance.now() at startSession
    sessionStartEpoch: null,   // Date.now() at startSession (wire metadata + filename)
    viewport: null,
    stylesheets: [],           // filled by capture-dom at startSession (tier dom)
    trials: [],
    guardViolations: [],       // filled via GuardFriction.onViolation subscription
    // Session-level viewport stream (spec §2 `viewport_changes`). Resize and
    // visualViewport changes are NOT segment events in v2 — the format keeps
    // them in one session-wide array, merged with the event streams by `t`
    // (spec §7) — so capture-trace pushes them here rather than into a trial.
    viewportChanges: [],
    captureFailures: [],
    captureStopped: false,
    endReason: null,
    markerAttr: null           // set by capture-dom (serialization markers)
  };
  var currentTrial = null;
  // Opaque marker registry (capture-dom owns it; capture-trace reads it for
  // interaction anchors). The recorder never inspects it — staying DOM-free.
  var markers = null;

  function transition(to) {
    if (VALID[state].indexOf(to) === -1) {
      throw new Error(
        '[cyborg-hunter-replay] invalid lifecycle call: ' + state + ' → ' + to +
        '. Expected order: attach() → startSession() → (startTrial → endTrial)* → stopSession() → destroy().' +
        (state === 'created' ? ' Did you forget startSession()?' : '')
      );
    }
    state = to;
  }

  function newTrial(opts, implicit) {
    trialCounter++;
    return {
      trialIndex: trialCounter - 1,
      trialId: (opts && opts.trialId) || (implicit ? '__session__' : 'trial-' + (trialCounter - 1)),
      plugin: (opts && opts.plugin) || 'ch:standalone',
      implicit: !!implicit,
      // tLoad is THE trial time origin (see design §10). tStart/tDomReady are
      // #3661-parity fields; null when the host has no pre-render hook.
      tLoad: implicit ? session.sessionStart : performance.now(),
      tStart: (opts && opts.tStart) != null ? opts.tStart : null,
      tDomReady: (opts && opts.tDomReady) != null ? opts.tDomReady : null,
      tEnd: null,
      initialDom: '',
      events: []
    };
  }

  function closeTrial() {
    currentTrial.tEnd = performance.now();
    session.trials.push(currentTrial);
    currentTrial = null;
  }

  // Fire trial-start subscribers (used by capture-dom for the initial DOM
  // snapshot). A throwing hook is contained like any capture failure.
  function fireTrialStart(trial) {
    for (var i = 0; i < trialStartHooks.length; i++) {
      try { trialStartHooks[i](trial); } catch (e) {
        session.captureFailures.push({
          channel: 'trial_start_hook',
          message: e && e.message ? String(e.message) : String(e),
          t: performance.now()
        });
      }
    }
  }

  // Set once, when the viewport stream hits its ceiling, so the note about it
  // is recorded once rather than per dropped entry.
  var viewportCapped = false;

  // Two viewport entries describe the same geometry when every field but `t`
  // agrees. Written generically rather than against the six §2 field names: the
  // recorder is the sink for whatever shape the spec's ViewportState grows into.
  function sameViewportState(a, b) {
    var seen = 0;
    for (var k in b) {
      if (k === 't' || !Object.prototype.hasOwnProperty.call(b, k)) continue;
      if (a[k] !== b[k]) return false;
      seen++;
    }
    for (var j in a) {
      if (j === 't' || !Object.prototype.hasOwnProperty.call(a, j)) continue;
      seen--;
    }
    return seen === 0;
  }

  // Spec §5.7's total-stop signal, replacing v1's `ch:capture_stopped`. The
  // configured limit that was actually crossed is CH's own diagnostic, not part
  // of the standard event, so it rides in the vendor namespace (spec §9) rather
  // than as an unknown top-level field.
  function captureStoppedSentinel(t, detail) {
    return {
      type: 'recording.capture_stopped',
      t: t,
      reason: 'buffer_limit',
      extensions: { 'cyborg-hunter': detail },
    };
  }

  // The single path into the buffer, shared by `pushEvent` (v1 vocabulary,
  // capture-dom until Task 6) and `pushRecord` (v2). Lifecycle gate, implicit
  // trial opening and both per-trial caps live here, so the two vocabularies
  // can never disagree about when a recording stops.
  function storeEvent(e) {
    if (state === 'destroyed') {
      throw new Error('[cyborg-hunter-replay] event pushed to a destroyed recorder');
    }
    if (state === 'created' || state === 'stopped') return; // not recording
    if (!currentTrial) {
      currentTrial = newTrial(null, true);
      fireTrialStart(currentTrial);
    }
    // Per-trial stop (not the session-wide flag): a trial that already hit a
    // cap drops further events, but a fresh trial is unaffected.
    if (stoppedTrials.has(currentTrial)) return;
    if (currentTrial.events.length >= config.maxEventsPerTrial) {
      stoppedTrials.add(currentTrial);
      session.captureStopped = true;
      currentTrial.events.push(
        captureStoppedSentinel(e.t, { limit_events: config.maxEventsPerTrial }));
      return;
    }
    // Size cap: stop capturing once the trial's estimated serialized length
    // exceeds maxCharsPerTrial, so a few huge values can't blow up the payload
    // while staying under the event-count cap. The budget is SEEDED with the
    // initial DOM snapshot (stored on the trial, not pushed as an event) so a
    // multi-megabyte snapshot counts too rather than bypassing the cap.
    if (config.maxCharsPerTrial != null) {
      var soFar = trialChars.get(currentTrial);
      if (soFar == null) {
        soFar = currentTrial.initialDom ? currentTrial.initialDom.length : 0;
      }
      soFar += estimateEventChars(e);
      if (soFar > config.maxCharsPerTrial) {
        stoppedTrials.add(currentTrial);
        session.captureStopped = true;
        currentTrial.events.push(
          captureStoppedSentinel(e.t, { limit_chars: config.maxCharsPerTrial }));
        return;
      }
      trialChars.set(currentTrial, soFar);
    }
    currentTrial.events.push(e);
  }

  var recorder = {
    config: config,

    startSession: function () {
      transition('session');
      session.sessionStart = performance.now();
      session.sessionStartEpoch = Date.now();
      // Viewport geometry, if a window exists (absent in node tests).
      var w = typeof window !== 'undefined' ? window : null;
      // documentElement.clientWidth/Height = the LAYOUT width the page was
      // actually formatted against (innerWidth minus any classic scrollbar) —
      // the viewer sizes its reconstruction by this, not innerWidth.
      var de = typeof document !== 'undefined' && document.documentElement
        ? document.documentElement : null;
      session.viewport = w ? {
        width: w.innerWidth || null,
        height: w.innerHeight || null,
        client_width: de ? de.clientWidth || null : null,
        client_height: de ? de.clientHeight || null : null,
        dpr: w.devicePixelRatio || 1,
        visual_viewport: w.visualViewport ? {
          width: w.visualViewport.width, height: w.visualViewport.height,
          scale: w.visualViewport.scale
        } : null
      } : { width: null, height: null, client_width: null, client_height: null,
            dpr: null, visual_viewport: null };
      if (config.autoSave.mode === 'none') {
        console.warn('[cyborg-hunter-replay] autoSave.mode is "none" — the recording will be lost unless you call getRecording() yourself.');
      }
    },

    startTrial: function (opts) {
      if (state === 'trial') {
        // Standalone users may forget endTrial(); auto-close so events never
        // bleed across trials, and leave an auditable marker.
        this.pushEvent('ch:lifecycle_error', { reason: 'startTrial_without_endTrial' });
        closeTrial();
        state = 'session';
      } else if (currentTrial) {
        // An implicit trial is open (session-scoped events arrived before
        // the first explicit startTrial — e.g. a guard violation during the
        // instructions screen). Close it; overwriting currentTrial would
        // orphan those events. This is the NORMAL path, not an error.
        closeTrial();
      }
      transition('trial');
      currentTrial = newTrial(opts, false);
      fireTrialStart(currentTrial);
    },

    endTrial: function () {
      transition('session');
      if (currentTrial) closeTrial();
    },

    stopSession: function (reason) {
      if (state === 'trial') {
        state = 'session';
      }
      // Close whatever trial is open — explicit (state was 'trial') or
      // implicit (state 'session' with a lazily-opened trial).
      if (currentTrial) closeTrial();
      transition('stopped');
      session.endReason = reason || 'finished';
    },

    // Central event sink used by all capture modules.
    // Events land in the current trial; unbracketed events lazily open a
    // single implicit trial that spans the session (design §5).
    pushEvent: function (kind, payload, tOverride) {
      storeEvent(Object.assign(
        { t: tOverride != null ? tOverride : performance.now(), kind: kind },
        payload || {}));
    },

    // v2 sink (spec §5): the caller hands over a complete RecordedEvent minus
    // its `t`, because v2 payloads are per-type shapes with nested blocks
    // (`camera`, `anchor`, `mods`, `extensions`) rather than a flat bag merged
    // onto a `kind`. `type` leads the wire, `t` follows it, matching how the
    // fixtures read — and `t` is written AFTER the merge, so the sink owns the
    // timestamp even if a caller ever puts one in the record.
    pushRecord: function (record, tOverride) {
      var e = Object.assign({ type: record.type, t: null }, record);
      e.t = tOverride != null ? tOverride : performance.now();
      storeEvent(e);
    },

    // Session-level viewport stream (spec §2). Not a segment event: the format
    // keeps viewport geometry in one session-wide array, so a resize that
    // happens between trials still lands somewhere.
    //
    // Two guards the per-trial caps cannot give this stream. A state identical
    // to the last one says nothing, and a drag-resize settles into repeated
    // identical states between frames, which is the storm case. Past the
    // ceiling the stream stops growing and says so ONCE, through the same
    // capture-failure channel every other capture-side anomaly uses (spec §9's
    // vendor namespace on the wire). It deliberately does NOT set
    // `captureStopped`: spec §5.7's truncation means event capture stopped, and
    // a bounded metadata stream is not that.
    pushViewportChange: function (entry, tOverride) {
      if (state === 'destroyed') {
        throw new Error('[cyborg-hunter-replay] viewport change pushed to a destroyed recorder');
      }
      if (state === 'created' || state === 'stopped') return;
      var changes = session.viewportChanges;
      if (changes.length && sameViewportState(changes[changes.length - 1], entry)) return;
      var cap = config.maxViewportChanges;
      if (cap != null && changes.length >= cap) {
        if (!viewportCapped) {
          viewportCapped = true;
          recorder.captureFailure('viewport_changes', new Error(
            'viewport_changes cap reached (' + cap + '); later viewport geometry is not recorded'));
        }
        return;
      }
      changes.push(Object.assign({}, entry, {
        t: tOverride != null ? tOverride : performance.now()
      }));
    },

    // Capture-channel failure: record and keep going. Recording must never
    // break an experiment (design §6).
    captureFailure: function (channel, err) {
      session.captureFailures.push({
        channel: channel,
        message: err && err.message ? String(err.message) : String(err),
        t: performance.now()
      });
    },

    onTrialStart: function (fn) {
      trialStartHooks.push(fn);
    },

    setStylesheets: function (sheets) {
      session.stylesheets = sheets || [];
    },

    // Marker registry passthrough (opaque — see comment on `markers` above).
    setMarkers: function (reg) { markers = reg; },
    getMarkers: function () { return markers; },
    setMarkerAttr: function (attr) { session.markerAttr = attr || null; },

    // Listener/interval registry — single teardown point.
    addListener: function (target, event, handler, options) {
      target.addEventListener(event, handler, options || false);
      listeners.push({ target: target, event: event, handler: handler, options: options || false });
    },

    addInterval: function (id) {
      intervals.push(id);
    },

    // Read-only view for serializer + tests. Trials array includes the open
    // trial so mid-session getRecording() sees everything so far.
    // Deliberately readable AFTER destroy(): the buffer survives teardown
    // (only capture stops), mirroring CH core's getSessionReport contract —
    // destroy-then-serialize returns complete data instead of losing it.
    getState: function () {
      var trials = session.trials.slice();
      if (currentTrial) trials.push(currentTrial);
      return Object.assign({}, session, { trials: trials, state: state });
    },

    destroy: function () {
      if (state === 'destroyed') return;
      transition('destroyed');
      listeners.forEach(function (l) {
        if (l.options && l.options._isObserver) {
          l.handler.disconnect();
        } else {
          l.target.removeEventListener(l.event, l.handler, l.options);
        }
      });
      listeners = [];
      intervals.forEach(function (id) { clearInterval(id); });
      intervals = [];
    }
  };

  return recorder;
}
