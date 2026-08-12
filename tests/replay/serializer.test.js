// tests/replay/serializer.test.js
// In-memory recorder buffer (absolute performance.now) → SessionRecording v2
// wire format (spec §2/§3, ms since recording start).
//
// Every test in this file runs its output through the strict conformance
// profile (tests/replay/schema-v2/validator.js). The serializer is the one
// place where CH claims to speak v2, so a shape assertion that the validator
// has not seen is a claim about the format made in prose — the v1 era's
// lesson. The inward import is deliberate and allowed: the schema directory
// itself imports nothing.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serialize } from '../../src/replay/serializer.js';
import { createRecorder } from '../../src/replay/recorder.js';
import { buildViewerModel } from '../../src/replay/viewer-model.js';
import { VERSION } from '../../src/shared/constants.js';
import { validateStrict } from './schema-v2/validator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const canonical = JSON.parse(readFileSync(
  join(HERE, 'schema-v2', 'fixtures', 'canonical-core.json'), 'utf8'));

// Assert-and-return: every test serializes through here, so no test can quietly
// skip the machine check.
function wire(state, opts) {
  const rec = serialize(state, opts || {});
  const result = validateStrict(rec);
  assert.deepStrictEqual(result.errors, [], 'strict validation errors');
  assert.strictEqual(result.ok, true);
  return rec;
}

// A DomNode keyframe, small but structurally complete (spec §4).
function tree() {
  return {
    id: 1, kind: 'element', tag: 'div', attrs: { id: 'stage' },
    children: [{ id: 2, kind: 'text', text: 'stim' }],
  };
}

// What recorder.getState() returns, in v2 field terms.
function state(overrides) {
  return Object.assign({
    participantId: 'P1',
    tier: 'dom',
    keys: 'full',
    sessionStart: 10000,              // performance.now() at startSession
    sessionStartEpoch: 1751600000000,
    userAgent: 'test-agent/1.0',
    observedRoot: null,
    viewport: { w: 1280, h: 800, dpr: 2, scale: 1, offset_x: 0, offset_y: 0 },
    viewportClient: { w: 1265, h: 800 },
    stylesheets: [{ id: 1, kind: 'inline', css: '.a{}', media: null }],
    trials: [
      {
        trialIndex: 0, trialId: 'rule-1', plugin: 'html-button-response',
        implicit: false,
        tLoad: 11000, tStart: 10950, tDomReady: 10990, tEnd: 15000,
        initialDom: tree(),
        initialState: { scroll: { x: 0, y: 40 }, element_scroll: [], media: [], form: [] },
        events: [
          { type: 'mouse.move', t: 11500, x: 5, y: 5 },
          { type: 'clipboard.paste', t: 12000, target: null, text: null, html: null, len: 42 },
        ],
      },
      {
        trialIndex: 1, trialId: '__session__', plugin: 'ch:standalone',
        implicit: true,
        tLoad: 15000, tStart: null, tDomReady: null, tEnd: null,
        initialDom: null,
        initialState: null,
        events: [{ type: 'mouse.click', t: 16000, x: 1, y: 2, button: 0, target: null }],
      },
    ],
    viewportChanges: [],
    guardViolations: [],
    captureFailures: [{ channel: 'scroll', message: 'boom', t: 12500 }],
    captureStopped: false,
    endReason: 'finished',
    state: 'stopped',
  }, overrides);
}

describe('serialize → SessionRecording v2 top level (spec §2)', () => {
  it('emits the v2 shell with the recorder identity split into name/version', () => {
    const rec = wire(state());
    assert.strictEqual(rec.schema_version, 2);
    assert.deepStrictEqual(rec.recorder, { name: 'cyborg-hunter-replay', version: VERSION });
    assert.strictEqual(rec.host, null, 'standalone recordings have no host runtime');
    assert.strictEqual(rec.participant_id, 'P1');
    assert.strictEqual(rec.recording_started_at, new Date(1751600000000).toISOString());
    assert.strictEqual(rec.user_agent, 'test-agent/1.0');
    assert.strictEqual(rec.observed_root, null);
    assert.strictEqual(rec.end_reason, 'finished');
    assert.strictEqual(rec.truncated, false);
  });

  it('recording_started_at_perf is the session origin, so event t is relative to it (spec §7)', () => {
    const rec = wire(state());
    assert.strictEqual(rec.recording_started_at_perf, 10000);
    // 11500 absolute − 10000 origin = 1500 on the wire; adding the origin back
    // returns the capture-time value, which is what §7's "relative to" means.
    assert.strictEqual(rec.segments[0].events[0].t, 1500);
    assert.strictEqual(rec.segments[0].events[0].t + rec.recording_started_at_perf, 11500);
  });

  it('ended_at_perf sits in the same performance clock as the origin', () => {
    const rec = wire(state());
    // The last observed moment: trial 1 is still open, so its last event.
    assert.strictEqual(rec.ended_at_perf, 16000);
    assert.ok(rec.ended_at_perf >= rec.recording_started_at_perf);
  });

  it('viewport is the §2 ViewportState, and CH client dims ride in the vendor namespace', () => {
    const rec = wire(state());
    assert.deepStrictEqual(rec.viewport,
      { w: 1280, h: 800, dpr: 2, scale: 1, offset_x: 0, offset_y: 0 });
    assert.deepStrictEqual(rec.extensions['cyborg-hunter'].viewport_client, { w: 1265, h: 800 });
  });

  it('stylesheets are one array of id-bearing snapshots plus an events array', () => {
    const rec = wire(state());
    assert.deepStrictEqual(rec.stylesheets,
      [{ id: 1, kind: 'inline', css: '.a{}', media: null }]);
    assert.deepStrictEqual(rec.stylesheet_events, [],
      'CH captures no stylesheet mutations yet (recorded gap)');
  });

  it('rng and rng_calls are both null — CH never re-executes code', () => {
    const rec = wire(state());
    assert.strictEqual(rec.rng, null);
    assert.strictEqual(rec.rng_calls, null);
  });

  it('observed_root carries the configured selector when there is one', () => {
    const rec = wire(state({ observedRoot: '#jspsych-content' }));
    assert.strictEqual(rec.observed_root, '#jspsych-content');
  });

  it('host is whatever the adapter supplies (jsPsych identity, spec §2)', () => {
    const rec = wire(state(), { host: { name: 'jspsych', version: '8.2.1' } });
    assert.deepStrictEqual(rec.host, { name: 'jspsych', version: '8.2.1' });
  });

  it('a viewport of unknown geometry serializes as zeros, not nulls', () => {
    // Strict validation types every ViewportState field as a number. A
    // recorder started with no window (node harness) has no geometry to
    // report, and the format has no way to say so — zeros keep the file
    // loadable where nulls would make it unparseable for every consumer.
    const rec = wire(state({ viewport: null, viewportClient: null }));
    assert.deepStrictEqual(rec.viewport,
      { w: 0, h: 0, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 });
    assert.strictEqual(rec.extensions['cyborg-hunter'].viewport_client, null);
  });
});

describe('serialize → segments (spec §3)', () => {
  it('index is the array position, label is the trial id, plugin survives', () => {
    const rec = wire(state());
    assert.strictEqual(rec.segments.length, 2);
    assert.strictEqual(rec.segments[0].index, 0);
    assert.strictEqual(rec.segments[0].label, 'rule-1');
    assert.strictEqual(rec.segments[0].plugin, 'html-button-response');
    assert.strictEqual(rec.segments[1].index, 1);
  });

  it('index follows the array even when the recorder counter disagrees (spec §7)', () => {
    // The counter and the array can only diverge through a recorder bug, and
    // §7 makes the array authoritative: strict validation rejects the
    // disagreement, so the wire must not carry the counter's opinion.
    const s = state();
    s.trials[1].trialIndex = 47;
    const rec = wire(s);
    assert.deepStrictEqual(rec.segments.map(x => x.index), [0, 1]);
  });

  it('keeps the four segment clocks, converted to wire time', () => {
    const rec = wire(state());
    const s0 = rec.segments[0];
    assert.strictEqual(s0.t_start, 950);
    assert.strictEqual(s0.t_dom_ready, 990);
    assert.strictEqual(s0.t_load, 1000);
    assert.strictEqual(s0.t_end, 5000);
  });

  it('an open segment ends at its last observed event', () => {
    const rec = wire(state());
    assert.strictEqual(rec.segments[1].t_start, null);
    assert.strictEqual(rec.segments[1].t_dom_ready, null);
    assert.strictEqual(rec.segments[1].t_end, 6000);
  });

  it('carries the DomNode keyframe and its initial_state seed verbatim', () => {
    const rec = wire(state());
    assert.deepStrictEqual(rec.segments[0].initial_dom, tree());
    assert.deepStrictEqual(rec.segments[0].initial_state,
      { scroll: { x: 0, y: 40 }, element_scroll: [], media: [], form: [] });
  });

  it('a segment with no keyframe is a continuation: initial_dom null', () => {
    const rec = wire(state());
    assert.strictEqual(rec.segments[1].initial_dom, null);
    assert.strictEqual(rec.segments[1].initial_state, null);
  });

  it('host_data is null unless the host supplies one', () => {
    const rec = wire(state());
    assert.strictEqual(rec.segments[0].host_data, null);
    const s = state();
    s.trials[0].hostData = { correct: true };
    assert.deepStrictEqual(wire(s).segments[0].host_data, { correct: true });
  });

  it('an implicitly opened segment says so in its own extensions block', () => {
    const rec = wire(state());
    assert.strictEqual(rec.segments[0].extensions, null,
      'a bracketed segment has nothing vendor-specific to say');
    assert.deepStrictEqual(rec.segments[1].extensions,
      { 'cyborg-hunter': { implicit: true } });
  });

  it('events are time-sorted within a segment', () => {
    const s = state();
    s.trials[0].events = [
      { type: 'clipboard.paste', t: 12000, target: null, text: null, html: null, len: 1 },
      { type: 'mouse.move', t: 11500, x: 1, y: 1 },
    ];
    const rec = wire(s);
    assert.deepStrictEqual(rec.segments[0].events.map(e => e.type),
      ['mouse.move', 'clipboard.paste']);
  });

  it('event payloads survive untouched apart from t', () => {
    const s = state();
    s.trials[0].events = [{
      type: 'key.down', t: 11100, key: 'a', code: 'KeyA',
      mods: { ctrl: false, shift: false, alt: false, meta: false },
      repeat: false, target: 2,
      camera: { scroll_x: 0, scroll_y: 0, viewport_w: 1280, viewport_h: 800,
                client_w: 1265, client_h: 800, dpr: 2,
                vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0 },
      anchor: { tag: 'input', id: 'answer', rect: { x: 1, y: 2, w: 3, h: 4 }, node: 2 },
      extensions: { 'cyborg-hunter': { shadow_retarget: true } },
    }];
    const rec = wire(s);
    const e = rec.segments[0].events[0];
    assert.strictEqual(e.t, 1100);
    assert.strictEqual(e.anchor.node, 2);
    assert.deepStrictEqual(e.extensions, { 'cyborg-hunter': { shadow_retarget: true } });
    assert.strictEqual(e.camera.dpr, 2);
  });
});

describe('serialize → viewport_changes (spec §2)', () => {
  it('the session-level viewport stream reaches the wire in session-relative time', () => {
    const rec = wire(state({
      viewportChanges: [
        { w: 1280, h: 800, dpr: 2, scale: 1, offset_x: 0, offset_y: 0, t: 11000 },
        { w: 900, h: 800, dpr: 2, scale: 1, offset_x: 0, offset_y: 0, t: 13000 },
      ],
    }));
    assert.deepStrictEqual(rec.viewport_changes.map(c => c.t), [1000, 3000]);
    assert.strictEqual(rec.viewport_changes[1].w, 900);
  });

  it('the stream is sorted on the wire even if it reached the buffer out of order', () => {
    // §7 requires the array time-sorted, and strict validation enforces it.
    // The capture side coalesces through RAF callbacks, so the serializer is
    // the last place that can guarantee the property for the file.
    const rec = wire(state({
      viewportChanges: [
        { w: 900, h: 800, dpr: 1, scale: 1, offset_x: 0, offset_y: 0, t: 13000 },
        { w: 1280, h: 800, dpr: 1, scale: 1, offset_x: 0, offset_y: 0, t: 11000 },
      ],
    }));
    assert.deepStrictEqual(rec.viewport_changes.map(c => c.t), [1000, 3000]);
  });
});

describe('serialize → extensions["cyborg-hunter"] (spec §9)', () => {
  const chSessionReport = {
    libraryVersion: '0.6.0',
    config: { preset: 'standard', participantId: 'P1' },
    hardScore: { paste: { count: 3, threshold: 2, triggered: true } },
    softScore: 7, softScoreThreshold: 6, anyHardTriggered: true, trialsCompleted: 2,
    sidebarEvents: [{ t: 11800, type: 'opened', deltaIW: 340 }],
    aiExtensionsFound: [{ name: 'Monica AI', t: 10100 }],
    devToolsEvents: [], windowPositions: [], layoutShifts: [], zoomChanges: [],
    keyboardShortcuts: [], idleGaps: [], extensionInjections: [],
  };

  it('carries the v1 ch_extensions content under the vendor key', () => {
    const rec = wire(state(), { chSessionReport });
    const ext = rec.extensions['cyborg-hunter'];
    assert.strictEqual(ext.replay_version, VERSION);
    assert.strictEqual(ext.ch_version, '0.6.0');
    assert.strictEqual(ext.preset, 'standard');
    assert.strictEqual(ext.scoring.soft_score, 7);
    assert.strictEqual(ext.scoring.any_hard_triggered, true);
    assert.strictEqual(ext.session_signals.sidebar_events[0].t, 1800,
      'session signals convert to session-relative time too');
    assert.strictEqual(ext.session_signals.ai_extensions_found[0].name, 'Monica AI');
  });

  it('marker_attr is retired — integer node ids replaced it (spec §4)', () => {
    const rec = wire(state({ markerAttr: 'data-chn-abc123' }), { chSessionReport });
    assert.strictEqual('marker_attr' in rec.extensions['cyborg-hunter'], false);
    assert.ok(!JSON.stringify(rec).includes('data-chn-'),
      'no nonce marker survives anywhere on the wire');
  });

  it('tier and keys move from metadata into the vendor namespace (spec §14)', () => {
    const rec = wire(state());
    assert.strictEqual(rec.extensions['cyborg-hunter'].tier, 'dom');
    assert.strictEqual(rec.extensions['cyborg-hunter'].keys, 'full');
  });

  it('capture failures and guard violations ride in the vendor namespace', () => {
    const rec = wire(state({
      guardViolations: [{ reason: 'not_fullscreen', phase: 'start', t: 11200 }],
    }));
    const ext = rec.extensions['cyborg-hunter'];
    assert.deepStrictEqual(ext.capture_failures.map(f => [f.channel, f.t]), [['scroll', 2500]]);
    assert.deepStrictEqual(ext.guard_violations.map(g => [g.reason, g.t]),
      [['not_fullscreen', 1200]]);
  });

  it('omits scoring when no CH report is provided (standalone use)', () => {
    const rec = wire(state());
    assert.strictEqual(rec.extensions['cyborg-hunter'].scoring, null);
    assert.strictEqual(rec.extensions['cyborg-hunter'].session_signals, null);
  });
});

describe('serialize → truncation (spec §5.7)', () => {
  it('truncated mirrors the recorder capture-stopped flag', () => {
    const s = state({ captureStopped: true });
    s.trials[0].events.push({
      type: 'recording.capture_stopped', t: 12800, reason: 'buffer_limit',
      extensions: { 'cyborg-hunter': { limit_events: 50000 } },
    });
    const rec = wire(s);
    assert.strictEqual(rec.truncated, true);
    assert.strictEqual(rec.extensions['cyborg-hunter'].capture_stopped, true);
    const stops = rec.segments.flatMap(x => x.events)
      .filter(e => e.type === 'recording.capture_stopped');
    assert.strictEqual(stops.length, 1, 'the stop signal is emitted once per recording');
  });

  it('carries the crossed cap from a REAL recorder run all the way to the model', () => {
    // The §5.7 banner in the viewer quotes the configured cap out of this
    // event's vendor namespace, so the copy-through is now load-bearing and
    // needs a test that would notice a narrowing. The test above CONSTRUCTS the
    // event and never asserts the namespace survives `serialize`; this one
    // starts from the real recorder, at a cap it was really configured with,
    // and follows the value to the object the viewer reads.
    const rec = createRecorder({ participantId: 'P1', maxEventsPerTrial: 3 });
    rec.startSession();
    rec.startTrial({ trialId: 't1' });
    for (let i = 0; i < 10; i++) rec.pushRecord({ type: 'mouse.move', x: i, y: i });
    rec.endTrial();
    rec.stopSession();

    const wired = wire(rec.getState());
    const stop = wired.segments.flatMap(x => x.events)
      .find(e => e.type === 'recording.capture_stopped');
    assert.ok(stop, 'the wire carries the §5.7 event');
    assert.strictEqual(stop.reason, 'buffer_limit');
    assert.deepStrictEqual(stop.extensions, { 'cyborg-hunter': { limit_events: 3 } },
      'the configured cap survives serialization, in the §9 vendor namespace');

    const model = buildViewerModel(wired);
    const modelStop = model.segments.flatMap(s2 => s2.events)
      .find(e => e.type === 'recording.capture_stopped');
    assert.deepStrictEqual(modelStop.extensions, { 'cyborg-hunter': { limit_events: 3 } },
      'and survives buildViewerModel, which is where the viewer reads it');
  });

  it('an untruncated recording says so explicitly', () => {
    assert.strictEqual(wire(state()).truncated, false);
  });
});

describe('serialize → failure modes', () => {
  it('throws a clear error when serialized before startSession', () => {
    // Direct serialize/getRecording before startSession is a programmer error
    // (there is no timestamp base) and fails loudly. The teardown path
    // (autoSaveNow) degrades to a no_session result instead.
    const s0 = state({ sessionStart: null, sessionStartEpoch: null });
    assert.throws(() => serialize(s0, {}), /startSession/);
  });

  it('an empty recording still validates', () => {
    const rec = wire(state({ trials: [], captureFailures: [] }));
    assert.deepStrictEqual(rec.segments, []);
    assert.strictEqual(rec.ended_at_perf, 10000);
  });

  it('is JSON-round-trip stable', () => {
    const rec = wire(state());
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rec)), rec);
  });
});

// ── Canonical shape ────────────────────────────────────────────────────────
// The hand-authored fixture is the external oracle: it predates this
// serializer and CH cannot influence it. Reproducing a session equivalent to
// it and deep-equalling the result is the check that CH emits the format
// rather than something the validator happens to accept.
describe('canonical-core equivalence', () => {
  // The session that would have produced canonical-core, in recorder terms.
  // Times are already session-relative in the fixture and the origin is 0, so
  // the buffer's absolute times equal the wire's.
  function canonicalState() {
    const seg = canonical.segments;
    return {
      participantId: canonical.participant_id,
      tier: 'dom', keys: 'full',
      sessionStart: 0,
      sessionStartEpoch: Date.parse(canonical.recording_started_at),
      userAgent: canonical.user_agent,
      observedRoot: canonical.observed_root,
      viewport: canonical.viewport,
      viewportClient: null,
      stylesheets: canonical.stylesheets,
      viewportChanges: canonical.viewport_changes,
      trials: seg.map((s, i) => ({
        trialIndex: i, trialId: s.label, plugin: s.plugin, implicit: false,
        tStart: s.t_start, tDomReady: s.t_dom_ready, tLoad: s.t_load, tEnd: s.t_end,
        initialDom: s.initial_dom, initialState: s.initial_state,
        hostData: s.host_data,
        events: s.events.map(e => Object.assign({}, e)),
      })),
      guardViolations: [], captureFailures: [], captureStopped: false,
      endReason: canonical.end_reason,
      state: 'stopped',
    };
  }

  it('reproduces the fixture exactly, apart from producer identity and the vendor block', () => {
    const rec = wire(canonicalState());
    // The two documented differences, both required rather than incidental:
    //  1. `recorder` names the producer; the fixture is hand-authored.
    //  2. `extensions` is null in the fixture; CH always has vendor data to
    //     carry (replay version, tier/keys config echo, capture diagnostics),
    //     and spec §9 is where it belongs.
    assert.deepStrictEqual(rec.recorder, { name: 'cyborg-hunter-replay', version: VERSION });
    assert.notStrictEqual(rec.extensions, null);

    const normalized = Object.assign({}, rec, {
      recorder: canonical.recorder,
      extensions: null,
    });
    assert.deepStrictEqual(normalized, canonical);
  });

  it('key order on the wire matches the fixture (readability is a contract too)', () => {
    const rec = wire(canonicalState());
    assert.deepStrictEqual(Object.keys(rec), Object.keys(canonical));
    assert.deepStrictEqual(Object.keys(rec.segments[0]), Object.keys(canonical.segments[0]));
  });
});
