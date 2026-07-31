// tests/cli/html-index-snapshot.test.js
// Full-output snapshot of renderIndexHtml with ALL opts absent. This is the
// contract every later opt (imageSources, inlineReplayModels, demo-mode hash
// guard) must not disturb: defaults absent ⇒ output identical to this file.
// Regenerate ONLY when a deliberate default-output change is intended:
//   SNAPSHOT_UPDATE=1 node --test tests/cli/html-index-snapshot.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractIntegrityData } from '../../src/cli/extract-core.js';
import { computeSummary } from '../../src/cli/analyzers/summary.js';
import { detectEdgeExits } from '../../src/cli/analyzers/edge-exit.js';
import { rankTriage } from '../../src/cli/analyzers/triage.js';
import { renderIndexHtml } from '../../src/cli/renderers/html-index-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXT = join(here, '..', 'fixtures', 'demo', 'DEMO-FIXT.json');

function build() {
  const raw = JSON.parse(readFileSync(FIXT, 'utf8'));
  const config = { outputDir: '.', participantIdField: 'participantId' };
  const p = extractIntegrityData(raw, config);
  const summaries = computeSummary([p], config);
  const edgeExits = detectEdgeExits([p], config);
  const triage = rankTriage(summaries, edgeExits, config);
  return { summaries, triage, participants: [p], config };
}

function snapshotCase(name, file, visualsRendered) {
  test(name, async () => {
    const { summaries, triage, participants, config } = build();
    const html = await renderIndexHtml(summaries, triage, participants, config, visualsRendered, {});
    const SNAP = join(here, '..', 'fixtures', 'cli', file);
    if (process.env.SNAPSHOT_UPDATE === '1' || !existsSync(SNAP)) { writeFileSync(SNAP, html); return; }
    assert.equal(html, readFileSync(SNAP, 'utf8'));
  });
}
snapshotCase('renderIndexHtml default output (visuals off) is snapshot-identical', 'index-default.snapshot.html', false);
snapshotCase('renderIndexHtml default output (visuals on) is snapshot-identical', 'index-default-visuals.snapshot.html', true);
