# schema-v2 — SessionRecording v2 validator + conformance fixtures

Package-shaped: this directory is the future shared schema package's root
(spec: docs/plans/2026-08-09-session-recording-v2-spec-draft.md, r2). It
imports nothing from the rest of the repo and lifts wholesale at
package-founding time. Until then, CH's CI runs it via `npm run test:schema`.

Layout: validator.js (dual profiles, spec §11) · fixtures/ (conformance
corpus) · expectations/ (per-fixture assertions) · conformance.test.js
(runner). Hand-authored canonical fixtures are the consumer contract;
generated producer recordings arrive in later tasks (T4, T7).
