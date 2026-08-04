// DOM-free: the pane takes an injected doc-like factory only in tests? No —
// keep it simple: run under a minimal fake document (createElement returning
// plain objects is NOT enough for innerHTML flows), so the pane is designed
// DOM-light: makeLivePane returns { addRow, setPayload, freeze, rowCount,
// renderRowHtml } where renderRowHtml is a pure string builder we can test
// without a DOM, and addRow appends via the injected mount's insertAdjacentHTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRowHtml, formatClock } from '../../demo/live-pane.js';
import { escHtml } from '../../demo/util.js';

test('escHtml escapes the four metacharacters', () => {
  assert.equal(escHtml('<a b="c">&'), '&lt;a b=&quot;c&quot;&gt;&amp;');
});
test('formatClock renders m:ss.d', () => {
  assert.equal(formatClock(52900), '0:52.9');
  assert.equal(formatClock(125300), '2:05.3');
});
test('renderRowHtml escapes visitor-triggered detail text', () => {
  const html = renderRowHtml({ tMs: 1000, trial: 'act1-paste', event: 'paste #1', detail: '"<script>x</script>"', hard: true });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('hard'));
});
test('renderRowHtml stamps data-trial with the trialId (the rail\'s filter key)', () => {
  const html = renderRowHtml({ tMs: 1000, trial: 'act1-paste', event: 'paste #1', detail: null });
  assert.ok(html.includes('data-trial="act1-paste"'));
});
test('renderRowHtml stamps data-trial="session" for a trial-less row', () => {
  const html = renderRowHtml({ tMs: 1000, trial: null, event: 'viewport_shift', detail: null });
  assert.ok(html.includes('data-trial="session"'));
});
test('renderRowHtml escapes a hostile trial id in data-trial', () => {
  const html = renderRowHtml({ tMs: 1000, trial: '"><script>x</script>', event: 'paste #1', detail: null });
  assert.ok(!html.includes('data-trial="">'));
  assert.ok(html.includes('data-trial="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'));
  assert.ok(!html.includes('<script>'));
});
