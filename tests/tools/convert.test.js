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

// A fresh clone with one deliberate defect applied.
function v1Patch(mutate) {
  const r = v1();
  mutate(r);
  return r;
}

// The converter's provenance stamp, addressed through the vendor slug.
function provenance(v2) {
  return v2.extensions['cyborg-hunter'].converter;
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
    // null, not String(trial_index): spec §3 calls `label` host-assigned, and
    // jsPsych assigns none. A stringified index would duplicate `index` while
    // asserting a label the recording never carried.
    assert.equal(s.label, null, `segments[${i}].label`);
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
  // `!== null` would also pass on a dropped field (undefined !== null), which
  // is the opposite of what this test is named for: a keyframe is a DomNode
  // object, so check for one.
  assert.ok(
    out.segments.every(s => s.initial_dom && typeof s.initial_dom === 'object'),
    'v1 wipes the display per trial, so no segment may come out as a continuation'
  );
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

test('provenance lands under the cyborg-hunter vendor slug, not a bare "converter" key', () => {
  const out = convertRecording(v1());
  // Spec §9 types `extensions` as { "<vendor>": JsonValue } with lowercase-slug
  // vendor keys. "converter" is a role, not a vendor, and this shape travels
  // into the fork with the jspsych-full fixture.
  assert.deepEqual(Object.keys(out.extensions), ['cyborg-hunter']);
  assert.deepEqual(Object.keys(out.extensions['cyborg-hunter']), ['converter']);
  const p = provenance(out);
  assert.deepEqual(Object.keys(p).sort(), ['source_sha256', 'tool', 'version']);
  assert.equal(p.tool, 'jspsych-v1-to-v2');
  assert.equal(p.version, CONVERTER_VERSION);
  assert.match(p.source_sha256, /^[0-9a-f]{64}$/);
});

test('the source hash is stable, content-sensitive, and key-order invariant', () => {
  const a = provenance(convertRecording(v1())).source_sha256;
  const b = provenance(convertRecording(v1())).source_sha256;
  assert.equal(a, b, 'same input twice must hash the same');

  const changed = v1();
  changed.user_agent = 'something-else';
  assert.notEqual(provenance(convertRecording(changed)).source_sha256, a,
    'a content change must change the hash');

  assert.equal(provenance(convertRecording(reorderKeys(v1()))).source_sha256, a,
    'reordering input keys must not change the hash');
});

test('the source hash pins the ALGORITHM, not just its three properties', () => {
  // Stability, content-sensitivity and key-order invariance all survive a swap
  // of the hash serialization, and the golden cannot witness one either: it is
  // regenerated by this same tool. So the digest an outside reader computes
  // from the docblock is asserted literally, off the golden path entirely.
  // Task 4's expectations quote source_sha256 as the regeneration link between
  // the committed raw v1 JSON and jspsych-full.json, which is worth nothing if
  // the algorithm can drift unnoticed.
  assert.equal(
    provenance(convertRecording(v1())).source_sha256,
    '82f0e641014a501ed281b665d1a4520b27a25df263ba06e7ab305f011480adc8'
  );
});

// ── the stylesheets/stylesheet_events backfill (the one concession) ──────────

test('a pre-stylesheet-feature recording converts, with the backfill self-reported', () => {
  const old = v1();
  delete old.stylesheets;
  delete old.stylesheet_events;
  const out = convertRecording(old);
  assert.deepEqual(out.stylesheets, []);
  assert.deepEqual(out.stylesheet_events, []);
  assert.deepEqual(provenance(out).backfilled, ['stylesheets', 'stylesheet_events']);
  assert.equal(validateStrict(out).ok, true);
});

test('the backfill is per-key: one absent field does not conjure the other', () => {
  const old = v1();
  delete old.stylesheet_events;
  const out = convertRecording(old);
  assert.deepEqual(out.stylesheets, v1().stylesheets, 'the present field is untouched');
  assert.deepEqual(out.stylesheet_events, []);
  assert.deepEqual(provenance(out).backfilled, ['stylesheet_events']);
});

test('the backfill report is absent when nothing was backfilled', () => {
  const p = provenance(convertRecording(v1()));
  assert.equal('backfilled' in p, false);
});

test('the backfill is absence-only: a present-but-wrong-type field is never filled in', () => {
  // Absence means "this recorder had no stylesheet feature", which [] records
  // faithfully. A present null or a present string means something went wrong,
  // and the converter has nothing true to say about it — so it passes the value
  // through untouched and the strict profile stops it at the CLI boundary.
  for (const bad of [null, 'not-an-array', {}]) {
    const broken = v1();
    broken.stylesheets = bad;
    const out = convertRecording(broken);
    assert.deepEqual(out.stylesheets, bad, `${JSON.stringify(bad)} passes through unfilled`);
    assert.equal('backfilled' in provenance(out), false);
    assert.equal(validateStrict(out).ok, false, `${JSON.stringify(bad)} must fail strict`);
  }
  const err = runCliExpectingFailure(JSON.stringify({ ...v1(), stylesheets: null }));
  assert.equal(err.status, 1);
  assert.match(err.stderr.toString(), /strict/i);
  assert.match(err.stderr.toString(), /stylesheets must be an array/);
});

test('the source hash describes the recording as it arrived, not as it was backfilled', () => {
  const absent = v1();
  delete absent.stylesheets;
  delete absent.stylesheet_events;
  const empty = { ...v1(), stylesheets: [], stylesheet_events: [] };
  // The two convert to the same stylesheet content but come from different
  // recordings: one recorder had no stylesheet feature, the other captured
  // nothing. source_sha256 is the regeneration link back to the committed raw
  // v1 JSON, so hashing the post-backfill clone would erase the distinction
  // precisely in the case where the converter changed something.
  assert.deepEqual(convertRecording(absent).stylesheets, convertRecording(empty).stylesheets);
  assert.notEqual(
    provenance(convertRecording(absent)).source_sha256,
    provenance(convertRecording(empty)).source_sha256
  );
});

test('the concession stops at those two fields: every other missing key still refuses', () => {
  for (const key of ['rng_calls', 'rng', 'viewport', 'viewport_changes', 'user_agent']) {
    const gone = v1();
    delete gone[key];
    assert.match(refusalMessage(gone), new RegExp(`missing top-level key\\(s\\): ${key}`),
      `${key} must keep refusing`);
  }
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

  // Pinned exactly: a bare /schema_version/ would also be satisfied by the
  // missing-key message this same input produces, so it would not witness the
  // refusal the test is named for.
  const missing = v1(); delete missing.schema_version;
  assert.match(refusalMessage(missing), /schema_version must be the integer 1 \(got undefined\)/);
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
  delete gone.user_agent;
  const msg = refusalMessage(gone);
  assert.match(msg, /missing top-level key/);
  assert.match(msg, /rng_calls/);
  assert.match(msg, /user_agent/);
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
  // Pinned exactly: a bare /trial_index/ would also be satisfied by the
  // position-mismatch message, which is a different refusal.
  assert.match(refusalMessage(frac), /trials\[0\]\.trial_index must be an integer \(got 0\.5\)/);
});

test('every refusal tells the operator what to do about it', () => {
  // A refusal is the end of the road for this recording until a human acts, so
  // naming the defect is only half the job. Each message must also carry a
  // second sentence: the remedy.
  const cases = [
    [[], 'not-an-object'],
    [v1Patch(r => { r.schema_version = 3; }), 'wrong schema_version'],
    [v1Patch(r => { r.nonsense = 1; }), 'unknown top-level key'],
    [v1Patch(r => { delete r.user_agent; }), 'missing top-level key'],
    [v1Patch(r => { r.jspsych_version = 8; }), 'non-string jspsych_version'],
    [v1Patch(r => { r.display_element_id = ''; }), 'empty display_element_id'],
    [v1Patch(r => { r.trials = {}; }), 'non-array trials'],
    [v1Patch(r => { r.trials = [null]; }), 'non-object trial'],
    [v1Patch(r => { r.trials[0].extra = 1; }), 'unknown trial-level key'],
    [v1Patch(r => { delete r.trials[0].plugin; }), 'missing trial-level key'],
    [v1Patch(r => { r.trials[0].trial_index = 'x'; }), 'non-integer trial_index'],
    [v1Patch(r => { r.trials[1].trial_index = 9; }), 'trial_index mismatch'],
  ];
  for (const [input, what] of cases) {
    let err;
    try { convertRecording(input); } catch (e) { err = e; }
    assert.ok(err, `${what} must refuse`);
    for (const reason of err.reasons) {
      // Sentence one names the defect; everything after it must open with an
      // instruction the operator can act on.
      const cut = reason.indexOf('. ');
      assert.ok(cut > 0, `${what}: single-sentence refusal "${reason}"`);
      assert.match(
        reason.slice(cut + 2),
        /^(Pass|Point|Re-export|Remove|Reorder|Quote|Drop|Name|Fix|Use)\b/,
        `${what}: the remedy does not open with an instruction: "${reason.slice(cut + 2)}"`
      );
    }
  }
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

// ── (4) the real jsPsych capture: corruption guardian + big-input regression ─
//
// tests/tools/fixtures/jspsych-v1-full.json is the raw v1 recording the
// Playwright harness cut (14 trials, 909 events, 1.2MB), and
// tests/replay/schema-v2/fixtures/jspsych-full.json is what this converter made
// of it. The conformance runner checks the SECOND file; nothing checked the
// first, so a corrupted or truncated capture would sit in the tree unnoticed
// until someone tried to regenerate from it — precisely when the regeneration
// path is supposed to be trustworthy. These three tests close that, and in
// doing so give the converter its only regression test over a real recording:
// every unit test above runs on a hand-built minimal object, so a mapping bug
// that only appears at scale (a trial shape the minimal object does not have, a
// 470KB stylesheet, a 189K-char canvas data URL) has no other tripwire.
const RAW_FULL_PATH = 'tests/tools/fixtures/jspsych-v1-full.json';
const FULL_FIXTURE_PATH = 'tests/replay/schema-v2/fixtures/jspsych-full.json';
// The digest the fixture's expectations quote as the raw-capture → fixture link
// (extensions["cyborg-hunter"].converter.source_sha256). Written out here as
// well as compared through the fixture, so a mismatch reads as "the capture
// changed" rather than as one line inside a 1.2MB deep-equal.
const RAW_FULL_SHA256 = '1d4a079d15493a0530b7a1f4827d59bfc3d1241a583051065bd6085405634664';

const rawFull = () => JSON.parse(readFileSync(RAW_FULL_PATH, 'utf8'));

test('the committed raw jsPsych capture still converts and strict-validates', () => {
  const result = validateStrict(convertRecording(rawFull()));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('converting the committed raw capture reproduces the jspsych-full fixture', () => {
  // The regeneration claim, executed: the conformance fixture is not a file
  // someone once produced and then edited, it is this converter's output for
  // the committed input. Corruption of EITHER file fails here, and so does a
  // converter change that alters the mapping without re-cutting the fixture.
  const converted = convertRecording(rawFull());
  assert.equal(converted.extensions['cyborg-hunter'].converter.source_sha256, RAW_FULL_SHA256);
  assert.deepEqual(converted, JSON.parse(readFileSync(FULL_FIXTURE_PATH, 'utf8')));
});

test('the capture carries the pinned stylesheet as text, not a cross-origin null', () => {
  // The recording harness serves the pinned jsPsych CSS from its own origin
  // precisely so the recorder can read `cssRules`; loaded from the CDN the
  // sheet is cross-origin and v1 records `css: null`, leaving a replayer with
  // an unstyled page. This is the one property of the capture that a
  // regeneration could silently lose (it would still convert, still validate,
  // still count 909 events), so it is asserted rather than described.
  const raw = rawFull();
  assert.equal(raw.stylesheets.length, 1);
  assert.equal(raw.stylesheets[0].kind, 'link');
  assert.equal(typeof raw.stylesheets[0].css, 'string');
  assert.ok(raw.stylesheets[0].css.length > 100_000,
    `base stylesheet carries only ${raw.stylesheets[0].css.length} chars of CSS`);
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
