// Replay-feature hardening.
// Privacy (redaction soundness), payload-size cap, serializer/model robustness.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';
import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';
import { attachDomCapture } from '../../src/replay/capture-dom.js';
import { buildViewerModel } from '../../src/cli/renderers/replay-assets.js';
import { autoSave } from '../../src/replay/persistence.js';

// ── Shared fakes ──────────────────────────────────────────────
function fakeTarget() {
  return {
    handlers: {},
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    removeEventListener(ev) { delete this.handlers[ev]; },
    fire(ev, obj) { if (this.handlers[ev]) this.handlers[ev](obj || {}); },
  };
}
function harness(configOverrides) {
  globalThis.window = { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1 };
  const rec = createRecorder({ participantId: 'P1', ...configOverrides });
  const doc = fakeTarget();
  const win = fakeTarget();
  let t = 1000;
  const rafQueue = [];
  const env = {
    doc, win, now: () => t, raf: (fn) => { rafQueue.push(fn); },
    advance: (ms) => { t += ms; }, flushRaf: () => { rafQueue.splice(0).forEach(f => f()); },
  };
  rec.startSession();
  attachTraceCapture(rec, env);
  const events = () => rec.getState().trials.flatMap(tr => tr.events);
  return { rec, doc, win, env, events };
}
// A DOM element that matches a redact selector (only '[data-ch-redact]' here).
// `nodeType` is load-bearing: the shared redaction predicate (redaction.js)
// asks about ELEMENTS, so a fake that does not declare itself one is not one.
function redactableTarget(tagName, value) {
  return {
    nodeType: 1, tagName, value,
    matches: (sel) => sel === '[data-ch-redact]',
  };
}

describe('F2 — keystroke capture must honor redactSelector', () => {
  it('redacts key identity for a field matching redactSelector', () => {
    const { doc, events } = harness({ keys: 'full', redactSelector: '[data-ch-redact]' });
    const target = redactableTarget('INPUT', 'secret@example.com');
    doc.fire('keydown', { key: 's', code: 'KeyS', target });
    doc.fire('keyup', { key: 's', code: 'KeyS', target });
    const evs = events();
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[0].redacted, true, 'keydown on a redacted field must not carry key identity');
    assert.strictEqual(evs[0].key, undefined);
    assert.strictEqual(evs[1].redacted, true);
  });

  it('still records key identity for a non-redacted field', () => {
    const { doc, events } = harness({ keys: 'full', redactSelector: '[data-ch-redact]' });
    doc.fire('keydown', { key: 'a', code: 'KeyA', target: { tagName: 'BODY', matches: () => false } });
    assert.strictEqual(events()[0].key, 'a');
  });
});

// A tier-2 capture over a real (happy-dom) document, with the observer
// injected so batches flush synchronously. The v1 sections here poked the
// HTML-string walker and the patch translator directly; both retired at the
// v2 switchover, and the invariant they defended — a redacted subtree's
// content reaches NO channel (spec §8) — is now a property of the wiring, so
// that is where it is checked.
function domHarness(html, config) {
  const win = new Window({ url: 'https://example.org/' });
  const doc = win.document;
  doc.body.innerHTML = html;
  globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
  const rec = createRecorder(Object.assign(
    { participantId: 'P', tier: 'dom', root: '#stage' }, config));
  let observerCb = null;
  const real = new win.MutationObserver(() => {});
  rec.startSession();
  attachDomCapture(rec, {
    doc, win, now: () => 1000,
    MutationObserver: function (cb) {
      observerCb = cb;
      return { observe: (n, i) => real.observe(n, i), disconnect: () => real.disconnect() };
    },
  });
  return {
    rec, doc,
    root: () => doc.querySelector('#stage'),
    flush: () => observerCb(real.takeRecords()),
    trial: (i) => rec.getState().trials[i],
    events: () => rec.getState().trials.flatMap(t => t.events),
  };
}

describe('F3 — DOM capture must honor redactSelector', () => {
  const REDACT = { redactSelector: '[data-ch-redact]' };

  it('the keyframe withholds the value of a redactSelector-matching input', () => {
    const h = domHarness(
      '<div id="stage"><input data-ch-redact type="email" value="alice@example.com">' +
      '<input type="text" value="visible answer"></div>', REDACT);
    h.rec.startTrial({ trialId: 't1' });
    const json = JSON.stringify(h.trial(0).initialDom);
    assert.ok(!json.includes('alice@example.com'), `redacted value leaked: ${json}`);
    assert.ok(json.includes('visible answer'), 'a non-redacted value still serializes');
  });

  it('typing into a redacted contenteditable emits no text', () => {
    // The real shape a characterData mutation delivers: the target is a TEXT
    // NODE with no matches() of its own, so only the ancestor walk catches it.
    const h = domHarness(
      '<div id="stage"><div data-ch-redact contenteditable>seed</div></div>', REDACT);
    h.rec.startTrial({ trialId: 't1' });
    h.root().firstChild.firstChild.data = 'typed secret';
    h.flush();
    const json = JSON.stringify(h.events());
    assert.ok(!json.includes('typed secret'), `redacted text leaked: ${json}`);
  });

  it('a subtree inserted into a redacted container arrives stripped', () => {
    const h = domHarness('<div id="stage"><div data-ch-redact></div></div>', REDACT);
    h.rec.startTrial({ trialId: 't1' });
    const added = h.doc.createElement('p');
    added.textContent = 'typed secret';
    h.root().firstChild.appendChild(added);
    h.flush();
    const json = JSON.stringify(h.events());
    assert.ok(json.includes('dom.add'), 'structure is not content: the add still happens');
    assert.ok(!json.includes('typed secret'), `redacted insertion leaked: ${json}`);
  });

  it('content withheld once stays withheld after the page moves it out (spec §8)', () => {
    // Redaction is a property of the FILE, not of a node's current position.
    const h = domHarness(
      '<div id="stage"><div data-ch-redact><p id="moved">secret text</p></div>' +
      '<div id="open"></div></div>', REDACT);
    h.rec.startTrial({ trialId: 't1' });
    h.doc.getElementById('open').appendChild(h.doc.getElementById('moved'));
    h.flush();
    const json = JSON.stringify(h.events());
    assert.ok(!json.includes('secret text'), `taint lost on move: ${json}`);
  });
});

describe('F4 — recorder must cap total payload size, not just event count', () => {
  it('stops capture when the size budget is exceeded even under the event-count cap', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P', maxEventsPerTrial: 100000, maxCharsPerTrial: 50000 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    const big = 'x'.repeat(10000);
    for (let i = 0; i < 20; i++) {
      rec.pushRecord({ type: 'input.value', node: 1, value: big });
    }
    const st = rec.getState();
    assert.equal(st.captureStopped, true, 'size budget must stop capture');
    const evs = st.trials.flatMap(tr => tr.events);
    assert.equal(evs.filter(e => e.type === 'recording.capture_stopped').length, 1,
      'exactly one capture_stopped signal per recording (spec §5.7)');
    // Far fewer than 20 events land — the size cap bit well before 100k events.
    assert.ok(evs.filter(e => e.type === 'input.value').length < 20);
  });

  it('counts the keyframe toward the budget (not just events)', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P', maxCharsPerTrial: 5000 });
    // Simulate capture-dom's keyframe hook: the tree is stored on the trial,
    // so its size reaches the budget only because the hook reports it.
    rec.onTrialStart((trial) => {
      trial.initialDom = { id: 1, kind: 'text', text: 'd'.repeat(6000) };
      rec.noteSnapshotChars(trial, JSON.stringify(trial.initialDom).length);
    });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushRecord({ type: 'mouse.move', x: 1, y: 1 });  // tiny, but already over
    const st = rec.getState();
    assert.equal(st.captureStopped, true, 'a keyframe over the budget must trip the cap on the next event');
  });

  it('the cap is PER-TRIAL: a fresh trial resumes capture after a prior trial hit it', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P', maxEventsPerTrial: 2 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushRecord({ type: 'mouse.move', x: 1, y: 0 });
    rec.pushRecord({ type: 'mouse.move', x: 2, y: 0 });
    rec.pushRecord({ type: 'mouse.move', x: 3, y: 0 }); // trips the cap in t1
    rec.endTrial();
    rec.startTrial({ trialId: 't2' });
    rec.pushRecord({ type: 'mouse.move', x: 9, y: 0 });  // must NOT be dropped
    const trials = rec.getState().trials;
    const t2 = trials.find(t => t.trialId === 't2');
    assert.ok(t2.events.some(e => e.type === 'mouse.move' && e.x === 9),
      'a new trial must capture even though an earlier trial hit the cap');
  });

  it('DROPS an oversized keyframe at assignment (not just on the next event)', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    // Cap 5 chars → any real keyframe is oversized and must be dropped.
    const rec = createRecorder({ participantId: 'P', tier: 'dom', maxCharsPerTrial: 5 });
    const body = {
      nodeType: 1, tagName: 'DIV', attributes: [],
      childNodes: [{ nodeType: 3, textContent: 'hello world this is a long snapshot', childNodes: [] }],
    };
    const doc = { body, querySelector: () => null, styleSheets: [] };
    rec.startSession();
    attachDomCapture(rec, { doc, win: {}, now: () => 0, MutationObserver: null });
    rec.startTrial({ trialId: 't1' }); // fires the keyframe hook — no event needed
    const st = rec.getState();
    assert.equal(st.trials[0].initialDom, null, 'oversized keyframe must be dropped, not retained');
    assert.ok(st.captureFailures.some(f => f.channel === 'dom_snapshot'),
      'a dom_snapshot captureFailure records the drop');
  });
});

describe('F5 — buildViewerModel must not crash on malformed artifacts', () => {
  it('tolerates non-array trials', () => {
    const model = buildViewerModel({ metadata: { participant_id: 'P' }, trials: {} });
    assert.deepEqual(model.trials, []);
  });
  it('tolerates non-array events and null entries', () => {
    const model = buildViewerModel({ metadata: {}, trials: [{ trial_index: 0, events: {} }, { trial_index: 1, events: [null, { t: 5, kind: 'click' }] }] });
    assert.equal(model.trials[0].events.length, 0);
    assert.equal(model.trials[1].events.length, 1);
    assert.equal(model.trials[1].events[0].kind, 'click');
  });
});

describe('F7 — buildViewerModel must sort events by time', () => {
  it('reorders out-of-order events (RAF-coalesced input can flush late)', () => {
    const model = buildViewerModel({
      metadata: {}, trials: [{ trial_index: 0, t_load: 0, events: [
        { t: 100, kind: 'mutation' },
        { t: 50, kind: 'input', value: 'x' },
        { t: 75, kind: 'mousemove' },
      ] }],
    });
    const ts = model.trials[0].events.map(e => e.t);
    assert.deepEqual(ts, [50, 75, 100], `events must be time-ordered, got ${ts}`);
  });
});

describe('F9 — autoSave must never throw, even on an unserializable recording', () => {
  it('returns saved_to:failed on a circular reference instead of throwing', async () => {
    const circular = {
      schema_version: 2, participant_id: 'P',
      recording_started_at: '2026-01-01T00:00:00Z',
      truncated: false, segments: [],
      extensions: { 'cyborg-hunter': { tier: 'trace', capture_failures: [] } },
    };
    circular.self = circular; // circular → JSON.stringify throws
    let result;
    await assert.doesNotReject(async () => {
      result = await autoSave(circular, { mode: 'datapipe', experimentId: 'exp1' });
    });
    assert.equal(result.saved_to, 'failed');
    assert.ok(result.error);
  });
});
