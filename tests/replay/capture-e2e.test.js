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
import { Window } from 'happy-dom';

import * as CHReplay from '../../src/replay/index.js';
import { validateStrict } from './schema-v2/validator.js';

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

const ALL_SENTINELS = [
  ['password IDL value', REDACTED_SENTINEL],
  ['value attribute in a redacted subtree', REDACTED_ATTR_SENTINEL],
  ['redacted form state (initial_state.form)', REDACTED_FORM_SENTINEL],
  ['excluded IDL value', EXCLUDED_SENTINEL],
  ['excluded value attribute', EXCLUDED_ATTR_SENTINEL],
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

// The capture modules read the real globals (that is the browser contract);
// the assembly passes them no environment. So the globals ARE the fixture.
function installWindow() {
  win = new Window({ url: 'https://example.org/exp/' });
  win.document.body.innerHTML = PAGE;
  saved = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  };
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.MutationObserver = win.MutationObserver;
}

function restoreWindow() {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
  globalThis.MutationObserver = saved.MutationObserver;
}

// capture-trace coalesces input and scroll through requestAnimationFrame,
// which is absent in node and falls back to a 16 ms timer; the MutationObserver
// delivers on its own schedule too. One await drains both.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

function fire(el, type, init) {
  el.dispatchEvent(new win.Event(type, Object.assign({ bubbles: true }, init)));
}

function key(el, type, k) {
  el.dispatchEvent(new win.KeyboardEvent(type, { bubbles: true, key: k, code: 'Key' + k }));
}

// A scripted session: two bracketed trials with DOM mutations, typing (plain,
// redacted and excluded), a click, and an element scroll.
async function record() {
  const doc = win.document;
  const api = CHReplay.attach({
    participantId: 'P-E2E-01', tier: 'dom', root: '#stage',
    autoSave: { mode: 'none' },
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
  api.startTrial({ trialId: 'trial-2', plugin: 'ch:standalone' });
  doc.getElementById('stage').removeChild(feedback);
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
    assert.equal(recording.segments.length, 2);
    assert.deepEqual(recording.segments.map(s => s.label), ['trial-1', 'trial-2']);
    const types = new Set(recording.segments.flatMap(s => s.events).map(e => e.type));
    for (const expected of ['mouse.click', 'key.down', 'input.value',
                            'dom.add', 'dom.attr', 'dom.text', 'dom.remove',
                            'scroll.element']) {
      assert.ok(types.has(expected), `expected a ${expected} in the recording`);
    }
  });

  it('every segment is a keyframe, and the second one seeds the scroll it inherited', () => {
    assert.ok(recording.segments.every(s => s.initial_dom && s.initial_dom.kind === 'element'));
    // The pane scrolled during trial 1; a fresh tree cannot carry that, so
    // trial 2's keyframe must say so (spec §3 element_scroll).
    const seed = recording.segments[1].initial_state;
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
    const seed = recording.segments[1].initial_state;
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
    assert.deepEqual(recording.extensions['cyborg-hunter'].capture_failures, [],
      'and nothing marks it — the silence is the documented cost, not a bug');
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
