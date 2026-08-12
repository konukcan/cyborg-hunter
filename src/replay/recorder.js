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

import { hasInheritedRedactionTaint } from './redaction.js';

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
  // Keyframe cadence (spec §3), read by capture-dom at every segment start.
  // The size-aware trigger takes a keyframe as soon as the patches since the
  // last one rival its size; this is the FALLBACK that bounds a span whose
  // DOM barely changes — at most this many segments per keyframe, so at most
  // this many segments a player must replay forward from a checkpoint. 1 =
  // keyframe every segment, which is what a display-wiping host wants (the
  // jsPsych adapter forces it). null disables the fallback, leaving only size.
  keyframeEvery: 10,
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
  // one event).
  //
  // The two storm shapes are bounded by different guards, and it is worth being
  // precise about which does what. A window sitting IDLE between frames repeats
  // the same geometry, and consecutive-identical dedup absorbs that entirely
  // (measured: 5000 → 1 entry). A window being actively DRAGGED reports a
  // distinct geometry every frame, which dedup cannot touch — that is what this
  // cap is for, and 2000 distinct states is about 33 s of continuous dragging at
  // 60 Hz, accumulated over the whole session. Past it the stream stops for good
  // and says so once through captureFailure, which means a participant who
  // fiddles with the window early keeps the early geometry and loses later
  // changes. That inversion is the known cost of a forward-only bound; the
  // alternative (dropping oldest) would leave the early segments unreplayable,
  // which is worse, since a viewport stream is state and not deltas. 2000 kept
  // deliberately at the v2 switchover: dedup now absorbs the cheap case, so
  // these are 2000 REAL geometries (~150 KB), already far past any real session.
  maxViewportChanges: 2000,
  // Ceiling for the SESSION-level guard-violation array (spec §9 vendor data).
  // The third stream the per-trial caps cannot see, and the most expensive per
  // entry: every `phase:'start'` violation carries a whole pre-scramble DOM
  // tree. `maxCharsPerTrial` bounds each tree, nothing bounded how many.
  //
  // 40 entries = 20 start/end episodes, so at most ~20 trees. A v2 keyframe
  // measures ~3.4x its v1 HTML (Task 2's measurement: 951 -> ~3.2 KB on the
  // demo page, and a mid-sized experiment DOM lands nearer 50 KB), which puts
  // the realistic ceiling around 1 MB of vendor payload — the same order the
  // viewport cap allows, and reached only by a session that left fullscreen
  // twenty times. CH's hard scoring has flagged such a participant long before
  // the eleventh episode; the trees after that are evidence nobody reads.
  //
  // Cost of a COUNT cap rather than a trees-only one: past the ceiling a
  // `phase:'end'` entry can be dropped while its `start` was kept, so the last
  // episode may read as unclosed. Accepted, because the array is unbounded in
  // both dimensions — a friction bug looping cheap violations grows it just as
  // surely as the trees do — and the ceiling sits far past any honest count.
  // Set null to disable.
  maxGuardViolations: 40
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
  // Channels with undelivered state to hand over before the recording closes
  // (see addPreCloseFlush). Drained once, then emptied, so stop-then-destroy
  // cannot run one twice.
  var preCloseFlushes = [];
  function runPreCloseFlushes() {
    var pending = preCloseFlushes;
    preCloseFlushes = [];
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](); } catch (e) { recorder.captureFailure('pre_close_flush', e); }
    }
  }
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
    sessionStartEpoch: null,   // Date.now() at startSession (wire time base + filename)
    userAgent: '',             // spec §2; read once at startSession
    // Spec §2's ViewportState — the SAME shape every `viewport_changes` entry
    // carries, because they describe the same thing at different times.
    viewport: null,
    // documentElement's client box, which §2's ViewportState has no room for
    // and CH's viewer sizes its reconstruction by. Vendor data (spec §9).
    viewportClient: null,
    observedRoot: null,        // selector of the observed subtree (spec §2); set by capture-dom
    // Did the page's shared redaction taint already hold nodes when this
    // recording started (redaction.js)? Read once at startSession, reported in
    // the vendor namespace, so an empty field in a second recording on one page
    // is diagnosable rather than ambiguous.
    inheritedRedactionTaint: false,
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
    endReason: null
  };
  var currentTrial = null;

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
      //
      // An implicit segment backdates its origin to the session start ONLY when
      // it is the first — spec §3's "unbracketed recordings are one whole-session
      // segment", where one segment genuinely owns the whole timeline. A
      // TRAILING implicit segment (events arriving after a bracketed trial
      // closed, e.g. the teardown flush, or a click between trials) opens when
      // it opens, and backdating it to 0 made the recording state two segments
      // that both own the same instant. That breaks §3's non-overlap rule
      // literally, and it breaks the viewer materially: the §3 origin is what
      // every player rebases segment-relative times by, so this segment's
      // playhead ran on the session clock while every other segment's ran on
      // its own. Found by T7's segment non-overlap check, which is the first
      // thing in the repo that compared one segment's end against the next
      // one's stated origin.
      tLoad: (implicit && trialCounter === 1) ? session.sessionStart : performance.now(),
      tStart: (opts && opts.tStart) != null ? opts.tStart : null,
      tDomReady: (opts && opts.tDomReady) != null ? opts.tDomReady : null,
      tEnd: null,
      // Spec §3: a keyframe is a DomNode tree, a continuation is null. Null
      // until the DOM capture's trial-start hook fills it, and on trace tier
      // it stays null for the whole recording, which is the honest statement
      // that no DOM was ever observed.
      initialDom: null,
      initialState: null,
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
  // The same, for the guard-violation array.
  var guardViolationsCapped = false;

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
  //
  // ONCE PER RECORDING (§5.7: "emitted once, into the segment open at stop
  // time"), which is also what makes top-level `truncated` a faithful mirror of
  // it — one flag, one signal. v1 fired it per trial, so a recording that hit a
  // cap in three trials claimed to have stopped capturing three times. The
  // per-trial RECOVERY is unchanged and is a different fact: one oversized trial
  // stops only itself, and the next captures fresh. What the recording says once
  // is that something, somewhere, was dropped.
  var captureStopSignalled = false;
  function signalCaptureStopped(trial, t, detail) {
    stoppedTrials.add(trial);
    session.captureStopped = true;
    if (captureStopSignalled) return;
    captureStopSignalled = true;
    trial.events.push({
      type: 'recording.capture_stopped',
      t: t,
      reason: 'buffer_limit',
      extensions: { 'cyborg-hunter': detail },
    });
  }

  // The single path into the buffer, behind `pushRecord`. Lifecycle gate,
  // implicit trial opening and both per-trial caps live here.
  function storeEvent(e) {
    if (state === 'destroyed') {
      throw new Error('[cyborg-hunter-replay] event pushed to a destroyed recorder');
    }
    if (state === 'created' || state === 'stopped') return; // not recording
    if (!currentTrial) {
      // RE-ENTRANT: the hooks below run while the caller is halfway through
      // pushing, and one of them is capture-dom's keyframe hook. That is why
      // capture-dom refuses to keyframe an implicit segment whose span already
      // has one (see its onTrialStart comment) — the ids in the record being
      // pushed were resolved against the span a keyframe here would reset.
      //
      // KNOWN LOSS, unchanged and deliberate: when this is the FIRST segment of
      // the recording, the span has no keyframe yet, so capture-dom must take
      // one — and the event that opened the segment already resolved its
      // `target` against the empty span, so it carries null. One event's target
      // id, on an unbracketed recording, at the only moment where the
      // alternative is a recording with no keyframe at all.
      currentTrial = newTrial(null, true);
      fireTrialStart(currentTrial);
    }
    // Per-trial stop (not the session-wide flag): a trial that already hit a
    // cap drops further events, but a fresh trial is unaffected.
    if (stoppedTrials.has(currentTrial)) return;
    if (currentTrial.events.length >= config.maxEventsPerTrial) {
      signalCaptureStopped(currentTrial, e.t, { limit_events: config.maxEventsPerTrial });
      return;
    }
    // Size cap: stop capturing once the trial's estimated serialized length
    // exceeds maxCharsPerTrial, so a few huge values can't blow up the payload
    // while staying under the event-count cap. The budget is SEEDED with the
    // keyframe (stored on the trial, not pushed as an event) so a
    // multi-megabyte snapshot counts too rather than bypassing the cap — see
    // `noteSnapshotChars`, which is where that seed now comes from.
    if (config.maxCharsPerTrial != null) {
      var soFar = trialChars.get(currentTrial) || 0;
      soFar += estimateEventChars(e);
      if (soFar > config.maxCharsPerTrial) {
        signalCaptureStopped(currentTrial, e.t, { limit_chars: config.maxCharsPerTrial });
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
      // Before any capture of this recording can add to it (see the field).
      session.inheritedRedactionTaint = hasInheritedRedactionTaint();
      // Viewport geometry, if a window exists (absent in node tests). Spec §2's
      // ViewportState, identical in shape to every `viewport_changes` entry.
      var w = typeof window !== 'undefined' ? window : null;
      var vv = w && w.visualViewport ? w.visualViewport : null;
      session.viewport = w ? {
        w: w.innerWidth || 0,
        h: w.innerHeight || 0,
        dpr: w.devicePixelRatio || 1,
        scale: vv && typeof vv.scale === 'number' ? vv.scale : 1,
        offset_x: vv ? (vv.offsetLeft || 0) : 0,
        offset_y: vv ? (vv.offsetTop || 0) : 0
      } : null;
      // documentElement.clientWidth/Height = the LAYOUT width the page was
      // actually formatted against (innerWidth minus any classic scrollbar) —
      // the viewer sizes its reconstruction by this, not innerWidth. Spec §2
      // has no field for it, so it travels as vendor data (spec §9).
      var de = typeof document !== 'undefined' && document.documentElement
        ? document.documentElement : null;
      session.viewportClient = de
        ? { w: de.clientWidth || 0, h: de.clientHeight || 0 } : null;
      session.userAgent = typeof navigator !== 'undefined' && navigator.userAgent
        ? String(navigator.userAgent) : '';
      if (config.autoSave.mode === 'none') {
        console.warn('[cyborg-hunter-replay] autoSave.mode is "none" — the recording will be lost unless you call getRecording() yourself.');
      }
    },

    startTrial: function (opts) {
      if (state === 'trial') {
        // Standalone users may forget endTrial(); auto-close so events never
        // bleed across trials, and leave an auditable marker. The marker is a
        // capture failure, not an event: spec §5.8 admits no vendor event types
        // in the stream, and this channel already carries CH's capture-side
        // anomalies to the analyst through the vendor extension.
        this.captureFailure('lifecycle',
          new Error('startTrial_without_endTrial: the open trial was auto-closed'));
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
      // BEFORE anything closes: a channel holding undelivered state gets to
      // deliver it into the still-open trial (F-5).
      runPreCloseFlushes();
      if (state === 'trial') {
        state = 'session';
      }
      // Close whatever trial is open — explicit (state was 'trial') or
      // implicit (state 'session' with a lazily-opened trial).
      if (currentTrial) closeTrial();
      transition('stopped');
      session.endReason = reason || 'finished';
    },

    // The event sink (spec §5): the caller hands over a complete RecordedEvent minus
    // its `t`. v2 payloads are per-type shapes with nested blocks (`camera`,
    // `anchor`, `mods`, `extensions`) rather than v1's flat bag merged onto a
    // `kind`. `type` leads the wire, `t` follows it, matching how the fixtures
    // read — and `t` is written AFTER the merge, so the sink owns the timestamp
    // even if a caller ever puts one in the record.
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

    // Guard-friction violations (spec §9's vendor namespace). NOT an event:
    // §5.8 forbids vendor types in the stream, and there is no standard event
    // for "the participant left fullscreen". The entry keeps its `t`, so a
    // viewer can still place it on the timeline beside the events.
    //
    // Capped like the viewport stream and for the same reason (a session-level
    // array no per-trial cap can see), with the same forward-only bound and the
    // same single note through captureFailure. Deliberately NOT captureStopped:
    // §5.7's truncation means EVENT capture stopped, and this is vendor data.
    pushGuardViolation: function (entry, tOverride) {
      if (state === 'destroyed') {
        throw new Error('[cyborg-hunter-replay] guard violation pushed to a destroyed recorder');
      }
      if (state === 'created' || state === 'stopped') return;
      var gcap = config.maxGuardViolations;
      if (gcap != null && session.guardViolations.length >= gcap) {
        if (!guardViolationsCapped) {
          guardViolationsCapped = true;
          recorder.captureFailure('guard_violations', new Error(
            'guard_violations cap reached (' + gcap + '); later guard violations ' +
            'are not recorded'));
        }
        return;
      }
      session.guardViolations.push(Object.assign({}, entry, {
        t: tOverride != null ? tOverride : performance.now()
      }));
    },

    // How many characters the keyframe payload of this trial takes.
    //
    // The keyframe lives ON the trial rather than in the event stream, so the
    // per-trial size cap cannot see it unless the capture module says. v1 read
    // `initialDom.length` off an HTML STRING; a v2 keyframe is a DomNode tree,
    // whose `.length` is undefined — and `undefined + n` is NaN, which compares
    // false against any cap, so the whole size budget would have failed silently
    // open. capture-dom measures the payload exactly (it has to anyway, to
    // decide whether the snapshot itself is over budget) and reports it here.
    noteSnapshotChars: function (trial, chars) {
      if (trial && typeof chars === 'number' && isFinite(chars)) {
        trialChars.set(trial, chars);
      }
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

    // Selector of the observed subtree (spec §2 `observed_root`); null means
    // "the document body", which is also what a trace-tier recording says.
    setObservedRoot: function (selector) {
      session.observedRoot = typeof selector === 'string' && selector ? selector : null;
    },

    // Listener/interval registry — single teardown point.
    addListener: function (target, event, handler, options) {
      target.addEventListener(event, handler, options || false);
      listeners.push({ target: target, event: event, handler: handler, options: options || false });
    },

    addInterval: function (id) {
      intervals.push(id);
    },

    // Work a capture channel must do before the recording closes, because it
    // holds state the browser has not delivered yet.
    //
    // The MutationObserver is the case that needs it: its callback is a
    // microtask, so DOM changes made in the same task as `stopSession()` — the
    // last thing a trial does before ending — sit in the observer's queue when
    // the recording closes, and disconnecting drops them with no trace. A
    // `takeRecords()` through the mapper turns that silent loss into the
    // patches the participant actually caused (T3 final review, F-5).
    //
    // Runs before the state transition in `stopSession` (so the events are
    // still accepted) and at the top of `destroy` (for a caller that tears down
    // without stopping — the buffer survives teardown either way). Each hook
    // runs at most once, and a throwing hook is contained like any other
    // capture channel.
    addPreCloseFlush: function (fn) {
      if (typeof fn === 'function') preCloseFlushes.push(fn);
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
      // A caller that tears down without stopping still gets its pending
      // batch: the buffer survives destroy() by contract, so the patches are
      // readable afterwards (F-5). A no-op after stopSession, which drained it.
      runPreCloseFlushes();
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
