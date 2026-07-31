// tests/cli/html-index-opts.test.js
// The three demo-mode opts for the in-browser report. Contract: ALL opts
// absent ⇒ byte-identical to the A1 snapshots (that test enforces it);
// each opt present ⇒ the specific emission below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractIntegrityData } from '../../src/cli/extract-core.js';
import { computeSummary } from '../../src/cli/analyzers/summary.js';
import { detectEdgeExits } from '../../src/cli/analyzers/edge-exit.js';
import { rankTriage } from '../../src/cli/analyzers/triage.js';
import { renderIndexHtml } from '../../src/cli/renderers/html-index-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'demo', 'DEMO-FIXT.json'), 'utf8'));
const config = { outputDir: '.', participantIdField: 'participantId' };
const p = extractIntegrityData(raw, config);
const summaries = computeSummary([p], config);
const triage = rankTriage(summaries, detectEdgeExits([p], config), config);
const PID = p.participantId;

test('imageSources swaps file paths for data URIs and shows those visuals', async () => {
  const html = await renderIndexHtml(summaries, triage, [p], config, false, {
    imageSources: { [PID]: {
      typingProfile: 'data:image/png;base64,AAA1',
      sessionTimeline: 'data:image/png;base64,AAA2',
      trajectories: 'data:image/png;base64,AAA3',
    } },
  });
  assert.ok(html.includes('data:image/png;base64,AAA2'));
  assert.ok(!html.includes('images/session_timeline_'));
});

test('imageSources with a missing plot omits that img entirely', async () => {
  const html = await renderIndexHtml(summaries, triage, [p], config, false, {
    imageSources: { [PID]: { sessionTimeline: 'data:image/png;base64,AAA2', typingProfile: null, trajectories: null } },
  });
  assert.ok(html.includes('data:image/png;base64,AAA2'));
  assert.ok(!html.includes('images/typing_profile_'));
});

test('inlineReplayModels embeds models, renders the replay section, and short-circuits the loader', async () => {
  const model = { schema: 1, frames: [], metadata: { tier: 'dom' } };
  const html = await renderIndexHtml(summaries, triage, [p], config, false, {
    inlineReplayModels: { [PID]: model },
  });
  assert.ok(html.includes('window.__chReplay'));
  assert.ok(html.includes(JSON.stringify({ [PID]: model }).replace(/</g, '\\u003c')));
  // The replay SECTION must render even though participant.replay is unset.
  // Real markup: renderReplaySection emits a .replay-block with a
  // .replay-mount, marked data-replay-preloaded instead of data-replay-src
  // when the model came from inlineReplayModels rather than a real artifact.
  assert.ok(html.includes('data-replay-preloaded="true"'));
  assert.ok(html.includes('class="replay-mount"'));
  assert.ok(html.includes('(dom tier)'));  // metadata.tier flows into the badge text
  // Loader short-circuit — the word "preloaded" is required to appear
  // (either the data attribute above or the loader's preloaded-first check
  // satisfies this, but we want the emitted JS itself to say it too).
  assert.ok(html.includes('preloaded'));
});

test('demo mode guards history.replaceState; default does not', async () => {
  const demo = await renderIndexHtml(summaries, triage, [p], config, false,
    { imageSources: { [PID]: {} } });
  assert.ok(/try\s*\{[^}]*history\.replaceState/.test(demo));
  const plain = await renderIndexHtml(summaries, triage, [p], config, false, {});
  assert.ok(!/try\s*\{[^}]*history\.replaceState/.test(plain));
  // The bare call must still be present on the default path — the guard is
  // additive in demo mode, not a replacement for the underlying call.
  assert.ok(plain.includes("history.replaceState(null, '', `#p-${sanitized}`);"));
});
