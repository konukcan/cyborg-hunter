// tests/browser/replay/archive/cursor-alignment-partA.retired.mjs
//
// RETIRED — NOT EXECUTABLE. Kept verbatim as the record of what part A of
// `cursor-alignment.battery.mjs` asserted, and as the source of the eight
// literal `{trial, tRel, target}` coordinates Task 8 re-pins against a v2
// recording. Moved here by T5 (A2) Task 1, in the same commit that made
// `buildViewerModel` v2-only.
//
// WHY IT CANNOT RUN. Part A calls `buildViewerModel` on
// `SMOKE-19NRQR-replay.json`, a `schema_version: 1` recording, and asserts
// `fixtureModel.legacy === true`. The v2 model builder rejects
// `schema_version !== 2` under the spec §11 tolerant profile and has no
// `legacy` key: there is no CH-v1 playback path and no v1→v2 converter
// (design §12, plan non-goals). Three of part A's 13 assertions cover
// machinery Task 1 deletes (`legacy`, the per-trial folded `view_state` seed,
// the legacy banner) and cannot survive by construction. It also depends on
// the battery's `harnessHtml()` / `openHarness()` / `check()` helpers, which
// stay in the live battery for parts B–E; they are deliberately NOT vendored
// here (a frozen viewer + frozen model builder + frozen fixture cannot
// change, so the test could never fail — see the adjudication in design §12).
//
// WHERE ITS CLAIMS WENT (design §12):
//   • "the cursor lands inside its target across scroll, sidebar squeeze and
//     a resize storm" → the revived part B synthetic grid, with REAL §6
//     anchors and per-event self-checks. Strictly stronger: part A tested the
//     legacy no-anchor projection path, which v2 abolishes.
//   • "240 resize events fold to ≤6 real iframe style writes" → a
//     `viewport_changes` storm case in the Task 8 stress battery, same bound.
//   • "old artifacts still render" → a 0.7.x-era REPORT generated from the
//     `v0.7.1` tag, committed in this directory by Task 8 with a
//     boot-and-reconstruct check. That is what an analyst with an old report
//     actually does.
//   • the eight literal coordinates below → Task 8 commits one v2 recording
//     as a frozen fixture and pins at least four literal coordinates against
//     it, so the battery keeps a non-self-referential anchor (a self-checking
//     battery cannot catch a drift that moves the drawn dot and the target
//     together).
//
// The fixture it reads now sits beside this file as
// `./SMOKE-19NRQR-replay.json`; the `join(here, 'fixtures', …)` path below is
// preserved verbatim, as it stood in the battery.
//
// To replay the fixture as it originally played, check out the `v0.7.1` tag.

// ════════════════ PART A — acceptance fixture (legacy path) ════════════════
console.log('▶ A — acceptance: the user\'s own failing recording (legacy path)');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'SMOKE-19NRQR-replay.json'), 'utf8'));
const fixtureModel = buildViewerModel(fixture);
check(fixtureModel.legacy === true, 'fixture is a legacy recording (no view_state)');
const t2cam = fixtureModel.trials[2].camera;
check(t2cam.y === 176 && t2cam.w === 1424,
  `trial-2 camera seed folded across trials (y=${t2cam.y}, w=${t2cam.w})`);

{
  const page = await openHarness(browser, fixtureModel, 'fixture');
  const chips = await page.evaluate(() => window.__chips());
  check(!!chips.legacy && /legacy/i.test(chips.legacy), 'legacy banner is shown unconditionally');

  // Every interaction the user KNOWS they made (smoke-test script), incl.
  // the trial-boundary click artifacts and the Finish mousedown that the old
  // bubble-phase capture used to lose.
  const SPECS = [
    { trial: 0, tRel: 1,     target: 'btn-start',   label: 'trial0 click #btn-start' },
    { trial: 0, tRel: 4165,  target: 'copy-source', label: 'trial0 selection end #copy-source' },
    { trial: 0, tRel: 5426,  target: 'answer-1',    label: 'trial0 click #answer-1' },
    { trial: 0, tRel: 7616,  target: 'btn-next-1',  label: 'trial0 mousedown #btn-next-1' },
    { trial: 1, tRel: 1,     target: 'btn-next-1',  label: 'trial1 boundary click #btn-next-1' },
    { trial: 1, tRel: 13485, target: 'btn-next-2',  label: 'trial1 mousedown #btn-next-2 (scrolled 176)' },
    { trial: 2, tRel: 1,     target: 'btn-next-2',  label: 'trial2 boundary click #btn-next-2 (seeded scroll)' },
    { trial: 2, tRel: 16806, target: 'btn-finish',  label: 'trial2 mousedown #btn-finish (post-squeeze, scrolled)' },
  ];
  let curTrial = -1;
  for (const s of SPECS) {
    if (s.trial !== curTrial) { await selectTrial(page, s.trial); curTrial = s.trial; }
    const m = await page.evaluate(({ tRel, target }) => window.__measure(tRel, target), s);
    check(dotInTarget(m), `${s.label}: cursor inside target ` +
      (m.dot && m.target ? `(dot ${Math.round(m.dot.x)},${Math.round(m.dot.y)} target ${Math.round(m.target.x)},${Math.round(m.target.y)} ${Math.round(m.target.w)}×${Math.round(m.target.h)})` : '(missing)'));
  }
  // The background click during the squeeze storm: no element target, but it
  // must land ON-stage now (it used to project off-stage entirely).
  if (curTrial !== 2) { await selectTrial(page, 2); curTrial = 2; }
  const bg = await page.evaluate(() => window.__measure(6771, null));
  check(bg.dot && bg.dot.x >= 0 && bg.dot.x <= bg.stage.w && bg.dot.y >= 0 && bg.dot.y <= bg.stage.h,
    `trial2 background click stays on-stage (dot ${bg.dot ? Math.round(bg.dot.x) + ',' + Math.round(bg.dot.y) : 'none'} in ${bg.stage.w}×${bg.stage.h})`);

  // Resize-storm thrash bound: replaying across 240 resize events must fold
  // to a handful of REAL iframe style writes, not hundreds.
  const styleWrites = await page.evaluate(async () => {
    const dbg = window.__dbg();
    dbg.selectTrial(2);
    await new Promise(r => setTimeout(r, 400));
    const f = document.querySelector('.replay-frame');
    let count = 0;
    const mo = new MutationObserver(muts => {
      muts.forEach(m => { if (m.attributeName === 'style') count++; });
    });
    mo.observe(f, { attributes: true });
    dbg.seek(30000);   // one forward seek across the whole storm
    await new Promise(r => setTimeout(r, 100));
    mo.disconnect();
    return count;
  });
  check(styleWrites <= 6, `resize storm folded (${styleWrites} iframe style writes for 240 resize events)`);
  await page.close();
}

