// Replay-feature hardening.
// Privacy (redaction soundness), payload-size cap, serializer/model robustness.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRecorder } from '../../src/replay/recorder.js';
import { attachTraceCapture } from '../../src/replay/capture-trace.js';
import { serializeDom, mutationToPatch, attachDomCapture } from '../../src/replay/capture-dom.js';
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
function redactableTarget(tagName, value) {
  return {
    tagName, value,
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

describe('F3 — DOM capture must honor redactSelector', () => {
  function inputNode(attrs, extra) {
    return Object.assign({
      nodeType: 1, tagName: 'INPUT', type: (attrs.type || 'text'),
      attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
      childNodes: [],
      matches: (sel) => sel === '[data-ch-redact]' && attrs['data-ch-redact'] !== undefined,
      getAttribute: (n) => attrs[n],
    }, extra);
  }

  it('does not serialize the value attribute of a redactSelector-matching input', () => {
    const node = inputNode({ 'data-ch-redact': '', type: 'email', value: 'alice@example.com' });
    const html = serializeDom(node, { redactSelector: '[data-ch-redact]' });
    assert.ok(!html.includes('alice@example.com'), `redacted value leaked into DOM: ${html}`);
    assert.ok(html.includes('data-ch-redacted="true"'), 'redaction marker present');
  });

  it('still serializes the value of a non-redacted input', () => {
    const node = inputNode({ type: 'text', value: 'visible answer' });
    const html = serializeDom(node, { redactSelector: '[data-ch-redact]' });
    assert.ok(html.includes('visible answer'));
  });

  // A redacted contenteditable div with a text-node child — the REAL shape a
  // characterData mutation delivers (target is the text node, which has no
  // matches()), so this exercises the ancestor walk, not an element shortcut.
  function redactedDivWithText(text) {
    const textNode = { nodeType: 3, textContent: text, parentNode: null };
    const div = {
      nodeType: 1, tagName: 'DIV', parentNode: null,
      attributes: [{ name: 'data-ch-redact', value: '' }],
      matches: (sel) => sel === '[data-ch-redact]',
      getAttribute: () => null,
      childNodes: [textNode],
    };
    textNode.parentNode = div;
    return { div, textNode };
  }

  it('redacts characterData mutations whose target is a text node inside a redacted element', () => {
    const { div, textNode } = redactedDivWithText('typed secret');
    const patch = mutationToPatch({ type: 'characterData', target: textNode }, div, { redactSelector: '[data-ch-redact]' });
    assert.ok(patch, 'patch produced');
    assert.ok(!String(patch.value).includes('typed secret'), `redacted text leaked: ${patch.value}`);
  });

  it('redacts childList mutations on a redacted element (children withheld)', () => {
    const { div } = redactedDivWithText('typed secret');
    const patch = mutationToPatch({ type: 'childList', target: div }, div, { redactSelector: '[data-ch-redact]' });
    assert.ok(patch);
    assert.ok(!String(patch.html).includes('typed secret'), `redacted childList leaked: ${patch.html}`);
  });

  it('preserves characterData for a non-redacted text node', () => {
    const textNode = { nodeType: 3, textContent: 'visible', parentNode: null };
    const div = { nodeType: 1, tagName: 'DIV', parentNode: null, matches: () => false, childNodes: [textNode], getAttribute: () => null, attributes: [] };
    textNode.parentNode = div;
    const patch = mutationToPatch({ type: 'characterData', target: textNode }, div, { redactSelector: '[data-ch-redact]' });
    assert.equal(patch.value, 'visible');
  });
});

describe('F4 — recorder must cap total payload size, not just event count', () => {
  it('stops capture when the size budget is exceeded even under the event-count cap', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P', maxEventsPerTrial: 100000, maxCharsPerTrial: 50000 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    const big = 'x'.repeat(10000);
    for (let i = 0; i < 20; i++) rec.pushEvent('input', { value: big });
    const st = rec.getState();
    assert.equal(st.captureStopped, true, 'size budget must stop capture');
    const evs = st.trials.flatMap(tr => tr.events);
    assert.ok(evs.some(e => e.kind === 'ch:capture_stopped'), 'a capture_stopped marker is recorded');
    // Far fewer than 20 events land — the size cap bit well before 100k events.
    assert.ok(evs.filter(e => e.kind === 'input').length < 20);
  });

  it('counts the initial DOM snapshot toward the budget (not just events)', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P', maxCharsPerTrial: 5000 });
    // Simulate capture-dom's snapshot hook writing a large initial DOM.
    rec.onTrialStart((trial) => { trial.initialDom = 'd'.repeat(6000); });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushEvent('mousemove', { x: 1, y: 1 }); // tiny event, but snapshot already over budget
    const st = rec.getState();
    assert.equal(st.captureStopped, true, 'a snapshot over the budget must trip the cap on the next event');
  });

  it('the cap is PER-TRIAL: a fresh trial resumes capture after a prior trial hit it', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    const rec = createRecorder({ participantId: 'P', maxEventsPerTrial: 2 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    rec.pushEvent('mousemove', { x: 1 });
    rec.pushEvent('mousemove', { x: 2 });
    rec.pushEvent('mousemove', { x: 3 }); // trips the cap in t1
    rec.endTrial();
    rec.startTrial({ trialId: 't2' });
    rec.pushEvent('click', { x: 9 });     // must NOT be dropped
    const trials = rec.getState().trials;
    const t2 = trials.find(t => t.trialId === 't2');
    assert.ok(t2.events.some(e => e.kind === 'click' && e.x === 9),
      'a new trial must capture even though an earlier trial hit the cap');
  });

  it('DROPS an oversized initial DOM snapshot at assignment (not just on the next event)', () => {
    globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    // Cap 5 chars → any real snapshot is oversized and must be dropped.
    const rec = createRecorder({ participantId: 'P', tier: 'dom', maxCharsPerTrial: 5 });
    const body = {
      nodeType: 1, tagName: 'DIV', attributes: [],
      childNodes: [{ nodeType: 3, textContent: 'hello world this is a long snapshot', childNodes: [] }],
    };
    const doc = { body, querySelector: () => null, styleSheets: [] };
    attachDomCapture(rec, { doc, win: {}, now: () => 0, MutationObserver: null });
    rec.startSession();
    rec.startTrial({ trialId: 't1' }); // fires the snapshot hook — no event needed
    const st = rec.getState();
    assert.equal(st.trials[0].initialDom, '', 'oversized snapshot must be dropped, not retained');
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
    const circular = { metadata: { participant_id: 'P', start_time: '2026-01-01T00:00:00Z', tier: 'trace' }, ch_extensions: {} };
    circular.self = circular; // circular → JSON.stringify throws
    let result;
    await assert.doesNotReject(async () => {
      result = await autoSave(circular, { mode: 'datapipe', experimentId: 'exp1' });
    });
    assert.equal(result.saved_to, 'failed');
    assert.ok(result.error);
  });
});
