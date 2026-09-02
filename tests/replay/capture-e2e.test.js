// tests/replay/capture-e2e.test.js
// The whole recorder, end to end, against a real (happy-dom) document:
// attach → keyframes → interactions and mutations → stop → serialize, with the
// output run through the strict conformance profile.
//
// Every other suite tests one module against inputs the test wrote. This one
// tests the ASSEMBLY (index.js): that the span reaches both capture modules so
// an event's `target` and a patch's `node` are the same numbering, that the
// redaction taint is shared so content withheld in one channel stays withheld
// in the other, and that what comes out the far end is a v2 recording rather
// than a collection of individually valid parts.
//
// Two machine checks stand in for a reviewer reading the JSON:
//   - validateStrict on the serialized output (spec §11's producer profile);
//   - a LEAK SENTINEL: distinctive strings typed into a redacted field and
//     into an excluded one appear NOWHERE in the file (spec §8's conformance
//     property, and §4's for the excluded case).

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

import * as CHReplay from '../../src/replay/index.js';
import { validateStrict } from '../../src/shared/schema-v2-validator.js';
import { createPlayer } from './support/dom-player.js';

// ONE SENTINEL PER CHANNEL. Spec §8 names the channels it closes — initial_dom
// attributes, initial_state.form, dom.text/dom.attr, key identity, clipboard,
// anchor identity — and a scan is only a scan of the channels the scripted
// session actually drives. The first version of this file typed exclusively
// through the `.value` IDL property, so no `value` ATTRIBUTE ever existed
// inside a withheld subtree and two of the three channels §8 names by name
// were never live: removing their guards changed nothing observable here.
//
// Distinct strings rather than one, so a failure says WHICH channel leaked.
// Distinct LENGTHS where a length is itself permitted: `value_len` is the one
// thing a redacted event may carry, so the excluded field's silence is only
// checkable if its length cannot be confused with the redacted one's.
const REDACTED_SENTINEL = 'ZQREDACTEDSECRET42';            // password IDL value
const REDACTED_ATTR_SENTINEL = 'ZQREDACTEDATTRIBUTE7';     // value ATTRIBUTE, redacted subtree
const REDACTED_FORM_SENTINEL = 'ZQREDACTEDFORMSTATE55';    // IDL value → initial_state.form
const EXCLUDED_SENTINEL = 'ZQBAITTYPEDVALUE9999999999';    // bait IDL value
const EXCLUDED_ATTR_SENTINEL = 'ZQBAITATTRIBUTE31';        // bait value ATTRIBUTE

// The same two channels again, driven from inside a CONTINUATION segment. A
// continuation is the one segment kind that takes no keyframe and resets
// nothing, so every withholding decision it makes is carried by the mutation
// and event paths alone — no fresh snapshot re-derives them. Separate strings
// so a leak names the segment kind as well as the channel.
const CONT_REDACTED_SENTINEL = 'ZQCONTREDACTED808';        // password IDL value
const CONT_REDACTED_ATTR_SENTINEL = 'ZQCONTREDACTEDATTR909'; // value ATTRIBUTE
const CONT_EXCLUDED_SENTINEL = 'ZQCONTBAITVALUE7070707070';  // bait IDL value

const ALL_SENTINELS = [
  ['password IDL value', REDACTED_SENTINEL],
  ['value attribute in a redacted subtree', REDACTED_ATTR_SENTINEL],
  ['redacted form state (initial_state.form)', REDACTED_FORM_SENTINEL],
  ['excluded IDL value', EXCLUDED_SENTINEL],
  ['excluded value attribute', EXCLUDED_ATTR_SENTINEL],
  ['password IDL value, in a continuation', CONT_REDACTED_SENTINEL],
  ['value attribute in a redacted subtree, in a continuation', CONT_REDACTED_ATTR_SENTINEL],
  ['excluded IDL value, in a continuation', CONT_EXCLUDED_SENTINEL],
];

// The bait marker sits on the INPUT ITSELF, not on a wrapper: that is the shape
// CH's own honeypot ships (extension-guard-honeypot.js stamps the marker on the
// bait input), and it is the only shape in which the exclusion guard in
// initial-state.js is reachable — a control merely INSIDE an excluded container
// is never delivered, so the delivery check stops the seed before exclusion is
// consulted, and removing the exclusion check changes nothing.
const PAGE = `
  <div id="stage">
    <p id="msg">Which card wins?</p>
    <button id="go">Go</button>
    <div id="pane" style="overflow:auto;height:40px">scrollable</div>
    <input id="answer" type="text">
    <input id="secret" type="password">
    <div data-ch-redact id="private">
      <input id="private-text" type="text" value="${REDACTED_ATTR_SENTINEL}">
    </div>
    <div id="bait">
      <input id="bait-field" data-record-exclude type="text" value="${EXCLUDED_ATTR_SENTINEL}">
    </div>
  </div>
`;

let win;
let saved;
// Frames capture-trace will schedule onto. See `settle()`.
let rafQueue = [];

// The capture modules read the real globals (that is the browser contract);
// the assembly passes them no environment. So the globals ARE the fixture.
function installWindow() {
  win = new Window({ url: 'https://example.org/exp/' });
  win.document.body.innerHTML = PAGE;
  saved = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.MutationObserver = win.MutationObserver;
  // OWNED FRAMES, not slept-through ones — see `settle()`. capture-trace picks
  // this up through the same `typeof requestAnimationFrame` probe it uses in a
  // browser (`capture-trace.js:113-115`), so nothing about the module under
  // test changes; only who decides when a frame happens.
  rafQueue = [];
  globalThis.requestAnimationFrame = function (fn) { return rafQueue.push(fn); };
}

function restoreWindow() {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
  globalThis.MutationObserver = saved.MutationObserver;
  if (saved.requestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = saved.requestAnimationFrame;
  rafQueue = [];
}

// capture-trace coalesces input, scroll, touch and viewport state through
// `requestAnimationFrame`, and the MutationObserver delivers on its own
// schedule. This used to be a fixed 40 ms sleep draining capture-trace's 16 ms
// no-rAF FALLBACK plus that delivery — a wall-clock budget, and the only one in
// the replay suite. `node --test` runs the suite's files in parallel, so on a
// loaded machine 40 ms is a race rather than a margin, and it is the leading
// candidate for the single unreproduced failure in T5.8's run. (T5.8 fix,
// review M-7.)
//
// So the frames are OURS: `installWindow` gives the module a queueing
// `requestAnimationFrame`, and this DRAINS it — repeatedly, because a flush can
// push records that re-arm the next frame, so "empty once" is not "settled".
// `setImmediate` sits after the microtask checkpoint AND after 0 ms timers, so
// each pass also drains MutationObserver delivery. No clock is consulted.
async function settle() {
  let quiet = 0;
  for (let i = 0; i < 50 && quiet < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (rafQueue.length) {
      const frames = rafQueue.splice(0);
      frames.forEach((fn) => fn(0));
      quiet = 0;
    } else {
      quiet++;
    }
  }
}

function fire(el, type, init) {
  el.dispatchEvent(new win.Event(type, Object.assign({ bubbles: true }, init)));
}

function key(el, type, k) {
  el.dispatchEvent(new win.KeyboardEvent(type, { bubbles: true, key: k, code: 'Key' + k }));
}

// A scripted session: three bracketed trials with DOM mutations, typing (plain,
// redacted and excluded), clicks, and an element scroll.
//
// `keyframeEvery: 2` fixes the cadence so the shape is a chain rather than an
// accident of size: segment 0 keyframes (§3 requires the first one to), segment
// 1 CONTINUES it, and segment 2 opens the next span. The scripted mutations are
// far too small to trip the size trigger, and the assertions state the shape, so
// a cadence change shows up as a failure here rather than as a quiet reshuffle.
async function record() {
  const doc = win.document;
  const api = CHReplay.attach({
    participantId: 'P-E2E-01', tier: 'dom', root: '#stage',
    keyframeEvery: 2, autoSave: { mode: 'none' },
  });
  api.startSession();

  api.startTrial({ trialId: 'trial-1', plugin: 'ch:standalone' });

  // A click on a real element, with its anchor and camera blocks.
  fire(doc.getElementById('go'), 'click');

  // Typing that must reach the file…
  const answer = doc.getElementById('answer');
  answer.value = 'ace of spades';
  key(answer, 'keydown', 'a');
  fire(answer, 'input');

  // …typing that must not, in either channel.
  const secret = doc.getElementById('secret');
  secret.value = REDACTED_SENTINEL;
  key(secret, 'keydown', 'Z');
  fire(secret, 'input');

  const bait = doc.getElementById('bait-field');
  bait.value = EXCLUDED_SENTINEL;
  key(bait, 'keydown', 'Z');
  fire(bait, 'input');

  // Two more channels §8 names, which typing alone does not reach.
  // The ATTRIBUTE channel: a page that mirrors input into a `value` attribute
  // drives both the keyframe's `attrs` and a `dom.attr` patch.
  const privateText = doc.getElementById('private-text');
  privateText.setAttribute('value', REDACTED_ATTR_SENTINEL + 'X');
  // The IDL channel that outlives the segment: this diverges from the
  // attribute, so trial 2's keyframe seed would carry it (spec §3
  // initial_state.form) if the withholding guard were not there. A password
  // cannot serve here — it is skipped by type before redaction is consulted.
  privateText.value = REDACTED_FORM_SENTINEL;
  key(privateText, 'keydown', 'Z');
  fire(privateText, 'input');

  // A DOM mutation the observer must turn into dom.* patches.
  const feedback = doc.createElement('div');
  feedback.className = 'feedback';
  feedback.textContent = 'Correct!';
  doc.getElementById('stage').appendChild(feedback);
  doc.getElementById('msg').setAttribute('class', 'answered');
  doc.getElementById('msg').firstChild.data = 'Round over';
  await settle();

  // An element scroll, which also seeds the NEXT keyframe (spec §3).
  const pane = doc.getElementById('pane');
  Object.defineProperty(pane, 'scrollTop', { value: 60, configurable: true });
  fire(pane, 'scroll');
  await settle();

  api.endTrial();

  // ── segment 1: a CONTINUATION (spec §3) ──
  // No keyframe, no seed, no span reset — everything below addresses the nodes
  // segment 0's keyframe numbered, and every privacy floor has to hold with no
  // fresh snapshot behind it.
  api.startTrial({ trialId: 'trial-2', plugin: 'ch:standalone' });

  fire(doc.getElementById('go'), 'click');          // anchor into the old span
  doc.getElementById('stage').removeChild(feedback);
  doc.getElementById('msg').firstChild.data = 'Next round';

  secret.value = CONT_REDACTED_SENTINEL;
  key(secret, 'keydown', 'Q');
  fire(secret, 'input');

  bait.value = CONT_EXCLUDED_SENTINEL;
  key(bait, 'keydown', 'Q');
  fire(bait, 'input');

  privateText.setAttribute('value', CONT_REDACTED_ATTR_SENTINEL);
  await settle();
  api.endTrial();

  // ── segment 2: the next keyframe ──
  api.startTrial({ trialId: 'trial-3', plugin: 'ch:standalone' });
  await settle();
  api.endTrial();

  api.stopSession('finished');
  const recording = api.getRecording();
  api.destroy();
  return recording;
}

describe('end-to-end capture → v2 recording', () => {
  let recording;

  before(async () => {
    installWindow();
    try { recording = await record(); } finally { restoreWindow(); }
  });

  it('strict-validates as a SessionRecording v2 (spec §11 producer profile)', () => {
    const result = validateStrict(recording);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('carries what the session actually did', () => {
    assert.equal(recording.schema_version, 2);
    assert.equal(recording.participant_id, 'P-E2E-01');
    assert.equal(recording.observed_root, '#stage');
    assert.equal(recording.segments.length, 3);
    assert.deepEqual(recording.segments.map(s => s.label),
      ['trial-1', 'trial-2', 'trial-3']);
    const types = new Set(recording.segments.flatMap(s => s.events).map(e => e.type));
    for (const expected of ['mouse.click', 'key.down', 'input.value',
                            'dom.add', 'dom.attr', 'dom.text', 'dom.remove',
                            'scroll.element']) {
      assert.ok(types.has(expected), `expected a ${expected} in the recording`);
    }
  });

  it('the cadence is keyframe → continuation → keyframe (spec §3)', () => {
    assert.deepEqual(recording.segments.map(s => !!s.initial_dom),
      [true, false, true]);
    assert.equal(recording.segments[0].initial_dom.kind, 'element');
    assert.equal(recording.segments[2].initial_dom.kind, 'element');
    assert.equal(recording.segments[2].initial_dom.id, 1,
      'the second keyframe opens a fresh span, numbering from 1 again');
  });

  it('reproduces the canonical fixture\'s chain, segment kind for segment kind', () => {
    // canonical-core.json is hand-authored and predates every line of the
    // capture rewrite, so it is the one oracle CH's own serializer cannot have
    // influenced. Its three segments are keyframe / continuation / keyframe with
    // a seed on the last, which is the chain the scripted session above drives —
    // and a continuation's key set is the same key set as a keyframe's, which is
    // what stops "continuation" from becoming a differently-shaped segment.
    const canonical = JSON.parse(readFileSync(
      new URL('./schema-v2/fixtures/canonical-core.json', import.meta.url), 'utf8'));
    const kinds = (r) => r.segments.map(s => [
      s.initial_dom == null ? 'continuation' : 'keyframe',
      s.initial_state == null ? 'no-seed' : 'seeded',
    ]);
    assert.deepEqual(kinds(recording), kinds(canonical));
    assert.deepEqual(Object.keys(recording.segments[1]),
      Object.keys(canonical.segments[1]));
    assert.deepEqual(Object.keys(recording.segments[1]),
      Object.keys(recording.segments[0]),
      'a continuation is a segment with a null field, not a different shape');
  });

  it('the continuation states nothing about the DOM — that is what makes it one', () => {
    const cont = recording.segments[1];
    assert.equal(cont.initial_dom, null);
    assert.equal(cont.initial_state, null,
      'a seed states what was true before a KEYFRAME (§3); a continuation has none');
    assert.ok(cont.events.some(e => e.type.startsWith('dom.')),
      'and it is a real continuation: it carries patches against the earlier span');
  });

  it('the continuation addresses the earlier keyframe: patches AND anchors', () => {
    // The property the whole feature rests on. Node ids are scoped to a
    // keyframe SPAN (spec §4), so a segment that takes no keyframe must keep
    // naming the nodes the span's keyframe numbered — in `dom.*` patches and in
    // the `anchor.node` of an ordinary interaction alike, since both read the
    // same registry.
    const keyframe = recording.segments[0].initial_dom;
    const ids = new Map();
    (function walk(n) {
      if (n.attrs && n.attrs.id) ids.set(n.attrs.id, n.id);
      (n.children || []).forEach(walk);
    })(keyframe);

    const cont = recording.segments[1];
    const text = cont.events.find(e => e.type === 'dom.text');
    assert.ok(text, 'the continuation changed text in the inherited tree');
    assert.equal(text.text, 'Next round');

    const remove = cont.events.find(e => e.type === 'dom.remove');
    assert.ok(remove, 'and removed a node that was ADDED in the previous segment');

    const click = cont.events.find(e => e.type === 'mouse.click');
    assert.equal(click.target, ids.get('go'),
      'the click names the id the earlier keyframe gave the button');
    assert.equal(click.anchor.node, ids.get('go'));
    assert.equal(click.anchor.tag, 'button');
  });

  it('the second keyframe seeds the scroll it inherited', () => {
    // The pane scrolled during trial 1; a fresh tree cannot carry that, so the
    // NEXT keyframe must say so (spec §3 element_scroll) — the continuation in
    // between needs no seed because it inherits the state along with the ids.
    const seed = recording.segments[2].initial_state;
    assert.ok(seed, 'the second keyframe needs a seed');
    assert.equal(seed.element_scroll.length, 1);
    assert.equal(seed.element_scroll[0].y, 60);
  });

  it('event targets and patch nodes are the same numbering (one span)', () => {
    const seg = recording.segments[0];
    const ids = new Set();
    (function walk(n) { ids.add(n.id); (n.children || []).forEach(walk); })(seg.initial_dom);

    const click = seg.events.find(e => e.type === 'mouse.click');
    assert.ok(ids.has(click.target), 'the click names a node the keyframe carries');
    assert.equal(click.anchor.node, click.target);
    assert.equal(click.anchor.tag, 'button');

    const patch = seg.events.find(e => e.type === 'dom.attr');
    assert.ok(ids.has(patch.node), 'a patch names a node the keyframe carries');

    const value = seg.events.find(e => e.type === 'input.value' && !e.redacted);
    assert.ok(ids.has(value.node));
    assert.equal(value.value, 'ace of spades');
  });

  it('LEAK SENTINEL: redacted and excluded content appear nowhere in the file', () => {
    const json = JSON.stringify(recording);
    for (const [channel, sentinel] of ALL_SENTINELS) {
      assert.ok(!json.includes(sentinel), `leaked through the ${channel} channel`);
    }
    // …and not one character of it, either: the redacted variants say that
    // something was typed without saying what.
    const events = recording.segments.flatMap(s => s.events);
    const redactedKeys = events.filter(e => e.type === 'key.down' && e.redacted === true);
    assert.ok(redactedKeys.length >= 1, 'the keystrokes are recorded as redacted, not dropped');
    assert.ok(redactedKeys.every(e => e.key === undefined && e.target === undefined));
    assert.ok(events.some(e => e.type === 'input.value' && e.redacted === true
      && e.value_len === REDACTED_SENTINEL.length),
      'the redacted field reports a length and no content');
    assert.ok(!events.some(e => e.type === 'input.value'
      && e.value_len === EXCLUDED_SENTINEL.length),
      'the excluded field reports nothing at all, not even a length');
  });

  it('the continuation\'s withheld channels are LIVE, not merely empty', () => {
    // The other half of the sentinel scan, for the segment kind that has no
    // keyframe behind it: these assert the continuation really drove the
    // password, bait and redacted-attribute channels, so their sentinels are
    // absent because something withheld them.
    const cont = recording.segments[1];
    assert.ok(cont.events.some(e => e.type === 'input.value' && e.redacted === true
      && e.value_len === CONT_REDACTED_SENTINEL.length),
      'the redacted field reports its new length and no content');
    assert.ok(cont.events.some(e => e.type === 'key.down' && e.redacted === true),
      'the redacted keystroke is recorded as redacted, not dropped');
    assert.ok(!cont.events.some(e => e.type === 'input.value'
      && e.value_len === CONT_EXCLUDED_SENTINEL.length),
      'the excluded field reports nothing at all, not even a length');
    assert.ok(!cont.events.some(e => e.type === 'dom.attr' && e.name === 'value'),
      'and the redacted value attribute produced no patch');
  });

  it('the excluded subtree is a placeholder, not content', () => {
    const stage = recording.segments[0].initial_dom;
    const wrapper = stage.children.find(c => c.attrs && c.attrs.id === 'bait');
    const bait = wrapper.children.find(c => c.tag === 'input');
    assert.ok(bait, 'the excluded input is still in the tree, in its position');
    assert.deepEqual(Object.keys(bait), ['id', 'kind', 'tag'],
      'an excluded element is {id, kind, tag} and nothing else');
  });

  it('the two channels the first sentinel could not see are LIVE', () => {
    // A scan proves nothing about a channel the session never drives. These
    // assert the channels exist and carry data, so the absence of the
    // sentinels above is withholding rather than emptiness.
    const seed = recording.segments[2].initial_state;
    assert.ok(seed.form.some(f => f.value === 'ace of spades'),
      'initial_state.form is a live channel: the plain field is seeded');
    assert.equal(seed.form.length, 1,
      'and the redacted and excluded controls are the ones missing from it');

    const attrPatches = recording.segments[0].events.filter(e => e.type === 'dom.attr');
    assert.ok(attrPatches.some(e => e.name === 'class'),
      'the dom.attr channel is live: a non-redacted attribute change is carried');
    assert.ok(!attrPatches.some(e => e.name === 'value'),
      'and the redacted value attribute produced no patch at all');

    const keyframeJson = JSON.stringify(recording.segments[0].initial_dom);
    assert.ok(keyframeJson.includes('"data-ch-redact"'),
      'the redacted element is in the tree with its non-value attributes');
  });

  it('a conforming player resolves every patch, and deletes only what the page deleted', () => {
    // The assertion class that would have caught C-1 end to end: replay the
    // whole recording the way §3 says a player must — re-instantiate at a
    // keyframe, carry on through a continuation — with a player that throws on
    // any id it was never sent (support/dom-player.js).
    //
    // It does not BITE C-1 on this session, because every mutation here is
    // bracketed inside an explicit trial and no implicit segment forms. It is
    // the net: any future cadence or wiring change that lets a patch address a
    // span the file no longer describes fails here rather than in the fork.
    let player = null;
    for (const seg of recording.segments) {
      const patches = seg.events.filter(e => e.type.startsWith('dom.'));
      if (seg.initial_dom) player = createPlayer(seg.initial_dom);
      assert.ok(player || patches.length === 0,
        `segment ${seg.index} carries patches with no keyframe behind it`);
      if (player) player.apply(patches);
    }

    const tags = [];
    const classes = [];
    (function walk(n) {
      if (n.kind === 'element') {
        tags.push(n.tag);
        if (n.attrs && n.attrs.class) classes.push(n.attrs.class);
      }
      (n.children || []).forEach(walk);
    })(player.tree());
    assert.ok(!classes.includes('feedback'),
      'the div added in segment 0 and removed in the continuation is gone');
    for (const kept of ['p', 'button', 'input']) {
      assert.ok(tags.includes(kept), `the removal took ${kept} with it`);
    }
  });

  it('the vendor namespace carries CH data and no marker attribute', () => {
    const ext = recording.extensions['cyborg-hunter'];
    assert.equal(ext.tier, 'dom');
    assert.equal(ext.keys, 'full');
    assert.equal(ext.capture_stopped, false);
    assert.equal(recording.truncated, false);
    assert.equal('marker_attr' in ext, false);
    assert.ok(!JSON.stringify(recording).includes('data-chn-'));
  });

  it('records no capture failures on a clean run', () => {
    assert.deepEqual(recording.extensions['cyborg-hunter'].capture_failures, []);
  });
});

describe('assembly wiring (index.js)', () => {
  beforeEach(() => installWindow());
  afterEach(() => restoreWindow());

  it('threads ONE taint set: content withheld in one channel stays withheld in the other', () => {
    // Neither capture module is given an explicit taint set, so both land on
    // redaction.js's module-level one. That is the symmetric choice and the
    // fail-closed one — the failure this pins is the asymmetric wiring, where
    // the trace channel marks a node and the DOM channel never hears about it.
    //
    // The shape: a field inside a redacted container is typed into, then MOVED
    // OUT. Redaction is a property of the file (spec §8), so its accumulated
    // content must not enter the next patch that describes it.
    const doc = win.document;
    const stage = doc.getElementById('stage');
    const box = doc.createElement('div');
    box.setAttribute('data-ch-redact', '');
    const field = doc.createElement('div');
    field.textContent = REDACTED_SENTINEL;
    box.appendChild(field);
    stage.appendChild(box);

    const api = CHReplay.attach({
      participantId: 'P', tier: 'dom', root: '#stage',
      redactSelector: '[data-ch-redact]', autoSave: { mode: 'none' },
    });
    api.startSession();
    api.startTrial({ trialId: 't1' });

    // The keyframe withheld it. Now the page moves it into the open.
    stage.appendChild(field);
    return settle().then(() => {
      api.stopSession('finished');
      const recording = api.getRecording();
      api.destroy();
      assert.ok(!JSON.stringify(recording).includes(REDACTED_SENTINEL),
        'the taint did not survive the move: the two halves are not sharing a set');
      assert.equal(validateStrict(recording).ok, true);
    });
  });

  it('a SECOND recording on the same page inherits the first\'s withholding', () => {
    // The accepted cost of the choice above, pinned so it is a decision rather
    // than an accident. `redaction.js`'s taint set is module-level and lives
    // for the PAGE, so a node recording 1 withheld stays withheld in recording
    // 2 even with no redaction configured at all. That is over-redaction: it
    // can only withhold, never leak, which is the side to fail on.
    //
    // Do NOT "fix" this by resetting the taint at attach(). The set exists to
    // close spec §8's move-out hole (content withheld at the keyframe, then
    // moved out of its container and re-serialized), and a per-recording reset
    // re-opens it across the boundary while making the can-only-over-redact
    // property conditional on where that boundary falls. The realistic case is
    // a researcher restarting a recording, or an SPA running several blocks in
    // one page load; attach() destroys any active instance, so the two
    // recorders are always sequential, never concurrent.
    const doc = win.document;
    const stage = doc.getElementById('stage');
    const box = doc.createElement('div');
    box.setAttribute('data-ch-redact', '');
    const field = doc.createElement('p');
    field.textContent = REDACTED_SENTINEL;
    box.appendChild(field);
    stage.appendChild(box);

    const first = CHReplay.attach({
      participantId: 'P1', tier: 'dom', root: '#stage',
      redactSelector: '[data-ch-redact]', autoSave: { mode: 'none' },
    });
    first.startSession();
    first.startTrial({ trialId: 't1' });
    first.stopSession('finished');
    first.destroy();

    // The page drops the marker entirely, and the second recording configures
    // no redaction whatsoever.
    box.removeAttribute('data-ch-redact');
    const second = CHReplay.attach({
      participantId: 'P2', tier: 'dom', root: '#stage',
      redactSelector: null, autoSave: { mode: 'none' },
    });
    second.startSession();
    second.startTrial({ trialId: 't1' });
    second.stopSession('finished');
    const recording = second.getRecording();
    second.destroy();

    assert.equal(validateStrict(recording).ok, true);
    const texts = [];
    (function walk(n) {
      if (n.kind === 'text') texts.push(n.text);
      (n.children || []).forEach(walk);
    })(recording.segments[0].initial_dom);
    assert.ok(!texts.includes(REDACTED_SENTINEL),
      'the second recording emitted content the first withheld');
    assert.ok(texts.includes(''),
      'it is present-but-empty: the node keeps its id and position (spec §4)');
    assert.equal(recording.extensions['cyborg-hunter'].inherited_redaction_taint, true,
      'and the file SAYS so: an empty field here is otherwise indistinguishable ' +
      'from a field the participant left alone');
    assert.deepEqual(recording.extensions['cyborg-hunter'].capture_failures, [],
      'the inheritance is not a capture failure — that channel means a channel broke');
  });

  it('an unbracketed CLICK still names the node the player holds (capture-trace)', async () => {
    // C-1's other exposure, and the one the observer-shaped reproduction hides:
    // capture-trace resolves `target` and `anchor.node` through the span at
    // DISPATCH, then pushes. If that push is what opens the segment, a keyframe
    // taken inside it renumbers everything the record already named — and the
    // record then contradicts itself, naming an id whose element in its own
    // keyframe has a different tag than its own `anchor.tag`.
    const doc = win.document;
    const stage = doc.getElementById('stage');
    const api = CHReplay.attach({
      participantId: 'P', tier: 'dom', root: '#stage',
      keyframeEvery: 1, autoSave: { mode: 'none' },
    });
    api.startSession();
    api.startTrial({ trialId: 't1' });

    // Insert at the FRONT, mid-span: the new node takes a HIGH id where a fresh
    // pre-order walk would give it a low one, so the two numberings disagree
    // for every node after it.
    const lead = doc.createElement('span');
    lead.id = 'lead';
    stage.insertBefore(lead, stage.firstChild);
    await settle();
    api.endTrial();

    fire(doc.getElementById('go'), 'click');   // no trial open → implicit segment
    await settle();
    api.stopSession('finished');
    const recording = api.getRecording();
    api.destroy();

    assert.equal(validateStrict(recording).ok, true);
    const segIndex = recording.segments.findIndex(
      s => s.events.some(e => e.type === 'mouse.click'));
    assert.ok(segIndex >= 0, 'the click has to reach the file for this to test anything');
    const click = recording.segments[segIndex].events.find(e => e.type === 'mouse.click');

    // Resolve the target against the keyframe that GOVERNS its segment (§3's
    // player rule: the nearest earlier keyframe).
    let governing = null;
    for (let i = segIndex; i >= 0 && !governing; i--) governing = recording.segments[i].initial_dom;
    let hit = null;
    (function walk(n) { if (n.id === click.target) hit = n; (n.children || []).forEach(walk); })(governing);

    assert.ok(hit, `target ${click.target} names no node in the governing keyframe`);
    assert.equal(hit.tag, click.anchor.tag,
      'the record contradicts itself: its target and its own anchor.tag are different elements');
    assert.equal(hit.tag, 'button');
    assert.equal(click.anchor.node, click.target);
  });

  it('a trace-tier recording is honestly node-free', () => {
    const api = CHReplay.attach({
      participantId: 'P', tier: 'trace', autoSave: { mode: 'none' },
    });
    api.startSession();
    api.startTrial({ trialId: 't1' });
    fire(win.document.getElementById('go'), 'click');
    api.endTrial();
    api.stopSession('finished');
    const recording = api.getRecording();
    api.destroy();

    assert.equal(validateStrict(recording).ok, true);
    assert.equal(recording.segments[0].initial_dom, null, 'no DOM was observed');
    const click = recording.segments[0].events.find(e => e.type === 'mouse.click');
    assert.equal(click.target, null, 'and nothing is addressable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TAINT SCOPE: one subtree, one verdict (T3 final review, F-1)
//
// The taint set is what keeps redacted content withheld after the page moves
// it out of the container that redacted it. Its SCOPE used to disagree across
// the three channels that consult it: the snapshot walk inherited a tainted
// ancestor's verdict downward, while the mutation mapper and the trace capture
// asked about the queried node alone. So content CREATED inside a tainted
// container after the move shipped in full mid-segment (dom.add, dom.text,
// input.value) and was then withheld by the next keyframe describing the same
// nodes — one file holding two verdicts about one subtree, and the weaker one
// arriving first.
//
// The scenario below is the reviewer's probe. Each sentinel travels a different
// channel, so reverting any one of the three fixed sites turns exactly its own
// assertion red.
// ═══════════════════════════════════════════════════════════════════════════

const TAINT_ADD_SENTINEL = 'ZQTAINTADDEDTEXT4242';        // dom.add payload
const TAINT_TEXT_SENTINEL = 'ZQTAINTREWRITTENTEXT515151'; // dom.text rewrite
const TAINT_INPUT_SENTINEL = 'ZQTAINTTYPEDVALUE60606';    // input.value
const TAINT_ATTR_SENTINEL = 'ZQTAINTVALUEATTR7171';       // dom.attr value

const TAINT_SENTINELS = [
  ['dom.add payload inside a tainted container', TAINT_ADD_SENTINEL],
  ['dom.text rewrite inside a tainted container', TAINT_TEXT_SENTINEL],
  ['input.value typed inside a tainted container', TAINT_INPUT_SENTINEL],
  ['value attribute inside a tainted container', TAINT_ATTR_SENTINEL],
];

const TAINT_PAGE = `
  <div id="stage">
    <div id="wrap" data-ch-redact>
      <div id="box"><span id="old">original</span></div>
    </div>
    <div id="outside"></div>
  </div>
`;

async function recordTaintMove() {
  const doc = win.document;
  const api = CHReplay.attach({
    participantId: 'P-TAINT-01', tier: 'dom', root: '#stage',
    keyframeEvery: 2, autoSave: { mode: 'none' },
  });
  api.startSession();

  // Segment 0's keyframe walks #box and #old inside the redacted wrapper, so
  // both are taint-marked and their content is withheld.
  api.startTrial({ trialId: 'trial-1', plugin: 'ch:standalone' });
  await settle();

  // The page moves the container OUT. Position no longer redacts it; history
  // still does.
  doc.getElementById('outside').appendChild(doc.getElementById('box'));
  await settle();

  // ── segment 1: a continuation, where every channel below runs with no fresh
  //    snapshot behind it ──
  api.startTrial({ trialId: 'trial-2', plugin: 'ch:standalone' });

  const box = doc.getElementById('box');

  // NEW content created inside the tainted container.
  const added = doc.createElement('p');
  added.id = 'added';
  added.textContent = TAINT_ADD_SENTINEL;
  box.appendChild(added);

  const typed = doc.createElement('input');
  typed.id = 'typed';
  typed.type = 'text';
  box.appendChild(typed);
  await settle();

  // …then rewritten, typed into, and mirrored into an attribute.
  added.firstChild.data = TAINT_TEXT_SENTINEL;
  typed.value = TAINT_INPUT_SENTINEL;
  key(typed, 'keydown', 'Z');
  fire(typed, 'input');
  typed.setAttribute('value', TAINT_ATTR_SENTINEL);
  await settle();

  api.endTrial();

  // ── segment 2: the next keyframe, which describes the same nodes ──
  api.startTrial({ trialId: 'trial-3', plugin: 'ch:standalone' });
  await settle();
  api.endTrial();

  api.stopSession('finished');
  const recording = api.getRecording();
  api.destroy();
  return recording;
}

describe('taint scope: content created inside a moved-out redacted container', () => {
  let recording;

  before(async () => {
    installWindow();
    win.document.body.innerHTML = TAINT_PAGE;
    try { recording = await recordTaintMove(); } finally { restoreWindow(); }
  });

  it('strict-validates', () => {
    const res = validateStrict(recording);
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  it('drove all three channels (a scan over a dead channel passes forever)', () => {
    // Liveness has to be proved by what SURVIVES the withholding, since the
    // whole point of the fix is that the content does not. Each channel leaves
    // a different trace:
    //   - dom.add still emits the subtree, stripped;
    //   - input.value still emits, as §5.2's redacted variant with a length;
    //   - dom.text is SUPPRESSED entirely, so its trace is the keyframe that
    //     describes the rewritten node (asserted in the next test).
    const events = recording.segments.flatMap(s => s.events);
    const adds = events.filter(e => e.type === 'dom.add');
    assert.ok(
      adds.some(e => JSON.stringify(e.node).includes('"id":"added"')),
      'the new subtree was added mid-span');
    const typedEvent = events.filter(e => e.type === 'input.value').pop();
    assert.ok(typedEvent, 'the field was typed into');
    assert.equal(typedEvent.redacted, true,
      'and the event took §5.2\'s redacted variant rather than vanishing');
    assert.equal(typedEvent.value_len, TAINT_INPUT_SENTINEL.length,
      'whose length says the channel really carried this keystroke');
    assert.equal(events.some(e => e.type === 'dom.text'), false,
      'the text rewrite was suppressed, which is how dom.text withholds');
    assert.ok(recording.segments.filter(s => s.initial_dom !== null).length >= 2,
      'a second keyframe describes the same nodes');
  });

  for (const [channel, sentinel] of TAINT_SENTINELS) {
    it(`withholds the ${channel}`, () => {
      const json = JSON.stringify(recording);
      assert.equal(json.includes(sentinel), false,
        `${channel} leaked: the taint verdict was not inherited by this channel`);
    });
  }

  it('the mid-span verdict agrees with the keyframe that follows it', () => {
    // The point of the finding, stated directly: the same node must not be
    // withheld at the keyframe and published in the patches that precede it.
    const lastKeyframe = recording.segments.filter(s => s.initial_dom !== null).pop();
    let addedNode = null;
    (function walk(n) {
      if (!n) return;
      if (n.kind === 'element' && (n.attrs || {}).id === 'added') addedNode = n;
      (n.children || []).forEach(walk);
    })(lastKeyframe.initial_dom);
    assert.ok(addedNode, 'the keyframe describes the node created mid-span');
    const text = (addedNode.children || []).map(c => c.text).join('');
    assert.equal(text, '', 'the keyframe withholds its text');

    const patches = recording.segments.flatMap(s => s.events)
      .filter(e => e.type === 'dom.add' || e.type === 'dom.text');
    assert.equal(JSON.stringify(patches).includes(TAINT_TEXT_SENTINEL), false);
    assert.equal(JSON.stringify(patches).includes(TAINT_ADD_SENTINEL), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEARDOWN: the last thing the participant did (T3 final review, F-5)
//
// A MutationObserver callback is a microtask. DOM changes made in the same task
// as stopSession() — which is exactly where a trial's final state change lands
// — are still queued when the recording closes, and disconnecting drops them
// with no trace. The recorder now drains the queue through the same handler
// before anything closes.
// ═══════════════════════════════════════════════════════════════════════════

describe('teardown flushes the mutations still queued at stop', () => {
  it('keeps DOM changes made in the same task as stopSession', () => {
    installWindow();
    try {
      const doc = win.document;
      const api = CHReplay.attach({
        participantId: 'P-FLUSH-01', tier: 'dom', root: '#stage',
        autoSave: { mode: 'none' },
      });
      api.startSession();
      api.startTrial({ trialId: 'trial-1', plugin: 'ch:standalone' });

      // No await anywhere below: the mutation, the trial end and the stop all
      // happen in one task, so the observer has not delivered when the
      // recording closes. This is the shape of a real final trial.
      const last = doc.createElement('div');
      last.id = 'final-word';
      last.textContent = 'submitted';
      doc.getElementById('stage').appendChild(last);
      api.endTrial();
      api.stopSession('finished');

      const recording = api.getRecording();
      api.destroy();

      assert.equal(validateStrict(recording).ok, true);
      const adds = recording.segments.flatMap(s => s.events)
        .filter(e => e.type === 'dom.add');
      assert.ok(
        adds.some(e => JSON.stringify(e.node).includes('"id":"final-word"')),
        'the last DOM change before stop reached the file');
    } finally {
      restoreWindow();
    }
  });

  it('flushes for a caller that destroys without stopping', () => {
    installWindow();
    try {
      const doc = win.document;
      const api = CHReplay.attach({
        participantId: 'P-FLUSH-02', tier: 'dom', root: '#stage',
        autoSave: { mode: 'none' },
      });
      api.startSession();
      api.startTrial({ trialId: 'trial-1', plugin: 'ch:standalone' });
      const last = doc.createElement('div');
      last.id = 'abandoned';
      doc.getElementById('stage').appendChild(last);
      api.destroy();   // no stopSession; the buffer survives teardown by contract

      const recording = api.getRecording();
      const adds = recording.segments.flatMap(s => s.events)
        .filter(e => e.type === 'dom.add');
      assert.ok(
        adds.some(e => JSON.stringify(e.node).includes('"id":"abandoned"')),
        'destroy() drains the queue too');
    } finally {
      restoreWindow();
    }
  });
});
