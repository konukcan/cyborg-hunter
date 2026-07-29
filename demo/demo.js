// demo/demo.js
// Tour engine: 12-step navigation, {{path}} template substitution, capability
// snapshot, participant-id boot stamp. Renders STEPS from steps.js through
// the idempotent lifecycle helper (lifecycle.js) so every advance/Back/skip
// closes any open trial before optionally opening the next.
//
// Live-signal rail: event-driven via the monitor's onSignal callback +
// aggregation of completed trial reports (fast typing has no onSignal event —
// it's only computable at endTrial()), plus a 5s poll for session-only
// signals (viewport-width shifts have no onSignal event either; sidebar gets
// BOTH — see pollSessionSignals()).

import { STEPS, POSITIONING, CLOSING_CTA, CONFIG_CAVEAT, RAIL_GROUPS, RAIL_INTRO } from './steps.js';
import { makeLifecycle } from './lifecycle.js';
import { renderRail, light, acknowledge } from './rail.js';
import { buildPayload } from './payload.js';
import { runFinale } from './finale.js';

var SESSION_POLL_MS = 5000;

console.log('cyborg-hunter demo · library', (window.CyborgHunter && CyborgHunter.VERSION) || 'unknown');

function randomParticipantId() {
  // Math.random() === 0 renders as the 1-char string '0' (no decimal point),
  // which would slice down to only 3 characters without padding — padEnd to
  // 6 chars first so the slice below always has 4 to take.
  return 'DEMO-' + Math.random().toString(36).padEnd(6, '0').slice(2, 6);
}

// Resolves {{path.to.value}} against `signals` (signal-manifest.json's
// `signals` object — see steps.js's docblock) and the special {{version}}
// placeholder against the library's runtime VERSION.
function substitute(str, signals, version) {
  return str.replace(/\{\{([\w.]+)\}\}/g, function (_, path) {
    if (path === 'version') return version;
    var value = signals;
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (value == null) return '';
      value = value[parts[i]];
    }
    return value == null ? '' : String(value);
  });
}

function fullscreenIsActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
}

// Step 7's 1.5s fullscreen-entry race. Calls OUR OWN requestFullscreen() —
// not GuardFriction.requestFullscreen(), which fires the request and
// swallows any promise rejection (prior eng review) — so we get a real
// promise to race against a timeout and the 'fullscreenchange' event.
// Resolves once fullscreen is confirmed active; rejects on timeout,
// rejection, an unavailable API, or fullscreen ending before it settled.
function raceFullscreenEntry() {
  var el = document.documentElement;
  var reqFn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;

  return new Promise(function (resolve, reject) {
    var settled = false;
    var timerId = null;

    function cleanup() {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      document.removeEventListener('mozfullscreenchange', onChange);
      if (timerId) clearTimeout(timerId);
    }
    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function onChange() {
      if (fullscreenIsActive()) succeed(); else fail(new Error('fullscreen exited before entry settled'));
    }

    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    document.addEventListener('mozfullscreenchange', onChange);
    timerId = setTimeout(function () { fail(new Error('fullscreen entry timed out')); }, 1500);

    if (!reqFn) { fail(new Error('fullscreen API unavailable')); return; }
    var ownPromise;
    try {
      ownPromise = reqFn.call(el);
    } catch (e) {
      fail(e);
      return;
    }
    // Older prefixed APIs don't return a promise at all — fall through to
    // the fullscreenchange/timeout race above in that case.
    if (ownPromise && typeof ownPromise.then === 'function') {
      ownPromise.then(succeed, fail);
    }
  });
}

function showSmallMode() {
  var cols = document.querySelector('.cols');
  if (cols) cols.style.display = 'none';
  var el = document.getElementById('smallmode');
  el.hidden = false;
  el.innerHTML =
    '<p>' + POSITIONING + '</p>' +
    '<p>This tour needs a desktop-sized browser window. Explore the docs instead:</p>' +
    '<p><a href="' + CLOSING_CTA.primaryHref + '">Quickstart</a> &middot; ' +
    '<a href="' + CLOSING_CTA.githubHref + '">GitHub</a></p>';
}

function boot() {
  var participantId = randomParticipantId();
  document.getElementById('pid').textContent = participantId;

  // Snapshotted ONCE at boot — later resizes rearrange layout but never
  // terminate a running session (states-and-edge-rules: 830→700→900px case).
  var capabilities = { interactive: window.innerWidth >= 820 };

  if (!capabilities.interactive) {
    showSmallMode();
    return;
  }

  fetch('./signal-manifest.json')
    .then(function (r) { return r.json(); })
    .then(function (manifest) { startTour(participantId, capabilities, manifest); })
    .catch(function (err) {
      console.error('cyborg-hunter demo: failed to load signal-manifest.json', err);
    });
}

// Row label lookup (RAIL_GROUPS -> {key: label}), used by acknowledge() so
// the inline "✓ detected" strip text lives in one place (steps.js) rather
// than being retyped at every signal call site.
var RAIL_LABELS = {};
['detectors', 'guard', 'recording'].forEach(function (g) {
  RAIL_GROUPS[g].forEach(function (r) { RAIL_LABELS[r.key] = r.label; });
});

function startTour(participantId, capabilities, manifest) {
  var version = (window.CyborgHunter && CyborgHunter.VERSION) || 'unknown';

  var state = {
    stepIndex: 0,
    // C10 (results): results.js only receives (container, state, manifest) —
    // not the monitor/participantId closures below — so it needs its own
    // copy to build the SAME payload buildDownloadFile('sessionData') does.
    participantId: participantId,
    // Snapshotted once, in goTo(), the moment the results step is entered
    // (see below) — later than that and the tour's own interactive steps
    // are over anyway, so a live reference isn't needed.
    sessionReport: null,
    capabilities: capabilities,
    replayOptIn: false,
    lampCounts: {},
    act2Skipped: false,
    violations: [],
    trialReports: [],
    // C7 (guard act): the token GuardFriction.start() returns — needed by
    // stop() — and per-reason violation tallies for the guard-cheat step's
    // chip row.
    guardStopToken: null,
    chipCounts: {},
    // C8 (replay opt-in): the attached CyborgHunterReplay instance (stays
    // null unless the welcome-screen toggle was ON at "Start the tour"),
    // and its finalized recording, cached so the download button and the
    // "show as text" fallback always agree.
    recorder: null,
    replayRecording: null,
    // C9 (jsPsych finale): guards step 10 against re-running on a Back-then-
    // forward revisit — CyborgHunter.init() is a module-level singleton, so
    // a second run would destroy-and-recreate yet another instance and push
    // duplicate trial reports into state.trialReports (see finale.js).
    // finaleFailed remembers WHICH outcome so a revisit's status text is
    // accurate instead of the stale "Loading jsPsych…" default.
    finaleStarted: false,
    finaleFailed: false,
    // True once finale.js's vendor load succeeded and it's about to call
    // initJsPsych() — i.e. about to destroy the outer CyborgHunter monitor
    // (see goTo()'s lifecycle.transitionTo guard below). Deliberately NOT
    // the same as finaleStarted: in the degraded (vendor-missing) path the
    // outer monitor is never touched, so Back-navigation through earlier
    // steps must keep working normally there.
    monitorDestroyed: false
  };

  var cardEl = document.getElementById('card');
  var progressEl = document.getElementById('progress');
  var railEl = document.getElementById('rail');

  renderRail(railEl, { groups: RAIL_GROUPS, intro: RAIL_INTRO });

  // Lamp wiring is lifecycle-bound (spec: "starts and stops with the tour").
  // startLampWiring/stopLampWiring are idempotent: entering the results step
  // stops the poll and turns every lamp handler into a no-op (the interactive
  // tasks are over; the monitor itself keeps running — finalization belongs
  // to the payload task); navigating Back into the tour restarts it.
  var lampWiringActive = false;
  var sessionPollId = null;
  // Step 6 (autotype)'s char-by-char animation runs its own setInterval,
  // outside the library entirely — tracked here so goTo() can cancel a
  // still-running animation on navigation (Back/Continue/skip are all valid
  // mid-animation, per "advance is always available"), instead of leaving it
  // ticking against a detached DOM node until it finishes on its own.
  var autotypeIntervalId = null;

  function stopAutotype() {
    if (autotypeIntervalId) {
      clearInterval(autotypeIntervalId);
      autotypeIntervalId = null;
    }
  }

  function startLampWiring() {
    if (lampWiringActive) return;
    lampWiringActive = true;
    sessionPollId = setInterval(pollSessionSignals, SESSION_POLL_MS);
  }

  function stopLampWiring() {
    if (!lampWiringActive) return;
    lampWiringActive = false;
    clearInterval(sessionPollId);
    sessionPollId = null;
  }

  // Lights `key` only if `count` is a new high — makes both the event-driven
  // path (increments a running local count) and the 5s poll (recomputes the
  // true count from the library's own data) safe to call without double-
  // counting or re-pulsing a lamp that hasn't actually changed.
  function syncCountLamp(key, count, hard, label) {
    if (count > (state.lampCounts[key] || 0)) {
      state.lampCounts[key] = count;
      light(key, count, { hard: hard });
      if (label) acknowledge(cardEl, label);
    }
  }

  function handleSignal(sig) {
    if (!lampWiringActive) return;
    var n;
    switch (sig.type) {
      case 'paste':
        n = (state.lampCounts.paste || 0) + 1;
        syncCountLamp('paste', n, n >= manifest.signals.paste.hardCountThreshold, RAIL_LABELS.paste);
        break;
      case 'copy':
      case 'cut':
        n = (state.lampCounts.copy || 0) + 1;
        syncCountLamp('copy', n, false, RAIL_LABELS.copy);
        break;
      case 'drop':
        n = (state.lampCounts.drop || 0) + 1;
        syncCountLamp('drop', n, n >= manifest.signals.drop.hardCountThreshold, RAIL_LABELS.drop);
        break;
      case 'tabReturn':
        var duration = (sig.data && sig.data.duration_ms) || 0;
        if (duration >= 10000) {
          n = (state.lampCounts.tabAwayLong || 0) + 1;
          syncCountLamp('tabAwayLong', n, false, RAIL_LABELS.tabAwayLong);
        } else if (duration > manifest.signals.tabAway.durationMs) {
          // Strict > matches the library convention: a tab-away exactly at
          // the cutoff is an unscored flicker (scoring.js:63, summary.js
          // "same `>` boundary" comment, session-timeline.js flicker bin).
          n = (state.lampCounts.tabAwayMid || 0) + 1;
          syncCountLamp('tabAwayMid', n, false, RAIL_LABELS.tabAwayMid);
        }
        break;
      case 'sidebarOpened':
        n = (state.lampCounts.sidebar || 0) + 1;
        syncCountLamp('sidebar', n, false, RAIL_LABELS.sidebar);
        break;
      case 'typingOutsideExperiment':
        n = (state.lampCounts.foreignInput || 0) + 1;
        syncCountLamp('foreignInput', n, false, RAIL_LABELS.foreignInput);
        break;
      case 'syntheticInsertion':
        n = (state.lampCounts.syntheticInsertion || 0) + 1;
        syncCountLamp('syntheticInsertion', n, true, RAIL_LABELS.syntheticInsertion);
        break;
      case 'keyboardShortcut':
        n = (state.lampCounts.devTools || 0) + 1;
        syncCountLamp('devTools', n, false, RAIL_LABELS.devTools);
        break;
      default:
        break;
    }
  }

  // Fast typing has no onSignal event — computeTypingSpeed() only runs
  // inside endTrial() (src/core/signals/typing.js), so it's only observable
  // once a trial closes, via the lifecycle helper's onTrialReport hook.
  function handleTrialReport(report) {
    // Accumulated for the payload regardless of lamp-wiring state — the
    // monitor keeps recording after stopLampWiring() (interactive tasks
    // being over doesn't mean trials stop closing), and the download step
    // needs every trial the visitor actually ran.
    state.trialReports.push(report);
    if (!lampWiringActive) return;
    var typingSpeed = report.trialSignals && report.trialSignals.soft && report.trialSignals.soft.typingSpeed;
    if (typingSpeed && typingSpeed.hit) {
      var n = (state.lampCounts.fastTyping || 0) + 1;
      syncCountLamp('fastTyping', n, false, RAIL_LABELS.fastTyping);
    }
  }

  // Session-only signals with no (or incomplete) onSignal coverage:
  //   - viewportWidthShifts: browser.js's ResizeObserver never calls
  //     fireSignal() at all — the poll is its only path.
  //   - sidebarEvents: the innerWidth_delta method fires 'sidebarOpened'
  //     (handled instantly above), but the layout_compression method does
  //     NOT fire a signal — the poll is a backstop that also catches those.
  //   - honeypot bait: GuardHoneypot has no event callback, only polled getters.
  function pollSessionSignals() {
    var report = monitor.getSessionReport();

    var sidebarOpens = report.sidebarEvents.filter(function (e) { return e.type === 'opened'; }).length;
    syncCountLamp('sidebar', sidebarOpens, false, RAIL_LABELS.sidebar);

    syncCountLamp('viewport', report.viewportWidthShifts.length, false, RAIL_LABELS.viewport);

    if (window.GuardHoneypot) {
      var hp = window.GuardHoneypot.getHoneypotData();
      if (hp.ai_use) syncCountLamp('honeypot', 1, true, RAIL_LABELS.honeypot);
    }
  }

  var monitor = window.CyborgHunter.init({
    participantId: participantId,
    preset: 'standard',
    onSignal: handleSignal
  });
  monitor.startSession();
  // Bait stays passively armed for the whole tour (spec: "No honeypot step
  // card — bait stays passively armed; a pre-recorded agent trace shows it
  // working"). No dedicated step calls this, so it has to happen here —
  // without it, pollSessionSignals()'s window.GuardHoneypot.getHoneypotData()
  // call below always reads the pre-injection default (ai_use: false) and
  // the honeypot rail lamp can never light.
  if (window.GuardHoneypot) {
    window.GuardHoneypot.init({ friction: window.GuardFriction });
  }
  // Recorder-like bridge for makeLifecycle's optional recorder param (C8).
  // A live proxy rather than passing state.recorder directly: replay only
  // attaches (if the visitor opted in) inside the "Start the tour" click,
  // which runs AFTER this lifecycle is constructed — reading state.recorder
  // at call time lets the very first trial (step 2) get bracketed too.
  var recorderBridge = {
    startTrial: function (opts) { if (state.recorder) state.recorder.startTrial(opts); },
    endTrial: function () { if (state.recorder) state.recorder.endTrial(); }
  };
  var lifecycle = makeLifecycle(monitor, { onTrialReport: handleTrialReport, recorder: recorderBridge });

  // Tab-close hygiene: don't leave the poll running into page teardown.
  window.addEventListener('pagehide', stopLampWiring);

  // Act-2 violations (GuardFriction is a separate global, not part of the
  // CyborgHunter monitor). Counts each violation the moment it starts, for
  // an immediately responsive lamp — not the same count as the honeypot's
  // own start/end-paired violations log.
  if (window.GuardFriction && typeof window.GuardFriction.onViolation === 'function') {
    window.GuardFriction.onViolation(function (violation) {
      // Recorded for the payload's guardFriction.violations[] regardless of
      // lamp-wiring state (see handleTrialReport's comment above — same reasoning).
      state.violations.push(violation);
      // Violation chips (type × count) live only in the guard-cheat step's
      // task panel — tally + repaint them only while that step is showing.
      var currentTask = STEPS[state.stepIndex].task;
      if (violation.phase === 'start' && currentTask && currentTask.kind === 'guard-cheat') {
        state.chipCounts[violation.reason] = (state.chipCounts[violation.reason] || 0) + 1;
        renderViolationChips();
      }
      if (!lampWiringActive) return;
      if (violation.phase !== 'start') return;
      var n = (state.lampCounts.guardViolations || 0) + 1;
      syncCountLamp('guardViolations', n, true, RAIL_LABELS.guardViolations);
    });
  }

  // ----- C7: guard act -------------------------------------------------

  // Standalone GuardFriction.start() — not the jsPsych entryTrial() helper,
  // since this demo has no jsPsych instance until the finale trials. Only
  // called after raceFullscreenEntry() already confirmed fullscreen is
  // active: start() runs an immediate is-fullscreen check and would log a
  // false 'not_fullscreen' violation if called first.
  function startGuardFriction() {
    try {
      if (window.GuardFriction && typeof window.GuardFriction.start === 'function') {
        state.guardStopToken = window.GuardFriction.start({});
      }
    } catch (err) {
      console.warn('cyborg-hunter demo: GuardFriction.start failed', err);
      state.guardStopToken = null;
    }
  }

  // Idempotent: state.guardStopToken is cleared after the first successful
  // stop() call, so reaching guard-finish normally AND skipping past it
  // (skipToFinale()/Alt+S) never double-stops.
  function finalizeGuard() {
    if (!state.guardStopToken) return;
    var token = state.guardStopToken;
    state.guardStopToken = null;
    try {
      if (window.GuardFriction && typeof window.GuardFriction.stop === 'function') {
        window.GuardFriction.stop(token);
      }
    } catch (err) {
      console.warn('cyborg-hunter demo: GuardFriction.stop failed', err);
    }
  }

  function renderViolationChips() {
    var container = cardEl.querySelector('[data-role="violation-chips"]');
    if (!container) return;
    container.innerHTML = Object.keys(state.chipCounts).map(function (reason) {
      return '<span class="chip hot">' + reason + ' × ' + state.chipCounts[reason] + '</span>';
    }).join('');
  }

  // Renders the fallback note (steps.js copy if the task defines one, else
  // a minimal inline string) and, if not already offered, a "Skip to
  // finale" link — reusing the same data-key the card's click delegation
  // already handles. The primary "Enter fullscreen" button stays enabled
  // for a retry either way (advance is never fully blocked).
  function showFullscreenFallback() {
    state.act2Skipped = true;
    var step = STEPS[state.stepIndex];
    var note = cardEl.querySelector('.fallback-note');
    if (note) {
      note.textContent = (step.task && step.task.fallbackNote) ||
        "Fullscreen didn't engage in time, so Act 2's enforcement can't run in this browser. That's fine — skip ahead; everything else in the tour still works.";
      note.hidden = false;
    }
    if (!cardEl.querySelector('a[data-key="skipToFinale"]')) {
      var secondary = document.createElement('p');
      secondary.className = 'secondary';
      secondary.innerHTML = '<a href="#" data-key="skipToFinale">Skip to finale</a>';
      cardEl.appendChild(secondary);
    }
  }

  // Drives step 7's fullscreen-entry race. A guard API absence (bundle
  // failed to load) is treated the same as a failed race — fallback + skip,
  // never a throw — since advancing into guard-cheat with no guard running
  // would silently pretend enforcement is active when it isn't.
  function handleFullscreenEntry(button) {
    var stepAtAttempt = state.stepIndex;
    if (button) button.disabled = true;
    raceFullscreenEntry().then(function () {
      if (state.stepIndex !== stepAtAttempt) return; // navigated away mid-race
      if (button) button.disabled = false;
      if (!window.GuardFriction || typeof window.GuardFriction.start !== 'function') {
        console.warn('cyborg-hunter demo: GuardFriction unavailable — degrading to fallback');
        showFullscreenFallback();
        return;
      }
      // Clears a flag a PRIOR failed attempt may have set — this retry
      // actually got into Act 2, so it's no longer accurate to call it skipped.
      state.act2Skipped = false;
      startGuardFriction();
      goTo(state.stepIndex + 1);
    }).catch(function () {
      if (state.stepIndex !== stepAtAttempt) return;
      if (button) button.disabled = false;
      showFullscreenFallback();
    });
  }

  // ----- C8: replay opt-in ----------------------------------------------

  // Attaches the standalone replay recorder if the welcome-screen toggle
  // was ON. Runs synchronously inside the "Start the tour" click handler,
  // before goTo(1) opens step 2's trial — recorderBridge reads
  // state.recorder live, so as long as this finishes first, the very first
  // trial gets bracketed too.
  function startReplayIfOptedIn() {
    if (!state.replayOptIn) return;
    try {
      if (!window.CyborgHunterReplay || typeof window.CyborgHunterReplay.attach !== 'function') {
        throw new Error('CyborgHunterReplay unavailable');
      }
      state.recorder = window.CyborgHunterReplay.attach({
        participantId: participantId,
        tier: 'dom',
        autoSave: { mode: 'none' }
      });
      state.recorder.startSession();
      var recEl = document.getElementById('rec');
      if (recEl) recEl.hidden = false;
    } catch (err) {
      console.warn('cyborg-hunter demo: replay opt-in failed, continuing without a recording', err);
      state.replayOptIn = false;
      state.recorder = null;
    }
  }

  // Idempotent: recorder.stopSession() throws if called on an
  // already-stopped recorder (recorder.js's lifecycle state machine), so
  // the serialized recording is cached after the first call and handed
  // back unchanged to every later caller (download click, then "show as
  // text").
  function finalizeReplay() {
    if (!state.recorder) return null;
    if (!state.replayRecording) {
      try {
        state.recorder.stopSession('finished');
        state.replayRecording = state.recorder.getRecording();
      } catch (err) {
        console.warn('cyborg-hunter demo: replay finalize failed', err);
        state.replayRecording = null;
      }
    }
    return state.replayRecording;
  }

  function tpl(str) {
    return substitute(str, manifest.signals, version);
  }

  function guardedActIndex() {
    return STEPS.findIndex(function (s) { return s.act === 'act2'; });
  }

  function finaleIndex() {
    return STEPS.findIndex(function (s) { return s.act === 'finale'; });
  }

  // .eyebrow .act2 (demo.css) colors the "Act 2" prefix red — it's a
  // descendant selector, so act2 steps need that prefix wrapped in its own span.
  function renderEyebrow(step) {
    if (step.act !== 'act2') return step.eyebrow;
    var idx = step.eyebrow.indexOf('·');
    if (idx === -1) return step.eyebrow;
    var prefix = step.eyebrow.slice(0, idx).trim();
    var rest = step.eyebrow.slice(idx);
    return '<span class="act2">' + prefix + '</span> ' + rest;
  }

  // Builds the { filename, data } pair for one downloads-step file button.
  // Called both by the download click handler and the "show as text"
  // fallback, so both always agree on exactly what would have been saved.
  function buildDownloadFile(key) {
    if (key === 'sessionData') {
      // Wrap each raw endTrial() report the way the jsPsych extension's
      // on_finish() does — { integrity: report } — so ingest.js's Shape-1
      // reader (t[intField], default 'integrity') finds it (demo/payload.js).
      var trials = state.trialReports.map(function (r) {
        return { trialId: r.trialId, integrity: r };
      });
      var payload = buildPayload({
        pid: participantId,
        trials: trials,
        sessionReport: monitor.getSessionReport(),
        violations: state.violations
      });
      return { filename: participantId + '.json', data: payload };
    }
    if (key === 'replay') {
      // renderDownloadsPanel() already drops this button when
      // !state.replayOptIn, so this is only reachable with a real attempt
      // to attach — but guard anyway in case opt-in silently failed.
      if (!state.replayOptIn) return null;
      var recording = finalizeReplay();
      if (!recording) return null;
      // Epoch from the recording's own meta when present (mirrors
      // persistence.js's replayFilename(), which isn't exposed on the
      // standalone window.CyborgHunterReplay global) else Date.now().
      var epoch = Date.now();
      if (recording.metadata && recording.metadata.start_time) {
        var parsedEpoch = Date.parse(recording.metadata.start_time);
        if (!isNaN(parsedEpoch)) epoch = parsedEpoch;
      }
      return {
        filename: participantId + '-replay-' + epoch + '.json',
        data: recording
      };
    }
    if (key === 'config') {
      return {
        filename: 'cyborg-hunter.config.json',
        data: { dataDir: '.', filePattern: 'DEMO-*.json', participantIdField: 'participantId' }
      };
    }
    return null;
  }

  // Synchronously builds a Blob + object URL and clicks a throwaway <a
  // download> — must run inside the same call stack as the button's click
  // handler (its own user gesture) so the browser never treats it as a
  // popup/auto-download.
  function triggerDownload(filename, data) {
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Download-failure fallback: opens the shared per-step <dialog> with the
  // file's JSON in a selectable <pre> for manual copy/save.
  function openFileTextDialog(filename, json) {
    var dlg = cardEl.querySelector('dialog.filetext-dialog');
    if (!dlg) return;
    dlg.querySelector('h3').textContent = filename;
    dlg.querySelector('pre').textContent = json;
    dlg.showModal();
  }

  function renderDownloadsPanel(task) {
    // Replay opt-out drops the replay file from the download step entirely
    // (spec: "downloads drop the replay file").
    var files = task.files.filter(function (f) {
      return f.key !== 'replay' || state.replayOptIn;
    });
    // scramble coupling: same .jspsych-content convention as renderTaskPanel
    // below — GuardFriction's obfuscateContent() only touches
    // getJsPsychContent()'s match, so this class keeps the downloads panel a
    // valid scramble target too (moot in practice: guard is long stopped by
    // this step, but the class is applied uniformly regardless of step).
    var parts = ['<div class="task jspsych-content">', '<p class="label">' + task.kind + '</p>'];
    parts.push('<div class="files">' + files.map(function (f) {
      // Config caveat (spec :182/:288): first-party copy, so innerHTML is
      // safe here the same as every other steps.js string this panel
      // renders (task.description, f.label, etc.) — rendered directly under
      // the config file's Save/show-as-text row, not restructuring the panel.
      var caveat = f.key === 'config'
        ? '<p class="file-caveat" data-role="config-caveat">' + tpl(CONFIG_CAVEAT) + '</p>'
        : '';
      return (
        '<div class="file">' +
        '<div class="file-info">' + f.label + '<small>' + f.filename + '</small>' +
        '<span class="file-desc">' + f.description + '</span></div>' +
        '<div class="file-actions">' +
        '<button class="btn" data-action="download" data-key="' + f.key +
        '" data-saved-label="' + f.savedLabel + '">Save</button>' +
        '<a href="#" data-action="showtext" data-key="' + f.key + '">show as text</a>' +
        '</div>' + caveat + '</div>'
      );
    }).join('') + '</div>');
    parts.push(
      '<dialog class="filetext-dialog"><h3></h3><pre></pre>' +
      '<button class="btn" data-action="close-dialog">Close</button></dialog>'
    );
    parts.push('</div>');
    return parts.join('');
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ----- Step 6: autotype ------------------------------------------------
  // Drives synthetic insertion + fast typing FOR REAL, not just visually.
  // src/core/signals/typing.js flags an 'input' event as synthetic when it
  // carries inputType 'insertText' and arrives more than syntheticGapMs
  // (100ms, standard preset) after the last keydown — so every character
  // here is written via .value + a manually dispatched InputEvent, and no
  // keydown is ever fired. The same dispatched events push editTimestamps,
  // so computeTypingSpeed() (called at endTrial) sees real per-character
  // timestamps ~28ms apart and reports genuine charsPerSec — comfortably
  // over both the copy's ">20cps" claim and the library's real 10cps
  // threshold (signal-manifest.json). No library changes; this is the
  // library's own detector, driven honestly.
  function runAutotype(button) {
    if (button.disabled) return;
    var task = STEPS[state.stepIndex].task;
    var field = cardEl.querySelector('[data-role="autotype-field"]');
    if (!field) return;

    var text = task.autotypeText;
    var caret = '▏'; // ▏ — visible caret glyph, part of the field's own text
    var typed = '';
    var i = 0;

    button.disabled = true;
    button.textContent = tpl(task.busyLabel);
    field.readOnly = true;
    field.classList.add('busy');
    field.value = caret;

    autotypeIntervalId = setInterval(function () {
      if (i >= text.length) {
        stopAutotype();
        field.value = typed;
        field.readOnly = false;
        field.classList.remove('busy');
        button.textContent = tpl(task.doneLabel);
        return;
      }
      var ch = text[i];
      typed += ch;
      field.value = typed + caret;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      i++;
    }, 35);
  }

  // Renders step 10's task panel: a mount point for the two live jsPsych
  // trials (finale.js's display_element target) plus the labeled code-
  // snippet split (steps.js's task.snippetSplit — actual code, not just a
  // label/file reference). The live-trial status paragraph and the
  // vendor/load-failure degradation note (task.degradedNote) are updated by
  // runFinaleStep() below once finale.js's promise settles; advance stays
  // available the whole time (spec: "advance always available").
  function renderFinalePanel(task) {
    var parts = ['<div class="task jspsych-content">', '<p class="label">' + task.kind + '</p>'];
    parts.push('<p class="hint">' + task.trialCount + ' trials via jsPsych</p>');
    parts.push(
      '<div class="finale-run">' +
      '<div class="finale-mount" data-role="finale-mount"></div>' +
      '<p class="hint" data-role="finale-status">Loading jsPsych…</p>' +
      '<p class="rule finale-note" hidden></p>' +
      '</div>'
    );
    parts.push('<div class="finale-snippets">' + task.snippetSplit.map(function (s) {
      return (
        '<p class="hint">' + s.label + ' — <code>' + s.file + '</code></p>' +
        '<pre><code>' + escHtml(s.code) + '</code></pre>'
      );
    }).join('') + '</div>');
    parts.push('</div>');
    return parts.join('');
  }

  function renderTaskPanel(task) {
    if (!task) return '';
    if (task.kind === 'downloads') return renderDownloadsPanel(task);
    if (task.kind === 'jspsych-finale') return renderFinalePanel(task);
    // scramble coupling: GuardFriction's obfuscateContent() only touches
    // getJsPsychContent()'s match (.jspsych-content / .jspsych-display-element
    // / #jspsych-content) — this class makes every task panel a valid target,
    // not just Act 2's, so a violation during any step scrambles the task.
    var parts = ['<div class="task jspsych-content">', '<p class="label">' + task.kind + '</p>'];
    var ruleText = task.prompt || task.ruleText;
    if (ruleText) parts.push('<p class="rule">' + tpl(ruleText) + '</p>');
    if (task.kind === 'type-answer' || task.kind === 'copy-paste') {
      parts.push('<textarea rows="3" placeholder="Type your answer here"></textarea>');
    }
    if (task.kind === 'autotype') {
      parts.push('<textarea rows="3" class="autotype-field" data-role="autotype-field"></textarea>');
      parts.push(
        '<div class="btnrow"><button class="btn" data-action="autotype" data-role="autotype-button">' +
        tpl(task.buttonLabel) + '</button></div>'
      );
    }
    if (task.kind === 'fullscreen-entry') {
      parts.push('<p class="rule fallback-note" hidden></p>');
    }
    if (task.targetPastes) {
      parts.push('<p class="hint">Target pastes: ' + tpl(task.targetPastes) + '</p>');
    }
    if (task.suggestedSeconds) {
      parts.push('<p class="hint">Suggested time away: ' + task.suggestedSeconds + 's</p>');
    }
    if (task.visualCps) {
      parts.push(
        '<p class="hint">Visual speed: ' + task.visualCps + ' cps &middot; real threshold: ' +
        tpl(String(task.realThresholdCps)) + ' cps</p>'
      );
    }
    parts.push('</div>');
    return parts.join('');
  }

  function renderSecondary(step) {
    if (!step.secondary) return '';
    return step.secondary.map(function (s) {
      if (s.kind === 'toggle') {
        var checked = state.replayOptIn ? ' checked' : '';
        return '<label><input type="checkbox" data-key="' + s.key + '"' + checked + '> ' + s.label + '</label>';
      }
      if (s.kind === 'link') {
        var shortcut = s.shortcut ? ' (' + s.shortcut + ')' : '';
        return '<a href="#" data-key="' + s.key + '">' + s.label + shortcut + '</a>';
      }
      return '';
    }).join(' ');
  }

  // Counts-by-type traces summary for the guard-finish step, built from
  // every violation GuardFriction reported this session (start events only
  // — 'end'/'tamper' phases describe the same violation, not a new one).
  function renderTracesSummary() {
    var counts = {};
    state.violations.forEach(function (v) {
      if (v.phase !== 'start') return;
      counts[v.reason] = (counts[v.reason] || 0) + 1;
    });
    var reasons = Object.keys(counts);
    // Not .jspsych-content — this is supplementary info rendered above the
    // actual task panel, not "the task container" the scramble targets
    // (moot anyway: finalizeGuard() already stopped the guard before this
    // renders, but the class doesn't belong on it regardless).
    if (reasons.length === 0) {
      return '<div class="task"><p class="label">traces</p>' +
        '<p class="hint">No violations recorded this run.</p></div>';
    }
    var rows = reasons.map(function (reason) {
      return '<li>' + reason + ' — ' + counts[reason] + '</li>';
    }).join('');
    return '<div class="task"><p class="label">traces</p><ul class="hint">' + rows + '</ul></div>';
  }

  function renderStep(i) {
    var step = STEPS[i];
    var html = '';
    html += '<p class="eyebrow">' + renderEyebrow(step) + '</p>';
    html += '<h2>' + tpl(step.title) + '</h2>';
    if (step.task && step.task.kind === 'guard-finish') html += renderTracesSummary();
    html += '<div class="stepcopy">' + tpl(step.body) + '</div>';
    // Violation chips render OUTSIDE the task panel deliberately: the panel
    // carries .jspsych-content, and GuardFriction's obfuscateContent() walks
    // and scrambles every text node inside its match — a chip row nested in
    // there would scramble its own "you triggered X" text the instant it's
    // written (confirmed while verifying: the chip text came back as
    // ciphertext). Chips need to stay legible while a violation is live.
    if (step.task && step.task.kind === 'guard-cheat') {
      html += '<div class="violations" data-role="violation-chips"></div>';
    }
    html += renderTaskPanel(step.task);
    // Results screen (step 11): renderTaskPanel(null) is '' (task: null in
    // steps.js) — this mount point is what goTo() hands to results.js's
    // buildResults(), which owns everything inside it (loading state,
    // walkthrough, iframe report). The surrounding eyebrow/title/body/expect/
    // buttons stay the normal generic layout; .results-mode (toggled by
    // goTo()) makes the WHOLE card full-width, not just this mount.
    if (step.id === 'results') {
      html += '<div class="results-mount" data-role="results-mount"></div>';
    }
    if (step.expect) {
      html += '<div class="expect"><span class="tag">Expect</span><span>' + tpl(step.expect) + '</span></div>';
    }
    html += '<div class="btnrow">';
    if (i > 0) html += '<button class="btn" data-action="back">Back</button>';
    html += '<button class="btn primary" data-action="primary">' + tpl(step.primaryLabel) + '</button>';
    html += '</div>';
    var secondary = renderSecondary(step);
    if (secondary) html += '<p class="secondary">' + secondary + '</p>';
    cardEl.innerHTML = html;
  }

  var resultsIndex = STEPS.findIndex(function (s) { return s.id === 'results'; });

  // Drives step 10's live jsPsych trials (finale.js). Guarded by
  // state.finaleStarted so a Back-then-forward revisit doesn't re-init
  // CyborgHunter a second/third time or push duplicate trial reports.
  // Degrades to the code-panel-only view (spec: "advance always available")
  // on any failure — missing vendor files, a load error, or missing globals.
  function runFinaleStep(task) {
    var mount = cardEl.querySelector('[data-role="finale-mount"]');
    var status = cardEl.querySelector('[data-role="finale-status"]');
    var note = cardEl.querySelector('.finale-note');
    if (state.finaleStarted) {
      // Back-then-forward revisit: the mount stays empty (re-running would
      // re-init CyborgHunter and duplicate trial reports — see finale.js),
      // but the status text should say what actually happened instead of
      // showing the stale "Loading jsPsych…" default forever.
      if (state.finaleFailed) {
        if (status) status.hidden = true;
        if (note) { note.textContent = task.degradedNote; note.hidden = false; }
      } else if (status) {
        status.textContent = 'Already ran earlier this session — both reports are in your payload.';
      }
      return;
    }
    state.finaleStarted = true;
    if (!mount) return;
    runFinale(mount, {
      participantId: participantId,
      onTrialReport: handleTrialReport,
      onReady: function () {
        // Vendor loaded — finale.js is about to call initJsPsych(), which
        // destroys the outer monitor (see state.monitorDestroyed's comment).
        state.monitorDestroyed = true;
        if (status) status.textContent = "Running below — press a key to continue.";
      }
    })
      .then(function () {
        if (status) status.textContent = 'Both trials complete — their reports are in your payload.';
      })
      .catch(function (err) {
        console.warn('cyborg-hunter demo: jsPsych finale unavailable, showing the code panel only', err);
        state.finaleFailed = true;
        if (status) status.hidden = true;
        if (note) { note.textContent = task.degradedNote; note.hidden = false; }
      });
  }

  function goTo(i) {
    stopAutotype();
    state.stepIndex = i;
    var step = STEPS[i];
    // Reaching guard-finish means Act 2 enforcement is over — stop it
    // (idempotent) before rendering, so the traces summary sees the final
    // 'end' event for whatever violation was open.
    if (step.task && step.task.kind === 'guard-finish') finalizeGuard();
    // Skipped once the outer monitor is destroyed: CyborgHunter.init() is a
    // module-level singleton, and finale.js's jsPsych-owned instance
    // destroys the outer monitor the moment it initializes (see finale.js's
    // docblock and state.monitorDestroyed above) — its state machine only
    // accepts transitions TO 'destroyed' after that, so calling
    // startTrial() again (e.g. Back-navigating to step 9, whose
    // task.trialId is real) throws "cannot transition from 'destroyed' to
    // 'trial'". Every step from here on (results, replicate-locally)
    // already has task.trialId null, so this only ever short-circuits a
    // Back revisit into an earlier real-trialId step — which the outer
    // monitor can no longer safely bracket anyway.
    if (!state.monitorDestroyed) {
      lifecycle.transitionTo(step.task ? step.task.trialId : null);
    }
    // Lamp wiring stops at the results step (interactive tasks are over) and
    // restarts if the visitor navigates Back into the tour. Both idempotent.
    if (i >= resultsIndex) stopLampWiring(); else startLampWiring();
    document.body.dataset.view = step.act;
    // Full-width payoff (spec: "not inside the tour card") — toggled here
    // (not by results.js) so every OTHER step deterministically clears it,
    // the same single-chokepoint pattern as dataset.view above.
    document.body.classList.toggle('results-mode', step.id === 'results');
    renderStep(i);
    // Repaints from state.chipCounts (not a reset) so Back-then-forward into
    // guard-cheat shows the tally already accumulated this session.
    if (step.task && step.task.kind === 'guard-cheat') renderViolationChips();
    if (step.task && step.task.kind === 'jspsych-finale') runFinaleStep(step.task);
    if (step.id === 'results') {
      // Snapshot here (not earlier): getSessionReport() reflects everything
      // up to and including the finale, and by this point the outer monitor
      // may already be the destroyed-but-still-readable instance finale.js
      // left behind (see finale.js's docblock) — getSessionReport() doesn't
      // check lifecycle state, so this is safe either way.
      state.sessionReport = monitor.getSessionReport();
      var mount = cardEl.querySelector('[data-role="results-mount"]');
      import('./results.js').then(function (mod) {
        mod.buildResults(mount, state, manifest);
      });
    }
    if (step.id === 'welcome') {
      var teaserMount = cardEl.querySelector('[data-role="teaser-mount"]');
      var traceMount = cardEl.querySelector('[data-role="agent-trace-mount"]');
      import('./teaser.js').then(function (mod) {
        mod.mountTeaser(teaserMount, traceMount);
      });
    }
    progressEl.textContent = 'Step ' + (i + 1) + ' of ' + STEPS.length;
  }

  function skipToFinale() {
    if (STEPS[state.stepIndex].act === 'act2') state.act2Skipped = true;
    // Skipping out of Act 2 (the "Skip to finale" link or Alt+S from
    // anywhere) must stop an active guard the same as reaching guard-finish
    // normally would — finalizeGuard() no-ops if it's already stopped.
    finalizeGuard();
    goTo(finaleIndex());
  }

  cardEl.addEventListener('click', function (e) {
    var back = e.target.closest('[data-action="back"]');
    if (back) { goTo(state.stepIndex - 1); return; }
    var autotypeBtn = e.target.closest('[data-action="autotype"]');
    if (autotypeBtn) { runAutotype(autotypeBtn); return; }
    var primary = e.target.closest('[data-action="primary"]');
    if (primary) {
      var currentStep = STEPS[state.stepIndex];
      // "Start the tour" is the trigger point for C8's replay opt-in — must
      // run before goTo(1) below so the first trial (step 2) is bracketed.
      if (currentStep.id === 'welcome') startReplayIfOptedIn();
      // Step 7's primary button drives the fullscreen race instead of a
      // plain advance — it only moves to step 8 once guard-friction is
      // actually armed (see handleFullscreenEntry).
      if (currentStep.task && currentStep.task.kind === 'fullscreen-entry') {
        handleFullscreenEntry(primary);
        return;
      }
      if (state.stepIndex < STEPS.length - 1) goTo(state.stepIndex + 1);
      return;
    }
    var downloadBtn = e.target.closest('[data-action="download"]');
    if (downloadBtn) {
      var toSave = buildDownloadFile(downloadBtn.dataset.key);
      if (toSave) {
        try {
          triggerDownload(toSave.filename, toSave.data);
          downloadBtn.textContent = downloadBtn.dataset.savedLabel;
        } catch (err) {
          openFileTextDialog(toSave.filename, JSON.stringify(toSave.data, null, 2));
        }
      }
      return;
    }
    var showTextBtn = e.target.closest('[data-action="showtext"]');
    if (showTextBtn) {
      e.preventDefault();
      var toShow = buildDownloadFile(showTextBtn.dataset.key);
      if (toShow) openFileTextDialog(toShow.filename, JSON.stringify(toShow.data, null, 2));
      return;
    }
    var closeDialogBtn = e.target.closest('[data-action="close-dialog"]');
    if (closeDialogBtn) {
      var dlg = closeDialogBtn.closest('dialog');
      if (dlg) dlg.close();
      return;
    }
    var link = e.target.closest('a[data-key]');
    if (link) {
      e.preventDefault();
      if (link.dataset.key === 'skipToGuardedAct') goTo(guardedActIndex());
      else if (link.dataset.key === 'skipToFinale') skipToFinale();
    }
  });

  cardEl.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('input[type="checkbox"][data-key="replayOptIn"]')) {
      state.replayOptIn = e.target.checked;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      skipToFinale();
    }
  });

  goTo(0);
}

boot();
