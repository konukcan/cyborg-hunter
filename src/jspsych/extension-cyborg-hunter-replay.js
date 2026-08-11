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
    version: '0.7.5',
    data: {}   // per-trial return is {}; session meta goes via addProperties
  };

  constructor(jsPsych) {
    this.jsPsych = jsPsych;
    this.api = null;
    this._chMonitor = null;
    this._lastRecording = null;
    this._monitoring = false;
  }

  // Keyframe cadence on a jsPsych host: EVERY segment, always.
  //
  // The standalone recorder keyframes adaptively (spec §3's size trigger plus a
  // segment fallback) because a persistent DOM makes a continuation cheap: the
  // player carries the previous segment's tree forward and applies deltas. A
  // jsPsych trial wipes the display and builds a new one, so there is nothing
  // to carry forward — a continuation would make the player reconstruct each
  // trial by replaying the wipe as a removal of everything followed by an
  // insertion of everything, and would leave a seek into any trial dependent on
  // the trials before it. §3 says as much: wiping hosts SHOULD keyframe every
  // segment, which is also jsPsych-v1's own behaviour.
  //
  // Forced over researcher config rather than merged under it: the reason is a
  // property of the host, not a tuning preference, so a value passed here is a
  // misunderstanding rather than a choice. It is not discarded silently.
  initialize(params) {
    this.params = params || {};
    if (this.params.keyframeEvery != null && this.params.keyframeEvery !== 1) {
      console.warn('[cyborg-hunter-replay] ignoring keyframeEvery: ' +
        this.params.keyframeEvery + ' — jsPsych wipes the display between ' +
        'trials, so every segment is recorded as a keyframe.');
    }
    this.api = CHReplay.attach(Object.assign({}, this.params, { keyframeEvery: 1 }));
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

  // Spec §2's `host`: the runtime the recorder was embedded in, as opposed to
  // `recorder`, which is this library. The recorder core is host-agnostic by
  // construction and never sniffs for globals, so the adapter — the one piece
  // that exists because jsPsych does — is where the answer comes from.
  //
  // §2 types host as `{name, version} | null` with version a required STRING,
  // so a runtime that reports no version gets no host record rather than a
  // half-record a conforming consumer would trip over.
  //
  // `version()` is the only shape checked for, because it is the only shape
  // jsPsych has: 7.3.1 defines `version() { return version; }` on the JsPsych
  // class and 8.x keeps the same core-API accessor. An earlier draft also
  // accepted a plain string field; nothing produces one, so it was speculative
  // dead code and went.
  //
  // Never throws: finalize()'s outer catch turns any throw into
  // replayFinalizeError with NO autosave, and the least important field in
  // the file must not be able to cost the recording.
  _detectHost() {
    try {
      var jp = this.jsPsych;
      if (!jp || typeof jp.version !== 'function') return null;
      var v = jp.version();
      if (typeof v !== 'string' || !v) return null;
      return { name: 'jspsych', version: v };
    } catch (e) {
      return null;
    }
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
      var result = await this.api.autoSaveNow({
        chSessionReport: chReport,
        host: this._detectHost()
      });
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
