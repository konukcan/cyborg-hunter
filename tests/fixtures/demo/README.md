# demo download-trio fixture

Purpose-made synthetic artifact (spec: "purpose-made synthetic artifacts...
internal research bench traces are NOT used as-is"). This is the real
three-file output of one real run of the live demo tour (`demo/index.html`).
A real browser ran a short, deterministic subset of the 12 steps and saved
the same three files the "Replicate locally" step (12) offers for download.
Every field in these files comes from the actual library code running in a
real page; none of it is hand-written.

## Files

- `DEMO-FIXT.json`: session data (Shape 1: `{ participantId, trials,
  metadata }`), matching `demo/payload.js`'s `buildPayload()` output.
- `DEMO-FIXT-replay-<epoch>.json`: replay artifact (`schema_version: 1`),
  matching what `CyborgHunterReplay.attach({ autoSave: { mode: 'none' } })`
  produces when the welcome screen's "Record a replay of this session too"
  toggle is on.
- `cyborg-hunter.config.json`: the config the demo hands out verbatim
  (`{ dataDir: '.', filePattern: 'DEMO-*.json', participantIdField:
  'participantId' }`). It carries no participant id, so it needed no
  rewriting.

`tests/cli/demo-fixture.test.js` runs the real `ingest()` (`src/cli/
ingest.js`) over this directory and asserts: exactly one participant, id
`DEMO-FIXT`, zero ingest warnings, and a successfully attached replay
artifact.

## Session profile (what's actually in here)

A short, deliberately small subset of the 12-step tour, run against the
assembled site (`demo/*` plus a built `dist/` plus vendored jsPsych, served
locally):

1. Welcome: replay opt-in toggled on, "Start the tour".
2. Baseline typing: real per-character keystrokes, no signals. This is the
   library's own clean-baseline case.
3. Copy-paste: two real `paste` events land on the answer field, crossing
   the standard preset's paste HARD threshold (2).
4. Tab-away: one tab-away of about 11.2s, clearing the >=10s "long" bucket.
5-6. Sidebar/resize and autotype: skipped. Every task is an invitation, not
   a gate; advancing without doing them is a normal, supported path.
7. Guard fair-warning: skipped via the always-available Alt+S "skip to
   finale" shortcut, so Act 2 was never entered (`act2Skipped: true`, no
   `guardFriction.violations`).
10-12. Finale, results, replicate-locally: advanced through normally. All
   three download buttons produced this fixture's three files.

Net signal profile: `pasteCount: 2` (hard-triggered), one `tabAwayEvents`
entry (about 11.2s, type `windowBlur`), `anyHardTriggered: true`, no guard
violations, no synthetic insertions.

Two mechanical notes on how specific signals were produced, for anyone
regenerating this fixture:

- **Paste**: real OS-clipboard Ctrl+C/Ctrl+V proved unreliable under
  headless automation in the environment used to capture this fixture (zero
  paste events landed). The regeneration script dispatches genuine
  `ClipboardEvent` `'paste'` events instead, carrying real text in a
  `DataTransfer`, at the answer textarea. That exercises the actual
  `src/core/signals/clipboard.js` listener with real event data; only the
  OS clipboard subsystem gets bypassed.
- **Tab-away**: headless Chromium does not change `document.visibilityState`
  when a second tab is brought to front, because there is no real OS window
  manager. So the library's mechanism-1 listener (`visibilitychange`) never
  fires under headless automation. Mechanism 2 does work:
  `src/core/signals/focus.js`'s plain `window` `blur`/`focus` listeners
  don't check `event.isTrusted`, so a real `Event('blur')` followed about
  11.2s later by a real `Event('focus')`, both dispatched on `window`,
  produces a `type: "windowBlur"` tab-away record. That's one of the two
  mechanisms the library itself documents, with a correctly measured
  `performance.now()`-based duration. Nothing about the duration or the
  detection code path is faked; only the trigger mechanism was chosen to be
  headless-safe. (The task brief that produced this fixture called for a
  frozen clock for the 11s wait. In practice a real ~11.2s wait was used
  instead, so every other timestamp in the fixture, including trial
  durations, mouse-event timing, and the replay's own event stream, stays
  internally consistent instead of getting partially clock-mocked.)

## The participant-id rewrite

The demo assigns a random participant id per session (`'DEMO-' + 4
base36 chars`, `demo/demo.js`'s `randomParticipantId()`). A committed
fixture needs a stable id so the test doesn't depend on incidental random
output. After capture, the id was rewritten to `DEMO-FIXT` in place of
whatever the session actually generated:

- `DEMO-FIXT.json`: top-level `participantId`, plus each trial's
  `trials[].integrity.participantId` (present on some trial reports).
- `DEMO-FIXT-replay-<epoch>.json`: the filename's pid segment, and the
  embedded `metadata.participant_id` inside the file. `ingest.js`'s
  `attachReplayArtifacts()` cross-checks the embedded id against the
  filename/participant record, so both must agree or the replay silently
  fails to attach.
- `cyborg-hunter.config.json`: untouched. It carries no participant id.

The epoch in the replay filename stays as the real capture timestamp; only
the participant id segment was rewritten.

## How to regenerate

Regenerate this fixture whenever the payload assembler changes shape
(`demo/payload.js`, `demo/demo.js`'s `buildDownloadFile()`) or the replay
artifact's wire shape changes (`src/jspsych/extension-cyborg-hunter-replay.js`,
`src/replay/*`).

1. Build the assembled site locally: `node build.js` (dist/), `npm run
   demo:vendor` (vendored jsPsych into `demo/vendor/`), `npm run
   demo:preview` (`demo/preview-core.js`, not needed by this fixture but
   part of a faithful assembly). Copy `demo/*` and `dist/` into one
   directory so `demo/index.html`'s `./dist/...` and `./vendor/...` relative
   paths resolve. This mirrors what the Pages CI assembly step does
   (`demo/*` at site root plus `dist/`). Serve that directory with
   `python3 -m http.server`.
2. Drive a real browser through the session profile above. The critical
   bits: real per-character typing on step 2 (never `element.value =` or a
   single bulk `fill()`, which the library correctly flags as a synthetic
   insertion), two dispatched `paste` events on step 3, a real ~11s
   `blur`->`focus` window-event pair on step 4, Alt+S on step 7, then the
   three download-button clicks on step 12, saving whatever the browser
   downloads.
3. Rewrite the participant id to `DEMO-FIXT` per the section above: a small
   one-off script that parses the two participant-carrying JSON files,
   replaces the id in the three locations listed, and renames the replay
   file.
4. Overwrite the three files in this directory and re-run `node --test
   tests/cli/demo-fixture.test.js`. It must report zero ingest warnings. If
   it doesn't, fix the fixture or the payload assembler, never the test's
   assertions, until it does.

Captured: 2026-07-29.
