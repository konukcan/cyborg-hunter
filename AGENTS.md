# AGENTS.md

Orientation for coding agents working in this repository.

**What this is:** cyborg-hunter detects AI-tool use during browser-based behavioral experiments. Two halves: a browser-side signal-collection library with optional deterrence and session-replay extensions (`src/core/`, `src/jspsych/`, `src/replay/`), and a Node CLI that turns saved participant files into a triage report (`src/cli/`, `bin/cyborg-hunter.js`).

## Layout

- `src/core/` — signal-collection library (the monitor)
- `src/jspsych/` — jsPsych extension adapters, one per concern
- `src/replay/` — session-replay recorder (capture, serialization, autosave)
- `src/cli/` — ingest → analyzers → renderers pipeline; `bin/cyborg-hunter.js` is the entry point
- `dist/` — built artifacts, produced by `node build.js`. Edit `src/`, never `dist/`.
- `tests/` — `node --test` suites per half, plus browser-run suites under `tests/browser/`
- `examples/synthetic-pilot/` — fully synthetic three-participant dataset; regenerate with its `generate-fixture.mjs`
- `docs/` — user documentation; `quickstart.md` and `worked-example.md` are the entry points

## Commands

- `npm test` — full Node suite (core, replay, cli, jspsych)
- `npm run test:cli` / `test:core` / `test:replay` / `test:jspsych` — one suite
- `node build.js` — rebuild `dist/`
- `node bin/cyborg-hunter.js report` — run the CLI from a clone (no global install)
- `scripts/check-public-hygiene.sh` — must pass before anything is published

## Invariants

- A golden regression suite freezes the ingest → summary → triage pipeline output. A change that alters counts, scores, or tiers on existing data is a versioned behavioral change, not a silent fix — see the deferred items in `docs/known-issues.md` for how those are handled.
- The CLI degrades on malformed participant payloads: warn and continue, never crash the whole report.
- No real participant data anywhere in the tree. Examples and test fixtures are synthetic by construction; keep it that way.
- Docs are written descriptively about the package, not in second person.
