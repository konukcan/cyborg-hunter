// jsPsych extension adapter for the cyborg-hunter session replay recorder.
// Bundled SELF-CONTAINED (imports the replay core), following the guard-
// extension precedent: one dist file provides both window.CyborgHunterReplay
// (standalone use) and window.jsPsychCyborgHunterReplay (jsPsych use).
//
// Wiring (order matters at finalize; declaration order is free):
//
//   const jsPsych = initJsPsych({
//     extensions: [
//       { type: jsPsychCyborgHunter,       params: { participantId, preset } },
//       { type: jsPsychGuardFriction },
//       { type: jsPsychGuardHoneypot },
//       { type: jsPsychCyborgHunterReplay, params: {
//           participantId, tier: 'dom',
//           autoSave: { mode: 'datapipe', experimentId: 'ABC123' } } }
//     ],
//     on_finish: async function () {
//       jsPsych.extensions['guard-friction'].finalize();
//       jsPsych.extensions['guard-honeypot'].finalize();
//       jsPsych.extensions['cyborg-hunter'].finalize();
//       await jsPsych.extensions['cyborg-hunter-replay'].finalize();
//       jsPsych.data.get().localSave('csv', 'data.csv');
//     }
//   });
//
// Replay finalizes LAST: it pulls CH's session report through a monitor
// reference stashed at initialize() — never through window.CyborgHunter,
// whose singleton slot is nulled by CH's destroy(). getSessionReport()
// remains callable after destroy() (sessionData survives teardown), so the
// pull works even though CH finalized first.

import * as CHReplay from '../replay/index.js';
import { buildReplayMeta } from '../replay/persistence.js';

class CyborgHunterReplayExtension {
  static info = {
    name: 'cyborg-hunter-replay',
    version: '0.7.3',
    data: {}   // per-trial return is {}; session meta goes via addProperties
  };

  constructor(jsPsych) {
    this.jsPsych = jsPsych;
    this.api = null;
    this._chMonitor = null;
    this._lastRecording = null;
    this._monitoring = false;
  }

  initialize(params) {
    this.params = params || {};
    this.api = CHReplay.attach(this.params);
    this.api.startSession();
    this._stashChMonitor();
  }

  // The cyborg-hunter extension initializes before this one when declared
  // earlier in the extensions array; if not, retry the stash at finalize.
  _stashChMonitor() {
    try {
      var ch = this.jsPsych && this.jsPsych.extensions &&
        this.jsPsych.extensions['cyborg-hunter'];
      if (ch && ch.monitor) this._chMonitor = ch.monitor;
    } catch (e) { /* standalone replay is fine */ }
  }

  // jsPsych 7 calls on_start unconditionally for every trial that lists the
  // extension — must exist even as a no-op (see extension-cyborg-hunter.js).
  on_start(_params) {}

  on_load(params) {
    if (!this.api) return;
    this._monitoring = true;
    var trialIndex = 0;
    var plugin = 'unknown';
    try { trialIndex = this.jsPsych.getProgress().current_trial_global; } catch (e) {}
    try {
      plugin = (this.jsPsych.getCurrentTrial() || {}).type?.info?.name || 'unknown';
    } catch (e) {}
    this.api.startTrial({
      trialId: (params && params.trialId) || 'trial-' + trialIndex,
      plugin: plugin
    });
  }

  on_finish(_params) {
    if (this.api && this._monitoring) {
      this._monitoring = false;
      this.api.endTrial();
    }
    return {};
  }

  // Called manually from the experiment's on_finish, AFTER the other three
  // extensions (see header). Serializes, autosaves, attaches the meta
  // pointer. Never throws — the experiment's save path must always run.
  async finalize() {
    if (!this.api) return;
    try {
      try { this.api.stopSession('finished'); } catch (e) { /* already stopped */ }
      if (!this._chMonitor) this._stashChMonitor();
      var chReport = null;
      try {
        chReport = this._chMonitor ? this._chMonitor.getSessionReport() : null;
      } catch (e) {
        console.warn('[cyborg-hunter-replay] could not pull CH session report:', e);
      }
      var result = await this.api.autoSaveNow({ chSessionReport: chReport });
      this._lastRecording = result.recording;
      this.jsPsych.data.addProperties({ integrityReplayMeta: result.meta });
    } catch (e) {
      console.warn('[cyborg-hunter-replay] finalize failed:', e);
      try {
        this.jsPsych.data.addProperties({
          replayFinalizeError: String(e && e.message ? e.message : e)
        });
      } catch (_) { /* nothing left to do */ }
    }
    try { this.api.destroy(); } catch (e) { /* teardown best-effort */ }
    // Null the handle so a second finalize() (e.g. duplicated on_finish
    // wiring) is a clean no-op instead of re-serializing and re-saving.
    this.api = null;
  }

  // Debug/test access to the finalized recording (also handy in the console
  // during piloting: jsPsych.extensions['cyborg-hunter-replay'].getLastRecording()).
  getLastRecording() {
    return this._lastRecording;
  }
}

export { CyborgHunterReplayExtension };
if (typeof window !== 'undefined') {
  window.jsPsychCyborgHunterReplay = CyborgHunterReplayExtension;
}
