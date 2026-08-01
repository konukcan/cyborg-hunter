// demo/tests/tour.spec.js
// Playwright E2E suite for the live demo tour (13-step remodel — spec:
// docs/superpowers/specs/2026-07-31-ch-demo-remodel-design.md; plan:
// docs/superpowers/plans/2026-07-31-ch-demo-remodel.md, Task D1).
// Runs against the ASSEMBLED site (.demo-site/, see playwright.config.js +
// tools/assemble-demo-site.mjs) so demo/index.html's ./dist/... relative
// paths resolve the same way they do on Pages.
//
// Every test asserts zero accumulated pageerrors via the auto `pageErrors`
// fixture (helpers.mjs). frozenClock/fullscreenMock are also auto-fixtures,
// inert until a test explicitly calls into them.
//
// Two behaviors below were established by DRIVING THE LIVE PAGE during D1,
// not by reading the copy/plan alone — see the inline comments at each site:
//   1. A synthetic 'blur' Event does NOT trigger a GuardFriction violation
//      (its check() reads real document.hasFocus(), unaffected by a
//      synthetic dispatch) — the guard-cheat test uses fullscreenMock.exit()
//      instead, the same mechanism the guard entry race already relies on.
//   2. GuardFriction's violation overlay (#guard-friction-overlay) is a
//      full-viewport curtain at int-max z-index that pointer-intercepts
//      everything beneath it — which originally trapped the in-card
//      .endguard button behind the overlay's resume flow. The demo now
//      counters this (spec §6 step 9's no-trap guarantee) by lifting the
//      button above the overlay while a violation is active (demo.js's
//      floatEndGuard). The happy path clicks .endguard DURING the active
//      violation — no resume first — and a dedicated test covers the
//      resume-then-click route (including that the unfloat restore doesn't
//      double-fire the advance).

import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  test, expect,
  dispatchPaste, dispatchCopy, dispatchDevToolsShortcut, typeRealistically,
  startTour, waitForLamp,
  installFailingFullscreenMock, installBlobCounter,
  primaryButton, backButton, railRow, pid, resultsFrame,
} from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, '..', '..', 'bin', 'cyborg-hunter.js');
const ANSWER = 'Canberra';
const AUTOTYPE_TEXT = 'No one is typing this. It is being inserted.';

// Waits for the playground's status line to show a FRESH "rebuilt in …ms"
// message — i.e. one that's different from whatever it said before this
// call. Necessary because two rebuilds in a row can both land on "rebuilt in
// N ms" text: a bare /rebuilt in/ match can resolve against the PRIOR
// rebuild's leftover text before the new (debounced, ~250ms) one has even
// started — found by driving the live page with two sequential control
// changes in one test.
async function waitForFreshRebuild(page, prevText) {
  await page.waitForFunction((prev) => {
    const el = document.querySelector('[data-role="pg-status"]');
    const t = (el && el.textContent) || '';
    return /rebuilt in/.test(t) && t !== prev;
  }, prevText, { timeout: 5000 });
}

// Baseline (step 2, typed) + two dispatched pastes of ANSWER (step 3, hard-
// lights paste) + an immediate, violation-free pass through the guarded act
// (skip link -> enter fullscreen -> end guard right away) -> signals-to-
// scores -> results. Empirically verified (by driving the live page) to
// give the visitor a HARD tier, all three plot images, and a mountable
// replay — the minimal session shape the Results/Playground tests need.
async function reachResultsWithSignals(page) {
  await startTour(page); // -> baseline (step 2)
  await typeRealistically(page.locator('#card textarea'), 'a city in Australia');
  await primaryButton(page).click(); // -> clipboard-cheat (step 3)
  await dispatchPaste(page, '#card textarea', ANSWER);
  await dispatchPaste(page, '#card textarea', ANSWER);
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry (step 8)
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13', { timeout: 5000 });
  await page.locator('.endguard').click(); // -> guard-debrief (step 10)
  await primaryButton(page).click(); // -> signals-to-scores (step 11)
  await primaryButton(page).click(); // -> results (step 12)
  await page.locator('.yourreport h3').waitFor({ timeout: 8000 });
}

// ---------------------------------------------------------------------------
// 1. Happy path: all 13 steps in order
// ---------------------------------------------------------------------------
test('happy path: all 13 steps, welcome through replicate-locally', async ({ page, frozenClock, fullscreenMock }) => {
  test.setTimeout(90000);

  // ----- Step 1: intro -----
  await startTour(page); // lands on step 2 (baseline)
  const participantId = await pid(page);
  expect(participantId).toMatch(/^DEMO-/);

  // ----- Step 2: baseline typing (real per-char typing lights nothing) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 2 of 13');
  await expect(page.locator('#rail .check')).toHaveClass(/awaiting/); // still inert
  await typeRealistically(page.locator('#card textarea'), 'a city in Australia');
  await expect(page.locator('#rail .check')).toHaveClass(/awaiting/); // still inert after typing
  await primaryButton(page).click();

  // ----- Step 3: clipboard cheat (copy the question, paste the answer x2) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 3 of 13');
  await dispatchCopy(page);
  await dispatchPaste(page, '#card textarea', ANSWER);
  await expect(railRow(page, 'paste')).toHaveClass(/lit/);
  await expect(railRow(page, 'paste')).not.toHaveClass(/hardlit/); // 1st paste: below the hard threshold (2)
  await dispatchPaste(page, '#card textarea', ANSWER);
  await expect(railRow(page, 'paste')).toHaveClass(/hardlit/); // 2nd paste crosses it
  await expect(railRow(page, 'paste').locator('.n')).toHaveText('2');
  // Only the paste that CROSSES the hard threshold is flagged hard in the
  // live pane (verified live: the 1st paste's row has no .hard class, since
  // its own count (1) is below the threshold at the moment it's logged) —
  // both paste rows carry the pasted text regardless.
  const pasteRows = page.locator('.lp-row', { has: page.locator('.lp-event', { hasText: 'paste' }) });
  await expect(pasteRows).toHaveCount(2);
  await expect(pasteRows.nth(0)).toContainText(ANSWER);
  await expect(pasteRows.nth(1)).toContainText(ANSWER);
  await expect(page.locator('.lp-row.hard')).toHaveCount(1);
  await expect(page.locator('.lp-row.hard')).toContainText(ANSWER);
  await primaryButton(page).click();

  // ----- Step 4: tab-away, three bins (frozen clock for exact durations) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 4 of 13');
  await frozenClock.tabAway(0, 2000);      // flicker: <=3000ms
  await frozenClock.tabAway(20000, 6000);  // mid: >3000ms, <10000ms
  await frozenClock.tabAway(40000, 12000); // long: >=10000ms
  // Freezing performance.now() never unfreezes itself — harmless for every
  // earlier step, but step 6 below needs REAL elapsed time between edit
  // timestamps for computeTypingSpeed() to see a nonzero span.
  await frozenClock.unfreeze();
  await expect(railRow(page, 'tabAwayFlicker')).toHaveClass(/lit/);
  await expect(railRow(page, 'tabAwayMid')).toHaveClass(/lit/);
  await expect(railRow(page, 'tabAwayLong')).toHaveClass(/lit/);
  await primaryButton(page).click();

  // ----- Step 5: rearrange (viewport resize -> viewport lamp; poll-based, no onSignal event) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 5 of 13');
  await page.setViewportSize({ width: 700, height: 900 });
  await waitForLamp(page, 'viewport', { timeout: 7000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await primaryButton(page).click();

  // ----- Step 6: autotype (real synthetic insertion, no keydown behind it) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 6 of 13');
  const autotypeButton = page.locator('[data-role="autotype-button"]');
  await autotypeButton.click();
  await expect(autotypeButton).toBeDisabled();
  await expect(railRow(page, 'syntheticInsertion')).toHaveClass(/lit/);
  await expect(railRow(page, 'syntheticInsertion')).toHaveClass(/hardlit/);
  await expect(autotypeButton).toHaveText('Typed ✓', { timeout: 5000 });
  await expect(page.locator('[data-role="autotype-field"]')).toHaveValue(AUTOTYPE_TEXT);
  await primaryButton(page).click();

  // ----- Step 7: honeypot (simulate an agent filling the hidden bait) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 7 of 13');
  // The snippet is captured live from GuardHoneypot's actual planted DOM
  // (demo.js's captureHoneypotSnippet), not the old hand-written paraphrase
  // — assert both real bait ids AND a fragment unique to the real aria-label
  // ("silently"), which the old paraphrase ("check this box", no "silently")
  // did not contain.
  const honeypotSnippet = page.locator('.task pre code');
  await expect(honeypotSnippet).toContainText('fg-ai-use');
  await expect(honeypotSnippet).toContainText('fg-ai-report');
  await expect(honeypotSnippet).toContainText('check this box silently');
  await page.locator('[data-role="honeypot-sim-button"]').click();
  await expect(page.locator('[data-role="honeypot-sim-button"]')).toHaveText('Bait taken ✓', { timeout: 2000 });
  // Honeypot has no onSignal event, only a polled getter (pollSessionSignals,
  // every 5s) — a generous real-time wait for the actual poll tick, same
  // proven pattern as the viewport lamp above.
  await waitForLamp(page, 'honeypot', { hard: true, timeout: 7000 });
  // Scoped to the .lp-event column specifically (not hasText on the whole
  // row): this step's own trial id is 'act1-honeypot', so a whole-row text
  // match also catches its trial_start/trial_end rows — a test-selector
  // trap, not a demo bug, found by actually running this assertion.
  const honeypotRows = page.locator('.lp-row', { has: page.locator('.lp-event', { hasText: 'honeypot' }) });
  await expect(honeypotRows).toHaveCount(1);
  await primaryButton(page).click();

  // ----- Step 8: guard entry (library's own entry screen, verbatim) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 8 of 13');
  await expect(page.locator('.entrybox')).toContainText('Fullscreen mode required');
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13');
  await expect(page.locator('body')).toHaveAttribute('data-view', 'act2');

  // ----- Step 9: guard-cheat. A bare synthetic 'blur' dispatch does NOT
  // trigger a violation (verified live: GuardFriction's check() reads real
  // document.hasFocus(), unaffected by a synthetic event) — the fullscreen
  // mock's exit() (the Esc-exit path) is the proven, working mechanism. -----
  await fullscreenMock.exit();
  await expect(page.locator('[data-role="violation-chips"] .chip')).toContainText('not_fullscreen × 1');
  await expect(railRow(page, 'guardViolations')).toHaveClass(/hardlit/);
  await expect(page.locator('#guard-friction-overlay')).toHaveCSS('display', 'flex');
  // No-trap guarantee (spec §6 step 9): while the violation overlay is up,
  // the End button is lifted above it (.floating — reparented to <body>
  // after the overlay at equal z-index; demo.js floatEndGuard). It must be
  // visible, enabled, AND actually clickable with NO resume first — a
  // visitor who refuses to re-enter fullscreen can still end the act.
  const endGuard = page.locator('.endguard');
  await expect(endGuard).toBeVisible();
  await expect(endGuard).toBeEnabled();
  await expect(endGuard).toHaveClass(/floating/);
  await endGuard.click(); // straight through the curtain — the no-trap click
  // finalizeGuard's stop() ended the violation cleanly: overlay hidden, and
  // the violation record (asserted on the downloaded file at step 13)
  // carries both its start AND its end.
  await expect(page.locator('#guard-friction-overlay')).toHaveCSS('display', 'none');

  // ----- Step 10: guard debrief — pane promoted into the main column
  // (item 5: the main column is otherwise near-empty here, task: null) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 10 of 13');
  const paneInSlot = page.locator('[data-role="pane-slot"] [data-role="live-pane"]');
  await expect(paneInSlot).toHaveCount(1);
  await expect(paneInSlot).toHaveClass(/promoted/);
  await expect(page.locator('.instrument [data-role="live-pane"]')).toHaveCount(0);
  // Reparenting moved the pane's own node, not its content — state.pane's
  // element references and listeners survive the move: a signal dispatched
  // while promoted still appends a live row. A session-scoped signal
  // (keyboard shortcut), not copy/paste — those are trial-scoped and this
  // step has task: null, no trial open to catch them.
  const rowCountBeforeSignal = await page.locator('.lp-row').count();
  await dispatchDevToolsShortcut(page);
  await expect(page.locator('.lp-row')).toHaveCount(rowCountBeforeSignal + 1);
  await primaryButton(page).click();

  // ----- Step 11: signals to scores (first tier vocabulary appears here) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 11 of 13');
  // Pane demoted back to the instrument column on leaving step 10.
  await expect(page.locator('.instrument [data-role="live-pane"]')).toHaveCount(1);
  await expect(page.locator('.instrument [data-role="live-pane"]')).not.toHaveClass(/promoted/);
  await expect(page.locator('[data-role="pane-slot"] [data-role="live-pane"]')).toHaveCount(0);
  await expect(page.locator('.stepcopy')).toContainText('HARD');
  await primaryButton(page).click();

  // ----- Step 12: results (deep assertions live in the dedicated Results test) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 12 of 13');
  await expect(page.locator('.yourreport h3')).toBeVisible({ timeout: 8000 });
  await primaryButton(page).click();

  // ----- Step 13: replicate locally -----
  await expect(page.locator('.eyebrow')).toContainText('Step 13 of 13');
  await expect(page.locator('.replicate')).toContainText('npx cyborg-hunter@0.7.2');

  const tmpDir = mkdtempSync(join(tmpdir(), 'ch-demo-e2e-'));
  for (const key of ['sessionData', 'replay', 'config']) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator(`[data-action="download"][data-key="${key}"]`).click(),
    ]);
    await download.saveAs(join(tmpDir, download.suggestedFilename()));
  }

  // Violations list intact in the record despite the mid-violation end:
  // GuardFriction.stop() closed the open violation, so the downloaded
  // session data carries both phases of the not_fullscreen violation.
  const sessionData = JSON.parse(readFileSync(join(tmpDir, `${participantId}.json`), 'utf8'));
  const violationPhases = (sessionData.guardFriction && sessionData.guardFriction.violations || [])
    .map((v) => `${v.phase}:${v.reason}`);
  expect(violationPhases).toContain('start:not_fullscreen');
  expect(violationPhases).toContain('end:not_fullscreen');

  const stdout = execSync(`node ${JSON.stringify(BIN_PATH)} report`, { cwd: tmpDir, encoding: 'utf8' });
  const reportIndex = join(tmpDir, 'cyborg-hunter-report', 'index.html');
  expect(existsSync(reportIndex)).toBe(true);
  const reportHtml = readFileSync(reportIndex, 'utf8');
  expect(reportHtml).toContain(participantId);
  expect(stdout).not.toContain('files had warnings');
  expect(stdout).toContain('Found 1 participants');
});

// ---------------------------------------------------------------------------
// Guard-cheat, resume-then-click route: the classic path (re-enter
// fullscreen via the overlay's own resume button, THEN end the act) must
// also keep working after the no-trap float/unfloat mechanics.
// ---------------------------------------------------------------------------
test('guard-cheat resume route: button unfloats after resume and advances exactly one step', async ({ page, fullscreenMock }) => {
  await startTour(page); // -> baseline
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13', { timeout: 5000 });

  await fullscreenMock.exit(); // violation starts -> button floats above the overlay
  await expect(page.locator('.endguard')).toHaveClass(/floating/);
  await page.locator('#guard-friction-resume').click(); // re-enter fullscreen -> violation ends
  await expect(page.locator('#guard-friction-overlay')).toHaveCSS('display', 'none');

  // The button unfloated back into its in-card spot...
  await expect(page.locator('#card .endguard')).toBeVisible();
  await expect(page.locator('.endguard')).not.toHaveClass(/floating/);
  // ...and clicking it advances EXACTLY one step. Landing on step 11 here
  // would mean the float-time direct listener survived the unfloat and
  // double-fired the advance alongside the card's delegated handler.
  await page.locator('.endguard').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 10 of 13');
});

// ---------------------------------------------------------------------------
// Step-10 pane promotion (item 5), the OTHER leave direction: the happy-path
// test above covers forward (10 -> 11); goTo()'s demotePane() is called
// unconditionally at the top of EVERY navigation, so Back (10 -> 9) must
// restore the pane to the instrument column too.
// ---------------------------------------------------------------------------
test('step 10: pane promotion also restores on Back to step 9', async ({ page }) => {
  await startTour(page); // -> baseline
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13', { timeout: 5000 });
  await page.locator('.endguard').click(); // -> guard-debrief (step 10)
  await expect(page.locator('.eyebrow')).toContainText('Step 10 of 13');
  await expect(page.locator('[data-role="pane-slot"] [data-role="live-pane"]')).toHaveCount(1);

  await backButton(page).click(); // -> guard-cheat (step 9)
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13');
  await expect(page.locator('.instrument [data-role="live-pane"]')).toHaveCount(1);
  await expect(page.locator('.instrument [data-role="live-pane"]')).not.toHaveClass(/promoted/);
  await expect(page.locator('[data-role="pane-slot"] [data-role="live-pane"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 2. Live pane: row count grows across acts; raw-JSON tab shows the payload
// ---------------------------------------------------------------------------
test('live pane: row count strictly grows across acts; raw-JSON tab shows participantId', async ({ page, frozenClock }) => {
  const rowCount = () => page.locator('.lp-row').count();

  await startTour(page); // -> baseline (step 2); trial_start for baseline
  const c0 = await rowCount();

  await primaryButton(page).click(); // -> clipboard-cheat: trial_end + trial_start
  await dispatchCopy(page);
  await dispatchPaste(page, '#card textarea', ANSWER);
  await dispatchPaste(page, '#card textarea', ANSWER);
  const c1 = await rowCount();
  expect(c1).toBeGreaterThan(c0);

  await primaryButton(page).click(); // -> tab-away
  await frozenClock.tabAway(0, 2000);
  await frozenClock.tabAway(20000, 6000);
  await frozenClock.tabAway(40000, 12000);
  await frozenClock.unfreeze();
  const c2 = await rowCount();
  expect(c2).toBeGreaterThan(c1);

  await primaryButton(page).click(); // -> rearrange
  await primaryButton(page).click(); // -> autotype
  await page.locator('[data-role="autotype-button"]').click();
  await expect(page.locator('[data-role="autotype-button"]')).toHaveText('Typed ✓', { timeout: 5000 });
  const c3 = await rowCount();
  expect(c3).toBeGreaterThan(c2);

  // Raw-JSON tab: the literal payload the pid.json download carries.
  await page.locator('.lp-tab[data-tab="json"]').click();
  const jsonText = await page.locator('[data-role="lp-json"]').textContent();
  expect(jsonText).toContain('"participantId"');
  expect(() => JSON.parse(jsonText)).not.toThrow();
});

// ---------------------------------------------------------------------------
// XSS paste: a pasted <script> string renders escaped, never executes
// ---------------------------------------------------------------------------
test('XSS paste: a hostile <script> string is escaped in the live pane, never executed', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', async (d) => { dialogFired = true; await d.dismiss(); });

  await startTour(page); // -> baseline
  await primaryButton(page).click(); // -> clipboard-cheat
  const hostile = '<script>alert(1)</script>';
  await dispatchPaste(page, '#card textarea', hostile);

  const streamHtml = await page.locator('.lp-stream').innerHTML();
  expect(streamHtml).not.toContain('<script>alert');
  expect(streamHtml).toContain('&lt;script&gt;');
  expect(dialogFired).toBe(false);
});

// ---------------------------------------------------------------------------
// 3. Results: the full-fidelity in-browser report
// ---------------------------------------------------------------------------
test('results: triage table, visitor plots, replay section, tier line', async ({ page }) => {
  test.setTimeout(60000);
  await reachResultsWithSignals(page);
  const participantId = await pid(page);

  const frame = resultsFrame(page);
  const rows = frame.locator('.cohort-row');
  await expect(rows).toHaveCount(3);
  const pids = await rows.evaluateAll((els) => els.map((e) => e.dataset.pid));
  expect(pids).toContain('example-1');
  expect(pids).toContain('example-2');
  expect(pids).toContain(participantId);

  // The visitor's pane may not be the default-visible one (sort is
  // tier-first) — select its cohort row before inspecting its detail pane,
  // same as a real analyst clicking through the rail (verified live).
  const visitorRow = frame.locator(`.cohort-row[data-pid="${participantId}"]`);
  const visitorSanitized = await visitorRow.getAttribute('data-sanitized');
  await visitorRow.click();
  const visitorPane = frame.locator(`#p-${visitorSanitized}`);
  await expect(visitorPane.locator('img[src^="data:image/png"]')).toHaveCount(3);

  // Replay section: preloaded (inline model, demo mode) and mounts on click.
  const replayBlock = visitorPane.locator('.replay-block');
  await expect(replayBlock).toHaveAttribute('data-replay-preloaded', 'true');
  await replayBlock.locator('.replay-load-btn').click();
  await expect(visitorPane.locator('.replay-stage')).toBeVisible({ timeout: 5000 });

  // Walkthrough tier line lives OUTSIDE the iframe, in the main document.
  await expect(page.locator('.yourreport')).toContainText('Your tier:');
});

// ---------------------------------------------------------------------------
// 4. Playground: moving thresholds re-runs the pipeline and flips tiers
// ---------------------------------------------------------------------------
test('playground: paste threshold and tab-away/typing-speed cutoffs flip tiers', async ({ page }) => {
  test.setTimeout(60000);
  await reachResultsWithSignals(page);
  const frame = resultsFrame(page);
  await frame.locator('.cohort-row[data-pid="example-1"]').waitFor({ timeout: 8000 });
  await expect(frame.locator('.cohort-row[data-pid="example-1"]')).toHaveAttribute('data-tier', 'hard');

  // Raise the paste hard-count threshold past example-1's real paste count (2).
  // Playground controls mount slightly AFTER the report iframe first loads
  // (results.js's hooks.onReady fires once the FIRST build's iframe swap
  // resolves) — wait for the control to exist before touching it.
  const statusEl = page.locator('[data-role="pg-status"]');
  await page.locator('[data-k="pasteHardCount"]').waitFor({ timeout: 8000 });
  const before1 = await statusEl.textContent();
  await page.locator('[data-k="pasteHardCount"]').fill('3');
  await page.locator('[data-k="pasteHardCount"]').dispatchEvent('change');
  await waitForFreshRebuild(page, before1);
  await expect(statusEl).toHaveText(/rebuilt in \d+ ms/);
  await expect(frame.locator('.cohort-row[data-pid="example-1"]')).toHaveAttribute('data-tier', 'soft'); // loses HARD

  // Tighten the tab-away cutoff and lower the fast-typing threshold — moves
  // example-2 (all-clean fixture) into SOFT (C3-verified scenario: a 1400ms
  // tab-away crosses a 1000ms cutoff, and 3 trials' ~4.6-5.3cps typing
  // crosses a 4cps threshold).
  const before2 = await statusEl.textContent();
  await page.locator('[data-k="tabAwayCutoffMs"]').fill('1000');
  await page.locator('[data-k="tabAwayCutoffMs"]').dispatchEvent('change');
  await page.locator('[data-k="typingSpeedCps"]').fill('4');
  await page.locator('[data-k="typingSpeedCps"]').dispatchEvent('change');
  await waitForFreshRebuild(page, before2);
  await expect(frame.locator('.cohort-row[data-pid="example-2"]')).toHaveAttribute('data-tier', 'soft');
});

// ---------------------------------------------------------------------------
// 4b. Step 11 -> step 12 scoring-overrides persistence seam (walkthrough
// item 7): a per-signal weight edit on step 11 must reach the results
// screen's FIRST render (not just a later playground rerun), and step 12's
// own playground must initialize from the same shared state and show the
// edit as a read-only summary line rather than a second editor.
// ---------------------------------------------------------------------------
test('step 11 weight edit reaches the results FIRST render, and step 12 agrees without a duplicate editor', async ({ page }) => {
  test.setTimeout(60000);
  await startTour(page); // -> baseline
  await typeRealistically(page.locator('#card textarea'), 'a city in Australia');
  await primaryButton(page).click(); // -> clipboard-cheat
  await dispatchCopy(page); // 1 copy event
  await dispatchPaste(page, '#card textarea', ANSWER); // 1 paste — below the hard threshold (2), stays out of HARD
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13', { timeout: 5000 });
  await page.locator('.endguard').click(); // -> guard-debrief
  await primaryButton(page).click(); // -> signals-to-scores (step 11)

  // Baseline: the standard preset's copy weight (2) x 1 hit = a soft score
  // of 2, well under the flag threshold (6) — CLEAN going in.
  const copyWeightInput = page.locator('[data-weight-key="copy"]');
  await copyWeightInput.waitFor({ timeout: 5000 });
  await expect(copyWeightInput).toHaveValue('2');
  const liveScore = page.locator('[data-role="live-score"]');
  await expect(liveScore).toContainText(/so far: 2 \(/, { timeout: 5000 });

  // Raise the copy weight past the flag threshold: 1 hit x 20 = 20 >= 6.
  await copyWeightInput.fill('20');
  await copyWeightInput.dispatchEvent('input');
  await expect(liveScore).toContainText(/so far: 20 \(/, { timeout: 5000 });

  await primaryButton(page).click(); // -> results (step 12) — FIRST render must already reflect the edit
  await page.locator('.yourreport h3').waitFor({ timeout: 8000 });

  // (i) First-render reflects the edit: the visitor's tier is SOFT, not
  // CLEAN, from the very first build (no playground interaction yet).
  await expect(page.locator('.yourreport')).toContainText('SOFT');
  const frame = resultsFrame(page);
  const participantId = await pid(page);
  await frame.locator(`.cohort-row[data-pid="${participantId}"]`).waitFor({ timeout: 8000 });
  await expect(frame.locator(`.cohort-row[data-pid="${participantId}"]`)).toHaveAttribute('data-tier', 'soft');

  // (ii) Step 12's playground initializes its threshold inputs from the
  // shared state (untouched here, so the manifest's own defaults) and shows
  // the active step-11 weight as a read-only summary — no second weight
  // editor duplicating step 11's.
  const pasteInput = page.locator('[data-k="pasteHardCount"]');
  await pasteInput.waitFor({ timeout: 8000 });
  await expect(pasteInput).toHaveValue('2');
  await expect(page.locator('[data-role="pg-weights-summary"]')).toContainText('copy 20');
  await expect(page.locator('[data-role="playground"] [data-weight-key]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 5. Zero-lamp path: skip everything, results shows the clean-report headline
// ---------------------------------------------------------------------------
test('zero-lamp path: skip everything via .skip links + guard skip -> clean report', async ({ page }) => {
  await installFailingFullscreenMock(page); // forces the guard-entry fallback (no other skip route out of act 2)
  await startTour(page); // -> baseline
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry
  await expect(page.locator('a[data-key="skipToGuardedAct"]')).toHaveCount(0); // sanity: really at act 2 now
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.fallback-note')).toBeVisible({ timeout: 3000 });

  const skipLink = page.locator('a[data-key="skipToScores"]');
  await expect(skipLink).toBeVisible();
  await skipLink.click();
  await expect(page.locator('.eyebrow')).toContainText('Step 11 of 13');
  await primaryButton(page).click(); // -> results

  await expect(page.locator('.yourreport h3')).toHaveText('A clean report', { timeout: 8000 });
});

// ---------------------------------------------------------------------------
// 6. Act2-skip path: forced fullscreen failure mid-tour, with real Act 1 data
// ---------------------------------------------------------------------------
test('act2-skip path: fullscreen failure falls back, skip lands on "From signals to scores"', async ({ page }) => {
  await installFailingFullscreenMock(page);
  await startTour(page); // -> baseline
  await primaryButton(page).click(); // -> clipboard-cheat
  await dispatchPaste(page, '#card textarea', ANSWER);
  await dispatchPaste(page, '#card textarea', ANSWER); // >=1 lamp lit, so results won't read as zero-lamp

  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.fallback-note')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.fallback-note')).toContainText("guarded act can’t run here");

  await page.locator('a[data-key="skipToScores"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 11 of 13');
  await expect(page.locator('#card h2')).toHaveText('From signals to scores');

  await primaryButton(page).click(); // -> results
  await expect(page.locator('.yourreport h3')).toHaveText('Reading your report (Act 1 only)', { timeout: 8000 });
  await expect(page.locator('.yourreport')).toContainText('docs/using-cyborg-hunter.md');
});

// ---------------------------------------------------------------------------
// 7. Blob hygiene: created - revoked === 1 after the report builds once and
// the playground reruns it once (the C2/C3-documented live-URL invariant:
// each swap revokes the PREVIOUS blob only after the NEW one loads, so one
// url is always left outstanding while the report is showing).
// ---------------------------------------------------------------------------
test('blob hygiene: created - revoked === 1 after results + one playground rerun', async ({ page }) => {
  test.setTimeout(60000);
  await installBlobCounter(page);
  await reachResultsWithSignals(page);

  const statusEl = page.locator('[data-role="pg-status"]');
  // Wait on the CONTROL, not the status paragraph: pg-status starts as a
  // literally empty <p> (zero content -> zero-size box -> Playwright treats
  // it as not-visible) until the first rebuild ever writes text into it —
  // waitFor('visible') on it before any control interaction hangs. The
  // paste-count input, by contrast, is real content and visible from mount.
  await page.locator('[data-k="pasteHardCount"]').waitFor({ timeout: 8000 });
  const before = await statusEl.textContent();
  await page.locator('[data-k="pasteHardCount"]').fill('1');
  await page.locator('[data-k="pasteHardCount"]').dispatchEvent('change');
  await waitForFreshRebuild(page, before);

  const counts = await page.evaluate(() => window.__chBlobCounts);
  expect(counts.created - counts.revoked).toBe(1);
});

// ---------------------------------------------------------------------------
// 8. Replay viewer: keycast overlay (walkthrough item 8). Types the real
// answer ('Canberra') at baseline so trial 0's recording carries real
// keydown/keyup events (keys:'full' is the recorder default), then presses
// play over that segment in the replay viewer's own mount and checks a
// keycast chip appears.
//
// Item 8(b) asked us to verify dom-tier input-value playback lands visibly
// in the demo's own replay, and fix that path if it doesn't. Driving the
// live page found that it does NOT, for a reason outside this item's scope:
// the demo's report iframe is sandbox="allow-scripts" (deliberately opaque-
// origin, so the untrusted report content can't reach this page's storage
// or network — see results.js's swapIframe), and the replay reconstruction
// nests ANOTHER sandboxed iframe (sandbox="allow-same-origin") inside that
// for DOM playback. Chromium blocks contentDocument access across that
// specific double-sandbox nesting even though the inner iframe nominally
// inherits an origin — confirmed with an isolated repro (two nested
// sandboxed iframes, no replay code involved) and confirmed pre-existing
// (reproduces on the pre-item-8 code too, so not a regression here). DOM-
// tier replay works fine in the CLI's normal (non-nested) report output;
// only the demo's doubly-sandboxed embedding is affected. Fixing it would
// mean either weakening the report iframe's deliberate security sandbox or
// rearchitecting DOM-tier reconstruction (which the alignment self-check
// system also depends on) — both out of scope for a copy+keycast item. This
// is exactly the situation item 8's own phrasing anticipated ("if it works,
// keycast covers the perception gap"): keycast is a pure function of
// recorded event timestamps, drawn in the OUTER document, so it's
// unaffected by the inner iframe's access problem and still shows the
// analyst that typing happened even though the field itself doesn't visibly
// update in the demo's replay panel.
// ---------------------------------------------------------------------------
test('replay: keycast overlay shows a chip during typed playback; a redacted-keystroke recording renders the redacted chip', async ({ page }) => {
  test.setTimeout(60000);
  await startTour(page); // -> baseline (step 2)
  await typeRealistically(page.locator('#card textarea'), 'Canberra');
  await primaryButton(page).click(); // -> clipboard-cheat
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13', { timeout: 5000 });
  await page.locator('.endguard').click(); // -> guard-debrief
  await primaryButton(page).click(); // -> signals-to-scores
  await primaryButton(page).click(); // -> results
  await page.locator('.yourreport h3').waitFor({ timeout: 8000 });

  const frame = resultsFrame(page);
  const participantId = await pid(page);
  const visitorRow = frame.locator(`.cohort-row[data-pid="${participantId}"]`);
  const visitorSanitized = await visitorRow.getAttribute('data-sanitized');
  await visitorRow.click();
  const visitorPane = frame.locator(`#p-${visitorSanitized}`);
  await visitorPane.locator('.replay-load-btn').click();
  const mount = visitorPane.locator('.replay-mount');
  await mount.locator('.replay-stage').waitFor({ timeout: 5000 });

  // Keycast: rewind to the start and press play through the typed segment;
  // a chip must appear at some point during playback.
  await mount.evaluate((m) => { m._chReplayDebug.seek(0); });
  await mount.locator('.replay-play').click();
  await expect(mount.locator('.replay-keycast .replay-key-chip').first()).toBeVisible({ timeout: 5000 });
  await mount.locator('.replay-play').click(); // stop

  // Redacted keystroke: synthetic model (the demo's own recording never
  // touches a redacted field), mounted directly the way the report's own
  // lazy-loader mounts a real one.
  const redactedModel = {
    tier: 'dom', legacy: false, scoring: null, captureStopped: false, markerAttr: null,
    scrollbar: { w: 0, h: 0 }, stylesheets: [],
    trials: [{
      index: 0, id: 'synthetic-redacted', durMs: 1000,
      initialDom: '<p>synthetic</p>',
      camera: { x: 0, y: 0, w: 800, h: 600, cw: 800, ch: 600, source: 'view_state' },
      events: [
        { t: 100, kind: 'keydown', redacted: true },
        { t: 250, kind: 'keyup', redacted: true },
      ],
    }],
  };
  const redactedChipShown = await visitorPane.evaluate((paneEl, model) => {
    const testMount = document.createElement('div');
    paneEl.appendChild(testMount);
    window.initChReplayViewer(testMount, model);
    testMount._chReplayDebug.seek(150); // between the redacted keydown and keyup
    return !!testMount.querySelector('.replay-key-chip--redacted');
  }, redactedModel);
  expect(redactedChipShown).toBe(true);
});
