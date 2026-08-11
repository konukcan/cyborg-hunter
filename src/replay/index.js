// src/replay/index.js
// Public assembly for the replay recorder: singleton attach(), capture
// wiring by tier, serialization + persistence surface.
//
// Standalone usage (no jsPsych):
//   const rec = CyborgHunterReplay.attach({ participantId, tier: 'dom',
//     autoSave: { mode: 'datapipe', experimentId: 'ABC' } });
//   rec.startSession();
//   rec.startTrial({ trialId: 'r1' });  // optional bracketing
//   rec.endTrial();
//   rec.stopSession('finished');
//   await rec.autoSaveNow();            // or rec.getRecording() and DIY
//   rec.destroy();

import { createRecorder } from './recorder.js';
import { attachTraceCapture } from './capture-trace.js';
import { attachDomCapture } from './capture-dom.js';
import { createSpan } from './span.js';
import { serialize } from './serializer.js';
import {
  replayFilename, buildReplayMeta, autoSave, compressRecording,
} from './persistence.js';

var _active = null;

export function attach(userConfig) {
  if (_active) {
    console.warn('[cyborg-hunter-replay] attach() called while a recorder is active — replacing the previous instance (its unsaved recording is discarded).');
    _active.destroy();
    _active = null;
  }

  var rec = createRecorder(userConfig);

  var api = {
    // Exposed for tests and advanced integrations; not part of the
    // documented surface.
    _recorder: rec,
    config: rec.config,

    startSession: function () {
      rec.startSession();
      // ONE capture span per recording (span.js): the node ids the keyframe
      // assigns and the record of what the file contains. Both capture modules
      // get the SAME object, because an event's `target` and a patch's `node`
      // are the same numbering or neither of them means anything. Created here,
      // reset at each keyframe by the DOM capture.
      var span = createSpan();
      // The §8 redaction taint set is deliberately NOT threaded alongside it.
      // Both capture modules accept one, and threading an explicit object to
      // some consumers and not others is the failure this seam invites: the
      // halves stop sharing, and a field moved out of a redacted container is
      // re-exposed by whichever half was forgotten. Passing NONE puts every
      // consumer — snapshot, mutations, initial-state, capture-trace — on
      // redaction.js's single module-level set, which is the symmetric answer
      // and the fail-closed one: a future consumer that forgets to thread
      // still lands in the same place. Its cost is that two recorders on one
      // page can over-redact each other's nodes, which is the safe direction,
      // and is what redaction.js documents.
      //
      // Capture modules attach after the session transition so nothing
      // touches the DOM until the researcher opts in. Trace capture goes
      // FIRST: its scrolled-element tracker is what the keyframe seed
      // enumerates, and its trial-start hook (which prunes that set) must run
      // before the keyframe hook that reads it.
      var trace = attachTraceCapture(rec, { span: span });
      if (rec.config.tier === 'dom' || rec.config.tier === 'canvas') {
        // 'canvas' is accepted for forward compat but captures at dom tier
        // in v0.7 (canvas snapshots arrive with the v0.8 diff codec).
        attachDomCapture(rec, {
          span: span,
          scrolled: trace.getScrolledElements,
        });
      }
      return api;
    },

    startTrial: function (opts) { rec.startTrial(opts); return api; },
    endTrial: function () { rec.endTrial(); return api; },
    stopSession: function (reason) { rec.stopSession(reason); return api; },

    getRecording: function (opts) {
      return serialize(rec.getState(), opts || {});
    },

    getRecordingCompressed: function (opts) {
      return compressRecording(api.getRecording(opts));
    },

    // Serialize + persist with the configured autoSave mode; returns
    // { recording, saveResult, meta } so callers (the jsPsych adapter, or a
    // standalone researcher) can attach the meta pointer to their data.
    // Teardown-safe: if the session never started (nothing to serialize),
    // it degrades to a no_session result instead of throwing, so a finish
    // path is never interrupted — while a DIRECT getRecording() before
    // startSession still throws to surface the programmer error.
    autoSaveNow: async function (opts) {
      if (rec.getState().sessionStart == null) {
        return {
          recording: null,
          saveResult: { saved_to: 'no_session' },
          meta: { schema_version: 1, saved_to: 'no_session',
                  note: 'recorder was never started; nothing to save' }
        };
      }
      var recording = api.getRecording(opts);
      var saveResult = await autoSave(recording, rec.config.autoSave);
      var meta = buildReplayMeta(recording, saveResult.saved_to);
      if (saveResult.error) meta.save_error = saveResult.error;
      return { recording: recording, saveResult: saveResult, meta: meta };
    },

    destroy: function () {
      rec.destroy();
      if (_active === api) _active = null;
    }
  };

  _active = api;
  return api;
}

export { replayFilename, buildReplayMeta, serialize };

// Browser global — same pattern as the guard extensions (explicit window
// assignment; no esbuild globalName).
if (typeof window !== 'undefined') {
  window.CyborgHunterReplay = { attach: attach };
}
