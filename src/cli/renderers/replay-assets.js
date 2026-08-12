// src/cli/renderers/replay-assets.js
// Emits per-participant replay assets into <outputDir>/replay/ as
// JSONP-style scripts: window.__chReplay['<pid>'] = <viewer model>.
//
// Why script files instead of JSON + fetch(): the HTML report is opened
// via file:// where fetch() of local files is CORS-blocked, but <script>
// tags load fine. The report injects the script lazily when the analyst
// opens a participant's Replay section.
//
// The wire→viewer time conversion (the second of the two allowed conversion
// points) lives in replay/viewer-model.js (0.7.2 extraction, pure/no Node
// APIs so a browser demo can bundle it); this module re-exports it below.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { sanitizeId as sanitize } from '../../shared/constants.js';
import { buildViewerModel } from '../../replay/viewer-model.js';
import { inlineSafeJson } from '../../shared/inline-safe.js';

// Load-bearing re-export: renderReplayAssets (below) calls buildViewerModel
// in-file, and tests/cli/replay-render.test.js + tests/replay/alignment-viewer-model.test.js
// import it from here.
export { buildViewerModel };

/**
 * Writes replay/<sanitizedPid>.replay.js for every participant with an
 * attached recording. Returns { count, totalBytes, skipped } so report.js can
 * print an honest size line (replay assets dominate report size at dom tier)
 * and an honest line about what did not make it.
 *
 * `skipped` is [{participantId, file, reason}] — one entry per artifact the
 * §11 tolerant profile rejected. buildViewerModel THROWS on that set (it is
 * v2-only; a CH-v1 artifact is the common case), and the alternative to
 * catching here is that one unloadable file in a cohort aborts the whole
 * report — which is precisely the data-loss trade §11 exists to refuse.
 * v1 degraded and rendered the rest; v2 skips the participant and says so.
 * The say-so is a stamp on `p.replay`, read by renderReplaySection's error
 * branch — the report's existing state for "attached but not viewable".
 *
 * NOT idempotent w.r.t. `skipped` (T5 Task 10 review M-5): the stamp clears
 * `p.replay.recording`, so a second call over the same participants array
 * sees nothing to skip and returns an empty list. One caller today
 * (`report.js:149`), which then renders the index from the same array.
 */
export function renderReplayAssets(participants, outputDir) {
  let count = 0;
  let totalBytes = 0;
  const skipped = [];
  const withReplay = participants.filter((p) => p.replay && p.replay.recording);
  if (withReplay.length === 0) return { count, totalBytes, skipped };

  // Created on the first successful write, not up front: a cohort whose
  // every artifact is unloadable would otherwise ship an empty replay/ dir
  // beside a report that says there is nothing to load.
  const replayDir = join(outputDir, 'replay');
  let dirMade = false;

  // Sanitization is lossy ('a/b' and 'a_b' both map to a_b) — dedupe with a
  // stable numeric suffix so a later write can never overwrite an earlier
  // participant's asset. The actual path is stamped on the participant
  // (replay.assetPath) and consumed by html-index, which must not recompute.
  const usedNames = new Set();
  for (const p of withReplay) {
    let model;
    try {
      model = buildViewerModel(p.replay.recording);
    } catch (e) {
      // Skip this participant, keep the cohort. The recording is dropped from
      // the participant so the index cannot render a Load button for an asset
      // that was never written; `error: 'unloadable'` distinguishes it from
      // ingest's 'parse_failed' (a file that could not even be read).
      // `e.reasons` is the §11 profile's own list; the message wrapper adds
      // a function name the analyst has no use for.
      const reason = Array.isArray(e.reasons) ? e.reasons.join('; ') : e.message;
      skipped.push({ participantId: p.participantId, file: p.replay.file || null, reason });
      p.replay = { error: 'unloadable', reason, file: p.replay.file || null };
      continue;
    }
    // The store is keyed by the RAW participant id (what the report's
    // loader passes); the filename uses the sanitized form.
    // Null-prototype store: participant ids are untrusted, and a pid like
    // "__proto__" on a plain object would mutate the store's prototype
    // instead of creating an entry (prototype pollution).
    const src =
      'window.__chReplay = window.__chReplay || Object.create(null);\n' +
      'window.__chReplay[' + JSON.stringify(String(p.participantId)) + '] = ' +
      inlineSafeJson(model) + ';\n';
    let base = sanitize(p.participantId);
    let name = base + '.replay.js';
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
      name = base + '~' + n + '.replay.js';
    }
    usedNames.add(name.toLowerCase());
    if (!dirMade) { mkdirSync(replayDir, { recursive: true }); dirMade = true; }
    writeFileSync(join(replayDir, name), src);
    p.replay.assetPath = 'replay/' + name;
    count++;
    totalBytes += Buffer.byteLength(src);
  }
  return { count, totalBytes, skipped };
}
