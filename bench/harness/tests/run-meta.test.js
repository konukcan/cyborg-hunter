// Tests for bench/harness/run-meta.js
//
// All three helpers accept a `search` string argument, so tests just pass in
// synthetic query strings — no need to stub `window` or any other global.
// This matches the DI pattern used in bench/pipeline/check-vendor.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getOrMakeRunId,
  getScenarioFromUrl,
  getGuardConfigFromUrl,
  getBotModeFromUrl,
} from '../run-meta.js';

describe('getOrMakeRunId', () => {
  it('returns the URL-supplied runId verbatim when present', () => {
    const id = getOrMakeRunId('?runId=fixed-id-xyz&scenario=foo&guards=none');
    assert.equal(id, 'fixed-id-xyz');
  });

  it('synthesizes scenario--guards--ts when no runId param exists', () => {
    const id = getOrMakeRunId('?scenario=demo&guards=strict');
    // Must begin with "demo--strict--" and have something after.
    assert.ok(
      id.startsWith('demo--strict--'),
      `expected "demo--strict--..." prefix, got: ${id}`
    );
    assert.ok(
      id.length > 'demo--strict--'.length,
      'expected a non-empty timestamp suffix'
    );
  });

  it('synthesized runId matches three-part double-hyphen pattern', () => {
    // The timestamp itself contains single hyphens (2026-05-13T...), so the
    // pattern asserts exactly three segments separated by `--`, where each
    // segment is one-or-more non-hyphen-pair characters. We use a permissive
    // character class that allows internal single hyphens.
    const id = getOrMakeRunId('?scenario=s1&guards=full');
    assert.match(id, /^[^-]+(?:-[^-]+)*--[^-]+(?:-[^-]+)*--.+$/);

    // Sanity: splitting on the `--` separator yields exactly 3 parts.
    const parts = id.split('--');
    assert.equal(parts.length, 3, `expected 3 segments, got: ${parts.length}`);
    assert.equal(parts[0], 's1');
    assert.equal(parts[1], 'full');
    // Timestamp segment should contain no `:` or `.` (we replaced them).
    assert.doesNotMatch(parts[2], /[:.]/);
  });

  it('falls back to unspecified/full when scenario and guards are absent', () => {
    const id = getOrMakeRunId('');
    assert.ok(
      id.startsWith('unspecified--full--'),
      `expected "unspecified--full--..." prefix, got: ${id}`
    );
  });
});

describe('getScenarioFromUrl', () => {
  it("returns 'unspecified' when no scenario param exists", () => {
    assert.equal(getScenarioFromUrl(''), 'unspecified');
    assert.equal(getScenarioFromUrl('?other=thing'), 'unspecified');
  });

  it('returns the param value when present', () => {
    assert.equal(getScenarioFromUrl('?scenario=baseline'), 'baseline');
    assert.equal(
      getScenarioFromUrl('?scenario=cheater-light&guards=full'),
      'cheater-light'
    );
  });
});

describe('getGuardConfigFromUrl', () => {
  it("defaults to 'full' when no guards param exists", () => {
    assert.equal(getGuardConfigFromUrl(''), 'full');
    assert.equal(getGuardConfigFromUrl('?scenario=demo'), 'full');
  });

  it("returns 'none' / 'friction' / 'full' per URL", () => {
    assert.equal(getGuardConfigFromUrl('?guards=none'), 'none');
    assert.equal(getGuardConfigFromUrl('?guards=friction'), 'friction');
    assert.equal(getGuardConfigFromUrl('?guards=full'), 'full');
  });
});

describe('getBotModeFromUrl', () => {
  it('returns false when no bot-mode param exists', () => {
    assert.equal(getBotModeFromUrl(''), false);
    assert.equal(getBotModeFromUrl('?scenario=demo&guards=full'), false);
  });

  it("returns true only when bot-mode=1", () => {
    assert.equal(getBotModeFromUrl('?bot-mode=1'), true);
    assert.equal(
      getBotModeFromUrl('?scenario=demo&guards=full&bot-mode=1'),
      true
    );
  });

  it('returns false for any non-1 value', () => {
    // Strictly `===` '1' — other truthy-looking values must NOT enable bot-mode,
    // so a typo like `bot-mode=true` doesn't silently mutate the human timeline.
    assert.equal(getBotModeFromUrl('?bot-mode=true'), false);
    assert.equal(getBotModeFromUrl('?bot-mode=0'), false);
    assert.equal(getBotModeFromUrl('?bot-mode='), false);
    assert.equal(getBotModeFromUrl('?bot-mode=yes'), false);
  });
});
