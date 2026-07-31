// demo/tests/helpers.mjs
// Shared Playwright fixtures + DOM-automation helpers for tour.spec.js
// (13-step remodel). Rewritten for D1 — keeps the v1 helper PATTERNS proven
// against headless Chromium (see each section below for why), drops the
// teaser/finale/Alt+S helpers the remodel deleted, and rewrites the
// fast-forward helper for the new step map.
//
// Three auto-fixtures apply to every test that imports `test` from this
// module:
//
//   - pageErrors:    accumulates page.on('pageerror') for the whole test and
//                     asserts it's empty at teardown.
//   - frozenClock:    addInitScript patch of performance.now(), controllable
//                     via window.__chFreezeNow/__chUnfreezeNow. The library's
//                     tab-away duration is `performance.now() - startedAt`
//                     (src/core/signals/focus.js), so freezing the clock
//                     around a blur->focus pair gives an EXACT duration
//                     instead of one subject to real wall-clock jitter.
//   - fullscreenMock: addInitScript patch of document.fullscreenElement +
//                     Element.prototype.requestFullscreen, exposing
//                     window.__chExitFullscreen() to simulate the Esc-driven
//                     exit GuardFriction treats as a violation. Headless
//                     Chromium's real Fullscreen API needs a user gesture
//                     and is unreliable in CI, hence the mock. Defaults to
//                     ALWAYS SUCCEEDING; installFailingFullscreenMock()
//                     below layers a rejecting override on top for the two
//                     tests that need the fallback path.
//
// Both addInitScript patches install before ANY page script runs (including
// dist/*.js and demo.js), so demo.js's raceFullscreenEntry() and
// GuardFriction's fullscreenElementOf()/check() read the patched APIs from
// the very first paint, same as a real implementation would.
//
// One thing driving the live page during D1 disproved: dispatching a
// synthetic 'blur' Event on window does NOT make GuardFriction log a
// violation. Its check() reads document.hasFocus() — real browser focus
// state, unaffected by a synthetic event — so a bare blur dispatch is a
// no-op there (unlike src/core/signals/focus.js's tab-away detector, which
// listens to the same 'blur' event directly and DOES fire on it). The
// reliable, already-proven mechanism for a guard violation is the fullscreen
// mock's exit() (the Esc-exit path), used below.

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
    // the way it would for a real Esc exit.
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

// Layers a rejecting override on top of the (already-installed, auto-fixture)
// succeeding fullscreen mock — a later addInitScript's property assignment
// wins over an earlier one on the same navigation, verified by driving the
// live page. Must be called BEFORE page.goto()/startTour() so it's in place
// for the very first navigation.
export async function installFailingFullscreenMock(page) {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = function () {
      return Promise.reject(new Error('mock: fullscreen entry unavailable'));
    };
  });
}

// Wraps URL.createObjectURL/revokeObjectURL to count calls on
// window.__chBlobCounts — the C2/C3 live-URL invariant tour.spec.js checks
// (swapIframe revokes the PREVIOUS blob url only after the new one loads, so
// created - revoked should equal the number of "no-previous-url-yet" swaps
// still outstanding: 1 after the first report build + any playground
// reruns). Must be called BEFORE page.goto() (like the fullscreen override
// above) so the wrapper is in place before demo.js's first report build.
export async function installBlobCounter(page) {
  await page.addInitScript(() => {
    window.__chBlobCounts = { created: 0, revoked: 0 };
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (b) { window.__chBlobCounts.created++; return origCreate(b); };
    URL.revokeObjectURL = function (u) { window.__chBlobCounts.revoked++; return origRevoke(u); };
  });
}

export async function startTour(page) {
  await page.goto('/');
  await page.locator('#card h2').waitFor();
  await primaryButton(page).click();
}

// Polls a rail lamp (#rail li[data-key]) until it's lit (and, if opts.hard,
// hardlit too). Two rail signals have NO onSignal event and are only ever
// observable via demo.js's 5s pollSessionSignals() — viewport shifts
// (ResizeObserver never fires a signal) and the honeypot bait (GuardHoneypot
// exposes only a polled getter). A real-time wait for the actual poll tick
// (v1's proven pattern for the sidebar/viewport lamp — see git history) is
// simpler and no less deterministic than faking setInterval: the poll WILL
// fire within one interval, so a generous timeout beyond 5s never flakes.
export async function waitForLamp(page, key, { hard = false, timeout = 7000 } = {}) {
  await page.waitForFunction(([k, h]) => {
    const el = document.querySelector('#rail li[data-key="' + k + '"]');
    return !!el && el.classList.contains('lit') && (!h || el.classList.contains('hardlit'));
  }, [key, hard], { timeout });
}

// Fast path from a fresh welcome screen to the replicate-locally step (13):
// baseline -> skip to the guarded act -> enter fullscreen (default succeeding
// mock) -> end the guard immediately (no violation needed for this path) ->
// debrief -> signals-to-scores -> results (waits for the report to actually
// build) -> replicate-locally. Used by tests that need SOME session data and
// the downloads step without walking every act-1 step.
export async function fastForwardToReplicate(page) {
  await startTour(page); // -> baseline (step 2)
  await page.locator('a[data-key="skipToGuardedAct"]').click(); // -> guard-entry (step 8)
  await page.locator('[data-action="enter-fullscreen"]').click();
  await expect(page.locator('.eyebrow')).toContainText('Step 9 of 13', { timeout: 5000 }); // guard-cheat
  await page.locator('.endguard').click(); // -> guard-debrief (step 10)
  await primaryButton(page).click(); // -> signals-to-scores (step 11)
  await primaryButton(page).click(); // -> results (step 12)
  await page.locator('.yourreport h3').waitFor({ timeout: 8000 });
  await primaryButton(page).click(); // -> replicate-locally (step 13)
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

// The report's own frameLocator — Playwright pierces the iframe's opaque
// (sandbox="allow-scripts", no allow-same-origin) origin fine; only real
// browser same-origin policy would block script-level access, not
// Playwright's out-of-process automation.
export function resultsFrame(page) {
  return page.frameLocator('.results-frame');
}
