import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateConfig } from '../../src/shared/validation.js';

describe('config validation', () => {
  it('passes with valid keys', () => {
    const warnings = validateConfig({ dataDir: './data', filePattern: '*.json' });
    assert.equal(warnings.length, 0);
  });

  it('suggests correction for misspelled key', () => {
    const warnings = validateConfig({ datDir: './data' });
    assert.ok(warnings[0].includes('did you mean'));
  });

  it('flags completely unknown keys', () => {
    const warnings = validateConfig({ completelyFakeKey: true });
    assert.ok(warnings[0].includes('Unknown'));
  });
});
