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
