// tests/cli/html-index-core.test.js
// Pins the pure render core: string return, injectable assets, no Node imports.
// This is the 0.7.2 extraction from cli/renderers/html-index.js — the fs-
// writing wrapper's own behavior (writeFileSync, default fallback string)
// stays covered by tests/cli/html-index.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { renderIndexHtml } from '../../src/cli/renderers/html-index-core.js';

describe('renderIndexHtml (pure core)', () => {
  it('returns an HTML string with the injected replay client', async () => {
    const html = await renderIndexHtml([], [], {}, { outputDir: '/unused', participantIdField: 'participantId' }, false,
      { replayClientSrc: '/*__MARKER__*/', visualsUnavailableNote: 'NOTE_MARKER' });
    assert.strictEqual(typeof html, 'string');
    assert.ok(html.length > 100);
    // With an empty triage array no detail panes render at all, so
    // NOTE_MARKER (only used inside renderDetail's visualsRendered=false
    // branch) has nowhere to appear — asserting it would test something
    // that isn't true. The replay client, by contrast, is embedded in the
    // page's trailing <script> block unconditionally, and the version
    // string always renders in the topbar meta line — both hold regardless
    // of triage content, so those are what we pin here.
    assert.ok(html.includes('/*__MARKER__*/'), 'injected replay client source appears');
    assert.ok(html.includes('v0.7.5'), 'version string appears in topbar meta');
  });
  it('renders the injected visualsUnavailableNote in a detail pane', async () => {
    // Unlike the empty-triage case above, a single triage row forces a detail
    // pane to render, and visualsRendered=false routes that pane through the
    // fallback branch where the injected note must appear.
    const triage = [{ participantId: 'p1', hardTriggered: false, softFlagged: false, score: 0, summary: {} }];
    const participants = [{ participantId: 'p1' }];
    const html = await renderIndexHtml([], triage, participants,
      { outputDir: '/unused', participantIdField: 'participantId' }, false,
      { replayClientSrc: '/*__MARKER__*/', visualsUnavailableNote: 'NOTE_MARKER' });
    assert.ok(html.includes('NOTE_MARKER'));
    assert.ok(html.includes('/*__MARKER__*/'));
  });
  it('module source has no fs/path imports', () => {
    const src = readFileSync(new URL('../../src/cli/renderers/html-index-core.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"](node:)?(fs|path)['"]/);
  });
});
