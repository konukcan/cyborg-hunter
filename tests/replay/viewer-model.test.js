// tests/replay/viewer-model.test.js
// buildViewerModel v2 (T5 Task 1, design §9): SessionRecording v2 from ANY
// producer → the viewer model the report ships alongside its viewer copy.
//
// This file was a shape check for the 0.7.2 module extraction; T5 grows it
// into the real suite, because the model is now the only place where the
// spec's segment/span vocabulary is turned into something the client walks.
// Both committed conformance fixtures are converted here — a hand-authored
// one and a foreign-producer one — so the wire-format claims stay pinned by
// files rather than by prose.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { buildViewerModel } from '../../src/replay/viewer-model.js';
// The strict profile, imported so the two readings of §3's pre-keyframe rule
// are compared by machine rather than by prose (review I-1).
import { validateStrict } from '../../src/shared/schema-v2-validator.js';

const FIXTURES = new URL('./schema-v2/fixtures/', import.meta.url);
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'));

const canonical = () => fixture('canonical-core');
const jspsychFull = () => fixture('jspsych-full');

// Smallest recording the tolerant profile (spec §11) accepts: schema_version,
// a recorder identity, and a segments array whose entries carry events[].
function minimalRecording(overrides) {
  return {
    schema_version: 2,
    recorder: { name: 'cyborg-hunter-replay', version: '0.7.5' },
    segments: [],
    ...overrides,
  };
}

function segment(overrides) {
  return {
    index: 0, label: null, plugin: null,
    t_start: null, t_dom_ready: null, t_load: null, t_end: null,
    initial_dom: null, initial_state: null, events: [],
    host_data: null, extensions: null,
    ...overrides,
  };
}

// A minimal DomNode tree (spec §4) — enough to mark a segment as a keyframe.
const keyframeTree = () => ({ id: 1, kind: 'element', tag: 'body', attrs: {}, children: [] });

describe('buildViewerModel — module hygiene', () => {
  it('imports no Node fs/path APIs (must stay bundleable for the browser demo)', () => {
    const src = readFileSync(
      new URL('../../src/replay/viewer-model.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"](node:)?(fs|path)['"]/);
  });

  it('carries no v1 vocabulary: legacy and markerAttr are deleted', () => {
    const model = buildViewerModel(canonical());
    assert.ok(!('legacy' in model), 'the reduced-guarantees banner has no v2 meaning');
    assert.ok(!('markerAttr' in model), 'nonce-marker addressing is retired (design §4)');
    assert.ok(!('trials' in model), 'trials became segments');
  });
});

describe('buildViewerModel — canonical-core (hand-authored keyframe/continuation)', () => {
  it('converts without throwing and reports the v2 top-level shape', () => {
    const model = buildViewerModel(canonical());
    assert.strictEqual(model.schemaVersion, 2);
    assert.deepStrictEqual(model.recorder, { name: 'hand-authored', version: '0.0.1' });
    assert.strictEqual(model.truncated, false);
    assert.strictEqual(model.endReason, 'finished');
    assert.strictEqual(model.startPerf, 0);
    assert.strictEqual(model.segments.length, 3);
  });

  it('marks keyframes and points every segment at its span start', () => {
    const model = buildViewerModel(canonical());
    assert.deepStrictEqual(model.segments.map((s) => s.keyframe), [true, false, true]);
    assert.deepStrictEqual(model.segments.map((s) => s.spanStart), [0, 0, 2],
      'segment 1 is a continuation of segment 0\'s span; segment 2 opens its own');
    assert.deepStrictEqual(model.segments.map((s) => s.defect), [null, null, null]);
  });

  it('rebases event times to the segment origin and keeps durations finite', () => {
    const model = buildViewerModel(canonical());
    const wire = canonical();
    const seg1 = model.segments[1];
    assert.strictEqual(seg1.origin, 2000, 'continuation states only t_start');
    assert.deepStrictEqual(
      seg1.events.map((e) => e.t),
      wire.segments[1].events.map((e) => Math.round((e.t - 2000) * 10) / 10));
    assert.strictEqual(seg1.durMs, 1500);              // t_end 3500 − origin 2000
    assert.ok(model.segments.every((s) => Number.isFinite(s.durMs)));
  });

  it('passes the keyframe tree and initial_state through untouched', () => {
    const model = buildViewerModel(canonical());
    const wire = canonical();
    assert.deepStrictEqual(model.segments[0].initialDom, wire.segments[0].initial_dom,
      'initialDom is a DomNode tree in v2, never an HTML string');
    assert.strictEqual(model.segments[1].initialDom, null);
    assert.deepStrictEqual(model.segments[2].initialState, wire.segments[2].initial_state);
    assert.strictEqual(model.segments[0].initialState, null);
  });

  it('keeps session-level streams in ABSOLUTE wire time', () => {
    const model = buildViewerModel(jspsychFull());
    const wire = jspsychFull();
    assert.deepStrictEqual(model.stylesheetEvents.map((e) => e.t),
      wire.stylesheet_events.map((e) => e.t),
      'one viewport_changes/stylesheet_events array serves every segment, so it is rebased at use');
    assert.strictEqual(model.stylesheets.length, 1);
  });
});

describe('buildViewerModel — jspsych-full (foreign producer, 14 keyframes)', () => {
  it('converts without throwing; every segment is its own span', () => {
    const model = buildViewerModel(jspsychFull());
    assert.strictEqual(model.segments.length, 14);
    assert.ok(model.segments.every((s) => s.keyframe), 'jsPsych wipes the display each trial');
    assert.deepStrictEqual(model.segments.map((s) => s.spanStart),
      model.segments.map((s) => s.index));
    assert.ok(model.segments.every((s) => s.defect === null));
  });

  it('takes the origin from t_dom_ready (t_load is null on all 14 segments)', () => {
    const model = buildViewerModel(jspsychFull());
    const wire = jspsychFull();
    assert.ok(wire.segments.every((s) => s.t_load === null));
    assert.deepStrictEqual(model.segments.map((s) => s.origin),
      wire.segments.map((s) => s.t_dom_ready));
    // The fork's player rebases by t_dom_ready too, so a session-relative
    // checkpoint t lands at the same moment in both players (plan Task 7).
    const first = model.segments[0];
    assert.strictEqual(first.events[0].t,
      Math.round((wire.segments[0].events[0].t - wire.segments[0].t_dom_ready) * 10) / 10);
  });

  it('infers a dom tier structurally when the CH extension carries none', () => {
    const model = buildViewerModel(jspsychFull());
    const wire = jspsychFull();
    assert.strictEqual(wire.extensions['cyborg-hunter'].tier, undefined,
      'the converter stamps provenance only');
    assert.strictEqual(model.tier, 'dom');
  });

  it('renders no CH panel data (each panel guarded on its own field)', () => {
    const model = buildViewerModel(jspsychFull());
    assert.strictEqual(model.scoring, null);
    assert.deepStrictEqual(model.guardViolations, []);
    assert.deepStrictEqual(model.captureFailures, []);
    assert.strictEqual(model.captureStopped, false);
    assert.strictEqual(model.keys, null);
  });
});

// ── §3 segment time origin ────────────────────────────────────────────────
// The table exists to pin ONE adjudication: spec §3 says "first non-null of
// t_load, t_dom_ready, t_start; else the first event's t". The pre-design's
// paraphrase swapped the first two. No committed fixture separates the two
// readings (canonical-core has t_dom_ready === t_load; jspsych-full has
// t_load: null everywhere; CH standalone emits t_load only), so case 1 below
// is the only assertion in the repo that pins the adjudication.
describe('buildViewerModel — §3 segment time origin', () => {
  const cases = [
    ['t_load WINS over a DIFFERENT t_dom_ready (the discriminating case)',
      { t_load: 700, t_dom_ready: 900, t_start: 500, events: [{ type: 'x', t: 1000 }] }, 700],
    ['t_load only (CH standalone emits nothing else)',
      { t_load: 700, events: [{ type: 'x', t: 1000 }] }, 700],
    ['t_dom_ready when t_load is null (jspsych-full\'s shape)',
      { t_dom_ready: 900, t_start: 500, events: [{ type: 'x', t: 1000 }] }, 900],
    ['t_start when neither load nor dom_ready is stated',
      { t_start: 500, events: [{ type: 'x', t: 1000 }] }, 500],
    ['the first event\'s t when no anchor is stated',
      { events: [{ type: 'x', t: 1000 }, { type: 'y', t: 1200 }] }, 1000],
    ['0 when there is neither an anchor nor an event', {}, 0],
  ];
  for (const [label, fields, expected] of cases) {
    it(label, () => {
      const model = buildViewerModel(minimalRecording({ segments: [segment(fields)] }));
      assert.strictEqual(model.segments[0].origin, expected);
    });
  }

  it('rebasing is a pure subtraction, not a clamp, even before the origin', () => {
    // A segment whose first event precedes its origin (t_load fires after an
    // early event). v1 clamped at 0; v2 must not, or a pre-origin event is
    // reported as happening at the segment start.
    const model = buildViewerModel(minimalRecording({
      segments: [segment({ t_load: 100, events: [{ type: 'x', t: 40 }, { type: 'y', t: 150 }] })],
    }));
    const seg = model.segments[0];
    assert.deepStrictEqual(seg.events.map((e) => e.t), [-60, 50]);
    assert.deepStrictEqual(seg.events.map((e) => seg.origin + e.t), [40, 150]);
  });

  // ── the conversion contract Task 7's checkpoint executor reads ──────────
  // Two claims, because they are not the same claim and only the first is
  // exact. Measured fixture-wide rather than asserted: an earlier version of
  // this suite pinned the round trip on exactly-representable integers only,
  // which passes while 735 of jspsych-full's 909 events miss it.
  for (const name of ['canonical-core', 'jspsych-full']) {
    it(`${name}: the FORWARD conversion is exact for every event (the executor's rule)`, () => {
      const wire = fixture(name);
      const model = buildViewerModel(wire);
      let n = 0;
      model.segments.forEach((seg, i) => seg.events.forEach((e, j) => {
        const t = wire.segments[i].events[j].t;
        // Recomputed independently of the implementation: session-relative
        // wire t minus the segment origin, rounded to the wire's own 0.1 ms.
        assert.strictEqual(e.t, Math.round((t - seg.origin) * 10) / 10,
          `segment ${i} event ${j}`);
        n++;
      }));
      assert.ok(n > 0, 'the fixture must actually carry events');
    });

    it(`${name}: the REVERSE conversion holds only to a bound, and the bound is 5e-7 ms`, () => {
      const wire = fixture(name);
      const model = buildViewerModel(wire);
      let worst = 0, worstAt = null, n = 0;
      model.segments.forEach((seg, i) => seg.events.forEach((e, j) => {
        const t = wire.segments[i].events[j].t;
        const d = Math.abs(seg.origin + e.t - t);
        if (d > worst) { worst = d; worstAt = `segment ${i} event ${j} (origin ${seg.origin}, tRel ${e.t}, wire ${t})`; }
        n++;
      }));
      assert.ok(n > 0, 'the fixture must actually carry events');
      assert.ok(worst <= 5e-7,
        `reverse round-trip error ${worst} ms exceeds the stated 5e-7 ms bound at ${worstAt}`);
    });
  }
});

// ── keyframe spans ────────────────────────────────────────────────────────
// The defect rule is `validator.js`'s, not a second reading of §3: a
// pre-keyframe segment is illegal IFF it carries `dom.*` events. The
// equivalence is asserted against the validator itself below, so the two
// cannot drift — the same argument the §11 reason strings are mirrored for.
describe('buildViewerModel — keyframe spans and defects', () => {
  it('marks a continuation carrying dom.* before any keyframe as a defect, and does not throw', () => {
    const model = buildViewerModel(minimalRecording({
      segments: [
        segment({ index: 0, t_start: 0, events: [{ type: 'dom.attr', t: 5, node: 1, name: 'class', value: 'x' }] }),
        segment({ index: 1, t_start: 10, initial_dom: keyframeTree() }),
      ],
    }));
    assert.strictEqual(model.segments[0].spanStart, null);
    assert.strictEqual(model.segments[0].defect, 'continuation-before-keyframe');
    assert.strictEqual(model.segments[1].defect, null, 'the keyframe itself is fine');
    assert.strictEqual(model.segments[1].spanStart, 1);
  });

  it('a trace recording (no keyframe ANYWHERE) is not a defect — spec §3', () => {
    const model = buildViewerModel(minimalRecording({
      segments: [segment({ index: 0, t_start: 0, events: [{ type: 'mouse.move', t: 5 }] })],
    }));
    assert.strictEqual(model.tier, 'trace', 'structural inference: no segment carries a keyframe');
    assert.strictEqual(model.segments[0].spanStart, null);
    assert.strictEqual(model.segments[0].defect, null,
      'null before any keyframe = the recording is trace-only, not a violation');
  });

  it('a TRACE PROLOGUE before a later keyframe is legal, not a defect', () => {
    // The shape a persistent-DOM host produces when it starts recording
    // before the DOM is ready and keyframes at the first boundary (§3:
    // "persistent-DOM hosts SHOULD keyframe periodically"). No committed
    // fixture carries it — CH's own capture forces a keyframe on an implicit
    // segment (capture-dom.js:311) — so it is constructed here.
    const model = buildViewerModel(minimalRecording({
      segments: [
        segment({ index: 0, t_start: 0, events: [{ type: 'mouse.move', t: 5 }, { type: 'key.down', t: 7 }] }),
        segment({ index: 1, t_start: 10, initial_dom: keyframeTree() }),
      ],
    }));
    assert.strictEqual(model.segments[0].defect, null,
      'a pre-keyframe segment with no dom.* events reconstructs nothing and loses nothing');
    assert.strictEqual(model.segments[0].spanStart, null);
    assert.strictEqual(model.tier, 'dom', 'a keyframe exists, so the recording is dom tier');
  });

  it('dom.* before any keyframe is a defect even when NO keyframe ever arrives', () => {
    // The false-negative half. Without this the viewer shows a neutral grey
    // trace stage and silently drops patches a player is required to flag.
    const model = buildViewerModel(minimalRecording({
      segments: [segment({
        index: 0, t_start: 0,
        events: [{ type: 'mouse.move', t: 1 }, { type: 'dom.text', t: 5, node: 3, text: 'x' }],
      })],
    }));
    assert.strictEqual(model.tier, 'trace', 'no keyframe anywhere: the tier inference is unchanged');
    assert.strictEqual(model.segments[0].defect, 'continuation-before-keyframe');
  });

  it('a non-DomNode initial_dom is not a keyframe (a v1 HTML string cannot be mounted)', () => {
    const model = buildViewerModel(minimalRecording({
      segments: [segment({
        index: 0, t_start: 0, initial_dom: '<div id="stim">Which card?</div>',
        events: [{ type: 'dom.text', t: 5, node: 3, text: 'x' }],
      })],
    }));
    assert.strictEqual(model.segments[0].keyframe, false);
    assert.strictEqual(model.segments[0].initialDom, null, 'never handed to mountTree');
    assert.strictEqual(model.segments[0].defect, 'continuation-before-keyframe');
    assert.strictEqual(model.tier, 'trace');
  });

  // The point of I-1: ONE reading of §3's pre-keyframe rule, machine-checked
  // against the strict profile rather than argued.
  it('agrees with validator.js on every pre-keyframe shape', () => {
    const SHAPES = {
      'trace prologue then keyframe': [
        segment({ index: 0, t_start: 0, events: [{ type: 'mouse.move', t: 5, x: 1, y: 2 }] }),
        segment({ index: 1, t_start: 10, initial_dom: keyframeTree() }),
      ],
      'dom.* prologue then keyframe': [
        segment({ index: 0, t_start: 0, events: [{ type: 'dom.attr', t: 5, node: 1, name: 'class', value: 'x' }] }),
        segment({ index: 1, t_start: 10, initial_dom: keyframeTree() }),
      ],
      'trace only, no keyframe': [
        segment({ index: 0, t_start: 0, events: [{ type: 'mouse.move', t: 5, x: 1, y: 2 }] }),
      ],
      'dom.* only, no keyframe': [
        segment({ index: 0, t_start: 0, events: [{ type: 'dom.text', t: 5, node: 3, text: 'x' }] }),
      ],
      'keyframe first, then dom.*': [
        segment({ index: 0, t_start: 0, initial_dom: keyframeTree() }),
        segment({ index: 1, t_start: 10, events: [{ type: 'dom.text', t: 15, node: 1, text: 'x' }] }),
      ],
      'non-DomNode initial_dom then dom.*': [
        segment({ index: 0, t_start: 0, initial_dom: '<div></div>',
          events: [{ type: 'dom.text', t: 5, node: 3, text: 'x' }] }),
      ],
    };
    const NEEDLE = /continuation carries dom\.\* events before any keyframe/;
    for (const [label, segs] of Object.entries(SHAPES)) {
      const rec = minimalRecording({ segments: segs });
      const model = buildViewerModel(rec);
      const strict = validateStrict(rec);
      const flaggedByValidator = new Set(
        (strict.errors || []).filter((e) => NEEDLE.test(e))
          .map((e) => Number(/segments\[(\d+)\]/.exec(e)[1])));
      const flaggedByModel = new Set(
        model.segments.filter((s) => s.defect !== null).map((s) => s.index));
      assert.deepStrictEqual([...flaggedByModel].sort(), [...flaggedByValidator].sort(),
        `${label}: model ${JSON.stringify([...flaggedByModel])} vs validator ${JSON.stringify([...flaggedByValidator])}`);
    }
  });

  it('a deep span points every continuation at the same keyframe', () => {
    const segs = [segment({ index: 0, t_start: 0, initial_dom: keyframeTree() })];
    for (let i = 1; i < 10; i++) segs.push(segment({ index: i, t_start: i * 100 }));
    const model = buildViewerModel(minimalRecording({ segments: segs }));
    assert.deepStrictEqual(model.segments.map((s) => s.spanStart), new Array(10).fill(0));
  });
});

// ── §11 tolerant loader ───────────────────────────────────────────────────
// Reject ONLY these four. Everything else loads with a documented default:
// recordings are unrepeatable participant data, and rejection at runtime is
// data loss. Strictness lives in CI (src/shared/schema-v2-validator.js).
describe('buildViewerModel — §11 tolerant-loader rejections', () => {
  const reject = (recording) => {
    let err = null;
    try { buildViewerModel(recording); } catch (e) { err = e; }
    assert.ok(err, 'must reject');
    return err;
  };

  it('rejects schema_version !== 2', () => {
    const err = reject(minimalRecording({ schema_version: 1 }));
    assert.deepStrictEqual(err.reasons, ['schema_version must be the integer 2']);
    assert.match(err.message, /schema_version/);
  });

  it('rejects a missing recorder identity', () => {
    assert.deepStrictEqual(reject(minimalRecording({ recorder: null })).reasons,
      ['recorder {name, version} strings are required']);
    assert.deepStrictEqual(reject(minimalRecording({ recorder: { name: 'x' } })).reasons,
      ['recorder {name, version} strings are required']);
  });

  it('rejects a missing (or non-array) segments array', () => {
    assert.deepStrictEqual(reject(minimalRecording({ segments: undefined })).reasons,
      ['segments array is required']);
    assert.deepStrictEqual(reject(minimalRecording({ segments: {} })).reasons,
      ['segments array is required']);
  });

  it('rejects a segment without events[], naming the position', () => {
    assert.deepStrictEqual(
      reject(minimalRecording({ segments: [segment({}), { index: 1 }] })).reasons,
      ['segments[1] must carry an events array']);
    assert.deepStrictEqual(reject(minimalRecording({ segments: [null] })).reasons,
      ['segments[0] must carry an events array']);
  });

  it('rejects a non-object recording', () => {
    assert.match(reject(null).message, /recording must be a JSON object/);
    assert.match(reject([]).message, /recording must be a JSON object/);
  });

  it('reports every reason at once rather than the first', () => {
    const err = reject({ schema_version: 1, recorder: null, segments: null });
    assert.strictEqual(err.reasons.length, 3);
  });
});

// ── degradation ───────────────────────────────────────────────────────────
describe('buildViewerModel — degradation outside the rejection set', () => {
  it('drops null and non-object event entries instead of throwing', () => {
    const model = buildViewerModel(minimalRecording({
      segments: [segment({ t_load: 0, events: [null, { type: 'mouse.click', t: 5 }, 7] })],
    }));
    assert.strictEqual(model.segments[0].events.length, 1);
    assert.strictEqual(model.segments[0].events[0].type, 'mouse.click');
  });

  it('sorts out-of-order events by t (stable at ties)', () => {
    const model = buildViewerModel(minimalRecording({
      segments: [segment({
        t_load: 0,
        events: [
          { type: 'dom.attr', t: 100 },
          { type: 'input.value', t: 50 },
          { type: 'mouse.move', t: 75 },
          { type: 'dom.text', t: 50, tag: 'second-at-50' },
        ],
      })],
    }));
    const ts = model.segments[0].events.map((e) => e.t);
    assert.deepStrictEqual(ts, [50, 50, 75, 100],
      'the viewer scans forward and would mis-apply an out-of-order event on a seek');
    assert.deepStrictEqual(model.segments[0].events.slice(0, 2).map((e) => e.type),
      ['input.value', 'dom.text'], 'equal-t order is preserved (stable sort)');
  });

  it('builds from a recording carrying nothing but the required fields', () => {
    const model = buildViewerModel(minimalRecording());
    assert.strictEqual(model.viewport, null);
    assert.strictEqual(model.viewportClient, null);
    assert.deepStrictEqual(model.viewportChanges, []);
    assert.deepStrictEqual(model.stylesheets, []);
    assert.deepStrictEqual(model.stylesheetEvents, []);
    assert.strictEqual(model.tier, 'trace');
    assert.strictEqual(model.pid, null);
    assert.strictEqual(model.host, null);
    assert.strictEqual(model.truncated, false);
  });

  it('tolerates a non-numeric t and a garbage segment index', () => {
    const model = buildViewerModel(minimalRecording({
      segments: [
        segment({ index: 'nonsense', t_load: 0, events: [{ type: 'x', t: 'soon' }] }),
        segment({ index: 99, t_start: 10 }),
      ],
    }));
    assert.deepStrictEqual(model.segments.map((s) => s.index), [0, 1],
      'spec §7: tolerant loaders trust array order');
    assert.ok(Number.isFinite(model.segments[0].events[0].t));
  });

  it('tolerates non-array session-level streams', () => {
    const model = buildViewerModel(minimalRecording({
      stylesheets: 'nope', stylesheet_events: null, viewport_changes: 3,
    }));
    assert.deepStrictEqual(model.stylesheets, []);
    assert.deepStrictEqual(model.stylesheetEvents, []);
    assert.deepStrictEqual(model.viewportChanges, []);
  });
});

// ── CH extension surface ──────────────────────────────────────────────────
describe('buildViewerModel — extensions[\'cyborg-hunter\']', () => {
  const chRecording = (ext) => minimalRecording({
    participant_id: 'P1',
    segments: [segment({ t_load: 0, initial_dom: keyframeTree() })],
    extensions: { 'cyborg-hunter': ext },
  });

  it('reads the tier from the CH namespace when it is stated', () => {
    const model = buildViewerModel(chRecording({ tier: 'trace' }));
    assert.strictEqual(model.tier, 'trace',
      'a stated tier beats the structural inference, even against a keyframe');
  });

  it('carries the CH panels through', () => {
    const model = buildViewerModel(chRecording({
      tier: 'dom', keys: 'full', ch_version: '0.7.5', preset: 'standard',
      scoring: { soft_score: 3, any_hard_triggered: false },
      guard_violations: [{ t: 5, kind: 'friction' }],
      capture_failures: [{ channel: 'scroll', message: 'x', t: 100 }],
      capture_stopped: true,
      inherited_redaction_taint: true,
    }));
    assert.strictEqual(model.keys, 'full');
    assert.strictEqual(model.chVersion, '0.7.5');
    assert.strictEqual(model.preset, 'standard');
    assert.strictEqual(model.scoring.soft_score, 3);
    assert.strictEqual(model.guardViolations.length, 1);
    assert.deepStrictEqual(model.captureFailures, ['scroll']);
    assert.strictEqual(model.captureStopped, true);
    assert.strictEqual(model.inheritedTaint, true);
  });

  it('surfaces the top-level truncated flag (spec §5.7)', () => {
    const model = buildViewerModel(minimalRecording({ truncated: true }));
    assert.strictEqual(model.truncated, true);
  });
});
