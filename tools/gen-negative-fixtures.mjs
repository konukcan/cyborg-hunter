// tools/gen-negative-fixtures.mjs
//
// Writes the `negative-*` family of the schema-v2 conformance corpus, plus the
// one `warn` witness, as fixture + expectations PAIRS.
//
// WHY A SCRIPT FOR HAND-AUTHORED FIXTURES. These are hand-authored in the sense
// the spec's Appendix means — nothing here was recorded, every byte is a
// deliberate claim about what the format forbids — but they are also fifteen
// near-copies of one minimal recording with a single defect each. Fifteen
// separately typed files drift: a spec change touches the base shape and
// fourteen of them get updated. The base lives once, here, and each entry is
// the delta plus the prose that says which review carry it answers. The output
// is DETERMINISTIC — no clock, no randomness — so re-running writes
// byte-identical files and `git diff` is empty unless a defect actually moved.
//
// WHAT EACH ENTRY OWES. A negative fixture is only worth its bytes if it fails
// for the reason it was cut for, so each one declares WHERE it is refused —
// the pipeline stage, or the named corpus invariant, or the strict error
// substring — and the runner asserts that exact placement. A fixture refused
// one stage early is a fixture that stopped testing what it says it tests.
//
// Run: node tools/gen-negative-fixtures.mjs

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { INVARIANT_NAMES } from '../tests/replay/schema-v2/corpus-invariants.js';
import { countsOf } from './gen-expectations-counts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(ROOT, 'tests', 'replay', 'schema-v2', 'fixtures');
const EXP = join(ROOT, 'tests', 'replay', 'schema-v2', 'expectations');

// ── the base every entry deviates from ─────────────────────────────────────
// Minimal, strict-valid, and boring on purpose: whatever a given entry fails
// on, everything else about it has to be conformant, or the fixture is a
// bundle of defects and the runner cannot say which one it caught.
const base = (over) => ({
  schema_version: 2,
  recorder: { name: 'hand-authored', version: '0.0.1' },
  host: null,
  participant_id: null,
  recording_started_at: '2026-08-12T00:00:00.000Z',
  recording_started_at_perf: 0,
  user_agent: 'negative-fixture',
  viewport: { w: 800, h: 600, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
  observed_root: null,
  stylesheets: [],
  stylesheet_events: [],
  viewport_changes: [],
  rng: null,
  rng_calls: null,
  ended_at_perf: 1000,
  end_reason: 'finished',
  truncated: false,
  extensions: null,
  segments: [],
  ...over,
});

const seg = (index, over) => ({
  index, label: null, plugin: null,
  t_start: 0, t_dom_ready: null, t_load: null, t_end: 1000,
  initial_dom: null, initial_state: null, events: [],
  host_data: null, extensions: null,
  ...over,
});

const el = (id, tag, attrs, children) =>
  ({ id, kind: 'element', tag, attrs: attrs ?? {}, children: children ?? [] });
const txt = (id, text) => ({ id, kind: 'text', text });

// A two-node keyframe: <div id=stage><p id=msg>hello</p></div>.
const KEYFRAME = () => el(1, 'div', { id: 'stage' }, [el(2, 'p', { id: 'msg' }, [txt(3, 'hello')])]);

// ── the entries ────────────────────────────────────────────────────────────
// `expected_failures` names the corpus invariants that MUST fail and the
// substring each message must contain; `invariants` is derived as the
// complement, so the exhaustiveness the runner asserts cannot be got wrong here.

const ENTRIES = [];
const entry = (e) => { ENTRIES.push(e); };

entry({
  name: 'negative-duplicate-node-ids.json',
  rec: base({ segments: [seg(0, {
    initial_dom: el(1, 'div', { id: 'stage' }, [
      el(3, 'p', {}, [txt(4, 'first')]),
      el(3, 'p', {}, [txt(5, 'second')]),
    ]),
  })] }),
  strict_valid: true,
  perf_frame: 'undiscriminating',
  expected_failures: { unique_node_ids: 'node id 3 is already live' },
  notes: {
    defect: 'One keyframe tree names id 3 twice, on two sibling <p> elements. Spec §4 assigns ids "in first-seen order", which presumes they are unique; a tree that breaks that has no well-defined assignment, and every dom.* event addressing id 3 afterwards is ambiguous.',
    why_this_one_matters: 'THE r3 QUESTION THIS PINS (T5 Task-3 fix round). A keyframe carrying duplicate ids is undefended on the viewer\'s NON-BODY mount path, where the root binds last, so two players silently disagree about which node keeps the id. The corpus REFUSES the file rather than picking a winner: with duplicates invalid, the first-seen vs last-seen question never arises for a conforming recording, and §4\'s ordering sentence stays a statement about the producer rather than a tie-break rule players have to share. If r3 decides duplicates are legal and names a winner, `unique_node_ids` in corpus-invariants.js is the check that changes and this fixture is where the new rule gets stated.',
    carve_out: 'Deliberately NOT a duplicate: dom.remove + dom.add of the same id inside one span, which is how a move legally encodes (M5). The generated `redacted.json` contains a real one — a <p> moved out of a redacted subtree, re-added with the same id and the same child text-node id — and it passes.',
    strict_is_silent_here: 'validateStrict walks the tree and type-checks every node; it does not hold a set of what it has seen, and adding one would make the strict profile carry corpus semantics. This is exactly the division corpus-invariants.js exists for.',
  },
});

entry({
  name: 'negative-invalid-references.json',
  rec: base({ segments: [seg(0, {
    initial_dom: KEYFRAME(),
    events: [
      { type: 'dom.text', t: 100, node: 2, text: 'still fine' },
      { type: 'dom.attr', t: 200, node: 99, name: 'class', value: 'nowhere' },
    ],
  })] }),
  strict_valid: true,
  perf_frame: 'undiscriminating',
  expected_failures: { references_resolve: 'node 99, which the keyframe span never emitted' },
  notes: {
    defect: 'The second event addresses node 99. The keyframe emitted ids 1, 2 and 3, and no dom.add introduces another, so the reference resolves to nothing.',
    why_this_one_matters: 'T3 Task-1 carry. Strict validation only NUMBER-checks `node`, `parent` and `before`, so a dangling reference is a well-typed pointer to nothing: the player resolves it to undefined and, being tolerant by design (an analyst tool must not throw on participant data), says nothing at all. The defect therefore has no symptom anywhere — which is why it needs a fixture rather than a code review.',
    ordered_not_setwise: 'references_resolve checks in TIME ORDER within the span, not against the span\'s whole id set. A reference that arrives BEFORE the dom.add introducing its node is the same defect with a different cause, and a set-wise check would call it fine.',
  },
});

entry({
  name: 'negative-unsorted-events.json',
  rec: base({ segments: [seg(0, {
    initial_dom: KEYFRAME(),
    events: [
      { type: 'mouse.move', t: 300, x: 10, y: 10 },
      { type: 'mouse.move', t: 100, x: 20, y: 20 },
    ],
  })] }),
  strict_valid: false,
  strict_errors: ['events must be time-sorted'],
  perf_frame: 'undiscriminating',
  expected_failures: { time_sorted: 'events unsorted at 1' },
  notes: {
    defect: 'Two mouse.move events at t=300 then t=100. Spec §5: "Every array is time-sorted."',
    ties_are_legal_and_this_is_not_a_tie: 'THE DISTINCTION THE FIXTURE EXISTS TO DRAW. §7 makes array order authoritative at equal `t`, so two events sharing a timestamp are conformant and a player must replay them in the order given. Only a DECREASE is a violation. `forward-compat.json` carries a real tie so the legal case has a witness too; without it, an implementation could "fix" this fixture by refusing ties and nothing would notice.',
    both_layers: 'Caught twice on purpose — by validateStrict\'s checkSorted and by the corpus time_sorted invariant, which is reimplemented independently of the validator so a validator bug cannot self-certify.',
  },
});

entry({
  name: 'negative-continuation-before-keyframe.json',
  rec: base({ segments: [seg(0, {
    events: [{ type: 'dom.attr', t: 100, node: 1, name: 'class', value: 'x' }],
  })] }),
  strict_valid: false,
  strict_errors: ['continuation carries dom.* events before any keyframe'],
  perf_frame: 'undiscriminating',
  expected_failures: {
    first_dom_bearing_is_keyframe: 'first DOM-bearing segment 0 is not a keyframe',
    references_resolve: 'node 1, which the keyframe span never emitted',
  },
  notes: {
    defect: 'The recording opens with a continuation (initial_dom: null) that patches node 1. Spec §3: "the first DOM-bearing segment of a recording MUST be a keyframe."',
    two_failures_one_defect: 'It fails references_resolve as well, and that is not sloppiness — it is the same defect seen from the other side. A continuation before any keyframe has no tree, so EVERY id it names is dangling. Declaring both is what stops a future reader from assuming the reference check is redundant here.',
    why_it_is_catastrophic_rather_than_merely_wrong: 'The checkpoint executor refuses this shape explicitly (checkpoints.test.js\'s §3 self-test). CH\'s viewer renders it as a defect chip over an empty body, which is right for an analyst and fatal for an oracle: with nothing mounted, every `exists` reads false and every checkpoint asserting ABSENCE passes over a blank stage.',
  },
});

entry({
  name: 'negative-index-mismatch.json',
  rec: base({ segments: [
    seg(0, { initial_dom: KEYFRAME(), t_end: 500 }),
    seg(5, { t_start: 500, t_end: 1000, events: [{ type: 'dom.text', t: 600, node: 3, text: 'later' }] }),
  ] }),
  strict_valid: false,
  strict_errors: ['index (5) must equal array position 1'],
  perf_frame: 'undiscriminating',
  expected_failures: { index_matches_position: 'segment at position 1 has index 5' },
  notes: {
    defect: 'The second segment states index 5 at array position 1. Spec §7: "index MUST equal the segment\'s array position. Strict validation rejects disagreement; tolerant loaders trust array order."',
    why_the_two_profiles_disagree_on_purpose: 'This fixture loads. It has to: §11\'s whole argument is that recordings are unrepeatable participant data and a runtime refusal is data loss, so the tolerant profile trusts the array and carries on. The disagreement between the profiles is the point, and a fixture is the only way to state it — which is why `expect` (does it load) and `strict_valid` (does it conform) are separate axes in the expectations format.',
    the_second_segment_is_a_real_continuation: 'It patches node 3 from the previous keyframe\'s span, so the file is otherwise a legal two-segment recording and the index is the only thing wrong with it.',
  },
});

entry({
  name: 'negative-segments-overlap.json',
  rec: base({ segments: [
    seg(0, { initial_dom: KEYFRAME(), t_start: 0, t_end: 800 }),
    seg(1, { t_start: 500, t_end: 1000, events: [{ type: 'dom.text', t: 600, node: 3, text: 'later' }] }),
  ] }),
  strict_valid: false,
  strict_errors: ['overlaps segments[1], whose origin is 500'],
  perf_frame: 'undiscriminating',
  expected_failures: {},
  notes: {
    defect: 'Segment 0 ends at 800; segment 1 opens at 500. Spec §3: "segments are ordered and non-overlapping (t_end[n] ≤ next segment\'s origin)".',
    why_it_is_not_harmless: 'Events between 500 and 800 belong to exactly one segment by §3, and an overlap makes that sentence unsatisfiable: a player assigning by time and a player trusting the arrays reconstruct different segments, which §7 forbids ("Two conforming players MUST reconstruct identical state from the same file"). The checkpoint format is affected directly — its second bound is the named segment\'s own window, and overlapping windows make "segment 1, t=600" name two moments.',
    origin_not_t_start: 'The comparison uses §3\'s segment ORIGIN (first non-null of t_load, t_dom_ready, t_start), not t_start, because a segment whose t_start is null still opens somewhere. Segment 1 here states only t_start, so origin and t_start coincide and the fixture reads simply; the rule it pins is the general one.',
    no_corpus_invariant: 'Checked by the validator alone. Non-overlap is a two-field comparison inside the segment list — exactly the shape a field walk can do — so putting it in the corpus layer would be duplication rather than independence.',
  },
});

entry({
  name: 'negative-rng-mismatch.json',
  rec: base({ rng: null, rng_calls: [], segments: [seg(0, { initial_dom: KEYFRAME() })] }),
  strict_valid: false,
  strict_errors: ['rng_calls must be non-null iff rng is non-null'],
  perf_frame: 'undiscriminating',
  expected_failures: {},
  notes: {
    defect: 'rng is null while rng_calls is an empty array. Spec §7: "rng_calls is non-null iff rng is non-null."',
    why_the_iff_carries_meaning: 'The two nulls are not redundant. §7 spells three distinct states: `rng: null` means RNG capture was OFF; `rng` present with an EMPTY rng_calls means capture was on and nothing fired; `rng` present with entries means capture was on and these are the draws. This file states the fourth combination, which says capture was off and here are zero of its results — an empty array that an analyst would read as "nothing fired" when the truthful reading is "nobody was watching". §13\'s warning in miniature.',
  },
});

entry({
  name: 'negative-non-boolean-redacted.json',
  rec: base({ segments: [seg(0, {
    initial_dom: KEYFRAME(),
    events: [{ type: 'key.down', t: 100, redacted: 1 }],
  })] }),
  strict_valid: false,
  strict_errors: ['redacted must be the boolean true when present'],
  perf_frame: 'undiscriminating',
  expected_failures: {},
  notes: {
    defect: 'A key.down whose `redacted` is the number 1 rather than the boolean true.',
    why_a_truthy_marker_is_dangerous_rather_than_untidy: '`redacted` is a VARIANT MARKER, not a toggle: every per-type check in the validator selects the redacted shape on `=== true`. A truthy non-boolean falls through to the PLAINTEXT branch, so the event asserts redaction and is then validated as if it had claimed nothing — licensing exactly the key identity the redaction was meant to remove. This fixture carries no payload alongside the bad marker, so it isolates the marker itself; `negative-redaction-leak.json` is where a payload rides one.',
    the_floor_still_holds_underneath: 'The corpus privacy scan opens on TRUTHINESS, not on `=== true`, precisely so a sloppy marker cannot walk past it: `no_redaction_leak` holds this event to key.down\'s allowlist and passes it, because the event genuinely carries nothing else. The two layers disagreeing about the marker while agreeing about the content is the intended arrangement, and it is why this fixture has no expected_failures.',
  },
});

entry({
  name: 'negative-redacted-canvas-snapshot.json',
  rec: base({ segments: [seg(0, {
    initial_dom: el(1, 'div', { id: 'stage' }, [el(2, 'canvas', { id: 'pad' }, [])]),
    events: [{
      type: 'canvas.snapshot', t: 100, node: 2,
      data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', redacted: true,
    }],
  })] }),
  strict_valid: false,
  strict_errors: ['canvas.snapshot has no redacted variant'],
  perf_frame: 'undiscriminating',
  expect_leak: true,
  expected_failures: { no_redaction_leak: 'no redacted variant defined for "canvas.snapshot"' },
  notes: {
    defect: 'A canvas.snapshot claiming `redacted: true` AND keeping its data_url. Spec §5.2 defines redacted variants for seven event types; canvas.snapshot is not one of them.',
    why_the_marker_is_worse_than_no_marker: 'Nothing in canvas.snapshot\'s check strips content, so the marker is a claim no layer can honour: the event says the pixels were withheld while carrying them. A reader filtering on `redacted` to find what was protected would skip precisely this event. The floor is an ALLOWLIST for exactly this reason — a denylist of known-bad names only catches the leaks someone thought to name, and every new event type would silently opt out of §8 until the list grew.',
    expect_leak: 'Declared, because the ALWAYS_ON privacy scan is expected to CATCH this rather than pass. Without the declaration the runner would fail the suite on a fixture doing its job; with it, the scan is asserted to fire and to name the type.',
    also_caught_by_strict: 'Both layers refuse it, from different directions: strict refuses the marker on a type outside REDACTABLE_TYPES, the corpus scan refuses an event claiming a variant that REDACTED_SHAPES does not define. The drift guard in corpus-invariants.test.js is what keeps those two tables naming the same seven types.',
  },
});

entry({
  name: 'negative-redaction-leak.json',
  rec: base({ segments: [seg(0, {
    initial_dom: el(1, 'div', { id: 'stage' }, [el(2, 'input', { id: 'a', type: 'text' }, [])]),
    events: [{
      type: 'input.value', t: 100, node: 2, redacted: true, value_len: 7,
      plaintext: 'hunter2',
    }],
  })] }),
  strict_valid: true,
  perf_frame: 'undiscriminating',
  expect_leak: true,
  expected_failures: { no_redaction_leak: 'redacted event carries disallowed key "plaintext"' },
  notes: {
    defect: 'A redacted input.value carrying the content in a key the spec never defined. `node`, `value_len` and the marker are all correct; the leak rides beside them.',
    why_THIS_is_the_fixture_the_corpus_most_needed: 'IT IS STRICT-VALID. validateStrict\'s redacted branch for input.value asks for a numeric node, a numeric value_len and an ABSENT `value` — all three hold — and it does not enumerate the keys an event may carry, because no per-field validator sensibly can. So the conformance profile passes this file and the privacy floor does not. That gap is the entire argument for the runner holding its own allowlist instead of trusting the validator, and before this fixture the argument was a comment.',
    what_a_real_producer_would_call_it: 'Not `plaintext`, obviously. It would be a vendor field a producer added for its own analytics, or a debugging key nobody removed — which is why the check is an allowlist of what may be present rather than a denylist of what may not.',
    expect_leak: 'Declared. The ALWAYS_ON scan is asserted to fire and to name the offending key, which is the inversion the T1 final review asked for.',
  },
});

entry({
  name: 'negative-password-floor.json',
  rec: base({ segments: [seg(0, {
    initial_dom: el(1, 'form', {}, [
      el(2, 'input', { id: 'user', type: 'text' }, []),
      el(3, 'input', { id: 'pw', type: 'password' }, []),
    ]),
    initial_state: { scroll: { x: 0, y: 0 }, element_scroll: [], media: [], form: [{ node: 3, value: 'hunter2' }] },
    events: [{ type: 'input.value', t: 100, node: 3, value: 'hunter2' }],
  })] }),
  strict_valid: true,
  perf_frame: 'undiscriminating',
  expect_leak: true,
  expected_failures: { password_floor: 'initial_state.form seeds a value for password node 3' },
  notes: {
    defect: 'A password field\'s value in TWO channels at once: seeded into initial_state.form, and typed in a non-redacted input.value. Spec §8\'s floor is a MUST — "values of <input type=password> are never recorded, in any channel".',
    why_it_is_strict_valid: 'Both events are perfectly typed. `input.value {node, value}` is the §5.2 plaintext variant and the validator has no idea node 3 is a password field, because knowing that means walking the keyframe tree and holding the answer while walking the event stream — the span-scoped work the corpus layer exists to do. §8 is the one section a field-by-field validator structurally cannot enforce.',
    two_channels_one_report: 'The check reports the first violation it finds (the seed), not a list. That is deliberate: a negative fixture pins ONE message as its expected_failure, and a check returning a bundle would make the pin depend on iteration order. The input.value violation is proven separately in corpus-invariants.test.js.',
    complements_rather_than_duplicates_the_scan: 'redacted.json proves that one recording contains no sentinel; this proves that NO recording may carry these channels at all, including fixtures nobody thought to type a sentinel into. Textual and structural halves of one floor.',
  },
});

entry({
  name: 'negative-truncation-mirror.json',
  rec: base({ truncated: true, segments: [seg(0, { initial_dom: KEYFRAME() })] }),
  strict_valid: true,
  perf_frame: 'undiscriminating',
  expected_failures: {
    truncation_mirrors_capture_stopped: 'truncated: true with no recording.capture_stopped',
  },
  notes: {
    defect: 'truncated: true with no recording.capture_stopped event anywhere in the file. Spec §5.7: the flag "mirrors" the event.',
    why_half_a_signal_is_worse_than_none: '§12 requires players to "surface truncation rather than presenting a partial recording as complete". A flag with no event leaves a player announcing truncation it cannot locate — the analyst sees a warning banner and no way to tell whether the missing minute is at the start, the middle or the end. The opposite half (an event with no flag) is the more dangerous one and is checked by the same invariant; a flag-only reader would present that file as complete.',
    the_affirmative_witness: '`truncated.json`, a real capture with a 12-event cap, is where both halves are present and agree.',
  },
});

entry({
  name: 'negative-perf-frame.json',
  rec: base({
    recording_started_at_perf: 5000,
    ended_at_perf: 5100,
    segments: [seg(0, { initial_dom: KEYFRAME(), t_end: 1000, events: [{ type: 'mouse.move', t: 900, x: 1, y: 1 }] })],
  }),
  strict_valid: true,
  perf_frame: 'absolute',
  expected_failures: { perf_frame: 'but the last observed moment on the wire clock is 1000' },
  notes: {
    defect: 'The recording states a perf origin of 5000 and an end of 5100 — a 100 ms session — while its only segment runs to t_end 1000 on the wire clock. Under the absolute reading it declares, the recording ended 900 ms before its own last moment.',
    why_a_declaration_is_needed_at_all: 'T3 Task-6 carry. Spec §7 puts every event `t` on the wire clock and says NOTHING about which clock `ended_at_perf` is on; §2 types it as `number | null` and stops. CH\'s serializer keeps it absolute by design; jsPsych-v1 states it on the wire clock and the converter copies that across. Both are strict-valid, and a consumer computing a duration gets two answers. So the expectations file declares the frame and the invariant holds the arithmetic to the declaration.',
    why_the_origin_is_5000_and_not_0: 'A zero origin cannot discriminate the two readings — flipping canonical-core to relative leaves it deep-equal, which is how the ambiguity survived until T3 Task-6 went looking. Only a large non-zero origin makes the declaration mean anything, which is also why `perf_frame: "undiscriminating"` is a real value rather than a hedge: canonical-core has to say out loud that it cannot answer.',
    routed_to_r3: '§7 needs one sentence naming the frame. Whichever it names, one of the two producers changes and one of the corpus\'s declarations flips with it.',
  },
});

entry({
  name: 'negative-segment-without-events.json',
  rec: base({ segments: [{ index: 0, label: null, plugin: null, initial_dom: KEYFRAME() }] }),
  expect: 'reject',
  reject_stage: 'tolerant',
  expect_error: 'segments[0] must carry an events array',
  notes: {
    defect: 'A segment object with no `events` key.',
    why_this_is_one_of_only_four_fatal_defects: 'Spec §11 lists exactly four things the TOLERANT profile refuses: schema_version ≠ 2, missing recorder identity, missing segments array, and a segment without events[]. Everything else loads with warnings, because recordings are unrepeatable participant data and a runtime refusal is data loss. This fixture is the witness for the fourth, and it is the reason the expectations format has a `reject` mode at all: a file that never becomes a recording has no counts to state and no invariants to run.',
    the_other_three: 'Not given fixtures of their own — they are covered by validator.test.js\'s unit assertions, which can state all four in four lines. What a FIXTURE adds here is the end-to-end path: the runner reading bytes off disk, refusing them at a named stage, and asserting no counts were authored for a recording that does not exist.',
  },
});

entry({
  name: 'negative-not-json.json',
  raw: '{"schema_version": 2, "recorder": {"name": "hand-authored", "version": "0.0.1"}, "segments": [\n',
  expect: 'reject',
  reject_stage: 'parse',
  expect_error: 'invalid JSON',
  notes: {
    defect: 'A truncated JSON document — the opening of a plausible recording, cut off mid-array. Not random bytes: a file that fails to parse for an INTERESTING reason, which is what a half-written upload or a killed export actually looks like.',
    why_parse_is_its_own_stage: 'validateTolerant would parse this itself and report the same failure, so separating the stages buys one thing: "this is not JSON" and "this is JSON that is not a recording" become different fixture claims. A negative fixture that says which one it is cannot quietly start passing for the other reason.',
  },
});

entry({
  name: 'negative-corrupt-gzip.json.gz',
  gzipCorrupt: true,
  expect: 'reject',
  reject_stage: 'gunzip',
  expect_error: 'incorrect data check',
  notes: {
    defect: 'A real gzip stream — correct magic bytes, correct header, decompressible body — with the trailing CRC32 damaged. Produced by gzipping a valid minimal recording and flipping two bytes of the checksum.',
    why_a_checksum_and_not_random_bytes: 'Random bytes after the magic fail immediately and prove only that the reader calls gunzip. A damaged CHECKSUM decompresses to plausible-looking JSON and fails at the very end, which is the case a reader is most likely to get wrong: a streaming implementation that parses as it inflates has already handed the caller a recording by the time the check fails. §10 makes gzip detection normative; this is what detection has to be robust to.',
    where_it_is_refused: 'At the gunzip stage, before parse. The gzip round-trip test for reject-mode fixtures also asserts that the magic bytes and the `.json.gz` extension agree, so the file cannot quietly stop being a gzip test.',
  },
});

entry({
  name: 'negative-decompression-bomb.json.gz',
  gzipBomb: true,
  expect: 'reject',
  reject_stage: 'gunzip',
  expect_error: 'Cannot create a Buffer larger than',
  notes: {
    defect: 'A valid gzip stream, ~17 KB on disk, that inflates to 17 MB — past the runner\'s 16 MB decompressed-size ceiling. Highly compressible filler, not a recording: what it inflates TO is irrelevant, since the point is that nothing may inflate it far enough to find out.',
    why_a_ceiling_is_normative_ish: 'Spec §10: "Players SHOULD enforce a decompressed-size ceiling before parsing (protection against decompression bombs; a configurable limit with a generous default)", and §12 makes recording content untrusted input. A reader without a ceiling turns a 17 KB upload into an allocation the size of its memory limit, and the ratio here is deliberately modest — a real bomb reaches gigabytes from the same few kilobytes.',
    the_ceiling_is_tested_separately_too: 'conformance.test.js proves the ceiling itself on a synthetic buffer, because a ceiling quietly raised above this fixture would leave the fixture passing for the wrong reason and nothing else would notice.',
  },
});

entry({
  name: 'warn-missing-advisory.json',
  rec: (() => { const r = base({ segments: [seg(0, { initial_dom: KEYFRAME() })] }); delete r.user_agent; return r; })(),
  expect: 'warn',
  expect_warning: 'missing advisory field: user_agent',
  strict_valid: false,
  strict_errors: ['user_agent must be a string'],
  perf_frame: 'undiscriminating',
  expected_failures: {},
  notes: {
    defect: 'No `user_agent`. §2 declares it required and §11 puts it outside the tolerant profile\'s four fatal defects, so the file loads with a warning and fails conformance.',
    why_the_corpus_needs_a_warn_witness: 'This is the middle of the three outcomes and the one nothing else in the corpus produces: every other positive fixture loads silently, every negative either fails strict or never loads at all. Without an entry here, the `warn` branch of the runner — and the tolerant profile\'s entire "loads with warnings and documented defaults" clause — is code no fixture reaches. The accept branch asserts warnings are EMPTY, so a producer that started warning on healthy files would also be caught.',
    the_default_is_visible_in_the_load: 'The tolerant profile fills absent top-level keys from TOP_DEFAULTS; `user_agent` is not among them, so it stays absent rather than becoming an empty string. That is deliberate — a defaulted "" would be a claim about the participant\'s browser that nobody made — and the semantic-preservation test asserts the loader added nothing.',
  },
});

// ── emit ───────────────────────────────────────────────────────────────────

function expectationsFor(e, rec) {
  const out = { fixture: e.name, expect: e.expect ?? 'accept' };
  if (out.expect === 'reject') {
    out.reject_stage = e.reject_stage;
    out.expect_error = e.expect_error;
    out.checkpoints = [];
    out.notes = e.notes;
    return out;
  }
  out.strict_valid = e.strict_valid;
  if (e.strict_valid === false) out.strict_errors = e.strict_errors;
  out.perf_frame = e.perf_frame;
  if (e.expect === 'warn') out.expect_warning = e.expect_warning;
  out.counts = countsOf(rec);
  out.spot_checks = e.spot_checks ?? [];
  if (e.expect_leak) out.expect_leak = true;
  const failures = e.expected_failures ?? {};
  out.invariants = INVARIANT_NAMES.filter((n) => !(n in failures));
  out.expected_failures = failures;
  out.checkpoints = [];
  out.notes = e.notes;
  return out;
}

// The corrupt-gzip and bomb payloads, built here so the bytes on disk are
// reproducible from the source rather than from someone's shell history.
function bytesFor(e) {
  if (e.raw != null) return Buffer.from(e.raw, 'utf8');
  if (e.gzipCorrupt) {
    const good = gzipSync(Buffer.from(JSON.stringify(
      base({ segments: [seg(0, { initial_dom: KEYFRAME() })] }), null, 2) + '\n'));
    const bad = Buffer.from(good);
    // The last four bytes of a gzip member are the CRC32 of the uncompressed
    // data; damaging them leaves a stream that inflates and then fails.
    bad[bad.length - 8] ^= 0xff;
    bad[bad.length - 7] ^= 0xff;
    return bad;
  }
  if (e.gzipBomb) return gzipSync(Buffer.alloc(17 * 1024 * 1024, 0x41));
  return Buffer.from(JSON.stringify(e.rec, null, 2) + '\n', 'utf8');
}

for (const e of ENTRIES) {
  const bytes = bytesFor(e);
  writeFileSync(join(FIX, e.name), bytes);
  const expName = e.name.endsWith('.gz') ? e.name.slice(0, -'.gz'.length) : e.name;
  writeFileSync(join(EXP, expName), JSON.stringify(expectationsFor(e, e.rec), null, 2) + '\n');
  console.log(`  ${e.name.padEnd(42)} ${String(bytes.length).padStart(7)} bytes  →  expectations/${expName}`);
}
console.log(`\n${ENTRIES.length} entries written. Deterministic: re-running leaves git clean.`);
