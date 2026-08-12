// tests/demo/replay-host.test.js
// DOM-free unit tests for replay-host.js's pure HTML-building step
// (walkthrough item 12). mountReplayHost/teardownReplayHost are
// DOM-dependent and get their coverage as E2E (demo/tests/tour.spec.js) —
// this file only exercises buildReplayHostHtml's escaping, since a broken
// escape there is a script-injection bug, not just a cosmetic one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayHostHtml } from '../../demo/replay-host.js';

// The model shape is a v2 VIEWER MODEL (design §9): `segments`, not `trials`.
// Re-pointed in T5 Task 10 — the demo host is the A6 regeneration path's
// consumer, and it must not be pinned against a shape buildViewerModel
// stopped producing at Task 1.
test('buildReplayHostHtml embeds the mount div, the client source, and the initChReplayViewer bootstrap call', () => {
  const html = buildReplayHostHtml({ segments: [] }, 'window.initChReplayViewer = function () {};');
  assert.match(html, /<div id="ch-replay-mount"><\/div>/);
  assert.match(html, /window\.initChReplayViewer = function \(\) \{\};/);
  assert.match(html, /window\.initChReplayViewer\(document\.getElementById\('ch-replay-mount'\), \{"segments":\[\]\}\);/);
});

test('buildReplayHostHtml neutralizes a literal </script> inside the replay client source', () => {
  const html = buildReplayHostHtml({ segments: [] }, '</script><script>alert(1)</script>');
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.match(html, /<\\\/script><script>alert\(1\)<\\\/script>/);
});

test('buildReplayHostHtml neutralizes a literal </script> inside visitor-controlled model data', () => {
  // A pasted/typed value ending up in the recorded DOM. Under v2 that value
  // is DomNode TEXT, never markup — but it still travels through
  // JSON.stringify into an inline <script>, so the escape is still what
  // stands between the visitor's text and the host document's parser.
  const model = { segments: [{ initialDom: { id: 1, kind: 'text',
    text: '</script><script>alert(1)</script>' } }] };
  const html = buildReplayHostHtml(model, '');
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.match(html, /<\\\/script><script>alert\(1\)<\\\/script>/);
});

test('buildReplayHostHtml redeclares the .replay-* CSS vars with concrete (non-var) values', () => {
  const html = buildReplayHostHtml({ segments: [] }, '');
  assert.match(html, /:root\{[^}]*--surface:#FFFFFF/);
  assert.match(html, /\.replay-badge \{[^}]*background: var\(--ink\)/);
});
