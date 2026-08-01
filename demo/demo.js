// demo/demo.js
// Tour engine: 13-step navigation, {{path}} template substitution, capability
// snapshot, participant-id boot stamp. Renders STEPS from steps.js through
// the idempotent lifecycle helper (lifecycle.js) so every advance/Back
// closes any open trial before optionally opening the next.
//
// Live-signal rail: event-driven via the monitor's onSignal callback +
// aggregation of completed trial reports (fast typing has no onSignal event —
// it's only computable at endTrial()), plus a 5s poll for session-only
// signals (viewport-width shifts have no onSignal event either; sidebar gets
// BOTH — see pollSessionSignals()).
//
// Live session pane: the SAME onSignal dispatch, trial open/close, and
// session poll also feed live-pane.js's append-only stream + raw-JSON view
// (paneRow()) — the rail is the demo-only curated subset, the pane is the
// full record. Frozen (+ replay/guard finalized, rail hidden) on entering
// the results step.

import {
  STEPS, POSITIONING, CLOSING_CTA, CONFIG_CAVEAT, RAIL_GROUPS, RAIL_INTRO,
  CODE_TABS, HONEYPOT, DOWNLOAD_FILES, REPLICATE, SCORING_PANEL
} from './steps.js';
import { makeLifecycle } from './lifecycle.js';
import { renderRail, light, acknowledge } from './rail.js';
import { buildPayload } from './payload.js';
import { makeLivePane } from './live-pane.js';
import { escHtml } from './util.js';

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

// Live-pane detail strings truncate any visitor-triggered text (pasted/
// dropped content) to a readable width — the pane escapes the FULL string
// at render time regardless, this is only about row length.
function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fullscreenIsActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
}

// Step 8's 1.5s fullscreen-entry race. Calls OUR OWN requestFullscreen() —
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
    lampCounts: {},
    act2Skipped: false,
    violations: [],
    trialReports: [],
    // C7 (guard act): the token GuardFriction.start() returns — needed by
    // stop() — and per-reason violation tallies for the guard-cheat step's
    // chip row.
    guardStopToken: null,
    chipCounts: {},
    // C8 (replay, always-on): the attached CyborgHunterReplay instance
    // (startReplay() attempts it unconditionally at "Start"), its finalized
    // recording — cached so the download button and the "show as text"
    // fallback always agree — and whether attaching ever failed, so the
    // downloads step and results copy can say so honestly instead of just
    // silently omitting the file.
    recorder: null,
    replayRecording: null,
    replayUnavailable: false,
    // Live session pane (demo/live-pane.js) + its own clock zero, set right
    // after creation below.
    pane: null,
    t0: 0,
    // C3 playground: the last settled control values (set via ctx.onControls
    // after each successful rebuild; null until the visitor touches a
    // control). buildDownloadFile('config') reads these so the downloaded
    // config reflects the report as last built, tweaks included.
    playgroundControls: null,
    // Walkthrough item 7: shared scoring overrides — CODEX override
    // contract — written by step 11's per-signal weight edits (weights)
    // and step 12's playground threshold controls (controls/preset). Read
    // by playground.js's mergePlaygroundConfig() to build one canonical
    // {controls, scoring} view every caller shares (step 11's live-score
    // readout, results.js's initial-render persistence seam below, step
    // 12's own rebuild) — so the two UIs can never quietly disagree.
    scoringOverrides: { weights: {}, controls: null, preset: null }
  };

  var cardEl = document.getElementById('card');
  var progressEl = document.getElementById('progress');
  var railEl = document.getElementById('rail');
  // The CSS card treatment (background/shadow/padding) lives on this class;
  // set once here rather than in every renderStep() innerHTML string.
  cardEl.classList.add('stepcard');

  renderRail(railEl, { groups: RAIL_GROUPS, intro: RAIL_INTRO });

  // ----- Live session pane -----------------------------------------------
  // Persistently visible record (spec §5.2), fed from the same signal
  // dispatch as the rail. buildCurrentPayload() is the SAME buildPayload(...)
  // call buildDownloadFile('sessionData') makes, extracted so both stay in
  // sync (DRY) — declared here as a function so it can close over `monitor`
  // below despite running after it (function declarations hoist).
  // paneEl IS the node makeLivePane owns (its `mount` arg, already
  // class="card") — walkthrough item 5 reparents this whole node between
  // the instrument column (paneHome) and the step-10 promotion target
  // ([data-role="pane-slot"], permanent markup in index.html) rather than
  // moving its content, so state.pane's internal element references and
  // listeners survive the move untouched.
  var paneEl = document.querySelector('[data-role="live-pane"]');
  var paneSlotEl = document.querySelector('[data-role="pane-slot"]');
  var paneHome = { parent: paneEl.parentNode, next: paneEl.nextSibling };
  var panePromoted = false;
  state.pane = makeLivePane(paneEl, participantId);
  state.t0 = performance.now();

  function buildCurrentPayload() {
    var trials = state.trialReports.map(function (r) {
      return { trialId: r.trialId, integrity: r };
    });
    return buildPayload({
      pid: participantId,
      trials: trials,
      sessionReport: monitor.getSessionReport(),
      violations: state.violations
    });
  }

  function paneRow(trial, event, detail, hard) {
    state.pane.addRow({ tMs: performance.now() - state.t0, trial: trial, event: event, detail: detail, hard: !!hard });
    state.pane.setPayload(buildCurrentPayload());
  }

  // Pins the stream's scroll to its tail — addRow() already does this on
  // every new row (live-pane.js), but a reparent (appendChild across
  // parents) can reset an element's scrollTop in some engines, so both
  // promote/demote below re-pin defensively after the move.
  function pinPaneScroll() {
    var streamEl = paneEl.querySelector('[data-role="lp-stream"]');
    if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
  }

  // Step-10 (guard-debrief) pane promotion, idempotent like
  // floatEndGuard/unfloatEndGuard below: promotePane()/demotePane() are
  // no-ops when already in the target state, and goTo() calls demotePane()
  // unconditionally at the top of every navigation (defensive), then
  // promotePane() only when landing on guard-debrief — so leaving step 10
  // in ANY direction (Back included) restores the instrument column.
  function promotePane() {
    if (panePromoted) return;
    panePromoted = true;
    paneSlotEl.appendChild(paneEl);
    paneEl.classList.add('promoted');
    pinPaneScroll();
  }

  function demotePane() {
    if (!panePromoted) return;
    panePromoted = false;
    paneEl.classList.remove('promoted');
    if (paneHome.parent && paneHome.parent.isConnected) {
      paneHome.parent.insertBefore(paneEl, paneHome.next);
    } else {
      document.querySelector('.instrument').appendChild(paneEl);
    }
    pinPaneScroll();
  }

  // Lamp wiring is lifecycle-bound (spec: "starts and stops with the tour").
  // startLampWiring/stopLampWiring are idempotent: entering the results step
  // stops the poll and turns every lamp handler into a no-op (the interactive
  // tasks are over; the monitor itself keeps running — finalization belongs
  // to the payload task); navigating Back into the tour restarts it.
  var lampWiringActive = false;
  var sessionPollId = null;
  // Step 6 (autotype)'s char-by-char animation runs its own setInterval,
  // outside the library entirely — tracked here so goTo() can cancel a
  // still-running animation on navigation (Back/Continue are both valid
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

  // Classifies a tab-away duration into the same three bins the lamp
  // wiring in the 'tabReturn' case below scores it into (long/mid/
  // flicker) — the live pane's per-row detail string reads this SAME
  // classification rather than re-deriving the ≥10s/3s cutoffs on its own.
  function tabAwayBin(duration) {
    if (duration >= 10000) return { key: 'tabAwayLong', detail: '≥10s bin' };
    // Strict > matches the library convention: a tab-away exactly at
    // the cutoff is an unscored flicker (scoring.js:63, summary.js
    // "same `>` boundary" comment, session-timeline.js flicker bin).
    if (duration > manifest.signals.tabAway.durationMs) return { key: 'tabAwayMid', detail: '3–10s bin' };
    // ≤ the cutoff: a flicker — under-3s tab-aways read as noise (a
    // notification, a stray click), so they get their own, non-hard
    // lamp instead of going unlit as in v1.
    return { key: 'tabAwayFlicker', detail: 'flicker' };
  }

  function handleSignal(sig) {
    var task = STEPS[state.stepIndex].task;
    var trialId = task ? task.trialId : null;
    var d = sig.data || {};
    var n, hard;
    switch (sig.type) {
      case 'paste':
        n = (state.lampCounts.paste || 0) + 1;
        hard = n >= manifest.signals.paste.hardCountThreshold;
        paneRow(trialId, 'paste', '"' + truncate(d.text || '', 28) + '" · ' + d.pastedLength + ' chars', hard);
        if (!lampWiringActive) break;
        syncCountLamp('paste', n, hard, RAIL_LABELS.paste);
        break;
      case 'copy':
        paneRow(trialId, 'copy', d.selectedLength + ' chars selected', false);
        if (!lampWiringActive) break;
        n = (state.lampCounts.copy || 0) + 1;
        syncCountLamp('copy', n, false, RAIL_LABELS.copy);
        break;
      case 'cut':
        // Logged under the same 'copy' lamp/count as clipboard.js logs it
        // under the same session copyCount — no text is available for cuts.
        paneRow(trialId, 'cut', null, false);
        if (!lampWiringActive) break;
        n = (state.lampCounts.copy || 0) + 1;
        syncCountLamp('copy', n, false, RAIL_LABELS.copy);
        break;
      case 'drop':
        n = (state.lampCounts.drop || 0) + 1;
        hard = n >= manifest.signals.drop.hardCountThreshold;
        paneRow(trialId, 'drop', '"' + truncate(d.text || '', 28) + '" · ' + d.droppedLength + ' chars', hard);
        if (!lampWiringActive) break;
        syncCountLamp('drop', n, hard, RAIL_LABELS.drop);
        break;
      case 'tabReturn':
        var duration = d.duration_ms || 0;
        var bin = tabAwayBin(duration);
        paneRow(trialId, 'tab_return', (duration / 1000).toFixed(1) + ' s · ' + bin.detail, false);
        if (!lampWiringActive) break;
        n = (state.lampCounts[bin.key] || 0) + 1;
        syncCountLamp(bin.key, n, false, RAIL_LABELS[bin.key]);
        break;
      case 'sidebarOpened':
        paneRow(trialId, 'sidebar_opened', 'width shift ' + (d.deltaIW || 0) + 'px', false);
        if (!lampWiringActive) break;
        n = (state.lampCounts.sidebar || 0) + 1;
        syncCountLamp('sidebar', n, false, RAIL_LABELS.sidebar);
        break;
      case 'typingOutsideExperiment':
        paneRow(trialId, 'foreign_input', 'outside field: ' + (d.targetTag || 'unknown'), false);
        if (!lampWiringActive) break;
        n = (state.lampCounts.foreignInput || 0) + 1;
        syncCountLamp('foreignInput', n, false, RAIL_LABELS.foreignInput);
        break;
      case 'syntheticInsertion':
        paneRow(trialId, 'synthetic_insertion', (d.dataLength || 0) + ' chars inserted', true);
        if (!lampWiringActive) break;
        n = (state.lampCounts.syntheticInsertion || 0) + 1;
        syncCountLamp('syntheticInsertion', n, true, RAIL_LABELS.syntheticInsertion);
        break;
      case 'keyboardShortcut':
        paneRow(trialId, 'devtools_shortcut', d.combo || null, false);
        if (!lampWiringActive) break;
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
    var typingSpeed = report.trialSignals && report.trialSignals.soft && report.trialSignals.soft.typingSpeed;
    if (typingSpeed && typingSpeed.hit) {
      paneRow(report.trialId, 'fast_typing', typingSpeed.charsPerSec.toFixed(1) + ' cps', false);
    }
    if (!lampWiringActive) return;
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
  // Each pane row here is guarded on "is this actually new" (checked against
  // the SAME state.lampCounts the lamp itself uses) so a repeat poll tick
  // over an already-announced count doesn't re-emit a duplicate row.
  function pollSessionSignals() {
    var report = monitor.getSessionReport();

    var sidebarOpens = report.sidebarEvents.filter(function (e) { return e.type === 'opened'; }).length;
    if (sidebarOpens > (state.lampCounts.sidebar || 0)) paneRow(null, 'sidebar_opened', null, false);
    syncCountLamp('sidebar', sidebarOpens, false, RAIL_LABELS.sidebar);

    var viewportShifts = report.viewportWidthShifts.length;
    if (viewportShifts > (state.lampCounts.viewport || 0)) paneRow(null, 'viewport_shift', null, false);
    syncCountLamp('viewport', viewportShifts, false, RAIL_LABELS.viewport);

    if (window.GuardHoneypot) {
      var hp = window.GuardHoneypot.getHoneypotData();
      if (hp.ai_use && !state.lampCounts.honeypot) paneRow(null, 'honeypot', 'bait field filled', true);
      if (hp.ai_use) syncCountLamp('honeypot', 1, true, RAIL_LABELS.honeypot);
    }
  }

  var monitor = window.CyborgHunter.init({
    participantId: participantId,
    preset: 'standard',
    onSignal: handleSignal,
    // A8: raw per-event mouse track, opt-in and off by default in the
    // library — the demo turns it on so the results report's trajectory
    // plots have real data to draw from a live session.
    collectForPostHoc: { rawMouseTrack: true }
  });
  monitor.startSession();
  // Bait stays passively armed for the whole tour (spec: "bait stays
  // passively armed"). No dedicated step calls this, so it has to happen
  // here — without it, pollSessionSignals()'s
  // window.GuardHoneypot.getHoneypotData() call above always reads the
  // pre-injection default (ai_use: false) and the honeypot rail lamp can
  // never light.
  if (window.GuardHoneypot) {
    window.GuardHoneypot.init({ friction: window.GuardFriction });
  }
  // Recorder-like bridge for makeLifecycle's optional recorder param (C8).
  // A live proxy rather than passing state.recorder directly: the replay
  // recorder only attaches inside the "Start" click (startReplay()), which
  // runs AFTER this lifecycle is constructed — reading state.recorder at
  // call time lets the very first trial (step 2) get bracketed too.
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
        paneRow(currentTask.trialId, 'violation: ' + violation.reason, null, true);
        // No-trap guarantee: lift the End button above the overlay while
        // the violation is live (microtask — see floatEndGuard's docblock).
        Promise.resolve().then(floatEndGuard);
      }
      // Unconditional (not gated on the current step): unfloat is a no-op
      // when nothing is floating, and the end can arrive via stop() during
      // finalizeGuard from any step.
      if (violation.phase === 'end') unfloatEndGuard();
      if (!lampWiringActive) return;
      if (violation.phase !== 'start') return;
      var n = (state.lampCounts.guardViolations || 0) + 1;
      syncCountLamp('guardViolations', n, true, RAIL_LABELS.guardViolations);
    });
  }

  // ----- C7: guard act -------------------------------------------------

  // Standalone GuardFriction.start() — not the jsPsych entryTrial() helper,
  // since this demo never spins up a jsPsych instance. Only called after
  // raceFullscreenEntry() already confirmed fullscreen is active: start()
  // runs an immediate is-fullscreen check and would log a false
  // 'not_fullscreen' violation if called first.
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
  // stop() call, so the end-guard button (the only path that calls this
  // during the tour) and the defensive call at the results step never
  // double-stop.
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

  // ----- No-trap guarantee (spec §6 step 9) ------------------------------
  // The End button must stay REACHABLE while the guard's violation overlay
  // is up — a visitor who exits fullscreen and refuses to re-enter must
  // still be able to end the act. GuardFriction's overlay is a fixed
  // inset-0 curtain at z-index 2147483647 (int max) appended to
  // document.body at the first violation; it paints over and
  // pointer-intercepts everything beneath it, including the in-card
  // .endguard button. CSS alone can't win: no z-index exceeds int max, and
  // at EQUAL z-index the LATER sibling in tree order paints (and
  // hit-tests) on top — verified empirically on chromium, firefox AND
  // webkit, where a max-z-index button inside the card or appended to body
  // BEFORE the overlay loses every time, and one appended AFTER wins.
  // So while a violation is active, the SAME button node is moved to
  // document.body after the overlay (the .floating class carries the
  // fixed-position styling, demo.css) and moved back when the violation
  // ends. The move is deferred one microtask because GuardFriction emits
  // phase:'start' BEFORE showOverlay() creates the overlay (its update()
  // is synchronous) — deferring guarantees the overlay exists so our
  // append lands after it in tree order.
  var endGuardRestore = null; // {parent, next} — where to put the button back

  function onEndGuardClick() {
    // finalizeGuard → GuardFriction.stop(): ends any active violation
    // (emitting its phase:'end', which unfloats via the handler below) and
    // hides the overlay — so ending the act mid-violation is clean.
    finalizeGuard();
    goTo(state.stepIndex + 1);
  }

  function floatEndGuard() {
    if (endGuardRestore) return; // already floating
    var btn = cardEl.querySelector('.endguard');
    if (!btn) return; // navigated off guard-cheat before the microtask ran
    endGuardRestore = { parent: btn.parentNode, next: btn.nextSibling };
    btn.classList.add('floating');
    // Direct listener while outside cardEl's subtree: the card's delegated
    // click handler can't see clicks that no longer bubble through it.
    btn.addEventListener('click', onEndGuardClick);
    document.body.appendChild(btn); // AFTER the overlay → paints on top
  }

  function unfloatEndGuard() {
    if (!endGuardRestore) return;
    var restore = endGuardRestore;
    endGuardRestore = null;
    var btn = document.querySelector('body > .endguard.floating');
    if (!btn) return;
    btn.classList.remove('floating');
    // Remove the direct listener: back inside cardEl, a click reaches the
    // delegated handler again — keeping both would double-fire goTo().
    btn.removeEventListener('click', onEndGuardClick);
    if (restore.parent && restore.parent.isConnected) {
      restore.parent.insertBefore(btn, restore.next);
    } else {
      btn.remove(); // the card re-rendered while floating; the node is stale
    }
  }

  // Renders the fallback note (steps.js copy if the task defines one, else
  // a minimal inline string) and, if not already offered, a skip link
  // straight to "From signals to scores" (index 10) — reusing the same
  // data-key the card's click delegation already handles. The primary
  // "Enter fullscreen" button stays enabled for a retry either way (advance
  // is never fully blocked).
  function showFullscreenFallback() {
    state.act2Skipped = true;
    var step = STEPS[state.stepIndex];
    var note = cardEl.querySelector('.fallback-note');
    if (note) {
      note.textContent = (step.task && step.task.fallbackNote) ||
        "Fullscreen didn't engage in time, so Act 2's enforcement can't run in this browser. Skip ahead; everything else in the tour still works.";
      note.hidden = false;
    }
    if (!cardEl.querySelector('a[data-key="skipToScores"]')) {
      var secondary = document.createElement('p');
      secondary.className = 'secondary';
      secondary.innerHTML = '<a href="#" class="skip" data-key="skipToScores">Skip to "From signals to scores"</a>';
      cardEl.appendChild(secondary);
    }
  }

  // Drives step 8's fullscreen-entry race. A guard API absence (bundle
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
        console.warn('cyborg-hunter demo: GuardFriction unavailable, degrading to fallback');
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

  // ----- C8: replay (always-on) ------------------------------------------

  // Attaches the standalone replay recorder unconditionally, called from the
  // "Start" click before goTo(1) opens step 2's trial — recorderBridge reads
  // state.recorder live, so as long as this finishes first, the very first
  // trial gets bracketed too. The REC pill shows immediately regardless of
  // whether attach actually succeeds (spec: replay is on by default); a
  // failure keeps the tour degrading gracefully and marks
  // state.replayUnavailable so the downloads step and results copy can say
  // so honestly instead of just silently dropping the file.
  function startReplay() {
    var recEl = document.getElementById('rec');
    if (recEl) recEl.hidden = false;
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
    } catch (err) {
      console.warn('cyborg-hunter demo: replay attach failed, continuing without a recording', err);
      state.recorder = null;
      state.replayUnavailable = true;
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

  function scoresIndex() {
    return STEPS.findIndex(function (s) { return s.id === 'signals-to-scores'; });
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
      return { filename: participantId + '.json', data: buildCurrentPayload() };
    }
    if (key === 'replay') {
      // renderDownloadsPanel() disables this button when
      // state.replayUnavailable, so this is only reachable after a real
      // attach attempt — guard anyway in case finalizeReplay() has nothing
      // to return.
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
      // "The scoring config the report used" — honestly. Beyond the ingest
      // keys, the file carries the scoring settings the in-browser report
      // last ran with (playground tweaks included; manifest defaults when
      // the controls were never touched), limited to keys the CLI actually
      // honors (src/cli/config.js merges the file wholesale; summary.js
      // reads thresholds.tabAwayDurationMs / typingSpeedThreshold_cps as
      // fallbacks behind each participant's saved runtime thresholds, and
      // triage.js honors scoring.softScoreThreshold as an analyst-side
      // override). The paste control has no CLI config key — the hard tier
      // is data-carried — so it is deliberately absent here.
      var pc = state.playgroundControls || {
        tabAwayCutoffMs: manifest.signals.tabAway.durationMs,
        typingSpeedCps: manifest.signals.typingSpeed.cps,
        softScoreThreshold: manifest.signals.softScoreThreshold
      };
      return {
        filename: 'cyborg-hunter.config.json',
        data: {
          dataDir: '.',
          filePattern: 'DEMO-*.json',
          participantIdField: 'participantId',
          thresholds: { tabAwayDurationMs: pc.tabAwayCutoffMs },
          typingSpeedThreshold_cps: pc.typingSpeedCps,
          scoring: { softScoreThreshold: pc.softScoreThreshold }
        }
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

  // Step 13's documentation-style walkthrough (REPLICATE.sections), numbered
  // headings with copyable code blocks. code may carry {{version}} — tpl()
  // substitutes before escaping, same order as everywhere else code renders.
  function renderReplicateSection() {
    var html = '<div class="replicate">';
    REPLICATE.sections.forEach(function (s) {
      html += '<h3>' + s.n + '. ' + escHtml(s.heading) + '</h3>';
      html += '<p>' + escHtml(s.text) + '</p>';
      if (s.code) html += '<pre><code>' + escHtml(tpl(s.code)) + '</code></pre>';
    });
    html += '<p class="hint">' + escHtml(REPLICATE.installNote) + '</p>';
    html += '</div>';
    return html;
  }

  function renderClosingCta() {
    return (
      '<p class="secondary">' + escHtml(CLOSING_CTA.installInvitation) + ' ' +
      '<a href="' + CLOSING_CTA.primaryHref + '">' + escHtml(CLOSING_CTA.primaryLabel) + '</a> &middot; ' +
      '<a href="' + CLOSING_CTA.githubHref + '">GitHub</a></p>'
    );
  }

  function renderDownloadsPanel(task) {
    // scramble coupling: same .jspsych-content convention as renderTaskPanel
    // below — GuardFriction's obfuscateContent() only touches
    // getJsPsychContent()'s match, so this class keeps the downloads panel a
    // valid scramble target too (moot in practice: guard is long stopped by
    // this step, but the class is applied uniformly regardless of step).
    var parts = ['<div class="task jspsych-content">', '<p class="label">' + task.kind + '</p>'];
    parts.push('<div class="files">' + DOWNLOAD_FILES.map(function (f) {
      var disabled = f.key === 'replay' && state.replayUnavailable;
      var description = disabled ? 'recording unavailable in this browser' : f.description;
      // Config caveat (spec :182/:288): first-party copy, so innerHTML is
      // safe here the same as every other steps.js string this panel
      // renders (f.label, f.description, etc.) — rendered directly under
      // the config file's Save/show-as-text row, not restructuring the panel.
      var caveat = f.key === 'config'
        ? '<p class="file-caveat" data-role="config-caveat">' + tpl(CONFIG_CAVEAT) + '</p>'
        : '';
      return (
        '<div class="file">' +
        '<div class="file-info">' + f.label + '<small>' + f.filename + '</small>' +
        '<span class="file-desc">' + description + '</span></div>' +
        '<div class="file-actions">' +
        '<button class="btn" data-action="download" data-key="' + f.key +
        '" data-saved-label="' + f.savedLabel + '"' + (disabled ? ' disabled' : '') + '>Save</button>' +
        (disabled ? '' : '<a href="#" data-action="showtext" data-key="' + f.key + '">show as text</a>') +
        '</div>' + caveat + '</div>'
      );
    }).join('') + '</div>');
    parts.push(
      '<dialog class="filetext-dialog"><h3></h3><pre></pre>' +
      '<button class="btn" data-action="close-dialog">Close</button></dialog>'
    );
    parts.push('</div>');
    parts.push(renderReplicateSection());
    parts.push(renderClosingCta());
    return parts.join('');
  }

  // Step 2's "what this looks like in your code" split (CODE_TABS): two
  // pill tabs, same active/hidden pattern as live-pane.js's stream/JSON tabs.
  function renderCodeTabs() {
    var order = ['jspsych', 'plainjs'];
    var html = '<p class="hint">' + escHtml(CODE_TABS.caption) + '</p>';
    html += '<div class="code-tabs">' + order.map(function (key) {
      var active = key === CODE_TABS.defaultTab ? ' active' : '';
      return '<button class="code-tab' + active + '" data-tab="' + key + '">' + escHtml(CODE_TABS[key].label) + '</button>';
    }).join('') + '</div>';
    html += order.map(function (key) {
      var hidden = key === CODE_TABS.defaultTab ? '' : ' hidden';
      return '<pre data-role="code-pane" data-tab="' + key + '"' + hidden + '><code>' + escHtml(CODE_TABS[key].code) + '</code></pre>';
    }).join('');
    return html;
  }

  // Cached module import: step 11's live-score readout and the results
  // step's playground both need playground.js — a repeated dynamic import
  // of the same specifier resolves from the module cache (no second
  // network fetch), so this local promise just avoids a redundant await
  // chain when the visitor reaches step 11 before the results step.
  var playgroundModPromise = null;
  function loadPlayground() {
    if (!playgroundModPromise) playgroundModPromise = import('./playground.js');
    return playgroundModPromise;
  }

  // The RESOLVED results.js module (not just its promise), set the first
  // time the results step loads it (below). goTo()'s viewer-host teardown
  // (item 12) reads this synchronously, so it can revoke the host's Blob
  // URL and drop its iframe on the way OUT of the results step without
  // waiting on a dynamic-import microtask — and without ever importing
  // results.js itself before the visitor has actually reached results.
  var resultsModCache = null;

  // Config-as-source snippets (step 11, walkthrough item 7a): both built
  // from the manifest's real values, never hand-typed, so a preset change
  // can't silently drift from what's displayed (same principle as
  // tools/gen-signal-manifest.mjs's own docblock). Shows the 'standard'
  // preset specifically — what this session actually collected under —
  // regardless of any preset the visitor later selects in step 12's
  // playground.
  function buildInitSnippet(manifest) {
    var soft = (manifest.presets && manifest.presets.standard &&
      manifest.presets.standard.scoring.soft) || {};
    var lines = Object.keys(soft).map(function (key) {
      var w = soft[key];
      var props = ['weight: ' + w.weight];
      if (w.maxPerTrial != null) props.push('maxPerTrial: ' + w.maxPerTrial);
      return '      ' + key + ': { ' + props.join(', ') + ' },';
    }).join('\n');
    return (
      "CyborgHunter.init({\n" +
      "  participantId: subject.id,\n" +
      "  preset: 'standard',\n" +
      "  scoring: {\n" +
      "    soft: {\n" +
      lines + "\n" +
      "    }\n" +
      "  }\n" +
      "});"
    );
  }

  function buildCliConfigSnippet(manifest) {
    var m = manifest.signals;
    return JSON.stringify({
      dataDir: '.',
      filePattern: '*.json',
      thresholds: { tabAwayDurationMs: m.tabAway.durationMs },
      typingSpeedThreshold_cps: m.typingSpeed.cps,
      scoring: { softScoreThreshold: m.softScoreThreshold },
    }, null, 2);
  }

  // Step 11's scoring panel (walkthrough item 7): per-signal weight editors
  // seeded from state.scoringOverrides.weights (falling back to the active
  // preset's own defaults) plus the two config-as-source snippets above.
  // Interactivity (weight-input listener, live soft-score readout) is
  // wired separately by wireScoringPanel() once playground.js has loaded —
  // this function only builds the static HTML shell, same split every
  // other step-specific panel here uses.
  function renderScoringPanel(manifest) {
    var presetName = state.scoringOverrides.preset || manifest.preset || 'standard';
    var presetEntry = (manifest.presets && manifest.presets[presetName]) || {};
    var baseSoft = (presetEntry.scoring && presetEntry.scoring.soft) || {};
    var weights = state.scoringOverrides.weights;

    var editorsHtml = SCORING_PANEL.weightFields.map(function (f) {
      var base = baseSoft[f.key];
      if (!base) return ''; // e.g. strict scores no copy soft — no editor for a term that isn't scored
      var current = weights[f.key] != null ? weights[f.key] : base.weight;
      return (
        '<label>' + escHtml(f.label) +
        ' <input type="number" min="0" max="20" data-role="weight-input" data-weight-key="' +
        f.key + '" value="' + escHtml(current) + '"></label>'
      );
    }).join(' ');

    return (
      '<div class="task" data-role="scoring-panel">' +
      '<p class="hint">' + escHtml(SCORING_PANEL.weightsIntro) + '</p>' +
      '<div class="weight-editors">' + editorsHtml + '</div>' +
      '<p class="hint" data-role="live-score"></p>' +
      '<p class="hint">' + escHtml(SCORING_PANEL.configIntro) + '</p>' +
      '<pre><code>' + escHtml(buildInitSnippet(manifest)) + '</code></pre>' +
      '<p class="hint">' + escHtml(SCORING_PANEL.cliConfigIntro) + '</p>' +
      '<pre><code>' + escHtml(buildCliConfigSnippet(manifest)) + '</code></pre>' +
      '</div>'
    );
  }

  // Step 11: wires the weight-input listener + the live current-soft-score
  // readout (buildCurrentPayload() -> recomputeSignals(), against the
  // visitor's own session so far). Debounced (reuses playground.js's
  // makeDebounced) so dragging an input's spinner doesn't recompute on
  // every intermediate value. Called fresh from goTo() every time step 11
  // renders — the previous render's panel/listeners are gone with the old
  // innerHTML, same discipline as every other step-specific wiring here.
  function wireScoringPanel(manifest) {
    var panel = cardEl.querySelector('[data-role="scoring-panel"]');
    var scoreEl = cardEl.querySelector('[data-role="live-score"]');
    if (!panel || !scoreEl) return;

    loadPlayground().then(function (playgroundMod) {
      function showScore() {
        var merged = playgroundMod.mergePlaygroundConfig(manifest, state.scoringOverrides);
        if (!merged) { scoreEl.textContent = ''; return; }
        var payload = playgroundMod.recomputeSignals(
          [buildCurrentPayload()], merged.controls, merged.scoring)[0];
        var session = payload.metadata.integritySession || {};
        scoreEl.textContent = 'Your soft score with these weights, from the session so far: ' +
          (session.softScore || 0) + ' (flags at ' + merged.scoring.softScoreThreshold + ' or above).';
      }
      var debouncedShowScore = playgroundMod.makeDebounced(showScore, 200);

      panel.addEventListener('input', function (e) {
        var input = e.target.closest('[data-weight-key]');
        if (!input) return;
        var value = Number(input.value);
        if (!isFinite(value)) return;
        state.scoringOverrides.weights[input.dataset.weightKey] = value;
        debouncedShowScore();
      });

      showScore();
    }).catch(function (err) {
      console.warn('cyborg-hunter demo: scoring panel failed to load playground', err);
    });
  }

  // Persistence seam (walkthrough item 7, ENG-REVIEW amendment): when step
  // 11's weight edits (or a prior visit to step 12's controls) left
  // state.scoringOverrides non-empty, the FIRST results build must reflect
  // them too — not just later playground reruns (results.js's buildResults
  // 5th `initial` param exists for exactly this). Returns null (the exact
  // baseline every build before this item produced) when nothing was ever
  // touched.
  function buildInitialScoringTransform(playgroundMod, manifest) {
    var overrides = state.scoringOverrides;
    var touched = Object.keys(overrides.weights).length > 0 || !!overrides.controls || !!overrides.preset;
    if (!touched) return null;
    var merged = playgroundMod.mergePlaygroundConfig(manifest, overrides);
    if (!merged) return null;
    return {
      configOverrides: {
        thresholds: { tabAwayDurationMs: merged.controls.tabAwayCutoffMs },
        typingSpeedThreshold_cps: merged.controls.typingSpeedCps,
        scoring: { softScoreThreshold: merged.scoring.softScoreThreshold },
      },
      transformPayloads: function (payloads) {
        return playgroundMod.recomputeSignals(payloads, merged.controls, merged.scoring);
      },
    };
  }

  // The four ids GuardHoneypot plants at boot (src/jspsych/extension-guard-
  // honeypot.js's injectHoneypotDOM): the hidden checkbox + text field
  // pair, then the two low-opacity visible micro-surfaces (button, input)
  // that exist to catch interactive-only DOM scrapes.
  var HONEYPOT_BAIT_IDS = ['fg-ai-use', 'fg-ai-report', 'fg-ai-bait-button', 'fg-ai-bait-input'];

  // Puts one attribute per line, indented — the ONLY change from the
  // node's real outerHTML. Splits on the attr="value" token boundary;
  // outerHTML always &quot;-escapes a literal quote inside a value, so a
  // bare [^"]* match never crosses a real attribute boundary. No
  // attribute is reordered, added, dropped, or edited.
  function prettyPrintOuterHtml(outerHtml, indent) {
    var attrs = outerHtml.match(/\s[\w-]+="[^"]*"/g);
    if (!attrs || !attrs.length) return outerHtml;
    var tagOpen = outerHtml.slice(0, outerHtml.indexOf(attrs[0]));
    var lastAttr = attrs[attrs.length - 1];
    var afterAttrs = outerHtml.slice(outerHtml.lastIndexOf(lastAttr) + lastAttr.length);
    return tagOpen + attrs.map(function (a) { return '\n' + indent + a.trim(); }).join('') + afterAttrs;
  }

  // Step 7's snippet: the REAL bait DOM GuardHoneypot planted, captured
  // live — truth-by-construction, same pattern as step 8's guard entry
  // (renderGuardEntryPanel renders window.GuardFriction.defaultEntryMessage
  // verbatim). GuardHoneypot.init() runs once at boot (see startTour,
  // before the first goTo), so by the time step 7 can render, the bait has
  // been sitting in the DOM for the whole tour — the "nodes missing"
  // branch below is defensive, not an expected path.
  function captureHoneypotSnippet() {
    var nodes = HONEYPOT_BAIT_IDS.map(function (id) { return document.getElementById(id); });
    if (nodes.some(function (n) { return !n; })) {
      return { html: escHtml(HONEYPOT.snippet), isFallback: true };
    }
    var raw = nodes.map(function (n) { return prettyPrintOuterHtml(n.outerHTML, '  '); }).join('\n\n');
    return { html: escHtml(raw), isFallback: false };
  }

  // Step 7's honeypot task: the captured bait markup (or, if the live
  // nodes aren't found, HONEYPOT.snippet labeled as a reference copy), the
  // "act like an agent" simulate button, and the sidebar invitation.
  function renderHoneypotPanel(task) {
    var snippet = captureHoneypotSnippet();
    var fallbackNote = snippet.isFallback
      ? '<p class="rule fallback-note">Reference copy. The live bait fields ' +
        "weren't found in the page, so this is the library's documented " +
        'markup rather than what actually rendered.</p>'
      : '';
    return (
      '<div class="task jspsych-content">' +
      '<p class="label">' + task.kind + '</p>' +
      fallbackNote +
      '<pre><code>' + snippet.html + '</code></pre>' +
      '<div class="btnrow"><button class="btn" data-action="honeypot-sim" data-role="honeypot-sim-button">' +
      escHtml(HONEYPOT.simulateLabel) + '</button></div>' +
      '<p class="hint">' + escHtml(HONEYPOT.sidebarInvite) + '</p>' +
      '</div>'
    );
  }

  // What an agent does when it finds the bait: read the DOM, fill it. Does
  // exactly that against the REAL fields GuardHoneypot planted, dispatching
  // real events, so the detection path exercised is the product's own —
  // not a demo shortcut. GuardHoneypot's existing 5s poll (pollSessionSignals)
  // is what actually lights the honeypot lamp/pane-row once ai_use flips.
  function runHoneypotSim(button) {
    button.disabled = true;
    button.textContent = HONEYPOT.simulateBusy;
    var box = document.getElementById('fg-ai-use');
    var report = document.getElementById('fg-ai-report');
    if (box) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
    if (report) {
      report.value = 'Simulated agent: answered the on-page question.';
      report.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setTimeout(function () { button.textContent = HONEYPOT.simulateDone; }, 400);
  }

  // Step 8's guard entry: the library's own entry message rendered VERBATIM
  // (truth-by-construction — never a drifting copy of it), with its own
  // button wired to the existing fullscreen-entry flow. Not wrapped in
  // .jspsych-content: the guard curtain never scrambles this step (it isn't
  // armed yet — start() only runs after entry succeeds).
  function renderGuardEntryPanel() {
    var msg = (window.GuardFriction && window.GuardFriction.defaultEntryMessage) || '';
    return (
      '<div class="entrybox">' + msg +
      '<div class="btnrow"><button class="btn" data-action="enter-fullscreen">Enter fullscreen and continue</button></div>' +
      '</div>' +
      '<p class="rule fallback-note" hidden></p>'
    );
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

  function renderTaskPanel(task) {
    if (!task) return '';
    if (task.kind === 'downloads') return renderDownloadsPanel(task);
    if (task.kind === 'honeypot') return renderHoneypotPanel(task);
    if (task.kind === 'fullscreen-entry') return renderGuardEntryPanel();
    // scramble coupling: GuardFriction's obfuscateContent() only touches
    // getJsPsychContent()'s match (.jspsych-content / .jspsych-display-element
    // / #jspsych-content) — this class makes every task panel a valid target,
    // not just Act 2's, so a violation during any step scrambles the task.
    var parts = ['<div class="task jspsych-content">', '<p class="label">' + task.kind + '</p>'];
    // The actual question text (baseline's `prompt`, clipboard-cheat's
    // `question`) gets the plain bold .question treatment; .rule is
    // reserved for callout-style copy (the guard's fallback-note).
    var questionText = task.prompt || task.question;
    if (questionText) parts.push('<p class="question">' + tpl(questionText) + '</p>');
    if (task.kind === 'copy-paste') {
      parts.push(
        '<div class="answerchip"><code>' + escHtml(task.providedAnswer) + '</code>' +
        '<span class="hint">copy this, then paste it below</span></div>'
      );
    }
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
    if (task.targetPastes) {
      parts.push('<p class="hint">Target pastes: ' + task.targetPastes + '</p>');
    }
    parts.push('</div>');
    // End-guard button (step 9): a sibling OUTSIDE .jspsych-content — its
    // legibility can never depend on scramble/blur context — doubling as
    // this step's primary action (steps.js sets primaryLabel for it, but
    // renderStep() suppresses the normal .btnrow primary for guard-cheat so
    // there's only the one button).
    if (task.kind === 'guard-cheat') {
      parts.push('<button class="endguard" data-action="end-guard">' + tpl(STEPS[state.stepIndex].primaryLabel) + '</button>');
    }
    return parts.join('');
  }

  function renderSecondary(step) {
    if (!step.secondary) return '';
    return step.secondary.map(function (s) {
      if (s.kind === 'link') {
        return '<a href="#" class="skip" data-key="' + s.key + '">' + s.label + '</a>';
      }
      return '';
    }).join(' ');
  }

  function renderStep(i) {
    var step = STEPS[i];
    var html = '';
    html += '<p class="eyebrow">' + renderEyebrow(step) + '</p>';
    html += '<h2>' + tpl(step.title) + '</h2>';
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
    if (step.showCodeTabs) html += renderCodeTabs();
    // Step 11 (walkthrough item 7): config-as-source snippets + per-signal
    // weight editors. task: null for this step, so this is a sibling of
    // the (empty) task panel, same placement pattern as results-mount below.
    if (step.id === 'signals-to-scores') html += renderScoringPanel(manifest);
    // Results screen (step 12): renderTaskPanel(null) is '' (task: null in
    // steps.js) — this mount point is what goTo() hands to results.js's
    // buildResults(), which owns everything inside it (loading state,
    // walkthrough, iframe report). The surrounding eyebrow/title/body/
    // buttons stay the normal generic layout; .results-mode (toggled by
    // goTo()) makes the WHOLE card full-width, not just this mount.
    if (step.id === 'results') {
      html += '<div class="results-mount" data-role="results-mount"></div>';
    }
    html += '<div class="btnrow">';
    if (i > 0) html += '<a href="#" class="skip" data-action="back">Back</a>';
    // guard-cheat's primary lives on the end-guard button rendered above
    // (outside the scramble wrapper) instead of here — never both. Steps
    // with primaryLabel: null (guard-entry) render no primary at all; the
    // entry box carries the library's own button.
    if (step.primaryLabel && !(step.task && step.task.kind === 'guard-cheat')) {
      html += '<button class="btn" data-action="primary">' + tpl(step.primaryLabel) + '</button>';
    }
    html += '</div>';
    var secondary = renderSecondary(step);
    if (secondary) html += '<p class="secondary">' + secondary + '</p>';
    cardEl.innerHTML = html;
  }

  var resultsIndex = STEPS.findIndex(function (s) { return s.id === 'results'; });

  function goTo(i) {
    stopAutotype();
    // Defensive unfloat on EVERY navigation: re-inserts a still-floating
    // End button into the (old) card subtree so renderStep's innerHTML
    // replacement below discards it instead of orphaning it on <body>.
    unfloatEndGuard();
    // Defensive demote on EVERY navigation, same reasoning: leaving step 10
    // in any direction (Back to 9 included) restores the pane to the
    // instrument column before the new step even renders.
    demotePane();
    // Defensive viewer-host teardown on EVERY navigation, same reasoning
    // (item 12): the replay viewer client runs a RAF loop + ResizeObserver
    // with no destroy() — leaving results (Back-nav included) must revoke
    // its host iframe's Blob URL, not just let renderStep's innerHTML
    // replacement below silently discard the node. cardEl still holds the
    // OLD step's markup here (renderStep(i) hasn't run yet this call), so
    // this only finds anything when the step we're LEAVING was results;
    // resultsModCache is null until results.js has loaded at least once, so
    // this never forces that (lazy) load early.
    if (resultsModCache) {
      var oldResultsMount = cardEl.querySelector('[data-role="results-mount"]');
      if (oldResultsMount) resultsModCache.teardownReplayHost(oldResultsMount);
    }
    var prevStep = STEPS[state.stepIndex];
    var prevTrialId = prevStep.task ? prevStep.task.trialId : null;
    state.stepIndex = i;
    var step = STEPS[i];
    var trialId = step.task ? step.task.trialId : null;

    lifecycle.transitionTo(trialId);
    if (prevTrialId != null) paneRow(prevTrialId, 'trial_end', null);
    if (trialId != null) paneRow(trialId, 'trial_start', null);

    // Lamp wiring stops at the results step (interactive tasks are over) and
    // restarts if the visitor navigates Back into the tour. Both idempotent.
    if (i >= resultsIndex) stopLampWiring(); else startLampWiring();
    document.body.dataset.view = step.act;
    // Full-width payoff — toggled here (not by results.js) so every OTHER
    // step deterministically clears it, the same single-chokepoint pattern
    // as dataset.view above.
    document.body.classList.toggle('results-mode', step.id === 'results');
    // Step-10 pane promotion (item 5): the main column is near-empty for
    // guard-debrief (task: null) while its copy points at the session
    // record — promote the pane into the space above the fold.
    if (step.id === 'guard-debrief') promotePane();
    renderStep(i);
    // Repaints from state.chipCounts (not a reset) so Back-then-forward into
    // guard-cheat shows the tally already accumulated this session.
    if (step.task && step.task.kind === 'guard-cheat') renderViolationChips();
    // Step 11 (walkthrough item 7): wire the weight-input listener + live
    // soft-score readout fresh against the new panel markup renderStep()
    // just wrote.
    if (step.id === 'signals-to-scores') wireScoringPanel(manifest);
    if (step.id === 'results') {
      // Snapshotted here (not earlier): results is the last interactive
      // step, so this reflects the complete session. The pane/replay/guard
      // are all one-way finalizations from here on — the tour proper is
      // done — and the rail (a demo-only "current session" instrument)
      // retires with them; the live pane stays visible, frozen, as the
      // historical record.
      state.sessionReport = monitor.getSessionReport();
      state.pane.freeze();
      finalizeReplay();
      finalizeGuard();
      railEl.hidden = true;
      var mount = cardEl.querySelector('[data-role="results-mount"]');
      // Dynamic import: results.js (and its plot-adapter.js dependency) are
      // only needed once, at this last step — lazy-loading them keeps every
      // earlier step's page weight down. playground.js (C3) is loaded the
      // same lazy way, alongside it (loadPlayground() reuses step 11's
      // cached import when the visitor already saw it there), and wired
      // through buildResults()'s optional 4th `hooks` arg — hooks.onReady is
      // what results.js calls once the first report build succeeds (see
      // results.js's buildResults docblock). The 5th `initial` arg is the
      // walkthrough-item-7 persistence seam: when state.scoringOverrides was
      // ever touched (step 11 weights, or a previous visit to step 12's
      // controls), the FIRST build reflects it too — see
      // buildInitialScoringTransform above. The playground load is its own
      // try: if it fails, the report itself still builds and shows, just
      // without the controls (and without the seam, since it needs
      // playground.js's recomputeSignals too) — same "degrade, don't block"
      // posture as replay/guard elsewhere here.
      import('./results.js').then(function (resultsMod) {
        resultsModCache = resultsMod; // goTo()'s viewer-host teardown, above
        loadPlayground().then(function (playgroundMod) {
          resultsMod.buildResults(mount, state, manifest, {
            onReady: function (ctx) {
              // Settled playground settings, reported after each successful
              // rebuild — buildDownloadFile('config') reads these so the
              // downloaded config matches what the report actually ran with.
              ctx.onControls = function (controls) { state.playgroundControls = controls; };
              // Shared state (CODEX override contract) so step 12's
              // playground initializes from, and writes back to, the same
              // object step 11's weight editors and live-score readout use.
              ctx.scoringOverrides = state.scoringOverrides;
              playgroundMod.mountPlayground(ctx);
            }
          }, buildInitialScoringTransform(playgroundMod, manifest));
        }).catch(function (err) {
          console.warn('cyborg-hunter demo: playground failed to load, showing the report without it', err);
          resultsMod.buildResults(mount, state, manifest);
        });
      }).catch(function (err) {
        console.warn('cyborg-hunter demo: results build failed to load', err);
        if (mount) mount.innerHTML = '<p class="hint">Couldn’t load the report builder in this browser.</p>';
      });
    }
    progressEl.textContent = 'Step ' + (i + 1) + ' of ' + STEPS.length;
  }

  cardEl.addEventListener('click', function (e) {
    var codeTabBtn = e.target.closest('.code-tab');
    if (codeTabBtn) {
      var tabKey = codeTabBtn.dataset.tab;
      cardEl.querySelectorAll('.code-tab').forEach(function (b) { b.classList.toggle('active', b === codeTabBtn); });
      cardEl.querySelectorAll('[data-role="code-pane"]').forEach(function (p) { p.hidden = p.dataset.tab !== tabKey; });
      return;
    }
    var back = e.target.closest('[data-action="back"]');
    if (back) { e.preventDefault(); goTo(state.stepIndex - 1); return; }
    var autotypeBtn = e.target.closest('[data-action="autotype"]');
    if (autotypeBtn) { runAutotype(autotypeBtn); return; }
    var honeypotBtn = e.target.closest('[data-action="honeypot-sim"]');
    if (honeypotBtn) { runHoneypotSim(honeypotBtn); return; }
    var enterFsBtn = e.target.closest('[data-action="enter-fullscreen"]');
    if (enterFsBtn) { handleFullscreenEntry(enterFsBtn); return; }
    var endGuardBtn = e.target.closest('[data-action="end-guard"]');
    if (endGuardBtn) { onEndGuardClick(); return; }
    var primary = e.target.closest('[data-action="primary"]');
    if (primary) {
      var currentStep = STEPS[state.stepIndex];
      // "Start" is the trigger point for C8's always-on replay — must run
      // before goTo(1) below so the first trial (step 2) is bracketed.
      if (currentStep.id === 'intro') startReplay();
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
      else if (link.dataset.key === 'skipToScores') goTo(scoresIndex());
    }
  });

  goTo(0);
}

boot();
