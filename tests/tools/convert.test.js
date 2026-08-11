// tests/tools/convert.test.js
// jsPsych-v1 → SessionRecording-v2 converter (T4 tasks 1+2).
//
// Three duties, in the order the plan lists them:
//   (1) the design §2 mapping table, field by field, over a hand-built minimal
//       v1 object (tests/tools/fixtures/jspsych-v1-minimal.json — the same
//       object the golden is cut from, so the two can never drift apart);
//   (2) every refusal path — the converter fails loud rather than guessing,
//       and NEVER renumbers a trial;
//   (3) the output is strict-valid v2 (validateStrict from the schema-v2 dir;
//       an inward import the design explicitly sanctions), byte-stable across
//       repeated runs and across input key order, and byte-identical to a
//       committed golden that the CLI regenerates.
//
// Paths are relative to the repo root, matching example-fixtures.test.js:
// `npm run test:tools` runs node --test from there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertRecording, CONVERTER_VERSION } from '../../tools/convert/jspsych-v1-to-v2.mjs';
import { validateStrict } from '../replay/schema-v2/validator.js';

const TOOL = 'tools/convert/jspsych-v1-to-v2.mjs';
const V1_PATH = 'tests/tools/fixtures/jspsych-v1-minimal.json';
const GOLDEN_PATH = 'tests/tools/fixtures/jspsych-v1-minimal.v2.golden.json';

// The committed sample IS the hand-built minimal v1 object. Every test that
// needs to mutate takes a fresh clone, so no test can leak into another.
function v1() {
  return JSON.parse(readFileSync(V1_PATH, 'utf8'));
}

// Refusals throw; this returns the message so tests can assert on its content.
function refusalMessage(input) {
  try {
    convertRecording(input);
  } catch (e) {
    return e.message;
  }
  return assert.fail('expected convertRecording to refuse, but it returned');
}

const V2_TOP_KEYS = [
  'schema_version', 'recorder', 'host', 'participant_id',
  'recording_started_at', 'recording_started_at_perf', 'user_agent', 'viewport',
  'observed_root', 'stylesheets', 'stylesheet_events', 'viewport_changes',
  'rng', 'rng_calls', 'ended_at_perf', 'end_reason', 'truncated', 'extensions',
  'segments',
];
const V2_SEGMENT_KEYS = [
  'index', 'label', 'plugin', 't_start', 't_dom_ready', 't_load', 't_end',
  'initial_dom', 'initial_state', 'events', 'host_data', 'extensions',
];

// ── (1) mapping table, field by field ───────────────────────────────────────

test('schema_version 1 becomes the integer 2', () => {
  assert.equal(convertRecording(v1()).schema_version, 2);
});

test('jspsych_version becomes recorder AND host {name:"jspsych", version}', () => {
  const src = v1();
  const out = convertRecording(src);
  assert.deepEqual(out.recorder, { name: 'jspsych', version: src.jspsych_version });
  assert.deepEqual(out.host, { name: 'jspsych', version: src.jspsych_version });
});

test('display_element_id becomes an id-selector observed_root', () => {
  const out = convertRecording(v1());
  assert.equal(out.observed_root, '#jspsych-display-element');
});

test('participant_id is null and truncated is false (v1 carries neither)', () => {
  const out = convertRecording(v1());
  assert.equal(out.participant_id, null);
  assert.equal(out.truncated, false);
});

test('unchanged top-level fields survive value-for-value', () => {
  const src = v1();
  const out = convertRecording(src);
  for (const k of [
    'recording_started_at', 'recording_started_at_perf', 'user_agent', 'viewport',
    'stylesheets', 'stylesheet_events', 'viewport_changes', 'rng', 'rng_calls',
    'ended_at_perf', 'end_reason',
  ]) {
    assert.deepEqual(out[k], src[k], `${k} must pass through unchanged`);
  }
});

test('no v1-only top-level key survives, and the v2 key set is exact', () => {
  const out = convertRecording(v1());
  for (const gone of ['jspsych_version', 'display_element_id', 'trials']) {
    assert.equal(gone in out, false, `${gone} must not appear in v2 output`);
  }
  assert.deepEqual(Object.keys(out).sort(), [...V2_TOP_KEYS].sort());
});

test('trials become segments, one per trial, in order', () => {
  const src = v1();
  const out = convertRecording(src);
  assert.equal(out.segments.length, src.trials.length);
  assert.deepEqual(out.segments.map(s => s.index), [0, 1]);
});

test('every segment field maps per the design §2 table', () => {
  const src = v1();
  const out = convertRecording(src);
  src.trials.forEach((t, i) => {
    const s = out.segments[i];
    assert.equal(s.index, t.trial_index, `segments[${i}].index`);
    assert.equal(s.label, String(t.trial_index), `segments[${i}].label`);
    assert.equal(typeof s.label, 'string', `segments[${i}].label is a string`);
    assert.equal(s.plugin, t.plugin, `segments[${i}].plugin`);
    assert.equal(s.t_start, t.t_start, `segments[${i}].t_start`);
    assert.equal(s.t_dom_ready, t.t_dom_ready, `segments[${i}].t_dom_ready`);
    assert.equal(s.t_end, t.t_end, `segments[${i}].t_end`);
    assert.equal(s.t_load, null, `segments[${i}].t_load is null (v1 has no t_load)`);
    assert.equal(s.initial_state, null, `segments[${i}].initial_state is null (jsPsych wipes)`);
    assert.deepEqual(s.initial_dom, t.initial_dom, `segments[${i}].initial_dom unchanged`);
    assert.deepEqual(s.events, t.events, `segments[${i}].events unchanged`);
    assert.deepEqual(s.host_data, t.trial_data, `segments[${i}].host_data is trial_data`);
    assert.equal(s.extensions, null, `segments[${i}].extensions`);
    assert.deepEqual(Object.keys(s).sort(), [...V2_SEGMENT_KEYS].sort(), `segments[${i}] key set`);
  });
});

test('every trial is a keyframe: initial_dom survives, no continuation is invented', () => {
  const out = convertRecording(v1());
  assert.ok(out.segments.every(s => s.initial_dom !== null),
    'v1 wipes the display per trial, so no segment may come out as a continuation');
});

test('t_end: null on an open final trial passes through (not coerced)', () => {
  const src = v1();
  assert.equal(src.trials[1].t_end, null, 'sample must keep an open final trial');
  assert.equal(convertRecording(src).segments[1].t_end, null);
});

test('output does not alias the input (mutating either leaves the other intact)', () => {
  const src = v1();
  const out = convertRecording(src);
  out.segments[0].events.push({ type: 'focus', t: 999 });
  out.viewport.w = 1;
  assert.equal(src.trials[0].events.length, 3);
  assert.equal(src.viewport.w, 1280);
});

// ── provenance ──────────────────────────────────────────────────────────────

test('provenance lands in extensions.converter with tool, version and source hash', () => {
  const out = convertRecording(v1());
  assert.deepEqual(Object.keys(out.extensions), ['converter']);
  const p = out.extensions.converter;
  assert.deepEqual(Object.keys(p).sort(), ['source_sha256', 'tool', 'version']);
  assert.equal(p.tool, 'jspsych-v1-to-v2');
  assert.equal(p.version, CONVERTER_VERSION);
  assert.match(p.source_sha256, /^[0-9a-f]{64}$/);
});

test('the source hash is stable, content-sensitive, and key-order invariant', () => {
  const a = convertRecording(v1()).extensions.converter.source_sha256;
  const b = convertRecording(v1()).extensions.converter.source_sha256;
  assert.equal(a, b, 'same input twice must hash the same');

  const changed = v1();
  changed.user_agent = 'something-else';
  assert.notEqual(convertRecording(changed).extensions.converter.source_sha256, a,
    'a content change must change the hash');

  assert.equal(convertRecording(reorderKeys(v1())).extensions.converter.source_sha256, a,
    'reordering input keys must not change the hash');
});

// ── (2) refusals ────────────────────────────────────────────────────────────

test('refuses anything that is not a JSON object', () => {
  for (const bad of [null, undefined, 42, 'a string', [], true]) {
    assert.match(refusalMessage(bad), /must be a JSON object/);
  }
});

test('refuses schema_version !== 1, naming what it got', () => {
  const two = v1(); two.schema_version = 2;
  assert.match(refusalMessage(two), /schema_version must be the integer 1 \(got 2\)/);

  const missing = v1(); delete missing.schema_version;
  assert.match(refusalMessage(missing), /schema_version/);
});

test('refuses unknown top-level keys, listing every one of them', () => {
  const extra = v1();
  extra.ch_extensions = { some: 'thing' };
  extra.segments = [];
  const msg = refusalMessage(extra);
  assert.match(msg, /unknown top-level key/);
  assert.match(msg, /ch_extensions/);
  assert.match(msg, /segments/);
});

test('refuses missing top-level keys rather than defaulting them', () => {
  const gone = v1();
  delete gone.rng_calls;
  delete gone.stylesheet_events;
  const msg = refusalMessage(gone);
  assert.match(msg, /missing top-level key/);
  assert.match(msg, /rng_calls/);
  assert.match(msg, /stylesheet_events/);
});

test('refuses a non-string jspsych_version and a non-string/empty display_element_id', () => {
  const badVersion = v1(); badVersion.jspsych_version = 8;
  assert.match(refusalMessage(badVersion), /jspsych_version must be a string/);

  const badId = v1(); badId.display_element_id = null;
  assert.match(refusalMessage(badId), /display_element_id must be a non-empty string/);

  const emptyId = v1(); emptyId.display_element_id = '';
  assert.match(refusalMessage(emptyId), /display_element_id must be a non-empty string/);
});

test('refuses a non-array trials and a non-object trial', () => {
  const notArray = v1(); notArray.trials = {};
  assert.match(refusalMessage(notArray), /trials must be an array/);

  const notObject = v1(); notObject.trials = [null];
  assert.match(refusalMessage(notObject), /trials\[0\] must be a JSON object/);
});

test('refuses unknown trial-level keys, naming the trial and the keys', () => {
  const extra = v1();
  extra.trials[1].ch_extensions = {};
  extra.trials[1].host_data = null;
  const msg = refusalMessage(extra);
  assert.match(msg, /trials\[1\]: unknown trial-level key/);
  assert.match(msg, /ch_extensions/);
  assert.match(msg, /host_data/);
});

test('refuses missing trial-level keys', () => {
  const gone = v1();
  delete gone.trials[0].t_dom_ready;
  assert.match(refusalMessage(gone), /trials\[0\]: missing trial-level key.*t_dom_ready/);
});

test('refuses trial_index !== array position, and never renumbers', () => {
  const skewed = v1();
  skewed.trials[1].trial_index = 7;
  // The refusal IS the guarantee: there is no output in which 7 became 1.
  assert.throws(
    () => convertRecording(skewed),
    /trials\[1\]\.trial_index \(7\) must equal its array position \(1\)/
  );
});

test('refuses trials whose order was swapped (the renumbering trap)', () => {
  const swapped = v1();
  swapped.trials = [swapped.trials[1], swapped.trials[0]];
  const msg = refusalMessage(swapped);
  assert.match(msg, /trials\[0\]\.trial_index \(1\)/);
  assert.match(msg, /trials\[1\]\.trial_index \(0\)/);
});

test('refuses a non-integer trial_index', () => {
  const frac = v1();
  frac.trials[0].trial_index = 0.5;
  assert.match(refusalMessage(frac), /trial_index/);
});

test('one refusal reports every reason it found, not just the first', () => {
  const messy = v1();
  messy.nonsense = 1;
  delete messy.user_agent;
  messy.trials[0].trial_index = 5;
  let err;
  try { convertRecording(messy); } catch (e) { err = e; }
  assert.ok(Array.isArray(err.reasons), 'the error carries a reasons array');
  assert.equal(err.reasons.length, 3, err.reasons.join(' | '));
});

// ── (3) strict validation, goldens, determinism ─────────────────────────────

test('converted output passes the schema-v2 strict profile', () => {
  const result = validateStrict(convertRecording(v1()));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('the committed golden passes the schema-v2 strict profile', () => {
  const result = validateStrict(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('the golden matches the converter on the top level and on segment 0', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const out = convertRecording(v1());
  const { segments: goldenSegments, ...goldenTop } = golden;
  const { segments: outSegments, ...outTop } = out;
  assert.deepEqual(outTop, goldenTop, 'top-level snapshot');
  assert.deepEqual(outSegments[0], goldenSegments[0], 'segment-0 snapshot');
  assert.equal(outSegments.length, goldenSegments.length);
});

test('the CLI regenerates the golden byte-for-byte', () => {
  const regenerated = execFileSync('node', [TOOL, V1_PATH, '--stdout']).toString();
  assert.equal(regenerated, readFileSync(GOLDEN_PATH, 'utf8'));
});

test('the CLI is deterministic: the same input twice is byte-identical', () => {
  const a = execFileSync('node', [TOOL, V1_PATH, '--stdout']).toString();
  const b = execFileSync('node', [TOOL, V1_PATH, '--stdout']).toString();
  assert.equal(a, b);
});

test('output bytes do not depend on the input file key order', () => {
  const straight = JSON.stringify(convertRecording(v1()), null, 2);
  const shuffled = JSON.stringify(convertRecording(reorderKeys(v1())), null, 2);
  assert.equal(shuffled, straight);
});

// ── CLI wrapper ─────────────────────────────────────────────────────────────

test('the CLI reads stdin when given no input path', () => {
  const out = execFileSync('node', [TOOL, '--stdout'], { input: readFileSync(V1_PATH) }).toString();
  assert.equal(out, readFileSync(GOLDEN_PATH, 'utf8'));
});

test('the CLI writes a file with --out', () => {
  const dest = join(tmpdir(), `ch-convert-${process.pid}.json`);
  execFileSync('node', [TOOL, V1_PATH, '--out', dest]);
  assert.equal(readFileSync(dest, 'utf8'), readFileSync(GOLDEN_PATH, 'utf8'));
});

test('the CLI exits non-zero and explains itself on a refusal', () => {
  const bad = v1(); bad.schema_version = 2;
  const err = runCliExpectingFailure(JSON.stringify(bad));
  assert.equal(err.status, 1);
  assert.match(err.stderr.toString(), /schema_version must be the integer 1/);
});

test('the CLI refuses to emit output that fails strict validation', () => {
  // Key sets are intact, so the mapping accepts it; the value is the wrong
  // type, which only the strict profile can see. The CLI must not write it.
  const bad = v1();
  bad.viewport.w = 'wide';
  const err = runCliExpectingFailure(JSON.stringify(bad));
  assert.equal(err.status, 1);
  assert.match(err.stderr.toString(), /strict/i);
  assert.match(err.stderr.toString(), /viewport/);
});

// ── helpers ─────────────────────────────────────────────────────────────────

// Reverses key order at the top level and inside each trial. Passthrough
// payloads (events, initial_dom) keep their own order: the converter copies
// participant data verbatim and only owns the keys it writes itself.
function reorderKeys(obj) {
  const flip = o => Object.fromEntries(Object.entries(o).reverse());
  const out = flip(obj);
  out.trials = obj.trials.map(flip);
  return out;
}

function runCliExpectingFailure(input) {
  try {
    execFileSync('node', [TOOL, '--stdout'], { input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return e;
  }
  return assert.fail('expected the CLI to exit non-zero');
}
