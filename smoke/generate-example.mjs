// smoke/generate-example.mjs
// Pre-generates ONE finished example (CLI report + replay viewer) so the
// user has something to look at before running their own smoke test.
//
// Adapted from tests/browser/replay/e2e-dogfood.mjs: records a scripted
// participant on the repo's own replay demo page, writes the data dir
// exactly as autosave would, and runs the real CLI report over it — but
// persists the output under smoke/example/ instead of a throwaway tmpdir.
//
// Run: node smoke/generate-example.mjs

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

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
const pw = resolvePlaywright();
if (!pw) { console.error('playwright-core not found — cannot pre-generate the example.'); process.exit(1); }
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const demoUrl = 'file://' + join(repoRoot, 'tests/browser/replay/demo-standalone.html');
const exampleDir = join(here, 'example');
const dataDir = join(exampleDir, 'data');
const reportDir = join(exampleDir, 'report');

rmSync(exampleDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

console.log('recording a scripted participant session on the repo\'s replay demo page...');
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(demoUrl);
await page.evaluate(() => window.CH_E2E.start());
await page.mouse.move(120, 140);
await page.mouse.move(420, 260, { steps: 15 });
await page.click('#card-b');
await page.fill('#answer', 'king of hearts');
await page.evaluate(() => window.CH_E2E.respond());
await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
await page.evaluate(() => window.CH_E2E.nextTrial());
await page.mouse.move(240, 420, { steps: 10 });
await page.click('#card-a');
const recording = await page.evaluate(() => window.CH_E2E.finish());
await page.close();

const pid = recording.metadata.participant_id;
const epoch = Date.parse(recording.metadata.start_time);

console.log('writing the data dir exactly as a study would deliver it...');
const participantFile = {
  participantId: pid,
  trials: recording.trials
    .filter((t) => t.trial_id !== '__session__')
    .map((t, i) => ({
      trialId: t.trial_id,
      integrity: {
        trialId: t.trial_id, participantId: pid, libraryVersion: '0.7.0',
        startTime: 1000 + i * 7000, duration_ms: 5000,
        trialStart_perfNow: 1000 + i * 7000,
        pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [],
        trialSoftScore: 0, trialSignals: {},
        integrityReplayMeta: {
          schema_version: 1, tier: 'dom',
          saved_to: `datapipe:example/${pid}-replay-${epoch}.json`,
          bytes_uncompressed: JSON.stringify(recording).length,
          capture_failures: [], capture_stopped: false,
        },
      },
    })),
};
writeFileSync(join(dataDir, `${pid}.json`), JSON.stringify(participantFile));
writeFileSync(join(dataDir, `${pid}-replay-${epoch}.json`), JSON.stringify(recording));

console.log('running the real CLI report...');
const cliOut = execFileSync('node', [
  join(repoRoot, 'bin', 'cyborg-hunter.js'), 'report',
  '--data', dataDir, '--output', reportDir,
], { encoding: 'utf8', cwd: dataDir });
console.log(cliOut);

if (!existsSync(join(reportDir, 'index.html'))) {
  console.error('report generation did not produce index.html — see CLI output above.');
  process.exit(1);
}

await browser.close();

console.log('Pre-generated example ready:');
console.log('  report:        ' + join(reportDir, 'index.html'));
console.log('  replay asset:  ' + join(reportDir, 'replay', `${pid}.replay.js`));
