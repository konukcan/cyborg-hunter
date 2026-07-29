// demo/tests/tour.spec.js
// Playwright E2E suite for the live demo tour (spec: docs/superpowers/specs/
// 2026-07-29-ch-demo-page-design.md, "Testing (launch layers)" item 2).
// Runs against the ASSEMBLED site (.demo-site/, see playwright.config.js +
// tools/assemble-demo-site.mjs) so demo/index.html's ./dist/... and
// ./vendor/... relative paths resolve the same way they do on Pages.
//
// Every test asserts zero accumulated pageerrors via the auto `pageErrors`
// fixture (helpers.mjs). Two more auto-fixtures (frozenClock, fullscreenMock)
// install their addInitScript patches before any page script runs; they're
// inert until a test explicitly calls into them.

import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  test, expect,
  dispatchPaste, dispatchCopy, typeRealistically,
  startTour, fastForwardToReplicate,
  primaryButton, backButton, railRow, pid,
} from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, '..', '..', 'bin', 'cyborg-hunter.js');
const RULE_TEXT = 'Rule: a hand wins when both cards share a suit and neither is below five.';
const AUTOTYPE_TEXT = "No one is typing this — it's appearing entirely on its own.";

// ---------------------------------------------------------------------------
// a. Full 12-step happy path
// ---------------------------------------------------------------------------
test('full 12-step happy path: welcome through replicate-locally', async ({ page, frozenClock, fullscreenMock }) => {
  test.setTimeout(90000);

  // ----- Step 1: welcome -----
  await startTour(page); // lands on step 2 (baseline-typing)
  const participantId = await pid(page);
  expect(participantId).toMatch(/^DEMO-/);

  // ----- Step 2: baseline typing (real per-char typing, nothing lights) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 2 of 12');
  await typeRealistically(page.locator('#card textarea'), 'a hand with matching suits and no low cards');
  await expect(page.locator('#rail .check')).toHaveClass(/awaiting/); // still inert
  await primaryButton(page).click();

  // ----- Step 3: copy-paste (two dispatched pastes cross the HARD threshold) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 3 of 12');
  await dispatchPaste(page, '#card textarea', RULE_TEXT);
  await expect(railRow(page, 'paste')).toHaveClass(/lit/);
  await expect(railRow(page, 'paste')).not.toHaveClass(/hardlit/);
  await dispatchPaste(page, '#card textarea', RULE_TEXT);
  await expect(railRow(page, 'paste')).toHaveClass(/hardlit/);
  await expect(railRow(page, 'paste').locator('.n')).toHaveText('2');
  await primaryButton(page).click();

  // ----- Step 4: tab-away >=10s (frozen clock for an exact 11s duration) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 4 of 12');
  await frozenClock.tabAway(0, 11000);
  await expect(railRow(page, 'tabAwayLong')).toHaveClass(/lit/);
  // tabAway() freezes performance.now() and never unfreezes it — harmless
  // for every earlier step, but step 6 below needs REAL elapsed time between
  // edit timestamps for computeTypingSpeed() to see a nonzero span.
  await frozenClock.unfreeze();
  await primaryButton(page).click();

  // ----- Step 5: resize (never ends the tour; may light sidebar/viewport) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 5 of 12');
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(async () => {
    const sidebarLit = await railRow(page, 'sidebar').evaluate((el) => el.classList.contains('lit'));
    const viewportLit = await railRow(page, 'viewport').evaluate((el) => el.classList.contains('lit'));
    expect(sidebarLit || viewportLit).toBe(true);
  }).toPass({ timeout: 6000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await primaryButton(page).click();

  // ----- Step 6: autotype (real synthetic insertion + fast typing) -----
  // Pressing the button drives the field via .value + dispatched
  // InputEvent('insertText') with no preceding keydown — the exact gap
  // src/core/signals/typing.js's synthetic-insertion detector watches for —
  // so the rail lamp lights immediately. Fast typing is only computable at
  // endTrial() (no onSignal event for it), so its lamp lights on advance,
  // once the trial actually closes.
  await expect(page.locator('.eyebrow')).toContainText('Step 6 of 12');
  const autotypeButton = page.locator('[data-role="autotype-button"]');
  const autotypeField = page.locator('[data-role="autotype-field"]');
  await autotypeButton.click();
  await expect(autotypeButton).toBeDisabled();
  await expect(railRow(page, 'syntheticInsertion')).toHaveClass(/lit/);
  await expect(railRow(page, 'syntheticInsertion')).toHaveClass(/hardlit/);
  await expect(railRow(page, 'fastTyping')).not.toHaveClass(/lit/); // not yet — trial's still open
  await expect(autotypeButton).toHaveText('Typed ✓', { timeout: 5000 });
  await expect(autotypeField).toHaveValue(AUTOTYPE_TEXT);
  await expect(autotypeField).not.toHaveJSProperty('readOnly', true); // re-enabled
  await primaryButton(page).click(); // closes the trial -> fast-typing lamp
  await expect(railRow(page, 'fastTyping')).toHaveClass(/lit/);

  // ----- Step 7: guard fair-warning (mocked fullscreen entry) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 7 of 12');
  await primaryButton(page).click(); // "Enter fullscreen" -> races the mocked API
  await expect(page.locator('.eyebrow')).toContainText('Step 8 of 12');
  await expect(page.locator('body')).toHaveAttribute('data-view', 'act2');

  // ----- Step 8: try to cheat (exactly one guard violation) -----
  await fullscreenMock.exit(); // simulates Esc -> not_fullscreen violation starts
  await expect(page.locator('[data-role="violation-chips"] .chip')).toContainText('not_fullscreen × 1');
  await expect(railRow(page, 'guardViolations')).toHaveClass(/hardlit/);
  await page.evaluate(() => document.documentElement.requestFullscreen()); // re-enter -> violation ends
  await primaryButton(page).click();

  // ----- Step 9: guard finish -----
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 12');
  await expect(page.locator('.task .hint')).toContainText('not_fullscreen — 1');
  await primaryButton(page).click();

  // ----- Step 10: jsPsych finale (real trials or degraded panel) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 10 of 12');
  const finaleOutcomeHandle = await page.waitForFunction(() => {
    const note = document.querySelector('.finale-note');
    const status = document.querySelector('[data-role="finale-status"]');
    if (note && !note.hidden) return 'degraded';
    if (status && /press a key/i.test(status.textContent || '')) return 'live';
    return false;
  }, null, { timeout: 10000 });
  const finaleOutcome = await finaleOutcomeHandle.jsonValue();
  console.log('[tour.spec] happy-path finale outcome:', finaleOutcome);
  if (finaleOutcome === 'live') {
    await page.keyboard.press('Space');
    await expect(page.locator('[data-role="finale-mount"]')).toContainText('Quick check', { timeout: 5000 });
    await page.keyboard.press('y');
    await expect(page.locator('[data-role="finale-status"]')).toHaveText(/Both trials complete/, { timeout: 5000 });
  }
  await primaryButton(page).click();

  // ----- Step 11: results (truthful in-browser report) -----
  await expect(page.locator('.eyebrow')).toContainText('Step 11 of 12');
  await expect(page.locator('.yourreport h3')).toHaveText("Here's what you built", { timeout: 8000 });
  const srcdoc = await page.locator('.results-frame').getAttribute('srcdoc');
  expect(srcdoc).toContain(participantId);
  expect(srcdoc).toContain(RULE_TEXT);
  await primaryButton(page).click();

  // ----- Step 12: replicate locally -----
  await expect(page.locator('.eyebrow')).toContainText('Step 12 of 12');
  await expect(page.locator('[data-action="download"][data-key="sessionData"]')).toBeVisible();
  await expect(page.locator('[data-action="download"][data-key="config"]')).toBeVisible();
});

// ---------------------------------------------------------------------------
// b. Back/skip lifecycle
// ---------------------------------------------------------------------------
test('back/skip lifecycle: Back, skip-to-guard link, Alt+S all navigate without errors', async ({ page }) => {
  await startTour(page); // step 2 (baseline-typing)
  await primaryButton(page).click(); // -> step 3 (copy-paste)
  await primaryButton(page).click(); // -> step 4 (tab-away)
  await expect(page.locator('.eyebrow')).toContainText('Step 4 of 12');

  await backButton(page).click(); // -> step 3
  await expect(page.locator('.eyebrow')).toContainText('Step 3 of 12');
  await backButton(page).click(); // -> step 2
  await expect(page.locator('.eyebrow')).toContainText('Step 2 of 12');

  await primaryButton(page).click(); // -> step 3
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> step 7 (guard-fair-warning)
  await expect(page.locator('.eyebrow')).toContainText('Step 7 of 12');

  await backButton(page).click(); // -> step 6 (autotype)
  await expect(page.locator('.eyebrow')).toContainText('Step 6 of 12');
  await primaryButton(page).click(); // -> step 7 again

  await page.keyboard.press('Alt+S'); // -> step 10 (jspsych-finale)
  await expect(page.locator('.eyebrow')).toContainText('Step 10 of 12');
});

// ---------------------------------------------------------------------------
// c. Zero-lamp path
// ---------------------------------------------------------------------------
test('zero-lamp path: Alt+S immediately shows the empty-state copy and CLEAN tier', async ({ page }) => {
  await page.goto('/');
  await page.locator('#card h2').waitFor();
  await page.keyboard.press('Alt+S'); // even before "Start the tour" -> step 10
  await expect(page.locator('.eyebrow')).toContainText('Step 10 of 12');
  await primaryButton(page).click(); // -> step 11 (results), no finale interaction needed

  await expect(page.locator('.yourreport h3')).toHaveText(
    "You triggered nothing — here's what a clean report looks like", { timeout: 8000 });
  await expect(page.locator('.results-mount .t-clean')).toHaveText('CLEAN');
});

// ---------------------------------------------------------------------------
// d. Act-2-skip variant
// ---------------------------------------------------------------------------
test('act-2-skip variant: one paste then Alt+S from act2 shows the guard-docs pointer', async ({ page }) => {
  await startTour(page); // step 2 (baseline-typing)
  await primaryButton(page).click(); // -> step 3 (copy-paste)
  await dispatchPaste(page, '#card textarea', RULE_TEXT); // one paste, not two

  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> step 7 (act2)
  await expect(page.locator('body')).toHaveAttribute('data-view', 'act2');
  await page.keyboard.press('Alt+S'); // skip from WITHIN act2 -> act2Skipped: true
  await expect(page.locator('.eyebrow')).toContainText('Step 10 of 12');
  await primaryButton(page).click(); // -> results

  await expect(page.locator('.yourreport h3')).toHaveText(
    "Here's what you built (Act 1 only)", { timeout: 8000 });
  await expect(page.locator('.yourreport')).toContainText('docs/using-cyborg-hunter.md');
});

// ---------------------------------------------------------------------------
// e. Resize mid-tour vs. fresh small-viewport load
// ---------------------------------------------------------------------------
test('resize mid-tour stays interactive; a fresh load at 700px is read-only smallmode', async ({ page }) => {
  await page.setViewportSize({ width: 830, height: 900 });
  await startTour(page); // capabilities snapshotted interactive=true at boot
  await expect(page.locator('.eyebrow')).toContainText('Step 2 of 12');

  await page.setViewportSize({ width: 700, height: 900 });
  await primaryButton(page).click(); // still interactive despite <820px now
  await expect(page.locator('.eyebrow')).toContainText('Step 3 of 12');
  await expect(page.locator('#smallmode')).toBeHidden();

  await page.setViewportSize({ width: 900, height: 900 });
  await primaryButton(page).click();
  await expect(page.locator('.eyebrow')).toContainText('Step 4 of 12');

  // Fresh load at 700px: capabilities snapshotted false -> read-only smallmode.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto('/');
  await expect(page.locator('#smallmode')).not.toBeHidden();
  await expect(page.locator('.cols')).toHaveCSS('display', 'none');
  await expect(page.locator('#smallmode')).toContainText('Quickstart');
});

// ---------------------------------------------------------------------------
// f. Tab-away boundary (3000ms vs 3001ms)
// ---------------------------------------------------------------------------
test('boundary: a tab-away of exactly 3000ms lights nothing; 3001ms lights the mid bin', async ({ page, frozenClock }) => {
  await startTour(page); // step 2
  await primaryButton(page).click(); // -> step 3
  await primaryButton(page).click(); // -> step 4 (tab-away)
  await expect(page.locator('.eyebrow')).toContainText('Step 4 of 12');

  await frozenClock.tabAway(0, 3000);
  await expect(railRow(page, 'tabAwayMid')).not.toHaveClass(/lit/);
  await expect(railRow(page, 'tabAwayLong')).not.toHaveClass(/lit/);

  await frozenClock.tabAway(3000, 3001);
  await expect(railRow(page, 'tabAwayMid')).toHaveClass(/lit/);
  await expect(railRow(page, 'tabAwayMid').locator('.n')).toHaveText('1');
  await expect(railRow(page, 'tabAwayLong')).not.toHaveClass(/lit/);
});

// ---------------------------------------------------------------------------
// g. Downloads -> real CLI
// ---------------------------------------------------------------------------
test('downloads e2e: the three downloaded files pipe through the real CLI with zero warnings', async ({ page }) => {
  test.setTimeout(60000);
  const tmpDir = mkdtempSync(join(tmpdir(), 'ch-demo-e2e-'));

  await fastForwardToReplicate(page, { replayOptIn: true });
  const participantId = await pid(page);

  for (const key of ['sessionData', 'replay', 'config']) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator(`[data-action="download"][data-key="${key}"]`).click(),
    ]);
    await download.saveAs(join(tmpDir, download.suggestedFilename()));
  }

  const stdout = execSync(`node ${JSON.stringify(BIN_PATH)} report`, { cwd: tmpDir, encoding: 'utf8' });

  const reportIndex = join(tmpDir, 'cyborg-hunter-report', 'index.html');
  expect(existsSync(reportIndex)).toBe(true);
  const reportHtml = readFileSync(reportIndex, 'utf8');
  expect(reportHtml).toContain(participantId);

  expect(stdout).not.toContain('files had warnings');
  expect(stdout).toContain('Found 1 participants');
});

// ---------------------------------------------------------------------------
// h. Lamp truthfulness
// ---------------------------------------------------------------------------
test('lamp truthfulness: two pastes hard-light with count 2; one copy lights but not hard', async ({ page }) => {
  await startTour(page); // step 2
  await primaryButton(page).click(); // -> step 3 (copy-paste)

  await dispatchCopy(page);
  await expect(railRow(page, 'copy')).toHaveClass(/lit/);
  await expect(railRow(page, 'copy')).not.toHaveClass(/hardlit/);
  await expect(railRow(page, 'copy').locator('.n')).toHaveText('1');

  await dispatchPaste(page, '#card textarea', RULE_TEXT);
  await dispatchPaste(page, '#card textarea', RULE_TEXT);
  await expect(railRow(page, 'paste')).toHaveClass(/lit/);
  await expect(railRow(page, 'paste')).toHaveClass(/hardlit/);
  await expect(railRow(page, 'paste').locator('.n')).toHaveText('2');
});

// ---------------------------------------------------------------------------
// i. Replay opt-in
// ---------------------------------------------------------------------------
test('replay opt-in ON: #rec is visible and the downloaded replay file parses with schema_version', async ({ page }) => {
  test.setTimeout(60000);
  const tmpDir = mkdtempSync(join(tmpdir(), 'ch-demo-e2e-replay-'));

  await startTour(page, { replayOptIn: true });
  await expect(page.locator('#rec')).toBeVisible();
  await expect(page.locator('#rec')).toContainText('REC replay');

  await page.locator('a[data-key="skipToGuardedAct"]').click();
  await page.keyboard.press('Alt+S');
  await primaryButton(page).click(); // jspsych-finale -> results
  await primaryButton(page).click(); // results -> replicate-locally

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="download"][data-key="replay"]').click(),
  ]);
  const savedPath = join(tmpDir, download.suggestedFilename());
  await download.saveAs(savedPath);
  const recording = JSON.parse(readFileSync(savedPath, 'utf8'));
  expect(recording.schema_version).toBe(1);
});

test('replay opt-out: no replay download button is offered', async ({ page }) => {
  await fastForwardToReplicate(page); // replayOptIn defaults to false
  await expect(page.locator('#rec')).toBeHidden();
  await expect(page.locator('[data-action="download"][data-key="replay"]')).toHaveCount(0);
});
