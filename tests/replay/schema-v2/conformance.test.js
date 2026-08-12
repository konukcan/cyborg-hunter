// Conformance runner: every fixtures/*.json (and *.json.gz) is checked against
// its expectations twin. A new fixture enrolls by existing on disk — no
// registry to update, so T4's converter output and T7's corpus join for free.
//
// THE PIPELINE, AND WHY THE STAGES ARE NAMED. A fixture is put through five
// stages in order — gunzip → parse → tolerant → strict → corpus — and the
// expectations file says where it is expected to come out. Before T7 the runner
// could only express "this file is a valid recording, here is what is in it",
// which is why the whole negative half of the spec's Appendix table was
// unbuilt: a corrupt gzip cannot be JSON.parsed for an events_by_type
// histogram, and a fixture whose only job is to be REFUSED has nothing to spot
// check. Naming the stage is what keeps a negative fixture honest — a rejection
// test that passes for the wrong reason (a typo'd fixture refused at `parse`
// when it was written to be refused at `strict`) is worse than no test.
//
// THE THREE EXPECTATION MODES (`expect`, describing the TOLERANT LOAD only):
//   "accept" (default) — the file loads clean. Full battery: counts,
//                        spot checks, every corpus invariant, gzip round-trip,
//                        §11 semantic preservation.
//   "warn"             — the file loads, with at least one warning matching
//                        `expect_warning`. Counts optional.
//   "reject"           — the file never becomes a recording. `reject_stage`
//                        (gunzip | parse | tolerant) and `expect_error` are
//                        required; counts, spot checks and invariants are not.
//
// STRICT VALIDITY IS A SEPARATE AXIS. `expect` says whether the file LOADS;
// `strict_valid` says whether it CONFORMS, and the two are independent by
// design (spec §11: recordings are unrepeatable participant data, so the
// runtime profile accepts things CI refuses). A fixture stating
// `strict_valid: false` must also state `strict_errors` — the substrings the
// refusal has to contain — so "strict rejected it" can never be credited to an
// error nobody intended.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validateStrict, validateTolerant, detectGzip } from './validator.js';
import { INVARIANT_CHECKS, INVARIANT_NAMES, PRIVACY_INVARIANTS } from './corpus-invariants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const EXP = join(HERE, 'expectations');

// Spec §10: "Players SHOULD enforce a decompressed-size ceiling before parsing
// (protection against decompression bombs; a configurable limit with a generous
// default)." Generous relative to this corpus — jspsych-full is 1.2 MB — and
// small enough that the bomb fixture stays a few hundred bytes on disk.
const DECOMPRESSED_CEILING = 16 * 1024 * 1024;

const STAGES = ['gunzip', 'parse', 'tolerant', 'strict', 'corpus'];

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

// ── enrollment ─────────────────────────────────────────────────────────────
// A `.json.gz` fixture is the §10 detection path exercised as a FILE rather
// than as a round-trip in memory, and its expectations twin drops the `.gz`:
// `negative-corrupt-gzip.json.gz` is answered by
// `expectations/negative-corrupt-gzip.json`. Mechanical, and the one collision
// it admits (a `.json` and a `.json.gz` fixture sharing a stem) is asserted
// against below rather than left to resolve silently in favour of whichever
// readdir returned last.
const FIXTURES = readdirSync(FIX).filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));
const expNameFor = (file) => (file.endsWith('.gz') ? file.slice(0, -'.gz'.length) : file);

// Enrollment sanity. Enrolling by existence is what makes new fixtures free,
// and it is also the failure mode with no symptom: an empty fixtures/ leaves a
// green suite that asserts nothing, and an expectations file whose twin was
// renamed or deleted simply stops being read. Neither shows up as a failing
// test anywhere else, so both are asserted directly.
test('enrollment: fixtures exist and every expectation has a fixture twin', () => {
  assert.ok(FIXTURES.length > 0, 'fixtures/ holds no *.json — the conformance suite would pass vacuously');
  const claimed = new Map();
  for (const f of FIXTURES) {
    const name = expNameFor(f);
    assert.ok(!claimed.has(name),
      `fixtures/${f} and fixtures/${claimed.get(name)} both map to expectations/${name} — ` +
      `one of them would be checked against the other's expectations`);
    claimed.set(name, f);
  }
  for (const e of readdirSync(EXP).filter(f => f.endsWith('.json'))) {
    assert.ok(claimed.has(e), `expectations/${e} has no fixture twin — it is being silently skipped`);
  }
});

// ── the pipeline ───────────────────────────────────────────────────────────

/**
 * Run a fixture's bytes through the five stages, stopping at the first refusal.
 * @returns {{stage: string|null, error: string|null, raw: string|null,
 *            rec: object|null, loaded: object|null, strict: object|null}}
 *          `stage` is the stage that REFUSED, or null when the file came all
 *          the way through.
 */
function runPipeline(bytes, exp) {
  const out = { stage: null, error: null, raw: null, rec: null, loaded: null, strict: null };

  // gunzip — §10's magic-byte detection plus the decompressed-size ceiling.
  let text;
  if (detectGzip(bytes)) {
    try {
      text = gunzipSync(bytes, { maxOutputLength: DECOMPRESSED_CEILING }).toString('utf8');
    } catch (e) {
      out.stage = 'gunzip';
      out.error = `gunzip refused the fixture: ${e.message}`;
      return out;
    }
  } else {
    text = bytes.toString('utf8');
  }
  out.raw = text;

  // parse — separated from `tolerant` even though validateTolerant would parse
  // it, because "this is not JSON" and "this is JSON that is not a recording"
  // are different fixture claims and a negative fixture pins which one it is.
  try { out.rec = JSON.parse(text); }
  catch (e) { out.stage = 'parse'; out.error = `invalid JSON: ${e.message}`; return out; }

  // tolerant (spec §11) — the runtime profile. Four fatal defects, everything
  // else loads with warnings.
  out.loaded = validateTolerant(text);
  if (!out.loaded.ok) {
    out.stage = 'tolerant';
    out.error = out.loaded.errors.join('; ');
    return out;
  }

  // strict (spec §11) — the conformance profile. NOT a pipeline stop: a
  // strict-invalid recording still loads, and `strict_valid`/`strict_errors`
  // carry that verdict independently of `expect`.
  out.strict = validateStrict(text);

  // corpus — the whole-recording invariants, run in a fixed order so a fixture
  // that violates two of them names the same one every run.
  out.invariantFailures = {};
  for (const name of INVARIANT_NAMES) {
    const failure = INVARIANT_CHECKS[name](out.rec, exp);
    if (failure != null) out.invariantFailures[name] = failure;
  }
  return out;
}

// ── per-fixture tests ──────────────────────────────────────────────────────

for (const file of FIXTURES) {
  const expFile = expNameFor(file);

  test(`conformance: ${file}`, () => {
    const bytes = readFileSync(join(FIX, file));
    const exp = JSON.parse(readFileSync(join(EXP, expFile), 'utf8'));
    // An expectations file that names a different fixture is being applied to
    // the wrong recording; a missing block would make its assertions no-ops.
    assert.equal(exp.fixture, file, `expectations/${expFile} declares fixture "${exp.fixture}"`);
    const mode = exp.expect ?? 'accept';
    assert.ok(['accept', 'warn', 'reject'].includes(mode),
      `expectations/${expFile} declares unknown expect mode "${mode}"`);

    const res = runPipeline(bytes, exp);

    // ── reject mode ────────────────────────────────────────────────────────
    if (mode === 'reject') {
      assert.ok(STAGES.includes(exp.reject_stage) && exp.reject_stage !== 'strict' && exp.reject_stage !== 'corpus',
        `expectations/${expFile} must declare reject_stage as "gunzip" | "parse" | "tolerant" ` +
        `(strict invalidity is carried by strict_valid/strict_errors, and a corpus-invariant ` +
        `violation by expected_failures — neither stops a file from loading)`);
      assert.ok(typeof exp.expect_error === 'string' && exp.expect_error.length > 0,
        `expectations/${expFile} declares expect: "reject" with no expect_error — a refusal ` +
        `for the wrong reason would pass`);
      assert.equal(res.stage, exp.reject_stage,
        res.stage === null
          ? `the fixture was NOT refused; it came through every stage`
          : `refused at "${res.stage}", not the declared "${exp.reject_stage}": ${res.error}`);
      assert.ok(res.error.includes(exp.expect_error),
        `the refusal message does not contain "${exp.expect_error}": ${res.error}`);
      // Counts, spot checks and invariants are not merely optional here — they
      // are unreachable, and stating them would be a claim about a recording
      // that was never built.
      for (const k of ['counts', 'spot_checks', 'invariants', 'checkpoints']) {
        if (k === 'checkpoints') continue;   // the checkpoints runner requires the (empty) array
        assert.ok(!(k in exp) || exp[k] == null,
          `expectations/${expFile} states "${k}" on a fixture that never becomes a recording`);
      }
      return;
    }

    // ── accept / warn ──────────────────────────────────────────────────────
    assert.equal(res.stage, null,
      `expectations/${expFile} declares expect: "${mode}", but the fixture was refused at ` +
      `"${res.stage}": ${res.error}`);

    if (mode === 'warn') {
      assert.ok(typeof exp.expect_warning === 'string' && exp.expect_warning.length > 0,
        `expectations/${expFile} declares expect: "warn" with no expect_warning`);
      assert.ok(res.loaded.warnings.some(w => w.includes(exp.expect_warning)),
        `no warning contains "${exp.expect_warning}": ${JSON.stringify(res.loaded.warnings)}`);
    } else {
      assert.deepEqual(res.loaded.warnings, [],
        `expectations/${expFile} declares expect: "accept", but the tolerant load warned`);
    }

    // Strict conformance, stated and — when it fails — itemised.
    assert.equal(typeof exp.strict_valid, 'boolean', `expectations/${expFile} has no strict_valid`);
    assert.equal(res.strict.ok, exp.strict_valid, `strict_valid mismatch: ${JSON.stringify(res.strict.errors)}`);
    if (exp.strict_valid === false) {
      assert.ok(Array.isArray(exp.strict_errors) && exp.strict_errors.length > 0,
        `expectations/${expFile} states strict_valid: false with no strict_errors — "strict ` +
        `rejected it" would be credited to whatever error happened to be there`);
      for (const want of exp.strict_errors) {
        assert.ok(res.strict.errors.some(e => e.includes(want)),
          `no strict error contains "${want}": ${JSON.stringify(res.strict.errors)}`);
      }
    } else {
      assert.ok(!('strict_errors' in exp),
        `expectations/${expFile} states strict_errors on a strict-VALID fixture`);
    }

    // ── corpus invariants ──────────────────────────────────────────────────
    // Every invariant runs against every fixture. The expectations file makes
    // an EXHAUSTIVE claim about the outcome: `invariants` lists the ones that
    // hold, `expected_failures` maps the ones that do not to the substring
    // their message must contain, and together they must account for the whole
    // table. An opt-in list would let a new invariant land with nothing
    // enrolled in it — green, and asserting nothing.
    const expectedFailures = exp.expected_failures ?? {};
    assert.ok(Array.isArray(exp.invariants), `expectations/${expFile} has no invariants array`);
    assert.deepEqual(
      [...exp.invariants, ...Object.keys(expectedFailures)].sort(),
      [...INVARIANT_NAMES].sort(),
      `expectations/${expFile} must account for every corpus invariant exactly once, across ` +
      `"invariants" (expected to hold) and "expected_failures" (expected to fail)`);

    // The privacy scans are the ones that may not fail by accident. A fixture
    // whose expected_failures names one of them is declaring a deliberate leak
    // and must say so out loud (T1 final review's `expect_leak`), so the
    // ALWAYS_ON scan inverts — asserting the scan CATCHES it — instead of
    // failing the suite.
    const declaredLeaks = Object.keys(expectedFailures).filter(n => PRIVACY_INVARIANTS.includes(n));
    if (declaredLeaks.length > 0) {
      assert.equal(exp.expect_leak, true,
        `expectations/${expFile} expects ${declaredLeaks.join('/')} to fail without declaring ` +
        `expect_leak: true — a deliberately-leaking fixture has to say so`);
    } else {
      assert.ok(!('expect_leak' in exp),
        `expectations/${expFile} declares expect_leak with no privacy invariant in expected_failures`);
    }

    for (const name of exp.invariants) {
      assert.equal(res.invariantFailures[name] ?? null, null,
        `invariant ${name}: ${res.invariantFailures[name]}`);
    }
    for (const [name, want] of Object.entries(expectedFailures)) {
      const got = res.invariantFailures[name];
      assert.ok(got != null,
        `expectations/${expFile} expects invariant ${name} to FAIL and it passed — the fixture ` +
        `no longer carries the defect it was cut for`);
      assert.ok(got.includes(want), `invariant ${name} failed for the wrong reason: ${got}`);
    }

    // ── counts, spot checks ────────────────────────────────────────────────
    // Required in accept mode and permitted in warn mode. `events_by_type` is
    // required, not optional: segment and event totals say how big a recording
    // is; only the per-type histogram says what is IN it, and that is the whole
    // claim a producer fixture makes — a jsPsych recording losing every
    // canvas.snapshot to a mapping regression keeps its 909-event total.
    // (tools/gen-expectations-counts.mjs computes it.)
    if (mode === 'accept') {
      assert.ok(exp.counts, `expectations/${expFile} has no counts block`);
      assert.ok(Array.isArray(exp.spot_checks), `expectations/${expFile} has no spot_checks array`);
    }
    const rec = res.rec;
    if (exp.counts) {
      assert.ok(exp.counts.events_by_type, `expectations/${expFile} has no counts.events_by_type`);
      const eventsTotal = rec.segments.reduce((n, s) => n + s.events.length, 0);
      assert.equal(rec.segments.length, exp.counts.segments);
      assert.equal(eventsTotal, exp.counts.events_total);
      assert.equal(rec.segments.filter(s => s.initial_dom != null).length, exp.counts.keyframes);
      assert.equal(rec.segments.filter(s => s.initial_dom == null).length, exp.counts.continuations);
      // Recomputed here rather than trusted: the histogram is an authored claim
      // about the fixture, and deepEqual holds it to being exhaustive in both
      // directions — a type the fixture carries but the block omits fails just as
      // loudly as a type the block invents.
      const byType = {};
      for (const s of rec.segments) for (const e of s.events) byType[e.type] = (byType[e.type] ?? 0) + 1;
      assert.deepEqual(byType, exp.counts.events_by_type);
      // No cross-check that the authored histogram sums to the authored
      // events_total: with both sides recomputed from the same fixture, that sum
      // is a theorem, not an assertion. A test that cannot fail is worse than no
      // test, because it gets credited with catching things the deepEqual caught.
    }
    for (const sc of exp.spot_checks ?? []) {
      assert.deepEqual(getPath(rec, sc.path), sc.equals, `spot check ${sc.path}`);
    }

    // ── §8 whole-FILE leak scan ────────────────────────────────────────────
    // "Redaction is a property of the FILE, not of event capture. A redacted
    // subtree's content must not appear anywhere in the serialized recording."
    // Structural checks cannot say that: `password_floor` knows the channels
    // §8 names, and §8's own sentence is about the bytes. So this one reads the
    // raw text and looks for a string.
    //
    // `present` is not decoration. An absence scan over an empty file passes,
    // and a fixture regeneration that silently captured nothing would leave
    // every `absent` entry green — so each scan carries liveness companions,
    // and the pin-8 residuals it deliberately does NOT claim to remove are
    // asserted present rather than left unmentioned.
    if (exp.leak_scan) {
      const { absent = [], absent_patterns = [], present = [] } = exp.leak_scan;
      assert.ok(present.length > 0,
        `expectations/${expFile} declares a leak_scan with no "present" companions — an ` +
        `absence scan over a fixture that captured nothing passes`);
      for (const s of absent) {
        assert.ok(!res.raw.includes(s), `leak scan: "${s}" appears in the serialized recording (spec §8)`);
      }
      for (const p of absent_patterns) {
        const m = new RegExp(p).exec(res.raw);
        assert.equal(m, null, `leak scan: /${p}/ matches "${m?.[0]}" in the serialized recording (spec §8)`);
      }
      for (const s of present) {
        assert.ok(res.raw.includes(s),
          `leak scan: "${s}" is absent — the fixture no longer carries what its scan is scanning around`);
      }
    }
  });

  test(`gzip round-trip: ${file}`, () => {
    const bytes = readFileSync(join(FIX, file));
    const exp = JSON.parse(readFileSync(join(EXP, expFile), 'utf8'));
    if ((exp.expect ?? 'accept') === 'reject') {
      // A fixture that never becomes a recording has no object to round-trip.
      // What IS asserted is the detection half of §10: whatever the bytes are,
      // detectGzip must agree with the filename the corpus stores them under —
      // the corrupt-gzip fixture is only a gzip test if the reader takes the
      // gunzip path to fail on it.
      assert.equal(detectGzip(bytes), file.endsWith('.gz'),
        `fixtures/${file}: magic bytes and file extension disagree about compression`);
      return;
    }
    const raw = detectGzip(bytes) ? gunzipSync(bytes, { maxOutputLength: DECOMPRESSED_CEILING }) : bytes;
    const gz = gzipSync(raw);
    assert.equal(detectGzip(gz), true);
    assert.equal(detectGzip(raw), false);
    assert.deepEqual(JSON.parse(gunzipSync(gz).toString('utf8')), JSON.parse(raw.toString('utf8')));
  });

  test(`semantic preservation: ${file}`, () => {
    // Spec §11 preservation rule: loading a recording must not silently drop
    // fields. This is the seam the forward-compat fixture pushes on.
    const bytes = readFileSync(join(FIX, file));
    const exp = JSON.parse(readFileSync(join(EXP, expFile), 'utf8'));
    if ((exp.expect ?? 'accept') === 'reject') return;
    const raw = (detectGzip(bytes) ? gunzipSync(bytes, { maxOutputLength: DECOMPRESSED_CEILING }) : bytes)
      .toString('utf8');
    const parsed = JSON.parse(raw);
    // The bare parse→serialize→parse anchor. Weak on its own — nothing
    // JSON.parse produces can fail it — and kept as the seam the forward-compat
    // fixture extends.
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
    // The half with teeth. The contract asserted here is the strict one: for
    // every key the file carried, the loaded value must come back identical —
    // no removal, no rewrite, and no addition anywhere beneath it. That holds
    // because validateTolerant fills absent defaults at the TOP level only
    // ({...TOP_DEFAULTS, ...obj}) and never reaches inside segments. Unknown
    // forward-compat fields are what a key-whitelisting loader drops, and
    // dropping them silently is the §11 violation this catches.
    // The strictness is deliberate. If the loader ever starts defaulting
    // *within* a segment, this test fails, and that change gets argued for
    // rather than absorbed. CH's recorder-side serializer is the other half of
    // §11, but this directory lifts wholesale into a shared package and may not
    // import it, so the serializer's preservation test belongs to the CH-side
    // suite.
    const loaded = validateTolerant(raw);
    // Strict-valid implies tolerant-valid: strict runs tolerant first and
    // inherits its errors. So a strict-valid fixture that fails to load is a
    // loader regression, and saying so here is what stops the branch below
    // from absolving one — a tolerant loader that rejected everything would
    // otherwise satisfy the error branch and pass this test.
    if (exp.strict_valid) {
      assert.equal(loaded.ok, true,
        `tolerant load rejected a strict-valid fixture: ${JSON.stringify(loaded.errors)}`);
    }
    if (loaded.ok) {
      for (const k of Object.keys(parsed)) {
        assert.deepEqual(loaded.recording[k], parsed[k], `tolerant load altered top-level "${k}"`);
      }
    } else {
      assert.ok(loaded.errors.length > 0, 'tolerant load failed without reporting an error');
    }
  });
}

// ── corpus-level coverage ──────────────────────────────────────────────────

test('corpus: every invariant is exercised in its FAILING direction by some fixture', () => {
  // An invariant only ever run against conforming files is an assertion nobody
  // has watched fail. The negative-* set exists so each one has a witness, and
  // this is the test that notices when a new invariant lands without one.
  const witnessed = new Set();
  for (const e of readdirSync(EXP).filter(f => f.endsWith('.json'))) {
    const exp = JSON.parse(readFileSync(join(EXP, e), 'utf8'));
    for (const name of Object.keys(exp.expected_failures ?? {})) witnessed.add(name);
  }
  const unwitnessed = INVARIANT_NAMES.filter(n => !witnessed.has(n));
  assert.deepEqual(unwitnessed, [],
    `no fixture makes ${unwitnessed.join(', ')} fail — cut a negative-* fixture that does, or the ` +
    `check is only ever observed passing`);
});

test('corpus: the §10 gzip detection path is exercised by a fixture on disk', () => {
  // The in-memory round-trip above compresses each fixture and reads it back,
  // which proves detectGzip's arithmetic and nothing about the reader's
  // handling of a file that ARRIVES compressed. That needs bytes on disk.
  assert.ok(FIXTURES.some(f => f.endsWith('.json.gz')),
    'no *.json.gz fixture — the enrollment path that reads compressed bytes off disk is untested');
});

test('corpus: at least one fixture pins the absolute perf frame', () => {
  // T3 Task-6's finding, kept from decaying back into a note: canonical-core's
  // zero origin cannot tell the absolute reading of `ended_at_perf` from the
  // relative one, so the corpus needs a fixture with a large non-zero origin or
  // the ambiguity is unpinned again.
  const frames = readdirSync(EXP).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(EXP, f), 'utf8')).perf_frame);
  assert.ok(frames.includes('absolute'),
    'no fixture declares perf_frame: "absolute" — the reading CH\'s serializer states is unpinned');
});

// ── self-tests of the runner's own machinery ───────────────────────────────

// A spot check whose path does not resolve must FAIL, never quietly pass.
// getPath returns undefined for an absent key, and node:assert/strict's
// deepEqual separates undefined from null — that pairing is what stops
// `{"equals": null}` from being satisfied by a key the producer forgot to emit.
// Keep both halves together.
test('getPath: an absent key is undefined and cannot satisfy {"equals": null}', () => {
  assert.equal(getPath({ a: {} }, 'a.b'), undefined);
  assert.throws(() => assert.deepEqual(getPath({ a: {} }, 'a.b'), null));
  // The real spot check it protects still resolves to a genuine null.
  assert.deepEqual(getPath({ segments: [{}, { initial_dom: null }] }, 'segments.1.initial_dom'), null);
});

test('runPipeline: the decompressed-size ceiling refuses a bomb before parsing', () => {
  // Proven on a synthetic buffer rather than only on the fixture, because the
  // fixture proves the ENROLLMENT path and this proves the ceiling itself: a
  // ceiling raised above the bomb would leave the fixture passing for the wrong
  // reason, and nothing else would notice.
  const bomb = gzipSync(Buffer.alloc(DECOMPRESSED_CEILING + 1, 0x41));
  const res = runPipeline(bomb, {});
  assert.equal(res.stage, 'gunzip');
  assert.match(res.error, /gunzip refused/);
  // …and a payload under the ceiling comes through the gunzip stage, so the
  // ceiling is refusing size rather than refusing compression.
  assert.equal(runPipeline(gzipSync(Buffer.from('not json')), {}).stage, 'parse');
});
