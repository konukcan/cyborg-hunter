// tests/cli/version-invariant.test.js
// Pins every hand-bumped version field to package.json. 0.7.1 shipped with
// three of these out of sync; this test makes that class of miss impossible.
import { it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { VERSION } from '../../src/shared/constants.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

it('constants.js VERSION matches package.json', () => {
  assert.strictEqual(VERSION, pkg.version);
});

it('both jsPsych extension info.version fields match package.json', async () => {
  // Read the source directly rather than importing: extension-cyborg-hunter.js
  // imports cleanly under plain node, but extension-cyborg-hunter-replay.js
  // pulls in ../replay/index.js, which (like the guard-friction/honeypot
  // extensions) expects browser globals — tests/jspsych/*.test.js shim those
  // with happy-dom before importing. A source-level regex check works
  // regardless of DOM-global requirements, so it's used for both files here.
  const files = [
    '../../src/jspsych/extension-cyborg-hunter.js',
    '../../src/jspsych/extension-cyborg-hunter-replay.js',
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const m = src.match(/version:\s*['"]([^'"]+)['"]/);
    assert.ok(m, `no version field found in ${f}`);
    assert.strictEqual(m[1], pkg.version, `stale version in ${f}`);
  }
});

// 0.7.2 shipped while CITATION.cff and the README bibtex still said 0.7.1 —
// citation metadata is exactly the field nobody rechecks by hand.
it('CITATION.cff version matches package.json', () => {
  const cff = readFileSync(new URL('../../CITATION.cff', import.meta.url), 'utf8');
  const m = cff.match(/^version:\s*(.+)$/m);
  assert.ok(m, 'no version field in CITATION.cff');
  assert.strictEqual(m[1].trim(), pkg.version);
});

it('README bibtex + version pins match package.json', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const bib = readme.match(/version = \{([^}]+)\}/);
  assert.ok(bib, 'no bibtex version field in README');
  assert.strictEqual(bib[1], pkg.version, 'stale bibtex version in README');
  for (const [, v] of readme.matchAll(/cyborg-hunter@(\d+\.\d+\.\d+)/g)) {
    assert.strictEqual(v, pkg.version, 'stale version pin in README');
  }
});

it('docs/quickstart.md version pins match package.json', () => {
  const qs = readFileSync(new URL('../../docs/quickstart.md', import.meta.url), 'utf8');
  for (const [, v] of qs.matchAll(/cyborg-hunter@(\d+\.\d+\.\d+)/g)) {
    assert.strictEqual(v, pkg.version, 'stale version pin in docs/quickstart.md');
  }
});
