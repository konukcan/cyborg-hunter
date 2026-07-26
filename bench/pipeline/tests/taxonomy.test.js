// taxonomy.test.js
// Validates bench/pipeline/taxonomy.json and cross-checks it against the
// CommonEvent schema (bench/adapters/schema.json).
//
// The taxonomy is the *ground-truth grid* for the bench matrix — it can be
// finer-grained than the raw event vocabulary. Some taxonomy behaviors are
// not 1:1 with a schema enum value because they are *derived* from raw
// events at analysis time (e.g. tab_away_short ← tab_away with duration < 10s).
//
// Run: node --test bench/pipeline/tests/taxonomy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TAXONOMY_PATH = join(REPO_ROOT, 'bench', 'pipeline', 'taxonomy.json');
const SCHEMA_PATH = join(REPO_ROOT, 'bench', 'adapters', 'schema.json');

const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// Taxonomy ids that are *intentionally* not in the schema's event-type enum.
// Each is derived from raw schema events by post-processing logic.
// If you add a new taxonomy id that isn't in the schema enum, either add the
// corresponding schema event or add the id here with a one-line rationale.
const ALLOWED_DERIVED_BEHAVIORS = {
  // Split of schema's `tab_away` event by duration (payload.duration_ms).
  tab_away_short:        'derived from tab_away events with duration_ms < 10000',
  tab_away_long:         'derived from tab_away events with duration_ms >= 10000',
  // Schema has the generic `extension_detected`; taxonomy specializes it.
  ai_extension_present:  'derived from extension_detected where payload identifies an AI extension',
  // Schema has no dedicated sidebar event; CH emits guard_violation_sidebar and
  // viewport_change. This is the broader (non-guard) sidebar observation.
  browser_sidebar:       'derived from viewport_change / window-width heuristic (non-guard sidebar)',
  // Typing-related behaviors are derived from typing_burst event payloads.
  fast_typing:           'derived from typing_burst events where cps exceeds preset threshold',
  no_corrections:        'derived from typing_burst events lacking backspace/edit signals',
  synthetic_insertion:   'derived from input mutations without a preceding keystroke event',
  foreign_input:         'derived from input events whose target is outside the experiment container',
  idle_gap:              'derived from gaps between mouse_sample / typing_burst events',
  // Schema bundles environment fingerprints under the generic `device_flag` event.
  headless_browser:      'derived from device_flag events with payload.kind === "headless"',
  vpn_or_tor:            'derived from device_flag events with payload.kind in {"vpn","tor","datacenter"}',
  vm_environment:        'derived from device_flag events with payload.kind === "vm"',
  location_spoofing:     'derived from device_flag events with payload.kind === "location_mismatch"',
};

test('taxonomy.behaviors is an array of length 29', () => {
  assert.ok(Array.isArray(taxonomy.behaviors), 'behaviors must be an array');
  assert.equal(taxonomy.behaviors.length, 29, 'expected 29 behaviors');
});

test('every behavior has a non-empty id and description', () => {
  for (const b of taxonomy.behaviors) {
    assert.ok(b && typeof b === 'object', 'behavior must be an object');
    assert.ok(typeof b.id === 'string' && b.id.length > 0,
      `behavior is missing a non-empty id: ${JSON.stringify(b)}`);
    assert.ok(typeof b.description === 'string' && b.description.length > 0,
      `behavior "${b.id}" is missing a non-empty description`);
  }
});

test('every behavior id is unique', () => {
  const ids = taxonomy.behaviors.map(b => b.id);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate taxonomy ids: ${dupes.join(', ')}`);
});

test('every taxonomy id is either in schema enum or in ALLOWED_DERIVED_BEHAVIORS', () => {
  const schemaEnum = schema.properties.type.enum;
  assert.ok(Array.isArray(schemaEnum), 'schema must have properties.type.enum');

  const schemaSet = new Set(schemaEnum);
  const allowedSet = new Set(Object.keys(ALLOWED_DERIVED_BEHAVIORS));

  const unaccounted = [];
  for (const b of taxonomy.behaviors) {
    const inSchema = schemaSet.has(b.id);
    const inAllowed = allowedSet.has(b.id);
    if (!inSchema && !inAllowed) {
      unaccounted.push(b.id);
    }
  }
  assert.deepEqual(
    unaccounted,
    [],
    `taxonomy ids not in schema enum and not in ALLOWED_DERIVED_BEHAVIORS: ${unaccounted.join(', ')}\n` +
    `Either add a corresponding event type to bench/adapters/schema.json or add ` +
    `the id to ALLOWED_DERIVED_BEHAVIORS with a rationale.`
  );
});

test('ALLOWED_DERIVED_BEHAVIORS only lists ids that are actually in the taxonomy', () => {
  const taxonomyIds = new Set(taxonomy.behaviors.map(b => b.id));
  const stale = Object.keys(ALLOWED_DERIVED_BEHAVIORS).filter(id => !taxonomyIds.has(id));
  assert.deepEqual(
    stale, [],
    `ALLOWED_DERIVED_BEHAVIORS contains ids not present in taxonomy.json: ${stale.join(', ')}`
  );
});

test('ALLOWED_DERIVED_BEHAVIORS does not shadow any schema enum value', () => {
  // If an id is in the schema enum, it should NOT be allowlisted as derived —
  // that would be a definition collision.
  const schemaSet = new Set(schema.properties.type.enum);
  const shadows = Object.keys(ALLOWED_DERIVED_BEHAVIORS).filter(id => schemaSet.has(id));
  assert.deepEqual(
    shadows, [],
    `ALLOWED_DERIVED_BEHAVIORS shadows schema enum values: ${shadows.join(', ')}`
  );
});
