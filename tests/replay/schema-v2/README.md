# schema-v2 — SessionRecording v2 validator + conformance fixtures

Package-shaped: this directory is the future shared schema package's root
(spec: docs/plans/2026-08-09-session-recording-v2-spec-draft.md, r2). Until
then, CH's CI runs it via `npm run test:schema`.

Layout: `validator.js` (dual profiles, spec §11) · `corpus-invariants.js`
(whole-recording properties a field walk cannot see) · `fixtures/` (the corpus)
· `expectations/` (per-fixture assertions) · `conformance.test.js` (wire-level
runner) · `checkpoints.test.js` (reconstruction-level runner) ·
`validator.test.js` and `corpus-invariants.test.js` (each layer's own reject
direction, on synthetic input).

Hand-authored canonical fixtures are the consumer contract; producer recordings
answer it. Both halves are needed and neither substitutes: a hand-authored
fixture proves the author knows what the spec says, a generated one proves the
recorder does.

## The corpus

| Fixture | Kind | What it is the witness for |
|---|---|---|
| `canonical-core` | hand-authored | Minimal valid v2: keyframe + continuation, dom.*, input, the four oracle checkpoints |
| `jspsych-full` | generated (jsPsych → converter) | A foreign producer's answer: 909 events, canvas region-diffs, RNG, stylesheet events |
| `redacted` | generated (CH, Chromium) | The §8 whole-FILE leak scan; the pin-8 residual boundary; the I2 moved-node vector; the §4 exclusion placeholder; the file-input floor |
| `length-only-clipboard` | generated (CH) | §5.3's length-only producer mode |
| `aborted` | generated (CH) | `end_reason: "aborted"` |
| `truncated` | generated (CH) | §5.7's `recording.capture_stopped` + `truncated` mirror |
| `touch-lifecycle` | generated (CH, touch context) | `touch.*` with §6 alignment blocks, plus `focus`/`blur` |
| `forward-compat` | hand-authored | §11 preservation: unknown fields at every level, unknown event types, a foreign vendor extension, a legal tie |
| `segment-bounds` | hand-authored | The three readings of a segment's origin, and an open segment (`t_end: null`) |
| `negative-*` (15) | hand-authored | One refusal each — see below |
| `warn-missing-advisory` | hand-authored | The tolerant profile's middle outcome: loads, with a warning |

## The expectations format

`expect` describes the TOLERANT LOAD only. Strict conformance is a separate
axis, because §11 makes them independent on purpose.

| Key | When | Meaning |
|---|---|---|
| `expect` | optional, default `"accept"` | `accept` (loads clean) · `warn` (loads, with warnings) · `reject` (never becomes a recording) |
| `reject_stage` + `expect_error` | required iff `expect: "reject"` | Which of `gunzip` / `parse` / `tolerant` refused it, and a substring of the message |
| `expect_warning` | required iff `expect: "warn"` | A substring of a warning that must be present |
| `strict_valid` | required unless the fixture never parses | The strict profile's verdict |
| `strict_errors` | required iff `strict_valid: false` | Substrings every one of which must appear in the error list |
| `invariants` + `expected_failures` | required | Together they must account for EVERY corpus invariant, exactly once |
| `expect_leak` | required iff a PRIVACY invariant is in `expected_failures` | The deliberate-leak declaration; the always-on scan inverts |
| `perf_frame` | required | `absolute` · `relative` · `undiscriminating` — see below |
| `counts` + `spot_checks` | required iff `expect: "accept"` | `events_by_type` is recomputed and deep-equalled |
| `leak_scan` | optional | Whole-file text scan: `absent`, `absent_patterns`, `present`. `present` is mandatory when the block exists |
| `checkpoints` | always (may be `[]`) | Reconstruction oracles; see the provenance rule |

A fixture is refused at the FIRST failing stage and the expectations must name
that stage. A rejection test that passes for the wrong reason is worse than no
test.

## Rules a new corpus entry must satisfy

**Every invariant is accounted for.** `invariants` lists the ones expected to
hold, `expected_failures` maps the ones expected to fail to the substring their
message must contain, and the union must equal the whole table. An opt-in list
would let a new invariant land with nothing enrolled in it. A second test
asserts each invariant has at least one fixture that makes it FAIL — an
invariant nobody has watched fail is a comment.

**Checkpoint provenance is not optional.** Any expectations file carrying a
non-empty `checkpoints` array must state, in `notes.checkpoints`, which OTHER
player agreed with those values first — machine-checked by the runner. CH's
viewer must never be its own conformance definition, and a value read off it is
a fixture defect. canonical-core's four were authored in the fork before CH had
an executor; jspsych-full's ten were authored from the recording's payloads and
executed by the fork before enrollment. The other entries author none, and each
says why in its notes.

**Checkpoints may not sit in a sub-quantum gap.** CH rebases `t` with
`round1(t − origin)` (the wire's own 0.1 ms grid, §7) where the fork compares
raw floats, so between two events closer together than 0.1 ms the two executors
place the same checkpoint on opposite sides. The guard in `checkpoints.test.js`
compares the quantised event prefix against the exact one and fails at authoring
time. Place a checkpoint on an event's own rounded time.

**Do not author checkpoints onto a segment whose origin fields disagree.**
`segment-bounds.json` is the demonstration: CH resolves §3's chain
(`t_load → t_dom_ready → t_start`), the fork's player uses `t_dom_ready` alone
and throws when it or `t_end` is null, and the fork's segment-window bound puts
`t_start` first. Until spec r3 names one rule, a checkpoint there is a bet, not
an oracle.

**Which clock is `ended_at_perf` on?** §7 puts every event `t` on the wire clock
and says nothing about this field, whose §2 type is only `number | null`. CH's
serializer keeps it absolute; jsPsych-v1 states it on the wire clock and the
converter copies that across. Both are strict-valid and a consumer computing a
duration gets two answers, so every expectations file DECLARES its frame and the
`perf_frame` invariant holds the arithmetic to the declaration. A recording whose
perf origin is 0 cannot tell the readings apart and must declare
`undiscriminating` — that value is the finding, not a hedge. **Routed to r3.**

## Regenerating

`tools/gen-schema-v2-fixtures.mjs` cuts the five CH captures by driving the
shipped recorder in headless Chromium. It is NOT deterministic — timestamps, RAF
coalescing and Chromium's MutationRecord batching all move — so re-cut
deliberately and re-author the `counts` block afterwards with
`tools/gen-expectations-counts.mjs`. Pass a fixture name to re-cut just one:
`node tools/gen-schema-v2-fixtures.mjs redacted.json`.

`tools/gen-negative-fixtures.mjs` writes the `negative-*` family and its
expectations twins as pairs. It IS deterministic (no clock, no randomness): re-run
it and `git diff` stays empty unless a defect actually moved. The entries are
hand-authored in the sense the spec means — nothing was recorded — but they are
fifteen near-copies of one base recording, and fifteen separately typed files
drift.

`jspsych-full` is 1.2MB, 460KB of it base64 Open Sans embedded in the recorded
stylesheet, so re-cutting it writes ~1.7MB of compressed permanent history across
three repos (CH's raw capture, this fixture, the fork's copy). Re-cut
deliberately. At a repo boundary (a package lift, or an offer upstream), re-cut
without the `@font-face` blocks (10.6KB of real rules survive) or ship it
gzipped.

## Where the layers divide

`validator.js` walks fields and answers "is each declared thing the type it
says". `corpus-invariants.js` holds what needs a keyframe span's id set, a
comparison between a top-level flag and an event deep inside a segment, or a
claim the expectations file makes about the recording as a whole. Nothing in the
invariants imports the validator: the runner is the oracle's oracle, and a
validator bug must not self-certify. The one deliberate exception is the drift
guard in `corpus-invariants.test.js`, which exists to compare the validator's
`REDACTABLE_TYPES` against the runner's `REDACTED_SHAPES` — two encodings of one
spec sentence that a revision has to move together.

## The one import that is not package-portable

Everything here is repo-independent except `checkpoints.test.js`, which
reconstructs each fixture and reads state off it, and reconstruction needs a
player. That dependency is one import block (`../support/viewer-harness.js`)
carrying three symbols: `boot` (the player binding proper — the fork binds its
own `Player` at the same seam) plus `baseRecording` and `segment`, two v2
recording constructors that one self-test needs because no fixture contains the
shape it checks. On a package lift the checkpoint format, the bounds arithmetic
and the placement guard travel; an adopting implementation re-supplies those
three. Everything else in this directory lifts unchanged.

These files are ESM and currently run as such because CH's root package.json
sets `"type": "module"`. At package-founding time the new package.json must
declare `"type": "module"` itself, or every `import` here breaks on lift.

## Proposed §11 wording, for r3

T7 settled two parked strictness questions with tests. The spec text has not
been touched (r2 is frozen for review); these are the sentences r3 should absorb,
stated here so the decision and its tests sit together:

1. **Tolerant profile, malformed known fields.** After "Everything else loads
   with warnings and documented defaults", add: *"Defaults fill ABSENT fields
   only. A field that is present but malformed is preserved untouched and
   reported as a warning — never coerced: overwriting participant data at load
   time is the loss this profile exists to avoid, and a coerced value would also
   hide the defect from the strict profile that type-checks the tolerant
   profile's output."*
2. **§5.3 clipboard fields.** Add: *"All four fields are stated explicitly on
   every clipboard event; the mode is expressed by which of them are null. An
   absent key is not a length-only record — it is silence, and a player cannot
   distinguish it from a producer bug."* (Risk on record: the corpus has one
   clipboard producer. If a conforming jsPsych content-mode recording omits
   `len`, this flips to fields-if-present.)
