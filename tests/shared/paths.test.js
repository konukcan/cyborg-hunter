import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getByPath } from '../../src/shared/paths.js';

describe('getByPath (pure module)', () => {
  it('walks dotted paths', () => {
    assert.equal(getByPath({ a: { b: 3 } }, 'a.b'), 3);
  });
  it('prefers a literal flat key containing a dot', () => {
    assert.equal(getByPath({ 'a.b': 1, a: { b: 2 } }, 'a.b'), 1);
  });
  it('returns undefined on missing path', () => {
    assert.equal(getByPath({}, 'x.y'), undefined);
  });
});
