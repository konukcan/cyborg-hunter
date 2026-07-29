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

// Load-bearing re-export: renderReplayAssets (below) calls buildViewerModel
// in-file, and tests/cli/replay-render.test.js + tests/replay/alignment-viewer-model.test.js
// import it from here.
export { buildViewerModel };

/**
 * Writes replay/<sanitizedPid>.replay.js for every participant with an
 * attached recording. Returns { count, totalBytes } so report.js can print
 * an honest size line (replay assets dominate report size at dom tier).
 */
export function renderReplayAssets(participants, outputDir) {
  let count = 0;
  let totalBytes = 0;
  const withReplay = participants.filter((p) => p.replay && p.replay.recording);
  if (withReplay.length === 0) return { count, totalBytes };

  const replayDir = join(outputDir, 'replay');
  mkdirSync(replayDir, { recursive: true });

  // Sanitization is lossy ('a/b' and 'a_b' both map to a_b) — dedupe with a
  // stable numeric suffix so a later write can never overwrite an earlier
  // participant's asset. The actual path is stamped on the participant
  // (replay.assetPath) and consumed by html-index, which must not recompute.
  const usedNames = new Set();
  for (const p of withReplay) {
    const model = buildViewerModel(p.replay.recording);
    // The store is keyed by the RAW participant id (what the report's
    // loader passes); the filename uses the sanitized form.
    // Null-prototype store: participant ids are untrusted, and a pid like
    // "__proto__" on a plain object would mutate the store's prototype
    // instead of creating an entry (prototype pollution).
    const src =
      'window.__chReplay = window.__chReplay || Object.create(null);\n' +
      'window.__chReplay[' + JSON.stringify(String(p.participantId)) + '] = ' +
      JSON.stringify(model).replace(/</g, '\\u003c') + ';\n';
    let base = sanitize(p.participantId);
    let name = base + '.replay.js';
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
      name = base + '~' + n + '.replay.js';
    }
    usedNames.add(name.toLowerCase());
    writeFileSync(join(replayDir, name), src);
    p.replay.assetPath = 'replay/' + name;
    count++;
    totalBytes += Buffer.byteLength(src);
  }
  return { count, totalBytes };
}
