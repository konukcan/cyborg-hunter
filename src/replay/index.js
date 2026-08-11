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
import { serialize, SCHEMA_VERSION } from './serializer.js';
import {
  replayFilename, buildReplayMeta, autoSave, compressRecording,
} from './persistence.js';

var _active = null;

/**
 * Create (and replace) the singleton recorder.
 *
 * REDACTION CARRIES ACROSS RECORDINGS ON ONE PAGE. Spec §8 makes redaction a
 * property of the FILE, and the mechanism that enforces it — redaction.js's
 * taint set, which remembers every node whose content was ever withheld — has
 * PAGE lifetime, not recording lifetime. So a second `attach()` in the same
 * page load inherits the first's withholding: a field the first recording
 * redacted stays empty in the second even if the second configures no
 * redaction at all.
 *
 * This is deliberate and it is the safe direction (it can only withhold, never
 * leak). Resetting it here would re-open the hole the set exists to close — a
 * node withheld at a keyframe, then moved out of its redacted container and
 * re-serialized. Worth knowing when reading a recording from an SPA that runs
 * several blocks in one page load: an empty field may mean "the participant
 * typed nothing" OR "an earlier recording on this page withheld it", and the
 * file does not distinguish them. Pinned in capture-e2e.test.js.
 */
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
      // FIRST for one mundane reason: `attachDomCapture` needs
      // `trace.getScrolledElements` as a VALUE, and that handle only exists
      // once trace capture has attached.
      //
      // Not because of hook ordering. `getScrolledElements()` prunes detached
      // elements on read (capture-trace.js), so the trial-start prune hook is
      // redundant for the seed and reversing the two attachments changes
      // nothing observable. That hook stays for the other reason it was
      // written: the tracker is a STRONG Set, so pruning once per trial bounds
      // its growth even across trials where nothing reads it.
      //
      // The handle is passed as a live function rather than as a snapshot of
      // the Set, so that elements which first scroll after this line are still
      // seeded — see capture-dom.test.js ("enumerates capture-trace's scrolled
      // elements", which adds to the set after attach) and end to end in
      // capture-e2e.test.js ("the second keyframe seeds the scroll it
      // inherited"). Neither test DISCRIMINATES, though: `getScrolledElements`
      // returns the live Set by reference, so caching its result here would
      // pass both. The function form buys independence from that — a tracker
      // that returned a copy, or rebuilt its set, would still work — which is
      // a property of the seam, not one today's tests can see.
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
          meta: { schema_version: SCHEMA_VERSION, saved_to: 'no_session',
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
