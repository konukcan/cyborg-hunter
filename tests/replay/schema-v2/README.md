# schema-v2 — SessionRecording v2 validator + conformance fixtures

Package-shaped: this directory is the future shared schema package's root
(spec: docs/plans/2026-08-09-session-recording-v2-spec-draft.md, r2). Until
then, CH's CI runs it via `npm run test:schema`.

Layout: validator.js (dual profiles, spec §11) · fixtures/ (conformance
corpus) · expectations/ (per-fixture assertions) · conformance.test.js
(wire-level runner) · checkpoints.test.js (reconstruction-level runner).
Hand-authored canonical fixtures are the consumer contract (canonical-core);
producer recordings answer it (jspsych-full, a real jsPsych recording converted
by tools/convert/jspsych-v1-to-v2.mjs — T4; more in T7).

ONE FILE IMPORTS CH, AND IT HAS TO. Everything here is repo-independent except
`checkpoints.test.js`, which reconstructs each fixture and reads state off it,
and reconstruction needs a player. Its player binding is one import block at the
top of the file (`../support/viewer-harness.js` → the shipped report viewer).
On a package lift the checkpoint format, the bounds arithmetic and the
placement guard travel; each implementation re-supplies that block, exactly as
the fork does in its own copy of the same contract. Everything else in this
directory still lifts unchanged.

Checkpoint provenance is not optional. Any expectations file carrying a
non-empty `checkpoints` array must state, in `notes.checkpoints`, which OTHER
player agreed with those values first — machine-checked by the runner. CH's
viewer must never be its own conformance definition, and a value read off it is
a fixture defect. canonical-core's four were authored in the fork before CH had
an executor; jspsych-full's ten were authored from the recording's payloads and
executed by the fork before enrollment.

jspsych-full is 1.2MB, 460KB of it base64 Open Sans embedded in the recorded
stylesheet, so re-cutting it writes ~1.7MB of compressed permanent history
across three repos (CH's raw capture, this fixture, the fork's copy). Re-cut
deliberately. At a repo boundary (a package lift, or an offer upstream), re-cut
without the `@font-face` blocks (10.6KB of real rules survive) or ship it
gzipped.

Every expectations file states `counts.events_by_type`, and the runner
recomputes it. `tools/gen-expectations-counts.mjs` computes the block for a new
fixture; it is an authoring convenience outside this directory, imported by
nothing here, and a package lift should take it along rather than leave the
next corpus author counting 909 events by hand.

These files are ESM and currently run as such because CH's root package.json
sets `"type": "module"`. At package-founding time the new package.json must
declare `"type": "module"` itself, or every `import` here breaks on lift.
