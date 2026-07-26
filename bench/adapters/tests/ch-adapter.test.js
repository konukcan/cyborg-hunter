// Tests for bench/adapters/ch-adapter.js
//
// The CH adapter reads CH's pilot-report/event-log.csv (real per-event rows
// with timestamps) and normalizes them to CommonEvent objects.
//
// Why event-log.csv (not the per-trial summary)? v1's adapter consumed
// aggregate counts and synthesized fake events at the same time_elapsed,
// which destroyed timing. v2 reads the event-level log so each row keeps
// its real timestamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';

import { chEventLogAdapter } from '../ch-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'ch-sample.csv');
const schemaPath = join(__dirname, '..', 'schema.json');

const csvText = readFileSync(fixturePath, 'utf8');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

const events = chEventLogAdapter(csvText);

test('returns an array of length 6 (one CommonEvent per CSV row)', () => {
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 6);
});

test('every event has source === "ch"', () => {
  for (const evt of events) {
    assert.equal(evt.source, 'ch');
  }
});

test('paste row → type "paste" with numeric t_ms', () => {
  const paste = events.find(e => e.payload && e.payload.rawEventType === 'paste');
  assert.ok(paste, 'expected a paste event in adapter output');
  assert.equal(paste.type, 'paste');
  assert.equal(typeof paste.t_ms, 'number');
  assert.equal(paste.t_ms, 12500.5);
});

test('tabAway row → type "tab_away" with payload.duration_ms === 2500', () => {
  const tab = events.find(e => e.payload && e.payload.rawEventType === 'tabAway');
  assert.ok(tab, 'expected a tabAway event in adapter output');
  assert.equal(tab.type, 'tab_away');
  assert.equal(tab.payload.duration_ms, 2500);
});

test('synthetic row → type "programmatic_typing"', () => {
  const syn = events.find(e => e.payload && e.payload.rawEventType === 'synthetic');
  assert.ok(syn, 'expected a synthetic event in adapter output');
  assert.equal(syn.type, 'programmatic_typing');
});

test('unknown event type → type "other" with rawEventType preserved for audit', () => {
  const unk = events.find(e => e.payload && e.payload.rawEventType === 'mysteryFlag');
  assert.ok(unk, 'expected the unknown-eventType row in adapter output');
  assert.equal(unk.type, 'other');
  assert.equal(unk.payload.rawEventType, 'mysteryFlag');
});

test('guard event row (tamper) → type "tamper_detected"', () => {
  const tamper = events.find(e => e.payload && e.payload.rawEventType === 'tamper');
  assert.ok(tamper, 'expected a tamper event in adapter output');
  assert.equal(tamper.type, 'tamper_detected');
});

test('every output event validates against the CommonEvent schema', () => {
  for (const evt of events) {
    const ok = validate(evt);
    assert.equal(
      ok,
      true,
      `event ${JSON.stringify(evt)} failed schema validation: ${JSON.stringify(validate.errors)}`
    );
  }
});
