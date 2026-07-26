// =============================================================================
// finish-screen-injector.test.js
//
// Structural unit tests for the finish-screen DOM injector.
//
// Run with:
//   node --test bench/harness/trials/tests/finish-screen-injector.test.js
//
// The injector is plain DOM manipulation — it replaces `document.body.innerHTML`.
// Under Node we stub a minimal `document` global so the function can run and
// its effect is observable.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Minimal DOM stub -------------------------------------------------------
// Just enough to let `document.body.innerHTML = '...'` capture a value.
function installDocumentStub() {
  globalThis.document = { body: { innerHTML: '' } };
}

function uninstallDocumentStub() {
  delete globalThis.document;
}

installDocumentStub();

const { showFinishScreen } = await import('../finish-screen-injector.js');

test('module exports showFinishScreen as a function', () => {
  assert.equal(typeof showFinishScreen, 'function',
    'expected showFinishScreen to be exported as a function');
});

test('showFinishScreen replaces document.body.innerHTML with the thank-you message', () => {
  globalThis.document.body.innerHTML = '<p>previous content</p>';
  showFinishScreen();
  assert.ok(
    globalThis.document.body.innerHTML.includes('Thank you for completing the experiment.'),
    `expected innerHTML to contain the thank-you message; got: ${globalThis.document.body.innerHTML}`
  );
  // And it should NOT still contain the previous content.
  assert.ok(
    !globalThis.document.body.innerHTML.includes('previous content'),
    'previous body content should be replaced wholesale'
  );
});

test('showFinishScreen is idempotent — running twice still leaves the thank-you message', () => {
  showFinishScreen();
  showFinishScreen();
  assert.ok(
    globalThis.document.body.innerHTML.includes('Thank you for completing the experiment.'),
    'thank-you message should still be present after two calls'
  );
  uninstallDocumentStub();
});
