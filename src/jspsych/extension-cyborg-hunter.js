// jsPsych extension adapter for cyborg-hunter.
// Loaded as a script tag AFTER cyborg-hunter.min.js — references
// window.CyborgHunter at runtime rather than importing the core, so the
// extension stays a thin (~2KB) adapter even though the core is ~28KB.

class CyborgHunterExtension {
  static info = {
    name: 'cyborg-hunter',
    // Must match the cyborg-hunter library version (src/shared/constants.js
    // and package.json). Hand-bumped on each release; if you forget, the
    // jsPsych developer console shows a stale number — the actual version
    // attached to data is read from window.CyborgHunter.VERSION at runtime.
    version: '0.7.2',
    data: { integrity: { type: 'object' } }
  };

  constructor(jsPsych) {
    this.jsPsych = jsPsych;
    this.monitor = null;
    this.params = {};
    this._monitoring = false;
    this._trialStart_perfNow = null;
  }

  // jsPsych calls this once during initJsPsych setup.
  // Splits extension-specific keys out and forwards the rest to the monitor.
  initialize(params) {
    this.params = params;
    const { autoMonitor, excludeTrialTypes, ...monitorConfig } = params;

    const CyborgHunter = window.CyborgHunter || window.IntegrityMonitor;
    if (!CyborgHunter) {
      throw new Error('CyborgHunter not found. Load cyborg-hunter.min.js before the jsPsych extension.');
    }

    this.monitor = CyborgHunter.init(monitorConfig);
    this.monitor.startSession();
  }

  // jsPsych 7 unconditionally calls on_start for every trial that lists this
  // extension, even though the actual setup happens in on_load (after DOM
  // render). Without this no-op, the very next trial throws
  // "this.extensions['cyborg-hunter'].on_start is not a function".
  on_start(_params) {}

  // Called per trial after DOM render. Per-trial extension params arrive here.
  on_load(params) {
    this._monitoring = false;

    // Explicit opt-in mode: only monitor trials that pass a trialId.
    if (this.params.autoMonitor === false && !(params && params.trialId)) {
      return;
    }

    // Auto-monitor with exclusions: skip trial types named in the config
    // (instructions, fixation, etc.). Trial type name comes from the plugin's
    // static info.name property.
    if (this.params.excludeTrialTypes) {
      const typeName = this.jsPsych.getCurrentTrial().type?.info?.name || '';
      if (this.params.excludeTrialTypes.includes(typeName)) return;
    }

    this._monitoring = true;
    // Capture performance.now() at trial start so ingest can compute
    // trial-relative tab-away timestamps by direct subtraction. tabAwayEvents
    // store their `start` on the same monotonic clock, so the difference is
    // exact. Without this anchor, the CLI falls back to a heuristic estimator
    // on session-anchored data, which is less precise.
    this._trialStart_perfNow = performance.now();
    const trialIndex = this.jsPsych.getProgress().current_trial_global;
    this.monitor.startTrial({
      trialId: (params && params.trialId) || `trial-${trialIndex}`,
      phase: params?.phase || null,
      // Nullish coalescing (not ||) so an explicit `decoyAnswer: false` — the
      // per-trial "skip the decoy" opt-out — reaches the core as false. With
      // `|| null` it became null, and the core auto-generated a decoy instead.
      decoyAnswer: params?.decoyAnswer ?? null,
      experimentContainer: params?.experimentContainer || null
    });
  }

  // Called when a trial finishes. Returns the integrity report, which jsPsych
  // merges into the trial's data under the key declared in static info.data
  // (i.e., data.integrity).
  on_finish(_params) {
    if (!this._monitoring) return {};
    this._monitoring = false;
    const report = this.monitor.endTrial();
    // Forward the on_load anchor (see on_load above) so ingest can do exact
    // time arithmetic without re-deriving it.
    report.trialStart_perfNow = this._trialStart_perfNow;
    this._trialStart_perfNow = null;
    return { integrity: report };
  }

  // Called explicitly by the researcher from initJsPsych({ on_finish }), BEFORE
  // saving data. Example:
  //
  //   const jsPsych = initJsPsych({
  //     extensions: [{ type: jsPsychCyborgHunter, params: { ... } }],
  //     on_finish: function () {
  //       jsPsych.extensions['cyborg-hunter'].finalize();
  //       jsPsych.data.get().localSave('csv', 'data.csv');
  //     }
  //   });
  //
  // Why this isn't automatic: jsPsych 7 has no on_finish_experiment extension
  // hook (only initialize / on_start / on_load / on_finish exist). An earlier
  // version of this wrapper defined on_finish_experiment and silently dropped
  // session data because jsPsych never called it. We surface the boundary
  // explicitly so it can't silently regress.
  //
  // Persistence shape (split attachment):
  //   - Scalars (counts, booleans, version) → addProperties, so they appear
  //     as columns on EVERY trial row. Cheap, queryable from R/pandas.
  //   - Arrays + nested objects (sidebarEvents, integrityScore, etc.) →
  //     addDataToLastTrial, so they're attached ONCE on the final row.
  //     Avoids duplicating kilobytes of identical JSON across every row.
  //
  // After persisting, tears down listeners and clears session state.
  finalize() {
    if (!this.monitor) return;

    try {
      // getSessionReport() is the source of truth: contains both the
      // accumulators and the scoring summary in one shape.
      const report = this.monitor.getSessionReport();

      const {
        // Arrays — attached once on the last trial only (no CSV bloat).
        sidebarEvents = [], keyboardShortcuts = [], windowPositions = [],
        layoutShifts = [], zoomChanges = [], idleGaps = [], extensionInjections = [],
        tabAwaySums = [], charsPerSec = [], aiExtensionsFound = [],
        // Scoring summary — full object on last trial; key scalars below
        // also duplicated to every row via addProperties.
        hardScore, softScore, anyHardTriggered, trialsCompleted, softScoreThreshold,
        // Scalars.
        pasteCount = 0, copyCount = 0, dropCount = 0,
        libraryVersion, config,
        // Future-proof: anything new from the monitor flows into integritySession
        // automatically without polluting the per-row scalar columns.
        ...extras
      } = report;

      this.jsPsych.data.addProperties({
        integrityPasteCount: pasteCount,
        integrityCopyCount: copyCount,
        integrityDropCount: dropCount,
        integrityAnyHardTriggered: !!anyHardTriggered,
        integritySoftScore: softScore,
        cyborgHunterVersion: libraryVersion,
      });

      this.jsPsych.data.addDataToLastTrial({
        integritySession: {
          pasteCount, copyCount, dropCount,
          sidebarEvents, keyboardShortcuts, windowPositions,
          layoutShifts, zoomChanges, idleGaps, extensionInjections,
          tabAwaySums, charsPerSec, aiExtensionsFound,
          // Persist the effective runtime settings (preset + thresholds the CLI
          // consumes) so the report can interpret this participant with the
          // thresholds the library actually used, not analyst-side defaults.
          config,
          ...extras
        },
        integrityScore: { hardScore, softScore, anyHardTriggered, trialsCompleted, softScoreThreshold },
      });
    } catch (e) {
      // Don't crash the experiment's end-of-session path — the user's save
      // call (localSave / dispatcher / etc.) MUST still run. But don't fail
      // silently either — drop a marker into the data so analysts can see
      // during ingest that finalize() failed for this participant, plus log
      // to console for local debugging.
      console.warn('[cyborg-hunter] Failed to save session report:', e);
      try {
        this.jsPsych.data.addProperties({
          cyborgHunterFinalizeError: String(e && e.message ? e.message : e)
        });
      } catch (_) { /* if even addProperties fails, the warn above is all we have */ }
    }

    this.monitor.destroy();
  }
}

// Module export AND IIFE-friendly window assignment. The build target is IIFE,
// so `window.jsPsychCyborgHunter` is what researchers reference in their
// extensions array. The named export exists for completeness.
export { CyborgHunterExtension };
if (typeof window !== 'undefined') {
  window.jsPsychCyborgHunter = CyborgHunterExtension;
}
