# `tests/browser/replay/archive/` — retired replay-test assets

Retired-but-kept material from the v1 replay era. Nothing here runs, and
nothing here is deleted: the repo's rule is that superseded code moves to
`archive/` with a note saying where its claims went.

Opened by **T5 (A2) Task 1** (plan
`docs/plans/2026-08-11-t5-a2-viewer-migration-implementation.md`, design §12,
plan-review C-3). Task 8 adds the 0.7.x-era report artifact and its
boot-and-reconstruct check here.

## Contents

| File | What it was | Why it is here |
|---|---|---|
| `cursor-alignment-partA.retired.mjs` | Part A of `cursor-alignment.battery.mjs` — the acceptance battery over a real captured failing session | Calls `buildViewerModel` on a `schema_version: 1` recording and asserts `model.legacy === true`. Task 1 made the model v2-only (spec §11 rejects `schema_version !== 2`) and deleted `legacy`, so part A cannot run. |
| `SMOKE-19NRQR-replay.json` | The CH-v1 recording part A replayed (moved from `../fixtures/`) | Its only in-repo consumers were part A and the Task 0/9 seek-latency harness's v1 control. |

## The declared coverage window

`npm run test:browser:alignment` asserts **nothing** between T5 Task 1 and
T5 Task 8. Parts B–E have been dark since T3 (the recorder moved to v2 while
the viewer stayed v1); part A was the one live part, and it dies with the v1
model builder. The window is stated here, in the battery's own header, and in
the T5 ledger, in the same way T3 declared its own.

What still covers this ground meanwhile: capture-side anchors, camera and
redaction variants in `tests/replay/alignment-capture.test.js` and
`tests/replay/capture-trace.test.js`; the whole-capture path in
`tests/browser/replay/capture-fork-smoke.mjs`; and the model-side camera seed,
client-box chain and `foreign` classification in
`tests/replay/alignment-viewer-model.test.js`.

## Where part A's claims went (design §12)

- *"the cursor lands inside its target across scroll, sidebar squeeze and a
  resize storm"* → the revived part B synthetic grid, with real §6 anchors and
  per-event self-checks. Strictly stronger: part A exercised the **legacy
  no-anchor projection path**, which v2 abolishes.
- *"240 resize events fold to ≤6 real iframe style writes"* → a
  `viewport_changes` storm case in Task 8's stress battery, same bound.
- *"old artifacts still render"* → a 0.7.x-era **report** generated once from
  the `v0.7.1` tag, committed here by Task 8 and opened by a Playwright check
  that asserts its viewer boots and reconstructs. That is what an analyst with
  an old report actually does, and it is a truer statement of the claim than
  running the new viewer over an old model.
- *the eight literal `{trial, tRel, target}` coordinates* → Task 8 commits one
  v2 recording as a frozen fixture and pins at least four literal coordinates
  against it. Parts B–E record fresh each run and assert self-consistency, and
  a self-checking battery cannot catch a drift that moves the drawn dot and
  the target together.

Deliberately **not** done: vendoring frozen 0.7.x copies of `viewer-model.js`
and `replay-viewer.client.js` so part A keeps running. A frozen viewer, a
frozen model builder and a frozen fixture cannot change, so that test could
never fail — it would be ~1.2k lines of duplicate carrying no regression
signal. The committed 0.7.x report is the same frozen viewer as a genuine
artifact.

## Replaying v1 recordings

There is no CH-v1 playback path and no v1→v2 converter (T5 non-goals). To play
`SMOKE-19NRQR-replay.json` as it originally played, check out the **`v0.7.1`**
tag. Reports already generated on disk are unaffected by any of this: a CH
report inlines its own viewer copy and its own models.
