// src/cli/renderers/html-index.js
// Thin Node wrapper around the pure render core (html-index-core.js):
// reads the replay viewer client from disk, writes index.html to outputDir.
// Public API unchanged — report.js and adopters keep calling renderHtmlIndex.
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { renderIndexHtml } from './html-index-core.js';

// The replay viewer client is developed as a real JS file (linted, syntax-
// highlighted) and embedded verbatim at render time — same file://-safe
// output as the inline IIFE, without string-blob development pain.
const REPLAY_CLIENT_SRC = readFileSync(
  new URL('./replay-viewer.client.js', import.meta.url), 'utf8');

export async function renderHtmlIndex(summaries, triage, participants, config, visualsRendered) {
  const html = await renderIndexHtml(summaries, triage, participants, config,
    visualsRendered, { replayClientSrc: REPLAY_CLIENT_SRC });
  writeFileSync(join(config.outputDir, 'index.html'), html);
  console.log('  index.html — report page');
}
