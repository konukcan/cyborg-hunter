// tests/browser/replay/capture-chromium.battery.mjs
// The Chromium-only capture battery (T3 Task 9c).
//
// WHY A BROWSER SUITE. Every case here asserts capture-side behaviour the unit
// suites CANNOT express, and each one is a bug the reviews found or a
// divergence they had to work around:
//
//   * happy-dom reports `oldValue: null` for an empty-valued attribute where
//     Chromium reports `""`, so the whole exclusion-toggle family is untestable
//     at unit level (task-3-review I3, which routed eight cases here);
//   * happy-dom leaves `option.defaultSelected` and `select.size` unusable and
//     never synthesizes `C:\fakepath\…` for a file input (task-4-review F8);
//   * Chromium decides for itself how many MutationRecords a task produces and
//     in what order — the mapper's batch pre-scan rests on that shape.
//
// Assertion style follows the sibling suites: hard-labelled checks, exit code
// is the signal. The oracle for "did the player end up with the right tree" is
// tests/replay/support/dom-player.js — the same fork-faithful, dangling-
// intolerant player the unit and fuzz suites judge the mapper against.
//
// Run: node build.js && node tests/browser/replay/capture-chromium.battery.mjs

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createPlayer } from '../../replay/support/dom-player.js';

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
const pageUrl = 'file://' + join(here, 'capture-battery.html');

let failures = 0;
let caseCount = 0;
const results = [];
function check(cond, label) {
  if (cond) { console.log('    ✔ ' + label); }
  else { failures++; console.error('    ✖ ' + label); }
}

const browser = await chromium.launch({ headless: true });

// Each case gets a FRESH PAGE: the redaction taint and the honeypot/friction
// globals are page-lifetime by design (Task 6 M-4), so sharing one page would
// let an earlier case decide a later one's behaviour.
async function withPage(name, fn) {
  caseCount++;
  console.log('\n▶ case ' + caseCount + ' — ' + name);
  const before = failures;
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', (e) => { failures++; console.error('    ✖ pageerror: ' + e.message); });
  await page.goto(pageUrl);
  try {
    await fn(page);
  } catch (e) {
    failures++;
    console.error('    ✖ threw: ' + (e && e.stack ? e.stack : e));
  }
  await page.close();
  results.push({ n: caseCount, name, passed: failures === before });
}

/** The player's tree in the same compact form the page produces for the DOM. */
function shapeOfPlayer(player) {
  const walk = (node) => {
    if (node.nodeType === 3) return JSON.stringify(node.data);
    if (node.nodeType === 8) return '<!--' + node.data + '-->';
    if (node.nodeType !== 1) return '?';
    let s = node.tagName.toLowerCase();
    if (node.id) s += '#' + node.id;
    const kids = [];
    const cn = node.childNodes;
    for (let i = 0; i < cn.length; i++) kids.push(walk(cn[i]));
    return s + '(' + kids.join(',') + ')';
  };
  return walk(player.root);
}

const start = (page, html, cfg) => page.evaluate(
  ({ html, cfg }) => window.BAT.start(html, cfg), { html, cfg: cfg || null });
const task = (page, src) => page.evaluate((s) => window.BAT.task(s), src);
const nextSegment = (page, id) => page.evaluate((i) => window.BAT.nextSegment(i), id);
const finish = (page) => page.evaluate(() => window.BAT.finish());

const kinds = (patches) => patches.map((p) => p.type);
const of = (patches, type) => patches.filter((p) => p.type === type);

// ═══════════════════════════════════════════════════════════════════════════
// EXCLUSION + BATCHING (task-3-review's eight required cases, plus the raw
// oldValue probe that explains why they cannot live in the unit suite)
// ═══════════════════════════════════════════════════════════════════════════

// 1. Exclusion toggle both directions with an EMPTY-VALUED attribute.
await withPage('exclusion toggle, empty-valued attribute, both directions', async (page) => {
  const { keyframe } = await start(page, '<div id="box"><span id="a">x</span><b id="bb">y</b></div>');
  const collapse = await task(page, "stage.querySelector('#box').setAttribute('data-record-exclude','');");
  check(of(collapse, 'dom.remove').length === 2,
    'collapse removes both emitted children (' + kinds(collapse).join(',') + ')');
  const nulls = of(collapse, 'dom.attr').filter((p) => p.value === null).map((p) => p.name).sort();
  check(nulls.includes('id') && nulls.includes('data-record-exclude'),
    'collapse nulls the snapshot attrs AND the exclusion attr itself (' + nulls.join(',') + ')');

  const reveal = await task(page, "stage.querySelector('#box').removeAttribute('data-record-exclude');");
  check(of(reveal, 'dom.add').length === 2,
    'reveal re-adds both children (' + of(reveal, 'dom.add').length + ')');
  check(of(reveal, 'dom.attr').some((p) => p.name === 'id' && p.value === 'box'),
    'reveal restores the placeholder attrs');

  const { recording, finalShape } = await finish(page);
  const player = createPlayer(keyframe);
  player.apply(recording.segments.flatMap((s) => s.events).filter((e) => e.type.startsWith('dom.')));
  check(shapeOfPlayer(player) === finalShape,
    'the player ends holding the live tree after the round trip\n        player: '
      + shapeOfPlayer(player) + '\n        page:   ' + finalShape);
});

// 2. Value change on an already-excluded element emits NOTHING.
//    Chromium reports oldValue "" here; happy-dom reports null and misfires,
//    which is exactly why this assertion has no unit-level home.
await withPage('value change on an already-excluded element emits no patches', async (page) => {
  await start(page, '<div id="box" data-record-exclude><span id="a">x</span></div>');
  const patches = await task(page, "stage.querySelector('#box').setAttribute('data-record-exclude','yes');");
  check(patches.length === 0,
    'no patches for a value change under an already-set exclusion (' + kinds(patches).join(',') + ')');
  await finish(page);
});

// 3. Exclusion added AND removed in the same task emits nothing (guards C2(b)).
await withPage('exclusion added and removed in one task emits no patches', async (page) => {
  const { keyframe } = await start(page, '<div id="box"><span id="a">x</span></div>');
  const patches = await task(page,
    "var b=stage.querySelector('#box'); b.setAttribute('data-record-exclude',''); b.removeAttribute('data-record-exclude');");
  check(patches.length === 0, 'net-effect: no patches (' + kinds(patches).join(',') + ')');
  const { recording, finalShape } = await finish(page);
  const player = createPlayer(keyframe);
  player.apply(recording.segments.flatMap((s) => s.events).filter((e) => e.type.startsWith('dom.')));
  check(shapeOfPlayer(player) === finalShape, 'the player never saw the flicker');
});

// 4. Exclusion added in the same task as the children going away: the
//    placeholder must end EMPTY in the player (guards C1).
await withPage('exclusion + child removal in one task leaves an empty placeholder', async (page) => {
  const { keyframe } = await start(page,
    '<div id="box"><span id="a">x</span><span id="b">y</span></div><p id="after">z</p>');
  const patches = await task(page,
    "var b=stage.querySelector('#box'); b.setAttribute('data-record-exclude',''); b.innerHTML='';");
  check(of(patches, 'dom.remove').length === 2,
    'both children removed even though the batch also removed them (' + of(patches, 'dom.remove').length + ')');
  const { recording } = await finish(page);
  const player = createPlayer(keyframe);
  player.apply(recording.segments.flatMap((s) => s.events).filter((e) => e.type.startsWith('dom.')));
  const box = player.root.querySelector('#box');
  check(box === null || box.childNodes.length === 0,
    'the placeholder holds no children in the player'
      + (box ? ' (' + box.childNodes.length + ')' : ' (placeholder attrs cleared)'));
});

// 5. Populate-then-reveal: each child added exactly once, in document order.
await withPage('populate-then-reveal adds each child exactly once, in order', async (page) => {
  const { keyframe } = await start(page, '<div id="box" data-record-exclude></div>');
  const patches = await task(page,
    "var b=stage.querySelector('#box');"
    + "b.innerHTML='<i id=\"c1\">1</i><i id=\"c2\">2</i><i id=\"c3\">3</i>';"
    + "b.removeAttribute('data-record-exclude');");
  const adds = of(patches, 'dom.add');
  check(adds.length === 3, 'exactly three dom.add (' + adds.length + ')');
  const ids = adds.map((a) => (a.node.attrs || {}).id);
  check(JSON.stringify(ids) === JSON.stringify(['c1', 'c2', 'c3']),
    'added in document order (' + ids.join(',') + ')');
  const { recording, finalShape } = await finish(page);
  const player = createPlayer(keyframe);
  player.apply(recording.segments.flatMap((s) => s.events).filter((e) => e.type.startsWith('dom.')));
  check(shapeOfPlayer(player) === finalShape,
    'player tree equals the live tree\n        player: ' + shapeOfPlayer(player)
      + '\n        page:   ' + finalShape);
});

// 6. Batched moves: append + move-to-end, then insert-before-a-node-that-
//    moves-in-later. The assertion is on the PLAYER's applied DOM, not the
//    event list (task-3-review C3).
await withPage('batched append + move keeps player order equal to DOM order', async (page) => {
  const { keyframe } = await start(page,
    '<div id="box"><span id="s1">1</span><span id="s2">2</span><span id="s3">3</span></div>');
  await task(page,
    "var b=stage.querySelector('#box');"
    + "var n=document.createElement('span'); n.id='s4'; n.textContent='4';"
    + "b.appendChild(n); b.appendChild(b.querySelector('#s1'));");
  await task(page,
    "var b=stage.querySelector('#box');"
    + "var n=document.createElement('span'); n.id='s5'; n.textContent='5';"
    + "b.insertBefore(n, b.querySelector('#s3')); b.appendChild(b.querySelector('#s3'));");
  const { recording, finalShape } = await finish(page);
  const player = createPlayer(keyframe);
  player.apply(recording.segments.flatMap((s) => s.events).filter((e) => e.type.startsWith('dom.')));
  check(shapeOfPlayer(player) === finalShape,
    'player order equals final DOM order\n        player: ' + shapeOfPlayer(player)
      + '\n        page:   ' + finalShape);
});

// 7. A move keeps Chromium's remove-then-add record shape, same-parent and
//    cross-parent — mapChildList's removals-before-insertions rests on it.
await withPage('moves stay remove-then-add, same-parent and cross-parent', async (page) => {
  const { keyframe } = await start(page,
    '<div id="p1"><span id="m">m</span><span id="k">k</span></div><div id="p2"></div>');
  const same = await task(page,
    "var p=stage.querySelector('#p1'); p.appendChild(p.querySelector('#m'));");
  const cross = await task(page,
    "stage.querySelector('#p2').appendChild(stage.querySelector('#m'));");
  for (const [label, patches] of [['same-parent', same], ['cross-parent', cross]]) {
    const removed = of(patches, 'dom.remove').map((p) => p.node);
    const added = of(patches, 'dom.add').map((p) => p.node.id);
    check(removed.length === 1 && added.length === 1 && removed[0] === added[0],
      label + ' move is one remove + one add of the SAME id (' + removed + ' / ' + added + ')');
  }
  const { recording, finalShape } = await finish(page);
  const player = createPlayer(keyframe);
  player.apply(recording.segments.flatMap((s) => s.events).filter((e) => e.type.startsWith('dom.')));
  check(shapeOfPlayer(player) === finalShape, 'player tree equals the live tree after both moves');
});

// 8. Mass append (I1): 250 children into an existing container in one task.
await withPage('mass append of 250 nodes stays linear and complete', async (page) => {
  const { keyframe } = await start(page, '<div id="box"><span id="seed">s</span></div>');
  const t0 = Date.now();
  const patches = await task(page,
    "var b=stage.querySelector('#box'); var f=document.createDocumentFragment();"
    + "for (var i=0;i<250;i++){var d=document.createElement('div'); d.id='n'+i; d.textContent='r'+i; f.appendChild(d);}"
    + "b.appendChild(f);");
  const wall = Date.now() - t0;
  check(of(patches, 'dom.add').length === 250,
    'one dom.add per appended node (' + of(patches, 'dom.add').length + ')');
  check(patches.length === 250, 'and nothing else in the batch (' + patches.length + ')');
  const { recording, finalShape } = await finish(page);
  const player = createPlayer(keyframe);
  player.apply(recording.segments.flatMap((s) => s.events).filter((e) => e.type.startsWith('dom.')));
  check(shapeOfPlayer(player) === finalShape, 'every appended node reached the player, in order');
  console.log('    · mass-append batch wall time incl. two frames: ' + wall + ' ms');
});

// 9. The raw Chromium fact the eight cases above rest on: an empty-valued
//    attribute reports oldValue "" here and `null` in happy-dom, which is why
//    the unit fuzz had to use a non-empty exclusion value.
await withPage('Chromium reports oldValue "" for an empty-valued attribute', async (page) => {
  const changed = await page.evaluate(() =>
    window.BAT.rawOldValue('', "el.setAttribute('data-record-exclude','yes');"));
  check(changed.length === 1 && changed[0].oldValue === '',
    'change from empty-valued: oldValue is "" not null (' + JSON.stringify(changed) + ')');
  const added = await page.evaluate(() =>
    window.BAT.rawOldValue(null, "el.setAttribute('data-record-exclude','');"));
  check(added.length === 1 && added[0].oldValue === null,
    'add of an empty-valued attribute: oldValue is null (' + JSON.stringify(added) + ')');
  const removed = await page.evaluate(() =>
    window.BAT.rawOldValue('', "el.removeAttribute('data-record-exclude');"));
  check(removed.length === 1 && removed[0].oldValue === '',
    'removal of an empty-valued attribute: oldValue is "" (' + JSON.stringify(removed) + ')');
});

// ═══════════════════════════════════════════════════════════════════════════
// FORM SEMANTICS (task-4-review F8: the select/file battery that happy-dom
// cannot express). initial_state is seeded at a KEYFRAME, so each case
// changes state and then opens a new segment with keyframeEvery: 1.
// ═══════════════════════════════════════════════════════════════════════════

const formOf = (seed) => (seed && seed.form) || [];

// 10. defaultSelected semantics: an option carrying the `selected` ATTRIBUTE is
//     the default, so an untouched select seeds nothing; changing away from it
//     does. happy-dom cannot express this (task-4-review scrutiny 3).
await withPage('defaultSelected: attribute-selected option is the default', async (page) => {
  await start(page,
    '<select id="s"><option value="a">a</option><option value="b" selected>b</option></select>',
    { keyframeEvery: 1 });
  const untouched = await nextSegment(page, 'seg-2');
  check(formOf(untouched.initial_state).length === 0,
    'untouched select at its attribute default seeds nothing ('
      + JSON.stringify(untouched.initial_state) + ')');
  await page.selectOption('#s', 'a');
  const changed = await nextSegment(page, 'seg-3');
  const entry = formOf(changed.initial_state)[0];
  check(entry && JSON.stringify(entry.selected) === JSON.stringify(['a']),
    'moving off the default seeds the new selection (' + JSON.stringify(entry) + ')');
  await finish(page);
});

// 11. A real user gesture through Playwright's selectOption, not a scripted
//     property write.
await withPage('real selectOption gesture reaches initial_state', async (page) => {
  await start(page,
    '<select id="s"><option value="s">Spades</option><option value="h">Hearts</option>'
    + '<option value="d">Diamonds</option></select>', { keyframeEvery: 1 });
  await page.selectOption('#s', 'd');
  const seg = await nextSegment(page, 'seg-2');
  const entry = formOf(seg.initial_state)[0];
  check(entry && JSON.stringify(entry.selected) === JSON.stringify(['d']),
    'the gesture-selected option is seeded (' + JSON.stringify(entry) + ')');
  await finish(page);
});

// 12. An untouched <select size="3"> selects NOTHING in a browser, so it must
//     seed nothing — the F3 bug, whose fix rests on a display-size reading
//     happy-dom reports differently.
await withPage('untouched select size=3 seeds nothing', async (page) => {
  await start(page,
    '<select id="s" size="3"><option value="a">a</option><option value="b">b</option></select>',
    { keyframeEvery: 1 });
  const sizeProbe = await page.evaluate(() => ({
    size: document.getElementById('s').size,
    selectedIndex: document.getElementById('s').selectedIndex,
  }));
  check(sizeProbe.selectedIndex === -1,
    'Chromium selects nothing in a size=3 select (selectedIndex ' + sizeProbe.selectedIndex + ')');
  const seg = await nextSegment(page, 'seg-2');
  check(seg.initial_state === null || formOf(seg.initial_state).length === 0,
    'no spurious {selected: []} entry (' + JSON.stringify(seg.initial_state) + ')');
  await finish(page);
});

// 13. <select multiple> with two `selected` attributes, one deselected by the
//     participant.
await withPage('multiple select with a deselection seeds the survivors', async (page) => {
  await start(page,
    '<select id="s" multiple size="3"><option value="a" selected>a</option>'
    + '<option value="b" selected>b</option><option value="c">c</option></select>',
    { keyframeEvery: 1 });
  const untouched = await nextSegment(page, 'seg-2');
  check(formOf(untouched.initial_state).length === 0,
    'both attribute-selected options are the default, so nothing is seeded ('
      + JSON.stringify(untouched.initial_state) + ')');
  await page.selectOption('#s', ['a']);   // deselects b
  const seg = await nextSegment(page, 'seg-3');
  const entry = formOf(seg.initial_state)[0];
  check(entry && JSON.stringify(entry.selected) === JSON.stringify(['a']),
    'the surviving selection is seeded (' + JSON.stringify(entry) + ')');
  await finish(page);
});

// 14. <input type="file"> after a REAL setInputFiles: browsers hand out
//     "C:\fakepath\<name>", which happy-dom never synthesizes, so the
//     SKIP_INPUT_TYPES.file floor has only ever been fault-injection-tested.
await withPage('file input after setInputFiles leaks neither value nor filename', async (page) => {
  await start(page, '<input type="file" id="f">', { keyframeEvery: 1 });
  await page.setInputFiles('#f', {
    name: 'FILESENTINEL-3XQ.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('irrelevant'),
  });
  const shown = await page.evaluate(() => document.getElementById('f').value);
  check(/fakepath/i.test(shown), 'the browser really did expose a fakepath value (' + shown + ')');
  const seg = await nextSegment(page, 'seg-2');
  check(formOf(seg.initial_state).length === 0,
    'the file input is not seeded (' + JSON.stringify(seg.initial_state) + ')');
  const { recording } = await finish(page);
  const json = JSON.stringify(recording);
  check(!json.includes('FILESENTINEL-3XQ'), 'the filename appears nowhere in the recording');
  check(!/fakepath/i.test(json), 'no fakepath value anywhere in the recording');
});

await browser.close();

console.log('\n══ battery summary ══');
for (const r of results) console.log('  ' + (r.passed ? 'pass' : 'FAIL') + '  case ' + r.n + ' — ' + r.name);
if (failures > 0) { console.error(`\n${failures} FAILURE(S) across ${caseCount} cases`); process.exit(1); }
console.log('\nAll ' + caseCount + ' Chromium capture cases passed.');
