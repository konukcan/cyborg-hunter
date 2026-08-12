// tools/gen-demo-fixture.mjs
//
// Regenerates the demo fixture's REPLAY ARTIFACT (tests/fixtures/demo/
// DEMO-FIXT-replay-<epoch>.json) by DRIVING THE REAL demo tour in headless
// Chromium and capturing the replay file the "Replicate locally" step hands
// out. Since the recorder/serializer moved to SessionRecording v2 (Phase A:
// A1/A2), a fresh capture produces a v2 artifact in place of the pre-A6
// (schema_version 1) one — this is A6, the demo-regeneration step that takes
// the ingest version-warning demo-fixture.test.js checks back to zero.
//
// SCOPE — replay artifact only. The session file (DEMO-FIXT.json) and config
// (cyborg-hunter.config.json) are FROZEN reference fixtures: plot-cores.test.js
// and html-index-snapshot.test.js bake this exact session's trial ids, counts,
// timings, and window geometry into hand-derived assertions and committed draw
// snapshots. They carry no schema_version and are unaffected by the v1→v2
// migration, so this generator leaves them untouched. The replay and session
// were never a 1:1 trial mapping (the recorder and the monitor bracket trials
// under different schemes); the replay is a v2 companion to the frozen session,
// paired by participant_id — which is all ingest uses to attach it.
//
// Reproducible, like the other tools/gen-*.mjs generators:
//   node tools/gen-demo-fixture.mjs
// It assembles .demo-site/ (the same artifact Pages CI + the Playwright suite
// use), serves it, walks the full tour (baseline typing + two pastes → advance
// through the optional tasks → a clean, violation-free pass through the guarded
// act → replicate-locally), captures the replay download via the browser's own
// download event, rewrites the random per-session pid to the stable DEMO-FIXT,
// and overwrites the committed replay file.
//
// Two post-capture rewrites keep the committed fixture stable and honest — the
// same synthetic-fixture discipline the README documents for the pid and
// gen-example-fixtures.mjs uses for its EPOCH:
//   - pid: the demo assigns a random 'DEMO-'+4-base36 id per session; a
//     committed fixture needs a fixed one, so every occurrence of the captured
//     id (the top-level participant_id and the pid text the topbar renders into
//     each segment's DOM snapshot) is replaced with DEMO-FIXT via a whole-file
//     string swap of the full 'DEMO-xxxx' token (distinctive; no collisions).
//   - the wall-clock anchor (recording_started_at) is pinned to the fixture's
//     existing filename epoch so the file OVERWRITES IN PLACE under the same
//     name rather than churning to a fresh epoch each run. Only the wall-clock
//     anchor is pinned; the recording's relative event timeline (perf-now
//     offsets, segment origins, durations) is the untouched real capture, so
//     playback is exactly what the recorder produced.
//
// Environment: uses playwright-core (resolved from openclaw when the repo has
// no local install), NOT @playwright/test — the same direct-drive pattern
// e2e-dogfood.mjs uses, so it runs in the batteries' environment.
//
// Flags:
//   --keep-site   leave the served .demo-site/ running for debugging

import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'demo');
const PORT = 8188;
const BASE = `http://localhost:${PORT}`;
const ANSWER = 'Canberra';

// The existing committed replay filename's epoch. Pinning recording_started_at
// to this keeps the fixture a single, same-named, in-place overwrite.
const PINNED_EPOCH = 1785352263344;

// ── playwright-core resolution (mirrors e2e-dogfood.mjs) ───────────────────
function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    import.meta.url,
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/',
  ].filter(Boolean);
  for (const base of candidates) {
    try { return createRequire(base)('playwright-core'); } catch { /* next */ }
  }
  return null;
}

// The fullscreen mock helpers.mjs installs: headless Chromium's real
// Fullscreen API needs a user gesture and is unreliable, so the guarded act's
// enter-fullscreen step is faked to SUCCEED (no violation — the exit path is
// never called). Same script as demo/tests/helpers.mjs installFullscreenMock.
function fullscreenMockInit() {
  let fsEl = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get() { return fsEl; },
  });
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
}

function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not come up: ' + url));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

async function main() {
  const keepSite = process.argv.includes('--keep-site');

  // 1. Assemble the deployable site (build.js if stale + preview-core + copy).
  console.log('gen-demo-fixture: assembling .demo-site/');
  execFileSync(process.execPath, ['tools/assemble-demo-site.mjs'], { cwd: ROOT, stdio: 'inherit' });

  // 2. Serve it with the same dependency-free static server the E2E suite uses.
  console.log('gen-demo-fixture: serving .demo-site/ on ' + BASE);
  const server = spawn(process.execPath, ['tools/serve-demo.mjs', String(PORT)],
    { cwd: ROOT, stdio: 'inherit' });
  const shutdown = () => { try { server.kill(); } catch { /* already dead */ } };

  let failed = false;
  try {
    await waitForServer(BASE + '/');

    const pw = resolvePlaywright();
    if (!pw) throw new Error('playwright-core not found (set PLAYWRIGHT_CORE_DIR)');
    const { chromium } = pw;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    await context.addInitScript(fullscreenMockInit);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const waitForStep = (n) => page.waitForFunction(
      (label) => {
        const el = document.querySelector('.eyebrow');
        return !!el && el.textContent.indexOf(label) !== -1;
      }, `Step ${n} of`, { timeout: 15000 });
    const clickPrimary = () => page.locator('#card [data-action="primary"]').click();
    const dispatchPaste = (sel, txt) => page.evaluate(([s, t]) => {
      const el = document.querySelector(s);
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [sel, txt]);

    // ── walk the whole tour so the replay brackets every step's segment ─────
    console.log('gen-demo-fixture: driving the tour');
    await page.goto(BASE + '/');
    await page.locator('#card h2').waitFor();
    await clickPrimary();                        // → step 2 (baseline)
    await waitForStep(2);

    // Real per-character typing on the clean baseline (never .value=/fill(),
    // which the library flags as synthetic insertion).
    await page.locator('#card textarea').click();
    await page.locator('#card textarea').pressSequentially('a city in Australia', { delay: 150 });
    await clickPrimary();                         // → step 3 (clipboard cheat)
    await waitForStep(3);

    // Two real dispatched 'paste' events cross the standard preset's paste HARD
    // threshold (2). OS clipboard is unreliable headless; a genuine
    // ClipboardEvent carrying real text exercises the actual listener.
    await dispatchPaste('#card textarea', ANSWER);
    await dispatchPaste('#card textarea', ANSWER);
    await clickPrimary();                         // → step 4 (tab-away)
    await waitForStep(4);
    // Steps 4-6 are optional tasks; advancing without performing them is a
    // supported path and brackets each step's replay segment all the same.
    await clickPrimary();                         // → step 5 (rearrange)
    await waitForStep(5);
    await clickPrimary();                         // → step 6 (autotype)
    await waitForStep(6);
    await clickPrimary();                         // → step 7 (guard-entry)
    await waitForStep(7);
    await page.locator('[data-action="enter-fullscreen"]').click();
    await waitForStep(8);                         // guard-cheat (fullscreen mock succeeded)
    await page.locator('.endguard').click();      // → step 9, ended clean (no violation)
    await waitForStep(9);
    await clickPrimary();                         // → step 10 (signals-to-scores)
    await waitForStep(10);
    await clickPrimary();                         // → step 11 (results)
    await waitForStep(11);
    await page.locator('.yourreport h3').waitFor({ timeout: 10000 });
    await clickPrimary();                         // → replicate-locally
    await page.locator('[data-action="download"][data-key="replay"]').waitFor({ timeout: 10000 });

    // ── capture the replay download only ────────────────────────────────────
    console.log('gen-demo-fixture: capturing the replay download');
    const tmp = mkdtempSync(join(tmpdir(), 'ch-demo-fixt-'));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-action="download"][data-key="replay"]').click(),
    ]);
    const dlPath = join(tmp, download.suggestedFilename());
    await download.saveAs(dlPath);
    const rawReplay = readFileSync(dlPath, 'utf8');

    if (pageErrors.length) throw new Error('page errors during capture: ' + pageErrors.join('; '));
    await browser.close();

    // ── rewrite the pid + pin the anchor, then write the replay in place ────
    const capturedPid = JSON.parse(rawReplay).participant_id;
    if (!/^DEMO-/.test(capturedPid)) throw new Error('unexpected pid: ' + capturedPid);

    // String swap first (catches the pid the topbar renders into the segment
    // DOM snapshots, not just the participant_id field), then parse + pin.
    const swapped = rawReplay.split(capturedPid).join('DEMO-FIXT');
    const replay = JSON.parse(swapped);
    if (replay.schema_version !== 2) throw new Error('expected v2 recording, got ' + replay.schema_version);
    if (replay.participant_id !== 'DEMO-FIXT') throw new Error('replay pid rewrite failed');
    replay.recording_started_at = new Date(PINNED_EPOCH).toISOString();

    const out = JSON.stringify(replay, null, 2) + '\n';
    if (out.indexOf(capturedPid) !== -1) throw new Error('captured pid still present after rewrite');

    const replayName = `DEMO-FIXT-replay-${PINNED_EPOCH}.json`;
    writeFileSync(join(FIXTURE_DIR, replayName), out);

    console.log('gen-demo-fixture: wrote ' + replayName);
    console.log('  schema_version 2, ' + replay.segments.length + ' segments: '
      + replay.segments.map((s) => s.label).join(', '));
    console.log('  captured pid ' + capturedPid + ' → DEMO-FIXT (from ' + download.suggestedFilename() + ')');
    console.log('  session + config left frozen (DEMO-FIXT.json, cyborg-hunter.config.json)');
  } catch (e) {
    failed = true;
    console.error('gen-demo-fixture FAILED: ' + e.message);
  } finally {
    if (!keepSite) shutdown();
  }
  process.exit(failed ? 1 : 0);
}

main();
