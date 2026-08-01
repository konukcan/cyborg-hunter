// tests/demo/replay-host.test.js
// DOM-free unit tests for replay-host.js's pure HTML-building step
// (walkthrough item 12). mountReplayHost/teardownReplayHost are
// DOM-dependent and get their coverage as E2E (demo/tests/tour.spec.js) —
// this file only exercises buildReplayHostHtml's escaping, since a broken
// escape there is a script-injection bug, not just a cosmetic one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayHostHtml } from '../../demo/replay-host.js';

test('buildReplayHostHtml embeds the mount div, the client source, and the initChReplayViewer bootstrap call', () => {
  const html = buildReplayHostHtml({ trials: [] }, 'window.initChReplayViewer = function () {};');
  assert.match(html, /<div id="ch-replay-mount"><\/div>/);
  assert.match(html, /window\.initChReplayViewer = function \(\) \{\};/);
  assert.match(html, /window\.initChReplayViewer\(document\.getElementById\('ch-replay-mount'\), \{"trials":\[\]\}\);/);
});

test('buildReplayHostHtml neutralizes a literal </script> inside the replay client source', () => {
  const html = buildReplayHostHtml({ trials: [] }, '</script><script>alert(1)</script>');
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.match(html, /<\\\/script><script>alert\(1\)<\\\/script>/);
});

test('buildReplayHostHtml neutralizes a literal </script> inside visitor-controlled model data', () => {
  // A pasted/typed value ending up in the recorded DOM (initialDom is an
  // HTML string in the real viewer model) — the exact shape doesn't matter
  // here, only that JSON.stringify's output isn't trusted verbatim.
  const model = { trials: [{ initialDom: '</script><script>alert(1)</script>' }] };
  const html = buildReplayHostHtml(model, '');
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.match(html, /<\\\/script><script>alert\(1\)<\\\/script>/);
});

test('buildReplayHostHtml redeclares the .replay-* CSS vars with concrete (non-var) values', () => {
  const html = buildReplayHostHtml({ trials: [] }, '');
  assert.match(html, /:root\{[^}]*--surface:#FFFFFF/);
  assert.match(html, /\.replay-badge \{[^}]*background: var\(--ink\)/);
});
