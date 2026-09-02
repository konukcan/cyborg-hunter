// tests/browser/replay/capture-fork-smoke.mjs
// THE T3 FINISH LINE — capture → strict-validate → hand to the fork player.
//
// Records a scripted participant session in a real Chromium against the REAL
// built dist (demo-standalone.html loads dist/ exactly as a study would), then
// checks the artifact against the in-repo strict validator and writes it out
// for the fork's smoke test to replay. This is the one place where CH's own
// recorder — not a fixture, not a happy-dom assembly — is the producer.
//
// Run:
//   node build.js && node tests/browser/replay/capture-fork-smoke.mjs
//   node tests/browser/replay/capture-fork-smoke.mjs --out=/path/to/file.json
//
// The artifact lands in tests/browser/replay/artifacts/ (gitignored) and is
// copied by hand into the fork at tests/fixtures/ch-real-capture.json. The
// copy is deliberate rather than automatic: the fork is a separate repo with
// its own review gate, and a test that writes across a repo boundary would
// make "what is in the fixture" depend on when someone last ran this file.
//
// WHAT THE SESSION EXERCISES (all of it required by the T3 plan's Task 9a)
//   * typing into an ordinary field, a REDACTED subtree, an EXCLUDED field
//     and a password field — each with a distinct sentinel string that must
//     appear nowhere in the serialized recording;
//   * mouse movement, clicks, window scroll, element scroll;
//   * DOM mutations (text rewrite, subtree add, subtree remove, attribute);
//   * enough segments, at keyframeEvery=3, to produce BOTH keyframes and
//     continuations (spec §3) — the shape the fork player has to walk.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { validateStrict } from '../../../src/shared/schema-v2-validator.js';

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
if (!pw) {
  console.log('SKIP: playwright-core not found (set PLAYWRIGHT_CORE_DIR or npm i -D playwright-core)');
  process.exit(0);
}
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const demoUrl = 'file://' + join(here, 'demo-standalone.html');
const artifactsDir = join(here, 'artifacts');
const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
const outPath = outArg ? outArg.slice('--out='.length) : join(artifactsDir, 'ch-real-capture.json');

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + label); }
}

// Sentinels: distinct, high-entropy, and DIFFERENT LENGTHS, so a leak cannot
// hide behind a length-only field that happens to match another channel's.
const SENTINELS = {
  redacted: 'REDSENTINEL-7Q4X',
  excluded: 'EXCSENTINEL-88ZK2',
  password: 'PWSENTINEL-1M',
  clipboard: 'CLIPSENTINEL-QQ903F',
};
const TYPED_OK = 'king of hearts';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => { failures++; console.error('  ✖ pageerror: ' + e.message); });

console.log('▶ recording a scripted participant session (real dist, real Chromium)');
await page.goto(demoUrl);
// keyframeEvery: 3 — one keyframe then at most two continuations, so a
// six-segment session carries both kinds however the size trigger fires.
await page.evaluate(() => window.CH_E2E.start({ keyframeEvery: 3 }));

// ── segment 1: mouse, click, typing on every privacy channel ──
await page.mouse.move(100, 120);
await page.mouse.move(320, 240, { steps: 10 });
await page.click('#card-b');
await page.fill('#answer', TYPED_OK);
await page.check('#confident');
await page.fill('#secret', SENTINELS.password);
await page.fill('#redacted-note', SENTINELS.redacted);
await page.fill('#excluded-note', SENTINELS.excluded);
await page.selectOption('#suit', 'h');
await page.evaluate((text) => {
  const dt = new DataTransfer();
  dt.setData('text', text);
  document.getElementById('answer').dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
}, SENTINELS.clipboard);
await page.evaluate(() => window.CH_E2E.respond());
await page.waitForTimeout(80);

// ── segments 2..6: mutations, scrolling, more input ──
for (let n = 2; n <= 6; n++) {
  await page.evaluate((id) => window.CH_E2E.nextTrial(id), 'trial-' + n);
  await page.evaluate((i) => window.CH_E2E.mutate(i), n);
  await page.mouse.move(200 + n * 20, 300 + n * 10, { steps: 6 });
  if (n === 3) {
    await page.evaluate(() => window.scrollTo(0, 260));
    await page.evaluate(() => { document.getElementById('scrollbox').scrollTop = 120; });
  }
  if (n === 4) await page.click('#card-a');
  if (n === 5) await page.fill('#answer', 'seven of spades');
  if (n === 6) await page.fill('#redacted-note', SENTINELS.redacted + '-again');
  await page.waitForTimeout(80);
}

const recording = await page.evaluate(() => window.CH_E2E.finish());
await browser.close();

const json = JSON.stringify(recording);

// ── stats ──────────────────────────────────────────────────────────────────
const segments = recording.segments || [];
const keyframes = segments.filter((s) => s.initial_dom !== null);
const continuations = segments.filter((s) => s.initial_dom === null);
const events = segments.reduce((a, s) => a + s.events.length, 0);
const types = {};
for (const s of segments) for (const e of s.events) types[e.type] = (types[e.type] || 0) + 1;
console.log('\n▶ recording stats');
console.log('  segments      : ' + segments.length + ' (' + keyframes.length + ' keyframe, '
  + continuations.length + ' continuation)');
console.log('  events        : ' + events);
console.log('  bytes         : ' + json.length);
console.log('  event types   : ' + Object.keys(types).sort().map((k) => k + '=' + types[k]).join(' '));
console.log('  initial_state : ' + segments.filter((s) => s.initial_state !== null).length + ' segment(s) seeded');

// ── strict validation ──────────────────────────────────────────────────────
console.log('\n▶ strict profile (src/shared/schema-v2-validator.js)');
const res = validateStrict(json);
if (!res.ok) {
  for (const e of res.errors) console.error('    ' + e);
}
check(res.ok, 'validateStrict().ok on a REAL captured recording (' + res.errors.length + ' errors)');

// ── shape the fork player depends on ───────────────────────────────────────
console.log('\n▶ v2 shape');
check(recording.schema_version === 2, 'schema_version is 2');
check(recording.recorder && recording.recorder.name === 'cyborg-hunter-replay',
  'recorder identity carried (' + (recording.recorder || {}).name + ')');
check(recording.participant_id === 'E2E-P1', 'participant_id at the top level');
check(keyframes.length >= 2, 'at least two keyframes (' + keyframes.length + ')');
check(continuations.length >= 1, 'at least one continuation (' + continuations.length + ')');
check(segments[0].initial_dom !== null, 'first DOM-bearing segment is a keyframe (§3)');
check(events > 50, 'the session carries a real event stream (' + events + ')');
const seeded = segments.filter((s) => s.initial_state !== null);
check(seeded.length >= 1, 'at least one segment carries an initial_state seed');
check(seeded.some((s) => s.initial_state.scroll && s.initial_state.scroll.y > 0),
  'a seed carries the inherited window scroll');
check(seeded.some((s) => (s.initial_state.element_scroll || []).length > 0),
  'a seed carries element scroll');
check(seeded.some((s) => (s.initial_state.form || []).length > 0),
  'a seed carries form IDL state');

// ── privacy floors: the whole-file scan ────────────────────────────────────
console.log('\n▶ leak sentinels (whole-file scan)');
for (const [channel, sentinel] of Object.entries(SENTINELS)) {
  check(!json.includes(sentinel), channel + ' sentinel appears nowhere in the recording');
}
// A scan of a channel that carried nothing passes forever. Prove each channel
// was actually driven, using what the wire DOES keep.
const allEvents = segments.flatMap((s) => s.events);
check(allEvents.some((e) => e.type === 'input.value' && e.value === TYPED_OK),
  'the UNREDACTED field did reach the wire (so the scan is over a live session)');
check(allEvents.some((e) => e.redacted === true),
  'at least one event took the redacted variant');
check(allEvents.some((e) => e.type === 'clipboard.paste'),
  'the clipboard channel fired (length-only by default)');

// ── no live v1 vocabulary ──────────────────────────────────────────────────
console.log('\n▶ v1 vocabulary is gone from the wire');
// v1 tagged every EVENT with `kind`. v2 keeps the word for two structural
// enums — DomNode.kind (§4) and Stylesheet.kind (§2) — so the check is that no
// event carries one and that every surviving occurrence is one of those.
check(!allEvents.some((e) => 'kind' in e), 'no event carries a v1 "kind" field');
const kindValues = [...new Set((json.match(/"kind":"[^"]*"/g) || []))];
check(kindValues.every((k) => ['"kind":"element"', '"kind":"text"', '"kind":"comment"',
  '"kind":"inline"', '"kind":"link"'].includes(k)),
  'every "kind" on the wire is a v2 DomNode/Stylesheet kind (' + kindValues.join(' ') + ')');
check(!json.includes('ch:capture_stopped'), 'no ch:capture_stopped');
check(!json.includes('data-chn-'), 'no marker attribute stamped into the DOM');
check(!('trials' in recording) && !('metadata' in recording), 'no v1 trials/metadata containers');

// ── write it out ───────────────────────────────────────────────────────────
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(recording, null, 0));
console.log('\nartifact: ' + outPath);
console.log('  copy into the fork as tests/fixtures/ch-real-capture.json to run the fork smoke test');

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nCapture → strict-validate passed. The artifact is ready for the fork player.');
