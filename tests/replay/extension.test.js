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

  it('a misconfigured capture root reaches the meta pointer as a capture failure', async () => {
    // The live half of the golden's `observed_root` row. Task 6's I-1 fix made
    // a root selector that matches nothing say so twice — `observed_root: null`
    // (spec §2's spelling for document.body, which is what was actually
    // observed) plus a capture failure naming the channel — and persistence.js
    // maps every capture failure's channel into the pointer. So the analyst
    // sees "this file describes a different subtree than the study configured"
    // from the CSV alone, without opening the recording.
    //
    // The unit golden pins the mapping; this pins that the channel is really
    // produced. A golden built over a channel nothing emits passes forever.
    const api = CHReplay.attach({
      participantId: 'P7', tier: 'dom', root: '#no-such-stage',
      autoSave: { mode: 'none' },
    });
    api.startSession();
    api.startTrial({ trialId: 'r1' });
    api.endTrial();
    api.stopSession('finished');
    const { recording, meta } = await api.autoSaveNow();
    assert.strictEqual(recording.observed_root, null);
    assert.ok(meta.capture_failures.includes('observed_root'),
      `expected observed_root in ${JSON.stringify(meta.capture_failures)}`);
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

  // `version` mirrors jsPsych's own accessor (a method returning the string).
  // Pass `null` for a runtime that exposes none, or a thrower to check that
  // host detection cannot take the finish path down with it.
  function mockJsPsych(withChExtension, version = () => '8.2.1') {
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
        ...(version === null ? {} : { version }),
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

  it('drives DOM capture at tier "dom": every segment gets a keyframe', async () => {
    // The plan's DECIDED item — the jsPsych host path calls buildInitialState
    // like every other path — holds by construction, because the adapter goes
    // through the same attach() and the same attachDomCapture. Nothing pinned
    // it, and every other adapter test runs at trace tier, where there is no
    // DOM capture to get wrong.
    const { jsPsych } = mockJsPsych(true);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P4', tier: 'dom', autoSave: { mode: 'none' } });
    ext.on_load({});
    ext.on_finish({});
    await ext.finalize();

    const rec = ext.getLastRecording();
    const segment = rec.segments.find(s => s.label === 'trial-7');
    assert.ok(segment.initial_dom, 'the adapter path takes keyframes');
    assert.strictEqual(segment.initial_dom.kind, 'element');
    assert.strictEqual(segment.initial_dom.tag, 'body');
    // A wiped display starts every trial at defaults, which is the spec's own
    // omit case — the call happens, and returns null honestly.
    assert.strictEqual(segment.initial_state, null);
    assert.strictEqual(rec.extensions['cyborg-hunter'].tier, 'dom');
  });

  // ── host identity (spec §2) ──────────────────────────────────────────────
  // `recorder` says which library wrote the file; `host` says what it was
  // embedded in. Only the adapter knows the answer — the recorder core is
  // host-agnostic by construction — so the adapter is the one place that can
  // state it, and the serializer takes it as an option rather than sniffing
  // for globals.

  it('finalize stamps the jsPsych host identity onto the recording', async () => {
    const { jsPsych } = mockJsPsych(true);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_load({});
    ext.on_finish({});
    await ext.finalize();
    assert.deepStrictEqual(ext.getLastRecording().host,
      { name: 'jspsych', version: '8.2.1' });
  });

  it('a jsPsych runtime that reports no version yields host null, not a half-record', async () => {
    // Spec §2 types host as `{name: string; version: string} | null` — version
    // is a required STRING, so {name:'jspsych', version:null} would be a
    // producer-side type violation. The format's own spelling for "no host
    // information" is null, and that is what an undetectable version leaves us
    // with. Both jsPsych 7 and 8 expose version(), so this is the defensive
    // branch, not the expected one.
    const { jsPsych } = mockJsPsych(true, null);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_load({});
    ext.on_finish({});
    await ext.finalize();
    assert.strictEqual(ext.getLastRecording().host, null);
  });

  it('a version() that returns nothing usable also yields host null', async () => {
    // The accessor exists but hands back undefined (a bundler that failed to
    // inline package.json, a fork). Without this case the string guard is
    // unreachable — the `typeof jp.version !== 'function'` check above it
    // already covers the absent-accessor mock — and the guard is what actually
    // enforces §2's required-string typing, so it has to stay driven.
    const { jsPsych } = mockJsPsych(true, () => undefined);
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_load({});
    ext.on_finish({});
    await ext.finalize();
    assert.strictEqual(ext.getLastRecording().host, null);
  });

  it('a throwing version() costs the host record, not the save', async () => {
    // finalize()'s outer try/catch would turn any throw here into
    // replayFinalizeError — i.e. no autosave at all. Host identity is the
    // least important field in the file; it must never be able to cost the
    // recording.
    const { jsPsych, store } = mockJsPsych(true, () => { throw new Error('no version'); });
    const ext = new CyborgHunterReplayExtension(jsPsych);
    ext.initialize({ participantId: 'P2', tier: 'trace', autoSave: { mode: 'none' } });
    ext.on_load({});
    ext.on_finish({});
    await ext.finalize();
    assert.strictEqual(store.props.integrityReplayMeta.saved_to, 'none',
      'the recording still saved');
    assert.strictEqual(store.props.replayFinalizeError, undefined);
    assert.strictEqual(ext.getLastRecording().host, null);
  });

  it('standalone recordings carry no host (the other side of the pin)', () => {
    const api = CHReplay.attach({ participantId: 'P8', tier: 'trace', autoSave: { mode: 'none' } });
    api.startSession();
    api.startTrial({ trialId: 'r1' });
    api.endTrial();
    api.stopSession('finished');
    assert.strictEqual(api.getRecording().host, null);
    api.destroy();
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
