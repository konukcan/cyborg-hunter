// Tests for bench/adapters/schema.json (CommonEvent).
// Uses node --test + ajv (Draft-07).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

test('accepts a valid CH paste event', () => {
  const evt = { t_ms: 1200, type: 'paste', source: 'ch', payload: {} };
  const ok = validate(evt);
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('accepts a valid Roundtable event with trialId null', () => {
  const evt = {
    t_ms: 4567,
    type: 'click',
    source: 'roundtable',
    trialId: null,
    payload: { x: 10, y: 20 }
  };
  const ok = validate(evt);
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('rejects an event with unknown type', () => {
  const evt = { t_ms: 100, type: 'nonsense', source: 'ch', payload: {} };
  const ok = validate(evt);
  assert.equal(ok, false);
});

test('rejects an event missing the source field', () => {
  const evt = { t_ms: 100, type: 'paste', payload: {} };
  const ok = validate(evt);
  assert.equal(ok, false);
  // Confirm the failure was specifically about a missing required field.
  const hasRequiredErr = (validate.errors || []).some(e => e.keyword === 'required');
  assert.equal(hasRequiredErr, true);
});

test('rejects an event where source is not in enum', () => {
  const evt = { t_ms: 100, type: 'paste', source: 'foo', payload: {} };
  const ok = validate(evt);
  assert.equal(ok, false);
});

// Regression guard: new guard-layer event types must remain accepted.
test('accepts new guard-layer event types (ai_use_bait, tamper_detected)', () => {
  const baitEvt = { t_ms: 2000, type: 'ai_use_bait', source: 'ch', payload: {} };
  assert.equal(validate(baitEvt), true, JSON.stringify(validate.errors));

  const tamperEvt = {
    t_ms: 2500,
    type: 'tamper_detected',
    source: 'roundtable',
    trialId: 'trial-42',
    payload: { reason: 'hook_removed' }
  };
  assert.equal(validate(tamperEvt), true, JSON.stringify(validate.errors));
});

// Phase 2.0: session_flags is a synthetic Roundtable-source event that folds
// the entire /report response (biometric_checks, device_checks, risk_score,
// recommended_action) into a single CommonEvent. The adapter emits at most
// one per session, typically at t_ms = 0.
test('accepts session_flags event from Roundtable /report rollup', () => {
  const evt = {
    t_ms: 0,
    type: 'session_flags',
    source: 'roundtable',
    trialId: null,
    payload: {
      biometric_checks: {
        agent_behavior: 'Not detected',
        programmatic_typing: 'Not detected',
        no_corrections: 'Detected',
        all_pasted: 'Not detected'
      },
      device_checks: { bot: 'Not detected', vpn: 'Not detected' },
      risk_score: 15,
      recommended_action: 'Auto-accept'
    }
  };
  const ok = validate(evt);
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('rejects session_flags event missing source', () => {
  const evt = { t_ms: 0, type: 'session_flags', payload: {} };
  assert.equal(validate(evt), false);
});
