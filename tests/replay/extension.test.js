// tests/replay/extension.test.js
// Public assembly (index.js attach singleton) + jsPsych adapter contract.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as CHReplay from '../../src/replay/index.js';
import { CyborgHunterReplayExtension } from '../../src/jspsych/extension-cyborg-hunter-replay.js';

beforeEach(() => {
  globalThis.window = { innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1 };
  globalThis.document = {
    body: { nodeType: 1, tagName: 'BODY', attributes: [], childNodes: [] },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    styleSheets: [],
  };
  // window must be an EventTarget for trace capture
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
});

describe('CyborgHunterReplay.attach', () => {
  it('second attach destroys the first and warns', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const a = CHReplay.attach({ participantId: 'P1', autoSave: { mode: 'datapipe', experimentId: 'X' } });
      a.startSession();   // a real recording in progress
      const b = CHReplay.attach({ participantId: 'P1', autoSave: { mode: 'datapipe', experimentId: 'X' } });
      assert.ok(warnings.some(w => w.includes('replacing')), 'replacement warning expected');
      // The replaced instance is destroyed: writes fail loudly, but its
      // buffer stays READABLE (CH getSessionReport idiom) — destroy-then-
      // serialize must never lose an in-progress recording.
      assert.throws(
        () => a._recorder.pushRecord({ type: 'mouse.move', x: 0, y: 0 }), /destroyed/);
      assert.strictEqual(a.getRecording().schema_version, 2);
      b.destroy();
    } finally { console.warn = origWarn; }
  });

  it('records end-to-end: session → trial → recording (trace tier)', () => {
    const api = CHReplay.attach({ participantId: 'P9', tier: 'trace', autoSave: { mode: 'datapipe', experimentId: 'X' } });
    api.startSession();
    api.startTrial({ trialId: 'r1' });
    api._recorder.pushRecord({ type: 'mouse.click', x: 3, y: 4, button: 0, target: null });
    api.endTrial();
    api.stopSession('finished');
    const rec = api.getRecording();
    assert.strictEqual(rec.schema_version, 2);
    assert.strictEqual(rec.participant_id, 'P9');
    assert.strictEqual(rec.segments.length, 1);
    assert.strictEqual(rec.segments[0].events[0].type, 'mouse.click');
    api.destroy();
  });
});

describe('jsPsych replay adapter', () => {
  const REQUIRED_HOOKS = ['initialize', 'on_start', 'on_load', 'on_finish'];
  for (const hook of REQUIRED_HOOKS) {
    it(`exposes ${hook} as an instance method`, () => {
      const ext = new CyborgHunterReplayExtension({});
      assert.equal(typeof ext[hook], 'function');
    });
  }

  function mockJsPsych(withChExtension) {
    const store = { props: {}, lastTrial: {} };
    const chMonitor = {
      destroyed: false,
      getSessionReport() {
        // CH getSessionReport works even after destroy() (sessionData
        // survives) — the adapter relies on this pinned contract.
        return {
          libraryVersion: '0.6.0',
          config: { preset: 'standard' },
          hardScore: {}, softScore: 2, softScoreThreshold: 6,
          anyHardTriggered: false, trialsCompleted: 1,
          sidebarEvents: [], aiExtensionsFound: [], devToolsEvents: [],
          windowPositions: [], layoutShifts: [], zoomChanges: [],
          keyboardShortcuts: [], idleGaps: [], extensionInjections: [],
        };
      },
      destroy() { this.destroyed = true; },
    };
    return {
      store, chMonitor,
      jsPsych: {
        extensions: withChExtension ? { 'cyborg-hunter': { monitor: chMonitor } } : {},
        getProgress: () => ({ current_trial_global: 7 }),
        getCurrentTrial: () => ({ type: { info: { name: 'html-button-response' } } }),
        data: {
          addProperties: (obj) => Object.assign(store.props, obj),
          addDataToLastTrial: (obj) => Object.assign(store.lastTrial, obj),
        },
      },
    };
  }

  it('drives the recorder from on_load/on_finish and finalizes with CH merge', async () => {
    const { jsPsych, store } = mockJsPsych(true);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_start({});
    ext.on_load({});
    const ret = ext.on_finish({});
    assert.deepStrictEqual(ret, {}, 'per-trial return stays empty (no CSV bloat)');
    await ext.finalize();
    const meta = store.props.integrityReplayMeta;
    assert.ok(meta, 'integrityReplayMeta must be attached');
    assert.strictEqual(meta.schema_version, 2);
    assert.strictEqual(meta.saved_to, 'none');
    // the recording itself is retrievable for tests/debugging
    const rec = ext.getLastRecording();
    assert.strictEqual(rec.segments.length, 1);
    assert.strictEqual(rec.segments[0].label, 'trial-7');
    assert.strictEqual(rec.segments[0].plugin, 'html-button-response');
    assert.strictEqual(rec.extensions['cyborg-hunter'].scoring.soft_score, 2,
      'CH session report merged via the stashed monitor reference');
  });

  it('works without the cyborg-hunter extension (standalone recording)', async () => {
    const { jsPsych, store } = mockJsPsych(false);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P3', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_load({});
    ext.on_finish({});
    await ext.finalize();
    assert.ok(store.props.integrityReplayMeta);
    assert.strictEqual(
      ext.getLastRecording().extensions['cyborg-hunter'].scoring, null);
  });

  it('double finalize() does not autosave twice', async () => {
    const { jsPsych, store } = mockJsPsych(true);
    let saves = 0;
    const origAdd = jsPsych.data.addProperties;
    jsPsych.data.addProperties = (o) => { if (o.integrityReplayMeta) saves++; return origAdd(o); };
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_load({}); ext.on_finish({});
    await ext.finalize();
    await ext.finalize();   // second call must be a no-op
    assert.strictEqual(saves, 1, 'finalize must attach the meta pointer at most once');
  });

  it('on_finish without on_load does not misattribute the next trial', async () => {
    const { jsPsych } = mockJsPsych(true);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_start({});
    ext.on_finish({});      // no on_load fired for this trial — must be a clean no-op
    ext.on_load({});        // real trial starts
    ext.on_finish({});
    await ext.finalize();
    const rec = ext.getLastRecording();
    const bracketed = rec.segments.filter(t => t.label !== '__session__');
    assert.strictEqual(bracketed.length, 1, 'exactly one real trial, not a phantom');
  });

  it('finalize before any trial degrades to a no_session save (no throw, no loss)', async () => {
    // A run that ends before startTrial (participant abandons instantly)
    // still finalizes: the adapter startSession'd at initialize, but if the
    // session somehow never anchored, autoSaveNow returns no_session rather
    // than throwing away the finish path.
    const { jsPsych, store } = mockJsPsych(true);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    // stub the recorder so its session looks un-anchored (defensive path)
    ext.api._recorder.getState = () => ({ sessionStart: null, trials: [], state: 'session' });
    await assert.doesNotReject(() => ext.finalize());
    assert.strictEqual(store.props.integrityReplayMeta.saved_to, 'no_session');
  });

  it('finalize never throws even if everything inside fails', async () => {
    const ext = new CyborgHunterReplayExtension({ data: {} });  // broken jsPsych
    // never initialized — finalize must still be safe
    await assert.doesNotReject(() => ext.finalize());
  });
});
