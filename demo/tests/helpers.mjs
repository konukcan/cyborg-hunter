// demo/tests/helpers.mjs
// Shared Playwright fixtures + DOM-automation helpers for tour.spec.js.
//
// Three auto-fixtures apply to every test that imports `test` from this
// module (spec: "page.on('pageerror') accumulated and asserted empty in
// EVERY test" + "an addInitScript fullscreen mock as a shared helper"):
//
//   - pageErrors:    accumulates page.on('pageerror') for the whole test and
//                     asserts it's empty at teardown.
//   - frozenClock:    addInitScript patch of performance.now(), controllable
//                     via window.__chFreezeNow/__chUnfreezeNow. The library's
//                     tab-away duration is `performance.now() - startedAt`
//                     (src/core/signals/focus.js), so freezing the clock
//                     around a blur->focus pair gives an EXACT duration
//                     instead of one subject to real wall-clock jitter —
//                     needed for the 3000ms/3001ms boundary test.
//   - fullscreenMock: addInitScript patch of document.fullscreenElement +
//                     document.documentElement.requestFullscreen, exposing
//                     window.__chExitFullscreen() to simulate the Esc-driven
//                     exit GuardFriction treats as a violation. Headless
//                     Chromium's real Fullscreen API needs a user gesture
//                     and is unreliable in CI, hence the mock.
//
// Both addInitScript patches install before ANY page script runs (including
// dist/*.js and demo.js), so demo.js's raceFullscreenEntry() and
// GuardFriction's fullscreenElementOf()/check() read the patched APIs from
// the very first paint, same as a real implementation would.

import { test as base, expect } from '@playwright/test';

async function installFrozenClock(page) {
  await page.addInitScript(() => {
    let frozen = null;
    const realNow = performance.now.bind(performance);
    performance.now = () => (frozen === null ? realNow() : frozen);
    window.__chFreezeNow = (ms) => { frozen = ms; };
    window.__chUnfreezeNow = () => { frozen = null; };
  });
}

async function installFullscreenMock(page) {
  await page.addInitScript(() => {
    let fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get() { return fsEl; },
    });
    // Patched on Element.prototype rather than the document.documentElement
    // instance directly: addInitScript can run before documentElement exists
    // on the very first (about:blank) document, when the instance is null.
    // The prototype exists as soon as the JS context does, and demo.js reads
    // `document.documentElement.requestFullscreen` fresh at click time (long
    // after the real document has parsed), so the prototype patch is picked
    // up identically to an instance patch would have been.
    Element.prototype.requestFullscreen = function () {
      fsEl = this;
      return Promise.resolve().then(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });
    };
    document.exitFullscreen = function () {
      fsEl = null;
      return Promise.resolve().then(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });
    };
    // Simulates a real participant's Esc keypress: the browser exits
    // fullscreen and fires fullscreenchange with fullscreenElement now null.
    // GuardFriction's check() reads that as reason 'not_fullscreen' exactly
    // the way it would for a real Esc exit — this IS the mechanic step 7's
    // copy describes ("Esc-during-guard is itself the tracked violation").
    window.__chExitFullscreen = function () {
      fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
  });
}

export const test = base.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err));
    await use(errors);
    expect(errors, 'accumulated page errors: ' + errors.map((e) => e.message).join('; ')).toEqual([]);
  }, { auto: true }],

  frozenClock: [async ({ page }, use) => {
    await installFrozenClock(page);
    await use({
      freeze: (ms) => page.evaluate((v) => window.__chFreezeNow(v), ms),
      unfreeze: () => page.evaluate(() => window.__chUnfreezeNow()),
      // Simulates a blur->focus tab-away of EXACTLY durationMs, anchored at
      // baseMs on the frozen clock.
      tabAway: async (baseMs, durationMs) => {
        await page.evaluate((v) => window.__chFreezeNow(v), baseMs);
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await page.evaluate((v) => window.__chFreezeNow(v), baseMs + durationMs);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      },
    });
  }, { auto: true }],

  fullscreenMock: [async ({ page }, use) => {
    await installFullscreenMock(page);
    await use({
      exit: () => page.evaluate(() => window.__chExitFullscreen()),
    });
  }, { auto: true }],
});

export { expect };

// ---- DOM-automation helpers (plain functions, not fixtures) ----

// Dispatches a real ClipboardEvent 'paste' carrying `text`, at `selector`.
// The OS clipboard doesn't work headless, so this exercises the actual
// src/core/signals/clipboard.js listener with real event data — only the OS
// clipboard subsystem is bypassed.
export async function dispatchPaste(page, selector, text) {
  await page.evaluate(([sel, txt]) => {
    const el = document.querySelector(sel);
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', txt);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [selector, text]);
}

// Dispatches a plain 'copy' event on document — clipboard.js's copy listener
// is attached to `document` and only reads window.getSelection(), not
// clipboardData, so no DataTransfer is needed here.
export async function dispatchCopy(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('copy', { bubbles: true }));
  });
}

// Real per-character typing (NOT locator.fill() — that sets .value directly
// and fires a single synthetic 'input', which the library correctly flags
// as synthetic insertion). delayMs defaults to 150ms/char (~6.7 cps),
// comfortably under the standard preset's 10 cps fast-typing threshold.
export async function typeRealistically(locator, text, delayMs = 150) {
  await locator.click();
  await locator.pressSequentially(text, { delay: delayMs });
}

export async function startTour(page, { replayOptIn = false } = {}) {
  await page.goto('/');
  await page.locator('#card h2').waitFor();
  if (replayOptIn) {
    await page.locator('input[type="checkbox"][data-key="replayOptIn"]').check();
  }
  await primaryButton(page).click();
}

// Fast path from a fresh welcome screen to the replicate-locally step (12),
// used by the downloads/replay tests that don't need the intervening steps.
export async function fastForwardToReplicate(page, opts = {}) {
  await startTour(page, opts);
  await page.locator('a[data-key="skipToGuardedAct"]').click();
  await page.keyboard.press('Alt+S');
  await primaryButton(page).click(); // jspsych-finale -> results
  await primaryButton(page).click(); // results -> replicate-locally
}

export function primaryButton(page) {
  return page.locator('#card [data-action="primary"]');
}

export function backButton(page) {
  return page.locator('#card [data-action="back"]');
}

export function railRow(page, key) {
  return page.locator(`#rail li[data-key="${key}"]`);
}

export function pid(page) {
  return page.locator('#pid').textContent();
}
