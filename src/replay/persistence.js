// src/replay/persistence.js
// Artifact naming, autosave, and the integrityReplayMeta pointer.
//
// Delivery semantics are honest by design (design §10): the artifact has the
// same delivery guarantees as the jsPsych data itself. There is no fallback
// chain — the configured mode either works or reports saved_to:'failed', and
// the analyst-facing meta pointer always states what actually happened.

var DATAPIPE_URL = 'https://pipe.jspsych.org/api/data/';

import { sanitizeId } from '../shared/constants.js';

/**
 * <pid>-replay-<sessionStartEpochMs>.json — the epoch suffix makes reloads
 * produce distinct artifacts instead of overwriting (CLI picks the latest
 * and warns on multiples).
 */
export function replayFilename(recording) {
  var pid = sanitizeId(recording.metadata.participant_id);
  var epoch = Date.parse(recording.metadata.start_time);
  return pid + '-replay-' + epoch + '.json';
}

/**
 * The small pointer that rides along in the jsPsych data (one
 * addProperties call) so the analyst can tell from the CSV alone whether a
 * replay exists, how big it was, and where it went.
 */
export function buildReplayMeta(recording, savedTo) {
  return {
    schema_version: recording.schema_version,
    tier: recording.metadata.tier,
    saved_to: savedTo,
    bytes_uncompressed: JSON.stringify(recording).length,
    capture_failures: (recording.ch_extensions.capture_failures || [])
      .map(function (f) { return f.channel; }),
    capture_stopped: !!recording.ch_extensions.capture_stopped
  };
}

/**
 * Saves the recording using the configured mode. Never throws — failures
 * come back as { saved_to: 'failed', error } so the experiment's finish
 * path is never interrupted.
 *
 * Modes:
 *   datapipe — window.jsPsychPipe.saveData if loaded, else a direct POST to
 *              the DataPipe API. Sends PLAIN JSON (DataPipe stores strings;
 *              base64-gzip would make the OSF file unreadable for analysts).
 *   download — synthetic-anchor download (participant's machine!). Useful
 *              for local piloting; the CLI warns if it sees this in meta.
 *   none     — recording stays in memory; researcher handles it.
 */
export async function autoSave(recording, autoSaveConfig) {
  var cfg = autoSaveConfig || { mode: 'none' };
  var filename = replayFilename(recording);
  var w = typeof window !== 'undefined' ? window : {};

  if (cfg.mode === 'none') {
    return { saved_to: 'none', filename: filename };
  }

  if (cfg.mode === 'datapipe') {
    if (!cfg.experimentId) {
      return { saved_to: 'failed', filename: filename,
        error: 'autoSave.mode "datapipe" requires autoSave.experimentId' };
    }
    try {
      // Inside the try: JSON.stringify can throw (circular ref, BigInt) and
      // this function is contractually never-throw — a serialization failure
      // must come back as saved_to:'failed', not break the experiment's finish.
      var json = JSON.stringify(recording);
      if (w.jsPsychPipe && typeof w.jsPsychPipe.saveData === 'function') {
        await w.jsPsychPipe.saveData(cfg.experimentId, filename, json);
      } else {
        var fetchFn = w.fetch || (typeof fetch !== 'undefined' ? fetch : null);
        if (!fetchFn) throw new Error('no fetch available for DataPipe POST');
        var res = await fetchFn(DATAPIPE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: '*/*' },
          body: JSON.stringify({
            experimentID: cfg.experimentId,
            filename: filename,
            data: json
          })
        });
        if (res && res.ok === false) throw new Error('DataPipe HTTP error');
      }
      return { saved_to: 'datapipe:' + cfg.experimentId + '/' + filename, filename: filename };
    } catch (e) {
      console.error('[cyborg-hunter-replay] DataPipe autosave failed:', e);
      return { saved_to: 'failed', filename: filename,
        error: e && e.message ? e.message : String(e) };
    }
  }

  if (cfg.mode === 'download') {
    try {
      var doc = typeof document !== 'undefined' ? document : null;
      var BlobImpl = w.Blob || (typeof Blob !== 'undefined' ? Blob : null);
      var urlApi = w.URL || (typeof URL !== 'undefined' ? URL : null);
      if (!doc || !BlobImpl || !urlApi) throw new Error('download mode needs a browser');
      var blob = new BlobImpl([JSON.stringify(recording)], { type: 'application/json' });
      var a = doc.createElement('a');
      a.href = urlApi.createObjectURL(blob);
      a.download = filename;
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
      urlApi.revokeObjectURL(a.href);
      return { saved_to: 'download', filename: filename };
    } catch (e) {
      console.error('[cyborg-hunter-replay] download autosave failed:', e);
      return { saved_to: 'failed', filename: filename,
        error: e && e.message ? e.message : String(e) };
    }
  }

  return { saved_to: 'failed', filename: filename,
    error: 'unknown autoSave.mode "' + cfg.mode + '"' };
}

/**
 * Gzip the recording via CompressionStream when the browser has it;
 * falls back to a plain-JSON Blob (callers check blob.type).
 */
export async function compressRecording(recording) {
  var json = JSON.stringify(recording);
  var w = typeof window !== 'undefined' ? window : {};
  var CS = w.CompressionStream ||
    (typeof CompressionStream !== 'undefined' ? CompressionStream : null);
  var BlobImpl = w.Blob || (typeof Blob !== 'undefined' ? Blob : null);
  if (!BlobImpl) return null;
  if (!CS) {
    return new BlobImpl([json], { type: 'application/json' });
  }
  var stream = new BlobImpl([json]).stream().pipeThrough(new CS('gzip'));
  var ResponseImpl = w.Response || (typeof Response !== 'undefined' ? Response : null);
  var buf = await new ResponseImpl(stream).arrayBuffer();
  return new BlobImpl([buf], { type: 'application/gzip' });
}
