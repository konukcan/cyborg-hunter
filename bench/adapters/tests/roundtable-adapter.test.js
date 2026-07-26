// Tests for bench/adapters/roundtable-adapter.js
//
// The Roundtable adapter normalizes two distinct RT API responses into the
// CommonEvent shape used elsewhere in the bench:
//   1. GET /v1/sessions/{id}/events  →  Array<CommonEvent>
//   2. GET /v1/sessions/{id}/report  →  one synthetic 'session_flags' event
//
// Pattern follows ch-adapter.test.js: per-feature `node --test` cases plus a
// final AJV gate that validates every produced event against schema.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';

import {
  roundtableEventsAdapter,
  roundtableReportAdapter,
} from '../roundtable-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventsFixturePath = join(__dirname, 'fixtures', 'rt-sample.json');
const reportFixturePath = join(__dirname, 'fixtures', 'rt-report-sample.json');
const schemaPath = join(__dirname, '..', 'schema.json');

const eventsPayload = JSON.parse(readFileSync(eventsFixturePath, 'utf8'));
const reportPayload = JSON.parse(readFileSync(reportFixturePath, 'utf8'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

const events = roundtableEventsAdapter(eventsPayload);
const sessionFlagsEvent = roundtableReportAdapter(reportPayload);

// ---------------------------------------------------------------------------
// roundtableEventsAdapter
// ---------------------------------------------------------------------------

test('roundtableEventsAdapter: returns an array', () => {
  assert.ok(Array.isArray(events));
});

test('roundtableEventsAdapter: every event has source === "roundtable"', () => {
  for (const evt of events) {
    assert.equal(evt.source, 'roundtable');
  }
});

test('roundtableEventsAdapter: every event has trialId === null (RT is session-level only)', () => {
  for (const evt of events) {
    assert.equal(evt.trialId, null);
  }
});

test('roundtableEventsAdapter: "User navigated to ..." → type "other" with payload.subkind "navigation"', () => {
  const nav = events.find(e => /^User navigated to /.test(e.payload.raw_action));
  assert.ok(nav, 'expected at least one navigation event in fixture');
  assert.equal(nav.type, 'other');
  assert.equal(nav.payload.subkind, 'navigation');
});

test('roundtableEventsAdapter: User clicked "Next >" → type "click" with payload.button_text === "Next >"', () => {
  const click = events.find(e => e.type === 'click' && e.payload.button_text === 'Next >');
  assert.ok(click, 'expected at least one "Next >" click in fixture');
  assert.equal(click.type, 'click');
  assert.equal(click.payload.button_text, 'Next >');
});

test('roundtableEventsAdapter: multi-line click preserves literal newlines in button_text', () => {
  const multiline = events.find(
    e => e.type === 'click'
      && typeof e.payload.button_text === 'string'
      && e.payload.button_text.includes('\n')
  );
  assert.ok(multiline, 'expected at least one multi-line click in fixture');
  assert.equal(
    multiline.payload.button_text,
    'Not at all confident\nSomewhat\nVery confident'
  );
});

test('roundtableEventsAdapter: "Page became hidden" → type "tab_away"', () => {
  const hidden = events.find(e => e.payload.raw_action === 'Page became hidden');
  assert.ok(hidden, 'expected a "Page became hidden" event in fixture');
  assert.equal(hidden.type, 'tab_away');
});

test('roundtableEventsAdapter: "Page became visible" → type "tab_return"', () => {
  const visible = events.find(e => e.payload.raw_action === 'Page became visible');
  assert.ok(visible, 'expected a "Page became visible" event in fixture');
  assert.equal(visible.type, 'tab_return');
});

test('roundtableEventsAdapter: "User edited #..." → type "typing_burst" with payload.element_id', () => {
  const edit = events.find(
    e => e.type === 'typing_burst'
      && e.payload.element_id === 'jspsych-survey-text-response-0'
  );
  assert.ok(edit, 'expected a User edited #jspsych-survey-text-response-0 event');
  assert.equal(edit.type, 'typing_burst');
  assert.equal(edit.payload.element_id, 'jspsych-survey-text-response-0');
});

test('roundtableEventsAdapter: "User submitted ..." → type "other" with payload.subkind "form_submit" and form_id', () => {
  const submit = events.find(
    e => e.type === 'other' && e.payload.subkind === 'form_submit'
  );
  assert.ok(submit, 'expected at least one form_submit event in fixture');
  assert.equal(submit.payload.form_id, 'jspsych-survey-multi-choice_form');
});

test('roundtableEventsAdapter: 63 input events → 63 output events', () => {
  assert.equal(events.length, 63);
});

test('roundtableEventsAdapter: every output event validates against the CommonEvent schema', () => {
  for (const evt of events) {
    const ok = validate(evt);
    assert.equal(
      ok,
      true,
      `event ${JSON.stringify(evt)} failed schema validation: ${JSON.stringify(validate.errors)}`
    );
  }
});

// ---------------------------------------------------------------------------
// roundtableReportAdapter
// ---------------------------------------------------------------------------

test('roundtableReportAdapter: returns a single CommonEvent (not an array)', () => {
  assert.equal(Array.isArray(sessionFlagsEvent), false);
  assert.equal(typeof sessionFlagsEvent, 'object');
});

test('roundtableReportAdapter: type "session_flags", source "roundtable", trialId null', () => {
  assert.equal(sessionFlagsEvent.type, 'session_flags');
  assert.equal(sessionFlagsEvent.source, 'roundtable');
  assert.equal(sessionFlagsEvent.trialId, null);
});

test('roundtableReportAdapter: payload.biometric.no_corrections === true (matches fixture)', () => {
  assert.equal(sessionFlagsEvent.payload.biometric.no_corrections, true);
});

test('roundtableReportAdapter: payload.biometric.all_pasted === false (matches fixture)', () => {
  assert.equal(sessionFlagsEvent.payload.biometric.all_pasted, false);
});

test('roundtableReportAdapter: payload.device.bot === false', () => {
  assert.equal(sessionFlagsEvent.payload.device.bot, false);
});

test('roundtableReportAdapter: payload.risk_score is a number; payload.recommended_action is a string', () => {
  assert.equal(typeof sessionFlagsEvent.payload.risk_score, 'number');
  assert.equal(typeof sessionFlagsEvent.payload.recommended_action, 'string');
});

test('roundtableReportAdapter: "Not detected" strings convert to false, NOT true-from-truthiness', () => {
  // The strict-string semantics from §6 of the schema notes are a real trap:
  // `Boolean("Not detected")` is `true` (non-empty string), which would
  // silently invert every signal. This test pins the correct behavior.
  const handcrafted = {
    risk_score: 0,
    risk_explanation: 'unit test',
    recommended_action: 'Auto-accept',
    biometric_checks: {
      agent_behavior: 'Not detected',
      programmatic_typing: 'Not detected',
      teleporting_mouse: 'Not detected',
      jump_scrolling: 'Not detected',
      center_clicks: 'Not detected',
      no_corrections: 'Not detected',
      all_pasted: 'Not detected',
    },
    device_checks: {
      bot: 'Not detected',
      virtual_machine: 'Not detected',
      software_renderer: 'Not detected',
      tor: 'Not detected',
      vpn: 'Not detected',
      location_spoofing: 'Not detected',
    },
  };
  const out = roundtableReportAdapter(handcrafted);
  for (const v of Object.values(out.payload.biometric)) {
    assert.equal(v, false, 'biometric "Not detected" must convert to false');
  }
  for (const v of Object.values(out.payload.device)) {
    assert.equal(v, false, 'device "Not detected" must convert to false');
  }
});

test('roundtableReportAdapter: output event validates against the CommonEvent schema', () => {
  const ok = validate(sessionFlagsEvent);
  assert.equal(
    ok,
    true,
    `session_flags event failed schema validation: ${JSON.stringify(validate.errors)}`
  );
});
