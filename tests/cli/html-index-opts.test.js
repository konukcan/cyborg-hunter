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

// `inlineReplayModels` holds VIEWER MODELS (html-index-core.js:40), so the
// shape below is a viewer model's: `tier` at the top level, `segments`, and
// no `metadata` block — a viewer model has never had one in any version.
// These tests used to pass a model with a v1-shaped `metadata` block, which
// is why the demo branch that read the tier out of one looked pinned while it
// in fact resolved to "trace" for every model the demo could ever have
// passed (T5 Task 10(a)).
test('inlineReplayModels embeds models, renders the replay section, and short-circuits the loader', async () => {
  const model = { schemaVersion: 2, tier: 'dom', segments: [] };
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
  assert.ok(html.includes('(dom tier)'));  // the model's own tier flows into the badge text
  // Loader short-circuit — pin the functional line itself (the preloaded-first
  // window.__chReplay lookup), so deleting the short-circuit fails this test
  // even while the data attribute above still renders.
  assert.ok(html.includes('const preloaded = (window.__chReplay || {})[pid];'));
});

test('inlineReplayModels without a matching participant renders without throwing and omits the replay section', async () => {
  // Regression: the demo-model lookup keys off the triage row, so a model can
  // exist for a pid with no participant object. renderReplaySection used to
  // crash on participant.participantId; now it must skip the section.
  const model = { schemaVersion: 2, tier: 'dom', segments: [] };
  const html = await renderIndexHtml(summaries, triage, [], config, false, {
    inlineReplayModels: { [PID]: model },
  });
  assert.ok(!html.includes('data-replay-preloaded'));
  assert.ok(!html.includes('Session replay'));
});

test('adversarial inlineReplayModels payload cannot break out of the inline script tag', async () => {
  const model = { schemaVersion: 2, tier: 'dom', segments: [],
    payload: '</script><!--"boom' };
  const html = await renderIndexHtml(summaries, triage, [p], config, false, {
    inlineReplayModels: { [PID]: model },
  });
  const m = html.match(/window\.__chReplay = (.*);<\/script>/);
  assert.ok(m, 'preloaded models script is present');
  assert.ok(!m[1].includes('<'), 'no raw < survives inside the embedded JSON');
  assert.ok(m[1].includes('\\u003c/script>'), 'script closer neutralized via \\u003c escape');
  assert.ok(m[1].includes('\\u003c!--'), 'comment opener neutralized via \\u003c escape');
  assert.deepEqual(JSON.parse(m[1]), { [PID]: model }, 'escaping round-trips losslessly');
});

test('adversarial imageSources value cannot break out of the src/href attributes', async () => {
  const evil = 'data:image/png;base64,AAA2" onerror="alert(1)';
  const html = await renderIndexHtml(summaries, triage, [p], config, false, {
    imageSources: { [PID]: { sessionTimeline: evil, typingProfile: null, trajectories: null } },
  });
  assert.ok(!html.includes(evil), 'raw attribute-breakout string must not appear');
  assert.ok(html.includes('AAA2&quot; onerror=&quot;alert(1)'), 'quote escaped to &quot; in the emitted attribute');
});

test('replayShownExternally:true suppresses the replay section entirely; absent/false renders it as before', async () => {
  // Suppressed: no replay-block ELEMENT, no section heading, and no
  // absent-state fallback message (the demo shows the replay in its own
  // sibling viewer-host iframe — a "not enabled" message here would be
  // false). The bare 'replay-block' substring can't be asserted on: the
  // report's static lazy-loader script always contains
  // btn.closest('.replay-block') regardless of whether any section renders.
  const suppressed = await renderIndexHtml(summaries, triage, [p], config, false, {
    replayShownExternally: true,
  });
  assert.ok(!suppressed.includes('class="image-block replay-block"'));
  assert.ok(!suppressed.includes('Session replay'));
  assert.ok(!suppressed.includes('recording was not enabled'));

  // Guard the other direction — absent AND explicit false both render the
  // section exactly as the default path always has (the fixture has no
  // replay artifact, so that's the absent-state block + fallback message).
  for (const opts of [{}, { replayShownExternally: false }]) {
    const rendered = await renderIndexHtml(summaries, triage, [p], config, false, opts);
    assert.ok(rendered.includes('class="image-block replay-block"'));
    assert.ok(rendered.includes('Session replay'));
    assert.ok(rendered.includes('recording was not enabled'));
  }
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
