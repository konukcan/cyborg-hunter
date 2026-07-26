// Tests for bench/pipeline/check-vendor.js
//
// We inject `getCurrentSha` and `readCommit` so the test never shells out to
// git and never touches the real vendor file. A tiny `{ write }` shim captures
// stderr so we can assert on the exact warning text.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { checkVendor } from '../check-vendor.js';

// Two arbitrary, distinct 40-char hex SHAs for the test cases.
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function makeStderr() {
  const chunks = [];
  return {
    write(s) { chunks.push(s); },
    get text() { return chunks.join(''); },
  };
}

describe('checkVendor', () => {
  it('does not warn when COMMIT matches HEAD', () => {
    const stderr = makeStderr();
    const result = checkVendor({
      readCommit: () => SHA_A,
      getCurrentSha: () => SHA_A,
      stderr,
    });

    assert.equal(result.drifted, false);
    assert.equal(result.vendored, SHA_A);
    assert.equal(result.current, SHA_A);
    assert.equal(stderr.text, '', 'stderr should be empty when no drift');
  });

  it('warns when COMMIT differs from HEAD', () => {
    const stderr = makeStderr();
    const result = checkVendor({
      readCommit: () => SHA_A,
      getCurrentSha: () => SHA_B,
      stderr,
    });

    assert.equal(result.drifted, true);
    assert.equal(result.vendored, SHA_A);
    assert.equal(result.current, SHA_B);

    // Warning must contain both SHAs (full form), the word "drifted",
    // and the re-vendor hint.
    assert.match(stderr.text, /drifted/);
    assert.ok(
      stderr.text.includes(SHA_A),
      'warning should include the vendored SHA'
    );
    assert.ok(
      stderr.text.includes(SHA_B),
      'warning should include the current SHA'
    );
    assert.match(stderr.text, /re-vendoring/);
  });

  it('includes short SHAs in the headline message for readability', () => {
    const stderr = makeStderr();
    checkVendor({
      readCommit: () => SHA_A,
      getCurrentSha: () => SHA_B,
      stderr,
    });

    // The headline uses 7-char short SHAs in parens.
    assert.ok(stderr.text.includes(`(${SHA_A.slice(0, 7)})`));
    assert.ok(stderr.text.includes(`(${SHA_B.slice(0, 7)})`));
  });

  it('warns (and does not crash) when readCommit throws', () => {
    const stderr = makeStderr();
    const result = checkVendor({
      readCommit: () => { throw new Error('ENOENT: no COMMIT file'); },
      getCurrentSha: () => SHA_A,
      stderr,
    });

    // Helper returns; it does NOT call process.exit. The CLI wrapper handles
    // exit codes; here we just confirm the in-process behavior.
    assert.equal(result.drifted, false);
    assert.equal(result.vendored, null);
    assert.equal(result.current, null);
    assert.match(stderr.text, /could not determine vendor drift/);
    assert.match(stderr.text, /ENOENT: no COMMIT file/);
    // Single-line warning prefixed `warning:`.
    assert.match(stderr.text, /^warning:/);
  });

  it('warns (and does not crash) when getCurrentSha throws', () => {
    const stderr = makeStderr();
    const result = checkVendor({
      readCommit: () => SHA_A,
      getCurrentSha: () => { throw new Error('not a git repository'); },
      stderr,
    });

    assert.equal(result.drifted, false);
    assert.equal(result.vendored, null);
    assert.equal(result.current, null);
    assert.match(stderr.text, /could not determine vendor drift/);
    assert.match(stderr.text, /not a git repository/);
    assert.match(stderr.text, /^warning:/);
  });

  it('treats SHA comparison as case-insensitive (no drift on case mismatch)', () => {
    const stderr = makeStderr();
    const result = checkVendor({
      readCommit: () => SHA_A.toUpperCase(),
      getCurrentSha: () => SHA_A.toLowerCase(),
      stderr,
    });

    assert.equal(result.drifted, false);
    assert.equal(stderr.text, '', 'no warning on case-only difference');
  });
});
