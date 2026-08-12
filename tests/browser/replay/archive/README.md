# `tests/browser/replay/archive/` — retired replay-test assets

Retired-but-kept material from the v1 replay era. Nothing here runs, and
nothing here is deleted: the repo's rule is that superseded code moves to
`archive/` with a note saying where its claims went.

Opened by **T5 (A2) Task 1** (plan
`docs/plans/2026-08-11-t5-a2-viewer-migration-implementation.md`, design §12,
plan-review C-3). **T5 Task 8 added the 0.7.x-era report artifact and its
boot-and-reconstruct check, and CLOSED the window.**

## Contents

| File | What it was | Why it is here |
|---|---|---|
| `cursor-alignment-partA.retired.mjs` | Part A of `cursor-alignment.battery.mjs` — the acceptance battery over a real captured failing session | Calls `buildViewerModel` on a `schema_version: 1` recording and asserts `model.legacy === true`. Task 1 made the model v2-only (spec §11 rejects `schema_version !== 2`) and deleted `legacy`, so part A cannot run. |
| `SMOKE-19NRQR-replay.json` | The CH-v1 recording part A replayed (moved from `../fixtures/`) | Its only in-repo consumers were part A and the Task 0/9 seek-latency harness's v1 control. |
| `v0.7.1-report/` (`index.html` + `replay/SMOKE-19NRQR.replay.js`) | A real report, generated once from the `v0.7.1` tag over `SMOKE-19NRQR-replay.json` | This is *"old artifacts still render"* as an artifact rather than an argument. It inlines its own 0.7.x viewer and its own model, so nothing in the tree can change what it does; the battery's part A′ opens it and asserts that it boots and reconstructs the recorded page. Regeneration recipe below. |

## The declared coverage window — CLOSED at Task 8

`npm run test:browser:alignment` asserted **nothing** between T5 Task 1 and
T5 Task 8. Parts B–E had been dark since T3 (the recorder moved to v2 while
the viewer stayed v1); part A was the one live part, and it died with the v1
model builder. The window was stated here, in the battery's own header, and in
the T5 ledger, in the same way T3 declared its own.

**Task 8 closed it.** The battery now runs part A′ (this report), part P (a
frozen v2 fixture with six literal coordinates) and parts B–E, on chromium by
default and green on all three engines. Zero `⊘` items remain in the file.

What covered this ground meanwhile: capture-side anchors, camera and
redaction variants in `tests/replay/alignment-capture.test.js` and
`tests/replay/capture-trace.test.js`; the whole-capture path in
`tests/browser/replay/capture-fork-smoke.mjs`; and the model-side camera seed,
client-box chain and `foreign` classification in
`tests/replay/alignment-viewer-model.test.js`.

## Where part A's claims went (design §12) — four landed, one gap declared

- *"the cursor lands inside its target across scroll, sidebar squeeze and a
  resize storm"* → the revived part B synthetic grid, with real §6 anchors and
  per-event self-checks. Strictly stronger: part A exercised the **legacy
  no-anchor projection path**, which v2 abolishes. **Landed**: 18 scenarios,
  recorded and replayed inside the engine under test.
- *"240 resize events fold to ≤6 real iframe style writes"* → a
  `viewport_changes` storm case in Task 8's stress battery, same bound.
  **Landed** as part B-storm; the measured fold is 0–2 writes.
- *"old artifacts still render"* → a 0.7.x-era **report** generated once from
  the `v0.7.1` tag, committed here by Task 8 and opened by a Playwright check
  that asserts its viewer boots and reconstructs. That is what an analyst with
  an old report actually does, and it is a truer statement of the claim than
  running the new viewer over an old model. **Landed** as part A′.
- *the eight literal `{trial, tRel, target}` coordinates* → Task 8 commits one
  v2 recording as a frozen fixture and pins at least four literal coordinates
  against it. Parts B–E record fresh each run and assert self-consistency, and
  a self-checking battery cannot catch a drift that moves the drawn dot and
  the target together. **Landed** as part P:
  `../fixtures/alignment-v2-frozen.json` plus **six** pins in the battery's
  `PINS` table, each carrying a literal `{segment, tRel, target}` triple AND
  the literal stage position of the dot and the target rect — so a drift that
  moves both together fails too, which part A's own coordinates could not
  catch. The six span both keyframes of the fixture, and they hold on all three
  engines (which is why the battery page's targets are `box-sizing:
  border-box`: a UA-default `<button>` is a different box per engine, and the
  pins would be measuring the UA stylesheet).

**Two of part A's claims are NOT inherited whole, and the loss is declared
rather than implied** (T5.8 fix round, review M-4):

- *coordinate #2, `trial0 selection end #copy-source`* — a **selection**-
  terminating interaction. There is no selection scenario among the 18. Half of
  what it carried is inherited 54 times over (it was an anchored `mouse.up`,
  and every scenario asserts down/up/click); what is genuinely absent is a
  selection, and adding one means re-recording the frozen fixture and re-reading
  all six pins by hand, which is not a fix-round change. Capture-side selection
  and clipboard behaviour is covered in `tests/replay/capture-trace.test.js`.
- *part A's ninth assertion, a background click with NO element target still
  landing on stage* — **now inherited**, after initially surviving only in part
  D (trace tier, which has no reconstruction and so could not stand in for the
  DOM-tier claim). Part P asserts it against the frozen fixture's un-anchored
  `mouse.move` in segment 9, the segment whose viewport width changed: the dot
  stays inside the stage box and lands at the letterboxed client point with no
  re-projection.

Deliberately **not** done: vendoring frozen 0.7.x copies of `viewer-model.js`
and `replay-viewer.client.js` so part A keeps running. A frozen viewer, a
frozen model builder and a frozen fixture cannot change, so that test could
never fail — it would be ~1.2k lines of duplicate carrying no regression
signal. The committed 0.7.x report is the same frozen viewer as a genuine
artifact.

## Regenerating `v0.7.1-report/`

It is committed output, not a build step: nothing runs this in CI, and the
point of the artifact is that it is frozen. The recipe, for the record:

```sh
mkdir -p /tmp/ch-v071 && git archive v0.7.1 | tar -x -C /tmp/ch-v071
ln -s "$PWD/node_modules" /tmp/ch-v071/node_modules      # 0.7.1's deps are a subset
#  then write, into /tmp/ch-v071-data/:
#    SMOKE-19NRQR.json                     Shape-1 participant file whose trials
#                                          carry integrityReplayMeta.saved_to
#    SMOKE-19NRQR-replay-<startEpochMs>.json   this directory's fixture, verbatim
#                                          (epoch = Date.parse(metadata.start_time))
node /tmp/ch-v071/bin/cyborg-hunter.js report \
  --data /tmp/ch-v071-data --output /tmp/ch-v071-report --no-visuals
cp /tmp/ch-v071-report/index.html                    v0.7.1-report/
cp /tmp/ch-v071-report/replay/SMOKE-19NRQR.replay.js v0.7.1-report/replay/
```

## Replaying v1 recordings

There is no CH-v1 playback path and no v1→v2 converter (T5 non-goals). To play
`SMOKE-19NRQR-replay.json` as it originally played, check out the **`v0.7.1`**
tag. Reports already generated on disk are unaffected by any of this: a CH
report inlines its own viewer copy and its own models.
