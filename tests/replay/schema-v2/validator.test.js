import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { detectGzip } from './validator.js';

test('detectGzip: true for gzipped bytes, false for JSON text and short input', () => {
  const gz = gzipSync(Buffer.from('{"schema_version":2}'));
  assert.equal(detectGzip(gz), true);
  assert.equal(detectGzip(Buffer.from('{"schema_version":2}')), false);
  assert.equal(detectGzip(Buffer.from([0x1f])), false);
  assert.equal(detectGzip(null), false);
});

import { validateTolerant } from './validator.js';

const MIN_VALID = {
  schema_version: 2,
  recorder: { name: 'test', version: '0.0.1' },
  segments: [{ index: 0, events: [] }],
};

test('tolerant: accepts a minimal recording and fills defaults', () => {
  const r = validateTolerant(structuredClone(MIN_VALID));
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.recording.truncated, false);
  assert.equal(r.recording.extensions, null);
  assert.ok(r.warnings.some(w => w.includes('user_agent')), 'missing advisory fields warn');
});

test('tolerant: rejects only the four fatal defects', () => {
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), schema_version: 1 }).ok, false);
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), recorder: { name: 'x' } }).ok, false);
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), segments: 'nope' }).ok, false);
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), segments: [{ index: 0 }] }).ok, false);
});

test('tolerant: array defaults are not shared between recordings', () => {
  const a = validateTolerant(structuredClone(MIN_VALID)).recording;
  const b = validateTolerant(structuredClone(MIN_VALID)).recording;
  a.stylesheets.push('contaminant');
  assert.deepEqual(b.stylesheets, []);
  assert.deepEqual(b.stylesheet_events, []);
  assert.deepEqual(b.viewport_changes, []);
});

test('tolerant: parses JSON strings and rejects invalid JSON', () => {
  assert.equal(validateTolerant(JSON.stringify(MIN_VALID)).ok, true);
  assert.equal(validateTolerant('{not json').ok, false);
});
