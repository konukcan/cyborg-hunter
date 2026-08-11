// src/cli/renderers/html-index.js
// Thin Node wrapper around the pure render core (html-index-core.js):
// reads the replay viewer client from disk, writes index.html to outputDir.
// Public API unchanged — report.js and adopters keep calling renderHtmlIndex.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { renderIndexHtml } from './html-index-core.js';
import { readReplayClientSrc } from './replay-client-source.js';

// The replay viewer client is developed as real JS files (linted, syntax-
// highlighted) and embedded verbatim at render time — same file://-safe
// output as an inline IIFE, without string-blob development pain. It is a
// CONCATENATION: the client calls into src/replay/dom-instantiate.js, which
// ships ahead of it in the same script (see replay-client-source.js).
const REPLAY_CLIENT_SRC = readReplayClientSrc();

export async function renderHtmlIndex(summaries, triage, participants, config, visualsRendered) {
  const html = await renderIndexHtml(summaries, triage, participants, config,
    visualsRendered, { replayClientSrc: REPLAY_CLIENT_SRC });
  writeFileSync(join(config.outputDir, 'index.html'), html);
  console.log('  index.html — report page');
}
