# demo download-trio fixture

Purpose-made synthetic artifact (spec: "purpose-made synthetic artifacts...
internal research bench traces are NOT used as-is"). The three files are the
output of the live demo tour (`demo/index.html`): the same three files the
"Replicate locally" step offers for download. Every field comes from the actual
library code running in a real page; none of it is hand-written. Only identity
fields are rewritten after capture (see "The participant-id rewrite").

`tests/cli/demo-fixture.test.js` runs the real `ingest()` (`src/cli/
ingest.js`) over this directory and asserts: exactly one participant, id
`DEMO-FIXT`, **zero** ingest warnings, and a successfully attached v2 replay
artifact.

Two files are frozen and one is regenerable:

- **`DEMO-FIXT.json` (session) and `cyborg-hunter.config.json` are FROZEN.**
  `tests/cli/plot-cores.test.js` and `tests/cli/html-index-snapshot.test.js`
  bake this exact session's trial ids, counts, timings, and window geometry into
  hand-derived assertions and committed draw snapshots. These files carry no
  `schema_version` and are unaffected by the replay wire migration, so they stay
  as first captured (2026-07-29). Changing them means rewriting those tests.
- **`DEMO-FIXT-replay-<epoch>.json` (replay) is regenerable** via
  `tools/gen-demo-fixture.mjs` (see "How to regenerate"). Regenerated 2026-08-12
  for A6 (jsPsych harmonization Phase A): the recorder now serializes
  SessionRecording **v2**, so the artifact is `schema_version: 2` rather than the
  pre-A6 v1 — which is what took the demo-fixture ingest version-warning to zero.

## Files

- `DEMO-FIXT.json`: session data (Shape 1: `{ participantId, trials,
  metadata }`), matching `demo/payload.js`'s `buildPayload()` output.
- `DEMO-FIXT-replay-<epoch>.json`: replay artifact (`schema_version: 2`, DOM
  tier), matching what `CyborgHunterReplay.attach({ tier: 'dom' })` serializes.
  v2 carries the id at the top level (`participant_id`), not under `metadata.*`.
- `cyborg-hunter.config.json`: the config the demo hands out verbatim
  (`{ dataDir, filePattern, participantIdField }`). It carries no participant id.

The replay and the session are NOT a 1:1 trial mapping — the recorder and the
integrity monitor bracket trials under different schemes, so the replay (8
segments: the five act-1 tasks, the two act-2 steps, and a trailing implicit
`__session__`) does not line up trial-for-trial with the session's six. `ingest`
attaches the replay by `participant_id` alone, which is all the fixture relies
on.

## Session profile (frozen — what's in DEMO-FIXT.json)

A short, deliberately small subset of the tour, run against the assembled site.
Net signal profile: `pasteCount: 2` (hard-triggered), one `tabAwayEvents` entry
(~11.2s, type `windowBlur`, `tabAwaySums: [11202]`), `anyHardTriggered: true`,
no guard violations, no synthetic insertions. Six trials: `act1-baseline`,
`act1-paste`, `act1-tabaway`, `act1-sidebar`, `act1-autotype`,
`act2-fullscreen-entry`.

Two mechanical notes on how specific signals were produced, for anyone
regenerating the session (a much larger job — the frozen tests above depend on
these exact numbers):

- **Paste**: real OS-clipboard Ctrl+C/Ctrl+V is unreliable under headless
  automation. A genuine `ClipboardEvent` `'paste'` carrying real text in a
  `DataTransfer` is dispatched at the answer textarea instead, exercising the
  actual `src/core/signals/clipboard.js` listener; only the OS clipboard
  subsystem is bypassed.
- **Tab-away**: headless Chromium does not change `document.visibilityState`, so
  mechanism 1 (`visibilitychange`) never fires. Mechanism 2 does: a real
  `Event('blur')` followed ~11.2s later by a real `Event('focus')` on `window`
  produces a `type: "windowBlur"` tab-away with a correctly measured
  `performance.now()` duration. Only the trigger mechanism is chosen to be
  headless-safe; the detection code path and duration are real.

## The participant-id rewrite

The demo assigns a random participant id per session (`'DEMO-' + 4 base36
chars`, `demo/demo.js`'s `randomParticipantId()`). A committed fixture needs a
stable id, so every occurrence of the captured id is replaced with `DEMO-FIXT`.

For the replay, `gen-demo-fixture.mjs` does this automatically: a whole-file
string swap of the full `DEMO-xxxx` token (distinctive enough that collisions
are impossible) covers the top-level `participant_id` and the pid text the
topbar renders into each segment's DOM snapshot. `ingest.js`'s
`attachReplayArtifacts()` cross-checks the embedded `participant_id` against the
filename/participant record, so those must agree or the replay silently fails to
attach; the generator asserts the old id appears nowhere before writing.

For the frozen session file, the id was rewritten once at capture in three
places: top-level `participantId`, each trial's `trials[].integrity.
participantId`, and the nested `metadata.integritySession.config.participantId`
(the monitor echoes its init config into the session report). The config file
carries no id.

## Pinned replay epoch

`recording_started_at` (the replay's wall-clock anchor) is pinned to the
existing filename epoch `1785352263344`, so the artifact overwrites in place
under the same name each run instead of churning to a fresh epoch. Only the
anchor is pinned; the recording's relative event timeline (perf-now offsets,
segment origins, durations) is the untouched real capture, so playback is
exactly what the recorder produced. This mirrors the fixed-`EPOCH` discipline in
`tools/gen-example-fixtures.mjs`.

## How to regenerate

Regenerate the **replay artifact** whenever the replay wire shape changes
(`src/replay/*`, the jsPsych replay extension) or the demo's replay download
seam changes (`demo/demo.js`'s `buildDownloadFile()`):

```
node tools/gen-demo-fixture.mjs
node --test tests/cli/demo-fixture.test.js   # must report zero ingest warnings
```

`gen-demo-fixture.mjs` assembles `.demo-site/` (the same artifact Pages CI and
the Playwright suite use), serves it, walks the full tour, captures the replay
download, rewrites the pid, pins the epoch, and overwrites the replay file here.
It leaves the session and config frozen. It uses `playwright-core` (resolved
from openclaw when the repo has no local install), the same direct-drive pattern
as `tests/browser/replay/e2e-dogfood.mjs`.

Regenerating the **session file** is out of scope for that tool and is a larger
job: `plot-cores.test.js` and `html-index-snapshot.test.js` would have to be
rewritten to the new capture's numbers. If the payload assembler
(`demo/payload.js`) changes shape, do that deliberately, never by editing the
tests' assertions to fit a broken fixture.

First captured 2026-07-29 (session + v1 replay); replay regenerated 2026-08-12
(v2, A6).
