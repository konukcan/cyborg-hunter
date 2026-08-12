// tests/demo/replay-host.test.js
// DOM-free unit tests for replay-host.js's pure HTML-building step
// (walkthrough item 12). mountReplayHost/teardownReplayHost are
// DOM-dependent and get their coverage as E2E (demo/tests/tour.spec.js) —
// this file only exercises buildReplayHostHtml's escaping, since a broken
// escape there is a script-injection bug, not just a cosmetic one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayHostHtml } from '../../demo/replay-host.js';
import { inlineSafeJson, inlineSafeSrc } from '../../src/shared/inline-safe.js';

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

test('buildReplayHostHtml escapes every < in visitor-controlled model data', () => {
  // A pasted/typed value ending up in the recorded DOM. Under v2 that value is
  // DomNode TEXT, never markup — but it still travels through JSON.stringify
  // into an inline <script>, so an escape is what stands between the visitor's
  // text and the host document's parser. The model takes the DATA rule (every
  // `<`), not the end-tag rule: see the next test for the case that forced it.
  const model = { segments: [{ initialDom: { id: 1, kind: 'text',
    text: '</script><script>alert(1)</script>' } }] };
  const html = buildReplayHostHtml(model, '');
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.match(html, /\\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>/);
});

test('a model whose text opens script-data-escaped state cannot reach the parser', () => {
  // T5 Task 10 review I-2, reproduced there in a real browser: with the
  // end-tag rule the host document below stayed double-escaped to EOF, so its
  // own </script> never closed the element, the replay card silently never
  // appeared, and no error was raised. No `</script` is needed for it.
  const model = { segments: [{ initialDom: { id: 1, kind: 'text',
    text: 'note: <!-- and then a <script> element' } }] };
  const html = buildReplayHostHtml(model, '');
  const bootstrap = html.slice(html.lastIndexOf('<script>'));
  assert.equal(/<!--/.test(bootstrap), false, 'no unpaired comment opener survives');
  assert.equal(/<script[\s/>]/i.test(bootstrap.slice('<script>'.length)), false,
    'no second script-tag opener survives inside the payload');
  assert.match(html, /\\u003c!-- and then a \\u003cscript> element/,
    'and the text is preserved exactly, as escapes');
});

test('both inlining rules mirror src/shared/inline-safe.js exactly', () => {
  // demo/ cannot import from src/ (only demo/* and dist/ reach the deployed
  // site), so the rules are copied here. This is the check that keeps the copy
  // honest: it drives the same adversarial inputs through both and compares.
  const hostileSrc = 'var re = /</g; // </SCRIPT > and a < b';
  const hostileModel = { t: 'x </script> y <!-- z <script> w', n: 1 < 2 };
  const html = buildReplayHostHtml(hostileModel, hostileSrc);
  assert.ok(html.includes(inlineSafeSrc(hostileSrc)),
    'the source rule must match inlineSafeSrc');
  assert.ok(html.includes(inlineSafeJson(hostileModel)),
    'the data rule must match inlineSafeJson');
});

test('buildReplayHostHtml redeclares the .replay-* CSS vars with concrete (non-var) values', () => {
  const html = buildReplayHostHtml({ segments: [] }, '');
  assert.match(html, /:root\{[^}]*--surface:#FFFFFF/);
  assert.match(html, /\.replay-badge \{[^}]*background: var\(--ink\)/);
});
