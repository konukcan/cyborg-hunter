// tests/replay/schema-v2/checkpoints.test.js
// The checkpoint executor: CH's shipped report viewer reconstructing each
// fixture to a named session-relative moment and reading state off the
// reconstruction through the recorded node ids.
//
// WHY THIS FILE EXISTS. `expectations/*.json` has carried a `checkpoints` array
// since T2 and nothing in CH read it — `conformance.test.js` asserts counts,
// spot checks and invariants over the WIRE and never reconstructs anything. So
// the strongest claim the corpus makes ("at t, this node holds this") was being
// checked by the fork's player alone. This is CH's half.
//
// THE INVARIANT THIS FILE IS SUBORDINATE TO. The viewer must never become CH's
// conformance definition. No expected value here was read off CH's viewer:
// canonical-core's four were authored in the FORK (commit 66d45b5) before CH
// had an executor at all, and jspsych-full's ten were authored from the
// recording's own payloads and executed by the fork's player first (fork commit
// 7dd9ee5; evidence in
// `.superpowers/sdd/2026-08-11-t5-a2-viewer-migration/task-7a-crosscheck.md`).
// A value CH's viewer and the fork disagree on is escalated, never adjusted.
//
// THE CONTRACT, mirroring the fork's `tests/checkpoints.test.ts`:
//   - four props: `text`, `exists`, `value`, `attr:<name>`; anything else
//     THROWS rather than falling through to `getAttribute("")` and reading a
//     quiet null;
//   - every prop but `exists` fails loudly on an id the span did not bind;
//   - `t` is SESSION-relative and is bounds-checked against BOTH the keyframe
//     span and the named segment's own window, because CH's `seek()` clamps
//     into `[0, durMs]` and a clamped seek reconstructs a neighbouring moment
//     in silence;
//   - `equals` is compared with `Object.is`: every authored value is a scalar.
//
// TWO PLAYERS, ONE CONVERSION. Checkpoint `t` is session-relative and CH's
// viewer speaks segment-relative ms, so the executor rebases — with the SAME
// forward rule the model uses, `round1(t − origin)` over the §3 origin
// (`viewer-model.js`'s conversion contract). Computing it the same way is what
// makes the comparison exact by construction; the reverse direction
// (`origin + tRel`) is inexact by up to 5e-7 ms and is never used for equality
// here. The one place a reconstructed absolute appears is a segment's END when
// the recording states no `t_end`, and that is a BOUND, not an equality — the
// post-seek playhead identity below is what catches an arithmetic slip anyway.
//
// THE ONE IMPORT THAT IS NOT PACKAGE-PORTABLE. This directory is package-shaped
// and imports nothing else from CH — except here. On a package lift the
// checkpoint FORMAT, the bounds arithmetic and the placement guard travel; this
// block is what each adopting implementation re-supplies, and it owes THREE
// symbols, not one (review M-4 — the label used to say "player binding" and
// name only the first):
//   `boot`          — the genuine player binding. The fork's copy of this
//                     contract binds its own `Player` at the same seam.
//   `baseRecording` — a minimal valid v2 recording. Format-level, not
//                     CH-specific except for its `recorder.name` and
//                     `extensions['cyborg-hunter']` defaults, both overridable.
//   `segment`       — the same for one segment.
// The last two are used by ONE self-test (the §3 continuation refusal), which
// needs a recording no fixture contains. A lift that moves them into the
// package would leave a single-symbol binding; until someone does, the label
// has to name all three.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── the non-portable block: player binding + two recording constructors ────
import { boot, baseRecording, segment } from '../support/viewer-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const EXP = join(HERE, 'expectations');

// The wire rounds to 0.1 ms (spec §7) and so does the model's rebasing.
const round1 = (v) => Math.round(v * 10) / 10;

const where = (cp) => `checkpoint t=${cp.t} segment=${cp.segment}`;

// ---------------------------------------------------------------------------
// Placing a checkpoint: session-relative t → the viewer's segment-relative
// playhead, with both bounds checked before anything is reconstructed.
// ---------------------------------------------------------------------------

/**
 * @returns {{seg: object, tRel: number, segEnd: number}}
 * @throws when the checkpoint cannot be placed — a refusal, never a silent seek
 *         to a neighbouring moment.
 */
function placeCheckpoint(model, cp) {
  if (typeof cp.t !== 'number' || !Number.isFinite(cp.t)) {
    throw new Error(`${where(cp)}: t must be a finite number of session-relative ms`);
  }
  const seg = model.segments[cp.segment];
  if (!seg) {
    throw new Error(`${where(cp)}: names segment ${cp.segment}, but the recording has ` +
      `${model.segments.length} segment(s)`);
  }

  // The span half. CH's viewer walks the keyframe span itself (design §5), so
  // there is no synthetic segment to build the way the fork's executor does —
  // but the same §3 precondition applies: a continuation with no keyframe
  // before it reconstructs nothing, and reading `exists: false` off an empty
  // body would be a green test over a blank stage.
  if (seg.spanStart == null || seg.defect) {
    throw new Error(`${where(cp)}: segment ${cp.segment} is a continuation with no keyframe ` +
      `before it (${seg.defect || 'no span'}) — the recording violates spec §3`);
  }
  const keyframe = model.segments[seg.spanStart];
  // Stated `t_end` where the recording states one; otherwise reconstructed, and
  // inexact by ≤5e-7 ms, which cannot matter for a bound.
  const segEnd = seg.tEnd != null ? seg.tEnd : round1(seg.origin + seg.durMs);
  if (cp.t < keyframe.origin || cp.t > segEnd) {
    throw new Error(`${where(cp)}: t is outside the keyframe span's window ` +
      `[${keyframe.origin}, ${segEnd}] (span opens at segment ${seg.spanStart})`);
  }

  // The segment half. The span bound only says the reconstruction is
  // well-defined: for a continuation the span reaches back to an earlier
  // keyframe, so "segment 1, t=500" would otherwise reconstruct a segment-0
  // moment and quietly pass.
  if (cp.t < seg.origin || cp.t > segEnd) {
    throw new Error(`${where(cp)}: t is outside segment ${cp.segment}'s own window ` +
      `[${seg.origin}, ${segEnd}]`);
  }

  return { seg, segEnd, tRel: round1(cp.t - seg.origin) };
}

// ---------------------------------------------------------------------------
// Reading one prop off one recorded node id
// ---------------------------------------------------------------------------

function readProp(v, id, prop, cp) {
  // `resolveNode` is tolerant by design (design §4) and returns undefined for
  // an id the span never bound. Tolerance is right for an analyst tool and
  // wrong for an oracle, so the loudness is this executor's own duty (T5.3's
  // carry: "the applier never throws").
  const node = v.dbg.getNode(id);

  // The one prop whose whole job is to report absence.
  if (prop === 'exists') return node != null && node.isConnected === true;

  if (node == null) {
    throw new Error(`${where(cp)}: node ${id} does not resolve in the segment's keyframe span — ` +
      `the viewer never mounted it, or an event already removed it. ` +
      `Only prop "exists" tolerates an unresolved node.`);
  }

  if (prop === 'text') {
    // Text and comment nodes carry their content in nodeValue; elements answer
    // for their subtree. Same split as the fork's reader.
    return (node.nodeType === 3 || node.nodeType === 8) ? node.nodeValue : node.textContent;
  }

  // The reconstruction lives in the frame's realm, so `instanceof` has to
  // resolve against ITS window — a parent-realm constructor answers false.
  const doc = v.doc();
  const W = doc && doc.defaultView;
  if (!W) throw new Error(`${where(cp)}: the reconstruction frame has no window`);

  if (prop === 'value') {
    if (node instanceof W.HTMLInputElement || node instanceof W.HTMLTextAreaElement
      || node instanceof W.HTMLSelectElement) {
      return node.value;
    }
    throw new Error(`${where(cp)}: node ${id} is a <${node.nodeName.toLowerCase()}>, ` +
      `not a form control — prop "value" has nothing to read`);
  }

  if (typeof prop === 'string' && prop.indexOf('attr:') === 0) {
    const name = prop.slice('attr:'.length);
    if (name === '') throw new Error(`${where(cp)}: prop "attr:" names no attribute`);
    if (!(node instanceof W.Element)) {
      throw new Error(`${where(cp)}: node ${id} is not an element — prop "${prop}" has nothing to read`);
    }
    return node.getAttribute(name);
  }

  throw new Error(`${where(cp)}: unrecognized prop ${JSON.stringify(prop)} — ` +
    `expected "text", "exists", "value" or "attr:<name>"`);
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * Boot the shipped viewer over `recording`, reconstruct to the checkpoint's
 * moment and check every assertion. Throws on the first mismatch; returns the
 * viewer and what it read, so a caller can assert on state the checkpoint
 * format has no node id for.
 */
function runCheckpoint(recording, cp) {
  const v = boot(recording);
  const { seg, tRel } = placeCheckpoint(v.model, cp);

  v.dbg.selectSegment(cp.segment);
  v.dbg.seek(tRel);

  // The reconstruction is synchronous (T5.4), so state is readable with no
  // polling. Nothing here reads a canvas bitmap, which is the one asynchronous
  // part of a restore — and the one thing this format cannot express (design
  // §3: a script-less frame holds correct pixels it never paints, so a pixel
  // prop would need per-player semantics neither repo has agreed).
  if (v.dbg.getSegment() !== cp.segment) {
    throw new Error(`${where(cp)}: the viewer is on segment ${v.dbg.getSegment()}`);
  }
  // The anti-clamp witness. `seek()` clamps into [0, durMs]; if the bounds
  // above ever let a t through that the viewer has to clamp, the playhead
  // stops matching the conversion and the checkpoint is reading a different
  // moment than the one it names.
  if (v.dbg.getPlayhead() !== tRel) {
    throw new Error(`${where(cp)}: the viewer clamped the seek — asked for ${tRel} ms into ` +
      `segment ${cp.segment} (origin ${seg.origin}, duration ${seg.durMs}), landed at ` +
      `${v.dbg.getPlayhead()}`);
  }

  const readings = cp.assert.map((a) => ({
    node: a.node, prop: a.prop, actual: readProp(v, a.node, a.prop, cp),
  }));

  for (let i = 0; i < cp.assert.length; i++) {
    const expected = cp.assert[i].equals;
    const actual = readings[i].actual;
    // Every authored `equals` is a scalar, so identity is the right comparison.
    if (!Object.is(actual, expected)) {
      throw new Error(`${where(cp)}: node ${cp.assert[i].node} prop "${cp.assert[i].prop}" — ` +
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  return { viewer: v, readings };
}

// ---------------------------------------------------------------------------
// Enrollment
//
// By existence, like the fixtures: a new corpus entry's checkpoints run without
// a registry edit. The failure mode of enrolling by existence is that it has no
// symptom — a `checkpoints` key that got renamed, or an expectations file whose
// fixture twin went away, simply stops being executed and nothing turns red. So
// the reachability of every authored checkpoint is asserted directly, against a
// count recomputed from disk rather than from the loop that runs them.
// ---------------------------------------------------------------------------

const FIXTURES = new Set(readdirSync(FIX).filter((f) => f.endsWith('.json')));
const EXPECTATIONS = readdirSync(EXP).filter((f) => f.endsWith('.json'))
  .map((file) => ({ file, exp: JSON.parse(readFileSync(join(EXP, file), 'utf8')) }));

// Parsed once per fixture: `buildViewerModel` copies every event and the viewer
// never writes into the recording, so one parse serves every boot.
const recordings = new Map();
const recordingFor = (file) => {
  if (!recordings.has(file)) {
    recordings.set(file, JSON.parse(readFileSync(join(FIX, file), 'utf8')));
  }
  return recordings.get(file);
};

const AUTHORED = EXPECTATIONS.reduce(
  (n, { exp }) => n + (Array.isArray(exp.checkpoints) ? exp.checkpoints.length : 0), 0);
let executed = 0;

test('enrollment: every expectations file states a checkpoints array', () => {
  for (const { file, exp } of EXPECTATIONS) {
    assert.ok(Array.isArray(exp.checkpoints),
      `expectations/${file} has no checkpoints array — the key is misspelled or was dropped, ` +
      `and this runner would skip it in silence`);
  }
});

test('enrollment: an expectations file carrying checkpoints has a fixture to run them against', () => {
  for (const { file, exp } of EXPECTATIONS) {
    if (!Array.isArray(exp.checkpoints) || exp.checkpoints.length === 0) continue;
    assert.ok(FIXTURES.has(file),
      `expectations/${file} authors ${exp.checkpoints.length} checkpoint(s) but has no ` +
      `fixtures/${file} twin — they are unreachable, not passing`);
  }
});

test('enrollment: the corpus authors at least one checkpoint', () => {
  // Without this the whole suite passes vacuously the day someone empties the
  // arrays — the same hole conformance.test.js's own enrollment test closes for
  // an empty fixtures/.
  assert.ok(AUTHORED > 0, 'no expectations file authors a checkpoint');
});

test('enrollment: a fixture carrying checkpoints records where they were cross-verified', () => {
  // The paper trail for this plan's central invariant. It does not (cannot)
  // check the fork's agreement from here; what it enforces is that a corpus
  // entry may not grow checkpoints without saying which other player agreed
  // with them first.
  for (const { file, exp } of EXPECTATIONS) {
    if (!Array.isArray(exp.checkpoints) || exp.checkpoints.length === 0) continue;
    const note = exp.notes && exp.notes.checkpoints;
    assert.ok(typeof note === 'string' && note.length > 0,
      `expectations/${file} authors checkpoints with no notes.checkpoints provenance — ` +
      `a checkpoint whose expected value was read off CH's own viewer is a fixture defect`);
  }
});

for (const { file, exp } of EXPECTATIONS) {
  if (!Array.isArray(exp.checkpoints) || !FIXTURES.has(file)) continue;
  exp.checkpoints.forEach((cp, i) => {
    test(`checkpoint ${i + 1}/${exp.checkpoints.length} of ${file} (t=${cp.t}, segment ${cp.segment})`, () => {
      executed++;
      runCheckpoint(recordingFor(file), cp);
    });
  });
}

test('enrollment: every authored checkpoint ran', () => {
  // Counted independently of the loop above: `AUTHORED` comes from re-reading
  // the expectations, `executed` from the test bodies. A filter that quietly
  // skipped a file would leave the two apart.
  assert.equal(executed, AUTHORED,
    `${AUTHORED} checkpoint(s) are authored on disk but ${executed} ran`);
});

// ---------------------------------------------------------------------------
// Authoring guard: a checkpoint may not sit where the 0.1 ms quantisation
// decides which events it includes
// ---------------------------------------------------------------------------

test('no authored checkpoint depends on the 0.1 ms quantisation for its placement', () => {
  // FOUND THE HARD WAY, at authoring time (T5.7). `t=2972.15` on jspsych-full's
  // segment 6 sat midway between five `dom.attr` writes at 2972.0999999046326
  // and the `dom.remove` teardown at 2972.1999998092651 — 0.05 ms of clearance
  // on each side, which reads as safe and is not. The two events are
  // 0.0999999046325 ms apart, BELOW the wire's own 0.1 ms grid, so no t between
  // them survives `round1`: the difference from the origin landed a hair above
  // the .15 midpoint, rounded UP, and CH placed the checkpoint after the
  // teardown while the fork — which compares raw floats — placed it before.
  // Same recording, same reconstruction, two moments.
  //
  // Neither reading is wrong; the checkpoint was. So the property asserted here
  // is that the authored t names a moment that exists at BOTH resolutions: the
  // event prefix CH's quantised rule selects is the prefix an exact comparison
  // selects. Any t that fails this is unplaceable, and the fix is to move it
  // onto an event's own rounded time rather than into a sub-quantum gap.
  //
  // THE ORIGIN COMES FROM THE MODEL, never from a second reading of §3 here.
  // This guard is the thing that has to be right when something else is wrong,
  // so it must not carry its own copy of the rule the viewer rebases by: a
  // hand-rolled chain keeps validating placements against the old order the day
  // the model's moves, and green-lights a checkpoint the viewer misplaces. Its
  // sibling test below ("rebases with the model's own forward rule") exists to
  // stop exactly that, and this loop was quietly exempt from it (review M-2).
  for (const { file, exp } of EXPECTATIONS) {
    // An entry with no checkpoints has no placement to guard, and from T7 the
    // corpus is full of them: eighteen negative fixtures, three of which are
    // not parseable recordings at all (a truncated JSON document, a corrupt
    // gzip, a decompression bomb). Parsing every twin to guard an empty array
    // crashed this test on the first of those — correctly, in the sense that
    // the fixture IS unparseable, and uselessly, since it authors nothing.
    if (!Array.isArray(exp.checkpoints) || exp.checkpoints.length === 0) continue;
    if (!FIXTURES.has(file)) continue;
    const rec = recordingFor(file);
    const model = boot(rec).model;
    for (const cp of exp.checkpoints) {
      // Raw wire events, model origin: the model's own event copies are already
      // rebased, and what this compares is which RAW events fall inside the
      // checkpoint under each reading.
      const s = rec.segments[cp.segment];
      const origin = model.segments[cp.segment].origin;
      const cpRel = round1(cp.t - origin);
      const quantised = s.events.map((e, i) => i).filter((i) => round1(s.events[i].t - origin) <= cpRel);
      const exact = s.events.map((e, i) => i).filter((i) => s.events[i].t <= cp.t);
      assert.deepEqual(quantised, exact,
        `${file} ${where(cp)}: rounding moves the checkpoint across an event. ` +
        `Quantised it includes ${quantised.length} of the segment's events, exactly it includes ` +
        `${exact.length}. Place it on an event's own time instead of between two closer than 0.1 ms.`);
    }
  }
});

// ---------------------------------------------------------------------------
// The four canonical-core oracles are the fork's, verbatim
// ---------------------------------------------------------------------------

test('canonical-core carries the four checkpoints the fork executes, verbatim', () => {
  // Mirrored from jspsych-replay-fork `tests/checkpoints.test.ts` (CHECKPOINTS,
  // landed there in commit 66d45b5 BEFORE CH had an executor). The pin is
  // one-directional in the same way the fork's fixture checksum is: an edit
  // here fails immediately, an edit there stays green until someone re-reads
  // this file. It is what makes "the same four the fork executes" a machine
  // check rather than a sentence.
  const forkFour = [
    { t: 500, segment: 0, assert: [{ node: 5, prop: 'text', equals: 'Clicked!' }] },
    { t: 2250, segment: 1, assert: [{ node: 6, prop: 'exists', equals: true },
      { node: 7, prop: 'text', equals: 'saved' }] },
    { t: 2350, segment: 1, assert: [{ node: 6, prop: 'exists', equals: false }] },
    { t: 4100, segment: 2, assert: [{ node: 3, prop: 'value', equals: 'abc' }] },
  ];
  const mine = EXPECTATIONS.find((e) => e.file === 'canonical-core.json').exp.checkpoints;
  assert.deepEqual(mine, forkFour);
});

// ---------------------------------------------------------------------------
// The executor's own failure modes
//
// An oracle that cannot fail proves nothing. Each of these is a way this file
// could be green over a broken reconstruction.
// ---------------------------------------------------------------------------

const canonical = () => recordingFor('canonical-core.json');
const jspsych = () => recordingFor('jspsych-full.json');

test('a wrong expected value fails, naming node, prop, expected and actual', () => {
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 0, assert: [{ node: 5, prop: 'text', equals: 'Not clicked' }],
  }), /node 5 prop "text" — expected "Not clicked", got "Clicked!"/);
});

test('an unresolvable id fails loudly for every prop but exists', () => {
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 0, assert: [{ node: 99, prop: 'text', equals: 'anything' }],
  }), /node 99 does not resolve/);
  // …and `exists` is the one prop that answers for it instead.
  runCheckpoint(canonical(), { t: 500, segment: 0, assert: [{ node: 99, prop: 'exists', equals: false }] });
});

test('a t outside the keyframe span is refused', () => {
  assert.throws(() => runCheckpoint(canonical(), {
    t: 9000, segment: 0, assert: [{ node: 5, prop: 'text', equals: 'Clicked!' }],
  }), /outside the keyframe span's window \[10, 2000\]/);
});

test('a t inside the span but outside the named segment is refused', () => {
  // t=500 sits inside segment 1's keyframe span — which reaches back to segment
  // 0's keyframe at origin 10 — but 1500 ms before segment 1 opens. Without the
  // second bound this reconstructs a segment-0 moment and passes.
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 1, assert: [{ node: 5, prop: 'text', equals: 'Clicked!' }],
  }), /outside segment 1's own window \[2000, 3500\]/);
});

test('a checkpoint naming a segment the recording does not have is refused', () => {
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 7, assert: [{ node: 5, prop: 'exists', equals: true }],
  }), /names segment 7, but the recording has 3 segment\(s\)/);
});

test('a continuation with no keyframe before it is refused, not read off a blank stage', () => {
  // The §3 defect. The viewer renders it as a defect chip over an empty body,
  // which is the right analyst behaviour and a catastrophic oracle: every
  // `exists` would read false and every checkpoint asserting absence would pass.
  const rec = baseRecording({
    segments: [segment({
      index: 0,
      events: [{ type: 'dom.attr', t: 5, node: 1, name: 'class', value: 'x' }],
    })],
  });
  assert.throws(() => runCheckpoint(rec, {
    t: 5, segment: 0, assert: [{ node: 1, prop: 'exists', equals: false }],
  }), /violates spec §3/);
});

test('an unrecognised prop throws rather than reading a quiet null', () => {
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 0, assert: [{ node: 2, prop: 'colour', equals: 'red' }],
  }), /unrecognized prop "colour"/);
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 0, assert: [{ node: 2, prop: 'attr:', equals: null }],
  }), /names no attribute/);
});

test('value refuses a node that is not a form control', () => {
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 0, assert: [{ node: 2, prop: 'value', equals: 'x' }],
  }), /not a form control/);
});

test('attr: refuses a text node', () => {
  assert.throws(() => runCheckpoint(canonical(), {
    t: 500, segment: 0, assert: [{ node: 5, prop: 'attr:id', equals: null }],
  }), /is not an element/);
});

// ---------------------------------------------------------------------------
// The conversion, stated once
// ---------------------------------------------------------------------------

test('the executor rebases with the model\'s own forward rule, exactly', () => {
  // Task 1's conversion contract: FORWARD is `round1(t − origin)` and any
  // consumer that needs a segment-relative time must compute it the same way.
  // jspsych-full's segment 12 opens at a decimal origin (7792.599999904633),
  // which is precisely where a second reading would drift.
  const v = boot(jspsych());
  const seg = v.model.segments[12];
  const { tRel } = placeCheckpoint(v.model, { t: 9600, segment: 12, assert: [] });
  assert.equal(tRel, round1(9600 - seg.origin));
  assert.equal(tRel, 1807.4);
  v.dbg.selectSegment(12);
  v.dbg.seek(tRel);
  assert.equal(v.dbg.getPlayhead(), tRel, 'the viewer takes the conversion unclamped');
  // And the fork places the same checkpoint at the same moment: jspsych-full
  // states `t_load: null` on all 14 segments, so §3's origin resolves to
  // `t_dom_ready`, which is exactly what the fork's player rebases by.
  assert.equal(seg.origin, seg.tDomReady);
});
