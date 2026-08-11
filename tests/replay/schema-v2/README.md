# schema-v2 — SessionRecording v2 validator + conformance fixtures

Package-shaped: this directory is the future shared schema package's root
(spec: docs/plans/2026-08-09-session-recording-v2-spec-draft.md, r2). It
imports nothing from the rest of the repo and lifts wholesale at
package-founding time. Until then, CH's CI runs it via `npm run test:schema`.

Layout: validator.js (dual profiles, spec §11) · fixtures/ (conformance
corpus) · expectations/ (per-fixture assertions) · conformance.test.js
(runner). Hand-authored canonical fixtures are the consumer contract
(canonical-core); producer recordings answer it (jspsych-full, a real jsPsych
recording converted by tools/convert/jspsych-v1-to-v2.mjs — T4; more in T7).

Every expectations file states `counts.events_by_type`, and the runner
recomputes it. `tools/gen-expectations-counts.mjs` computes the block for a new
fixture; it is an authoring convenience outside this directory, imported by
nothing here, and a package lift should take it along rather than leave the
next corpus author counting 909 events by hand.

These files are ESM and currently run as such because CH's root package.json
sets `"type": "module"`. At package-founding time the new package.json must
declare `"type": "module"` itself, or every `import` here breaks on lift.
