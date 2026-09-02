// src/core/monitor.js
// Main CyborgHunter orchestrator.
// Imports signal modules, manages lifecycle, exposes public API.
//
// The public API is a frozen object returned by init(). Internal state
// is closure-scoped so participants cannot disable monitoring via console.

import { createStateMachine, deepCopy } from './state-machine.js';
import { DEFAULT_THRESHOLDS, PRESETS, VERSION } from '../shared/constants.js';
import { validateConfig, validateScoringShape } from '../shared/validation.js';
import { computeTrialScores, shouldScreenout as _shouldScreenout } from './scoring.js';
import { attachClipboardSignals } from './signals/clipboard.js';
import { attachFocusSignals, attachIdleGapSignals } from './signals/focus.js';
import { attachMouseSignals, computeMouseMetrics } from './signals/mouse.js';
import { attachTypingSignals, attachForeignInputSignals, computeTypingSpeed } from './signals/typing.js';
import { attachBrowserSignals, attachElementTrace } from './signals/browser.js';
import { injectDecoy, removeDecoyElement, resetDecoyState } from './signals/dom-protection.js';

let _activeInstance = null; // Track for idempotent init

/**
 * Initialize a new CyborgHunter monitor instance.
 * Returns a frozen monitor object with lifecycle methods.
 *
 * @param {Object} userConfig - Configuration object. Only participantId is required.
 * @returns {Object} Frozen monitor instance
 */
export function init(userConfig) {
  // Idempotent: if already initialized, destroy previous instance
  if (_activeInstance) {
    _activeInstance.destroy();
    _activeInstance = null;
  }

  // ── Merge preset with user overrides ──
  var presetName = userConfig.preset || "standard";
  var preset = PRESETS[presetName];
  if (!preset) {
    throw new Error("[cyborg-hunter] unknown preset '" + presetName + "'. Use: permissive, standard, strict.");
  }

  // Build effective config: DEFAULT_THRESHOLDS → preset → user overrides.
  var userScoring = userConfig.scoring || {};
  var presetScoring = preset.scoring;
  var mergedScoring = {
    hard: Object.assign({}, presetScoring.hard, userScoring.hard || {}),
    soft: Object.assign({}, presetScoring.soft, userScoring.soft || {}),
    softScoreThreshold: userScoring.softScoreThreshold != null
      ? userScoring.softScoreThreshold : presetScoring.softScoreThreshold
  };

  var config = {
    participantId: userConfig.participantId || "unknown",
    preset: presetName,
    signals: Object.assign({}, preset.signals, userConfig.signals || {}),
    thresholds: Object.assign({}, DEFAULT_THRESHOLDS, preset.thresholds || {}, userConfig.thresholds || {}),
    scoring: mergedScoring,
    screenout: Object.assign({}, preset.screenout, userConfig.screenout || {}),
    domProtection: Object.assign({
      preventTextSelection: false,
      honeypotText: null,
      logCopyAttempts: true,
      renderStimulusAsCanvas: false
    }, userConfig.domProtection || {}),
    collectForPostHoc: Object.assign({
      fullKeystrokeTimestamps: false,
      rawMouseTrack: true,   // see the privacy note at endTrial (flipped on 2026-09-02)
      responseText: false,
      windowPositionLog: true,
      elementTrace: false,
      pasteDropContent: true,
      foreignInputContent: true
    }, userConfig.collectForPostHoc || {}),
    decoyAnswers: userConfig.decoyAnswers || false,
    decoyMap: userConfig.decoyMap || null,
    decoyVisibility: userConfig.decoyVisibility || "offscreen",
    decoyFraming: userConfig.decoyFraming || "answer-key",
    decoyExcludeButtons: userConfig.decoyExcludeButtons || [".jspsych-btn"]
  };

  // Validate config keys — warn on typos.
  var KNOWN_KEYS = [
    "participantId", "preset", "signals", "thresholds", "scoring",
    "screenout", "domProtection", "collectForPostHoc", "decoyAnswers",
    "decoyMap", "decoyVisibility", "decoyFraming", "decoyExcludeButtons",
    "onSignal", "experimentContainer", "knownInputs"
  ];
  var warnings = validateConfig(userConfig, KNOWN_KEYS);
  warnings.forEach(function (w) { console.warn("[cyborg-hunter] " + w); });

  // Shape-check the MERGED scoring config: a nested typo in an override
  // (e.g. countThreshhold) silently disables a screenout rule because the
  // rule object is replaced wholesale and top-level key validation can't see
  // inside it. Warn so the misconfiguration is visible instead of silent.
  validateScoringShape(mergedScoring).forEach(function (w) {
    console.warn("[cyborg-hunter] " + w);
  });

  // Freeze config
  Object.freeze(config);
  Object.freeze(config.signals);
  Object.freeze(config.thresholds);
  Object.freeze(config.scoring);
  Object.freeze(config.scoring.hard);
  Object.freeze(config.scoring.soft);
  Object.freeze(config.screenout);

  // ── Callback hook ──
  var onSignal = typeof userConfig.onSignal === "function"
    ? userConfig.onSignal : null;

  // ── Experiment container ──
  var _experimentContainerSpec = userConfig.experimentContainer || null;
  var _experimentContainerEl = null;
  var _knownInputsSpec = userConfig.knownInputs || null;

  function resolveExperimentContainer() {
    if (_experimentContainerEl) return _experimentContainerEl;
    if (!_experimentContainerSpec) return null;
    if (typeof _experimentContainerSpec === "string") {
      _experimentContainerEl = document.querySelector(_experimentContainerSpec);
    } else if (_experimentContainerSpec.nodeType) {
      _experimentContainerEl = _experimentContainerSpec;
    }
    return _experimentContainerEl;
  }

  function isKnownInput(target) {
    if (!target) return false;
    if (_knownInputsSpec) {
      try { if (target.matches(_knownInputsSpec)) return true; } catch (e) {}
    }
    var container = resolveExperimentContainer();
    if (container) return container.contains(target);
    return null;
  }

  function fireSignal(type, event, data) {
    if (!onSignal) return;
    try {
      onSignal({
        type: type,
        event: event || null,
        trialId: trialData ? trialData.trialId : null,
        data: data || {}
      });
    } catch (e) { /* Callback errors must not break the library */ }
  }

  // ── Internal state ──
  var sm = createStateMachine();
  // viewportWidthShifts is the canonical name since 0.6.1 (the signal measures
  // viewport-width changes, not Web-Vitals-style layout shift). layoutShifts is
  // kept as a deprecated alias pointing at the SAME array, so serialized
  // reports carry both keys and downstream consumers reading either keep
  // working. The alias will be removed in a future major version.
  var _viewportWidthShifts = [];
  var sessionData = {
    pasteCount: 0, copyCount: 0, dropCount: 0,
    tabAwaySums: [], tabAwayEvents: [], charsPerSec: [],
    sidebarEvents: [], devToolsEvents: [],
    aiExtensionsFound: [], keyboardShortcuts: [],
    windowPositions: [], idleGaps: [],
    extensionInjections: [],
    viewportWidthShifts: _viewportWidthShifts,
    layoutShifts: _viewportWidthShifts,
    zoomChanges: [],
    hardScore: {}, softScore: 0, trialsCompleted: 0
  };
  var trialData = null;
  var listeners = [];
  var trialListeners = [];
  var intervals = [];        // session-scoped, cleared at destroy()
  var trialIntervals = [];   // trial-scoped, cleared at endTrial() AND destroy()

  // Module-level decoy state (cal-{N} numbering) must restart per instance.
  resetDecoyState();

  function transition(to) {
    if (!sm.transition(to)) {
      // Common causes: calling startTrial() while another trial is open
      // (forgot endTrial?), calling endTrial() before startTrial(), or
      // calling anything after destroy(). Show what was expected vs got
      // so the user can match the lifecycle.
      throw new Error(
        "[cyborg-hunter] invalid lifecycle call: cannot transition from '" +
        sm.current + "' to '" + to + "'. " +
        "Expected order: init() → startSession() → (startTrial → endTrial)* → destroy(). " +
        "Common cause: a startTrial() without a preceding endTrial(), or a call after destroy()."
      );
    }
  }

  function addListener(target, event, handler, options) {
    target.addEventListener(event, handler, options || false);
    listeners.push({ target: target, event: event, handler: handler, options: options || false });
  }

  function addTrialListener(target, event, handler, options) {
    target.addEventListener(event, handler, options || false);
    trialListeners.push({ target: target, event: event, handler: handler, options: options || false });
  }

  function addInterval(id) {
    intervals.push(id);
  }

  function addTrialInterval(id) {
    trialIntervals.push(id);
  }

  function removeTrialListeners() {
    trialListeners.forEach(function (l) {
      l.target.removeEventListener(l.event, l.handler, l.options);
    });
    trialListeners = [];
    trialIntervals.forEach(function (id) { clearInterval(id); });
    trialIntervals = [];
    removeDecoyElement();
  }

  // ── Shared context for signal modules ──
  // Signal modules receive this context object. They use it to access
  // config, session/trial data, and register listeners. This avoids
  // modules importing from each other (which would cause circular deps).
  function buildSessionCtx() {
    return {
      config, sessionData, listeners,
      addListener, addInterval, fireSignal,
      getTrialData: function () { return trialData; }
    };
  }

  function buildTrialCtx() {
    return {
      config, sessionData, trialData, listeners,
      addTrialListener, addInterval, addTrialInterval, fireSignal, isKnownInput,
      getTrialData: function () { return trialData; }
    };
  }

  // ── Build the public API ──
  var monitor = {
    startSession: function () {
      transition("session");
      var ctx = buildSessionCtx();
      attachBrowserSignals(ctx);
      attachFocusSignals(ctx);
    },

    startTrial: function (opts) {
      transition("trial");
      opts = opts || {};

      // Allow per-trial override of experiment container
      if (opts.experimentContainer != null) {
        _experimentContainerSpec = opts.experimentContainer;
        _experimentContainerEl = null;
      }
      if (opts.knownInputs != null) {
        _knownInputsSpec = opts.knownInputs;
      }

      trialData = {
        trialId: opts.trialId || ("trial-" + sessionData.trialsCompleted),
        phase: opts.phase || "default",
        startTime: performance.now(),
        pasteEvents: [], copyEvents: [], dropEvents: [],
        editTimestamps: [], mouseEvents: [],
        tabAwayEvents: [], idleGaps: [],
        foreignInputEvents: [],
        syntheticInsertions: []
      };

      // Decoy injection. Logic in one place instead of four scattered branches:
      //   - decoyAnswers off + opts.decoyAnswer set      → warn, no injection
      //   - opts.decoyAnswer === false                   → record explicit skip
      //   - opts.decoyAnswer is a non-empty string OR
      //     config.decoyMap has an entry for this trial  → inject NOW
      //   - anything else                                → defer via setTimeout(0)
      //                                                    (gives DOM time to settle
      //                                                    when startTrial runs
      //                                                    before the trial UI is up)
      // Invalid (non-string, non-false, non-null) values get a warning before
      // the deferred inject.
      removeDecoyElement();
      if (!config.decoyAnswers) {
        if (opts.decoyAnswer != null) {
          console.warn(
            "[cyborg-hunter] decoyAnswer provided but decoyAnswers is not enabled. " +
            "Add decoyAnswers: true to init() config."
          );
        }
      } else if (opts.decoyAnswer === false) {
        trialData.decoy = { level: 0, source: "skipped" };
      } else {
        var currentTrialId = trialData.trialId;
        var inject = function () {
          injectDecoy(opts, currentTrialId, config, trialData, function () { return trialData; });
        };
        var hasExplicitString = typeof opts.decoyAnswer === "string" && opts.decoyAnswer.length > 0;
        var hasMapEntry = config.decoyMap && config.decoyMap[currentTrialId];
        if (hasExplicitString || hasMapEntry) {
          inject();
        } else {
          if (opts.decoyAnswer != null) {
            console.warn(
              "[cyborg-hunter] decoyAnswer must be a non-empty string, got: " +
              typeof opts.decoyAnswer + ". Falling through to auto-detection."
            );
          }
          setTimeout(inject, 0);
        }
      }

      // Attach trial-scoped signal listeners
      var ctx = buildTrialCtx();
      attachClipboardSignals(ctx);
      attachTypingSignals(ctx);
      attachMouseSignals(ctx);
      attachIdleGapSignals(ctx);
      attachElementTrace(ctx);

      // Foreign input detection (only when container is specified)
      if (_experimentContainerSpec || _knownInputsSpec) {
        attachForeignInputSignals(ctx);
      }
    },

    endTrial: function () {
      transition("session");
      if (!trialData) return null;

      // Check if decoy element survived the trial
      if (trialData.decoy) {
        trialData.decoy.survivedTrial = !!document.getElementById("ch-decoy");
      }

      removeTrialListeners();

      var report = deepCopy(trialData);
      report.duration_ms = performance.now() - trialData.startTime;
      report.libraryVersion = VERSION;
      report.participantId = config.participantId;
      // Wall-clock stamp at trial end (ISO 8601). Downstream renderers anchor
      // per-rule phase bands with Date.parse(trial.timestamp); before 0.6.1
      // the report carried only performance.now() values, so payloads whose
      // app layer didn't stamp its own timestamp produced NaN anchors.
      // Note: in Shape-1 ingest the integrity sub-object wins key collisions,
      // so for new data this stamp shadows an app-level trial timestamp —
      // both are trial-end wall-clocks, so they agree to within milliseconds.
      report.timestamp = new Date().toISOString();

      // Compute typing speed
      var cps = computeTypingSpeed(trialData.editTimestamps);
      if (cps !== null) {
        report.charsPerSec = cps;
        sessionData.charsPerSec.push(cps);
      }

      // Privacy gate: the raw per-edit timestamps are keystroke-timing data.
      // Persist them ONLY when keystroke dynamics are explicitly enabled
      // (signals.keystrokeDynamics, or collectForPostHoc.fullKeystrokeTimestamps).
      // Otherwise keep only the derived charsPerSec — the typing-speed signal
      // still works, but the raw timings never leave the browser. Without this,
      // the documented "off by default in permissive/standard" privacy toggle was
      // inert and the timings were saved verbatim regardless.
      if (!config.signals.keystrokeDynamics && !config.collectForPostHoc.fullKeystrokeTimestamps) {
        report.editTimestamps = [];
      }

      // Compute mouse bot metrics
      var mouseMetrics = computeMouseMetrics(
        trialData.mouseEvents,
        config.thresholds.mouseBotMinEvents
      );
      if (mouseMetrics) {
        report.mouseMetrics = mouseMetrics;
      }

      // Raw per-sample mouse coordinates persist under `mouseTrack` (the
      // name extract-core's field map expects: mouseTrack → mouseEvents, so a
      // saved report round-trips through extractIntegrityData() without new
      // glue) unless collectForPostHoc.rawMouseTrack is set false, in which
      // case only the derived mouseMetrics above ship and the {x,y,t,type}
      // samples never leave the browser. ON by default since 2026-09-02: a
      // researcher who adds CH to an experiment has already adjudicated
      // collecting behavioural traces, and an off-by-default gate made the
      // report's trajectory panels read "no mouse data" for everyone who
      // never found the toggle (found by CK on the bench harness). The
      // toggle stays for protocols that need less.
      if (config.collectForPostHoc.rawMouseTrack) {
        report.mouseTrack = report.mouseEvents;
      }
      delete report.mouseEvents;

      // Accumulate into session
      sessionData.trialsCompleted++;

      // Two-tier scoring
      var scores = computeTrialScores(trialData, sessionData, config, report);
      report.trialSoftScore = scores.trialSoftScore;
      report.trialSignals = scores.trialSignals;
      sessionData.softScore += scores.trialSoftScore;
      sessionData.hardScore = scores.updatedHardScore;

      trialData = null;
      return report;
    },

    getSessionScore: function () {
      return {
        hardScore: deepCopy(sessionData.hardScore),
        softScore: sessionData.softScore,
        softScoreThreshold: config.scoring.softScoreThreshold,
        anyHardTriggered: Object.keys(sessionData.hardScore).some(function (k) {
          return sessionData.hardScore[k].triggered;
        }),
        trialsCompleted: sessionData.trialsCompleted
      };
    },

    getSessionReport: function () {
      var report = deepCopy(sessionData);
      // Merge in the authoritative scoring summary — same values getSessionScore() returns.
      // Single source of truth: callers don't need to call both methods.
      report.hardScore = deepCopy(sessionData.hardScore);
      report.softScore = sessionData.softScore;
      report.softScoreThreshold = config.scoring.softScoreThreshold;
      report.anyHardTriggered = Object.keys(sessionData.hardScore).some(function (k) {
        return sessionData.hardScore[k].triggered;
      });
      report.trialsCompleted = sessionData.trialsCompleted;
      // Carry the effective runtime settings the CLI report needs to interpret
      // this participant's data with the SAME thresholds the library screened
      // them against (e.g. a strict-preset participant's tab-away cutoff), rather
      // than analyst-side CLI defaults.
      report.config = {
        preset: config.preset,
        participantId: config.participantId,
        thresholds: {
          tabAwayDurationMs: config.thresholds.tabAwayDurationMs,
          typingSpeedCps: config.thresholds.typingSpeedCps
        }
      };
      report.libraryVersion = VERSION;
      return report;
    },

    shouldScreenout: function () {
      return _shouldScreenout(sessionData, config);
    },

    getRawData: function () {
      return deepCopy({
        session: sessionData,
        config: { preset: config.preset, participantId: config.participantId },
        libraryVersion: VERSION
      });
    },

    getTrialSnapshot: function () {
      if (!trialData) return null;
      return deepCopy(trialData);
    },

    destroy: function () {
      sm.transition("destroyed");
      // Clean up session-scoped listeners
      listeners.forEach(function (l) {
        if (l.options && l.options._isMutationObserver) {
          l.handler.disconnect();
        } else if (l.options && l.options._isResizeObserver) {
          l.handler.disconnect();
        } else {
          l.target.removeEventListener(l.event, l.handler, l.options);
        }
      });
      listeners = [];
      removeTrialListeners();
      intervals.forEach(function (id) { clearInterval(id); });
      intervals = [];
      _activeInstance = null;
    }
  };

  Object.freeze(monitor);
  _activeInstance = monitor;
  return monitor;
}
