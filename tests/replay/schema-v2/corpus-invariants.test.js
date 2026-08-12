// tests/replay/schema-v2/corpus-invariants.test.js
// The corpus invariants' own reject direction, proven on synthetic recordings.
//
// WHY SYNTHETIC. Every check in corpus-invariants.js runs against every fixture
// in the corpus, and the corpus is (correctly) full of files that pass. A check
// that always passes is indistinguishable from a check that cannot fail, so
// each one is shown refusing something here, on a recording small enough to
// read in one screen. The corpus's own negative-* entries then prove the same
// refusals end-to-end through the runner; these prove the checks in isolation,
// which is what tells a broken invariant apart from a broken fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVARIANT_CHECKS, INVARIANT_NAMES, PRIVACY_INVARIANTS, REDACTED_SHAPES }
  from './corpus-invariants.js';
import { REDACTABLE_TYPES } from './validator.js';

// ── the dual-encoding drift guard (T1 final review) ────────────────────────

test('REDACTED_SHAPES and REDACTABLE_TYPES encode the same set of §8 variants', () => {
  // Two tables, one spec sentence, opposite directions: the validator's
  // REDACTABLE_TYPES says which event types may CLAIM `redacted: true`, and the
  // runner's REDACTED_SHAPES says what a claimed event may CARRY. Neither can
  // be derived from the other — the validator's per-type checks strip content,
  // the runner's allowlist bounds keys — so they are two encodings of §5.2/§8
  // that a spec revision has to move together. The failure mode is silent in
  // both directions: a type added to REDACTABLE_TYPES alone gets a redacted
  // variant with NO allowlist, and the runner refuses every recording that uses
  // it ("no redacted variant defined"); a type added to REDACTED_SHAPES alone
  // gets an allowlist strict never lets a file reach.
  assert.deepEqual(Object.keys(REDACTED_SHAPES).sort(), [...REDACTABLE_TYPES].sort());
});

test('every REDACTED_SHAPES entry allows type, t and the redacted marker', () => {
  // The three keys every redacted event carries by construction. An entry
  // missing one of them would reject the very shape §5.2 defines, and the
  // corpus would look clean because no producer emits it.
  for (const [type, shape] of Object.entries(REDACTED_SHAPES)) {
    for (const k of ['type', 't', 'redacted']) {
      assert.ok(Object.hasOwn(shape.allowed, k), `${type}'s allowlist is missing "${k}"`);
    }
  }
});

// ── shared scaffolding ─────────────────────────────────────────────────────

const el = (id, tag, attrs, children) => ({ id, kind: 'element', tag, attrs: attrs ?? {}, children: children ?? [] });
const txt = (id, text) => ({ id, kind: 'text', text });

function recording(segments, over) {
  return Object.assign({
    schema_version: 2, recorder: { name: 'synthetic', version: '0' },
    recording_started_at_perf: 0, ended_at_perf: 1000, truncated: false,
    segments: segments.map((s, i) => Object.assign(
      { index: i, t_start: 0, t_dom_ready: null, t_load: null, t_end: 1000,
        initial_dom: null, initial_state: null, events: [] }, s)),
  }, over);
}
const run = (name, rec, exp) => INVARIANT_CHECKS[name](rec, exp ?? {});

// ── §8: the redacted-variant allowlist ─────────────────────────────────────
// The one invariant that runs unconditionally against every fixture, so its
// reject direction has to be proven on synthetic events rather than inferred
// from a corpus that (correctly) contains no leaks.

const redactedRec = (...events) => recording([{ events }]);

test('no_redaction_leak: a redacted event type with no defined variant is refused', () => {
  const failure = run('no_redaction_leak', redactedRec(
    { type: 'canvas.snapshot', t: 1, node: 2, data_url: 'data:image/png;base64,AAA', redacted: true }));
  assert.match(String(failure), /no redacted variant defined for "canvas\.snapshot"/);
});

test('no_redaction_leak: a redacted event carrying a key outside its allowlist fails, naming the key', () => {
  const leaked = run('no_redaction_leak', redactedRec(
    { type: 'input.value', t: 1, node: 3, redacted: true, value_len: 4, value: 'leak' }));
  assert.match(String(leaked), /disallowed key "value"/);
  const keyed = run('no_redaction_leak', redactedRec({ type: 'key.down', t: 1, redacted: true, code: 'KeyA' }));
  assert.match(String(keyed), /disallowed key "code"/);
  // Truthiness, not `=== true`: a producer emitting `redacted: 1` is held to
  // the same floor. (The strict validator rejects the non-boolean marker
  // separately; the privacy floor must not depend on that having run.)
  const truthy = run('no_redaction_leak', redactedRec(
    { type: 'input.value', t: 1, node: 3, redacted: 1, value_len: 4, value: 'leak' }));
  assert.match(String(truthy), /disallowed key "value"/);
});

test('no_redaction_leak: an allowlisted key must carry the scalar it claims', () => {
  // Allowing a key name is not allowing arbitrary content under it. `node` is
  // an id on a redacted input.value; an object there hides exactly the
  // plaintext the redaction removed, and a name-only allowlist would wave it
  // through. This is what keeps the check flat: every allowed key is a scalar,
  // so there is no subtree left for a recursive scan to descend into.
  const nested = run('no_redaction_leak', redactedRec(
    { type: 'input.value', t: 1, node: { text: 'secret' }, redacted: true, value_len: 6 }));
  assert.match(String(nested), /"node"/);
  const bagged = run('no_redaction_leak', redactedRec(
    { type: 'clipboard.paste', t: 1, target: null, len: { html: 'secret' }, redacted: true }));
  assert.match(String(bagged), /"len"/);
});

test('no_redaction_leak: the spec-defined redacted variants pass', () => {
  assert.equal(run('no_redaction_leak', redactedRec(
    { type: 'key.down', t: 1, redacted: true },
    { type: 'key.up', t: 2, redacted: true },
    { type: 'input.value', t: 3, node: 4, redacted: true, value_len: 1 },
    // text/html on a redacted clipboard event are tolerated only as explicit
    // nulls: "there was content, and it is gone".
    { type: 'clipboard.paste', t: 4, target: null, len: 5, redacted: true, text: null, html: null },
  )), null);
  // A non-redacted event is not the allowlist's business — it keeps its content.
  assert.equal(run('no_redaction_leak', redactedRec({ type: 'input.value', t: 1, node: 3, value: 'abc' })), null);
});

// ── §8: the password floor, structurally ───────────────────────────────────

const PW_KEYFRAME = el(1, 'form', {}, [
  el(2, 'input', { type: 'text', id: 'answer' }),
  el(3, 'input', { type: 'PASSWORD', id: 'secret' }),   // case-insensitive by §8's mechanism
]);

test('password_floor: a non-redacted input.value on a password node is refused', () => {
  const rec = recording([{ initial_dom: PW_KEYFRAME, events: [
    { type: 'input.value', t: 1, node: 3, value: 'hunter2' },
  ] }]);
  assert.match(String(run('password_floor', rec)), /non-redacted input\.value on password node 3/);
  // The redacted variant is the conforming way to record that the field was
  // typed into, and it passes.
  const ok = recording([{ initial_dom: PW_KEYFRAME, events: [
    { type: 'input.value', t: 1, node: 3, redacted: true, value_len: 7 },
    { type: 'input.value', t: 2, node: 2, value: 'not a secret' },
  ] }]);
  assert.equal(run('password_floor', ok), null);
});

test('password_floor: an initial_state.form seed for a password node is refused', () => {
  const rec = recording([{ initial_dom: PW_KEYFRAME,
    initial_state: { scroll: { x: 0, y: 0 }, element_scroll: [], media: [], form: [{ node: 3, value: 'hunter2' }] } }]);
  assert.match(String(run('password_floor', rec)), /initial_state\.form seeds a value for password node 3/);
});

test('password_floor: a value-bearing dom.attr on a password node is refused', () => {
  const rec = recording([{ initial_dom: PW_KEYFRAME, events: [
    { type: 'dom.attr', t: 1, node: 3, name: 'value', value: 'hunter2' },
  ] }]);
  assert.match(String(run('password_floor', rec)), /value-bearing dom\.attr on password node 3/);
  // Clearing the attribute is how a producer says the field was emptied.
  const ok = recording([{ initial_dom: PW_KEYFRAME, events: [
    { type: 'dom.attr', t: 1, node: 3, name: 'value', value: null },
  ] }]);
  assert.equal(run('password_floor', ok), null);
});

test('password_floor: a keyframe keeping a value attribute on a password node is refused', () => {
  const rec = recording([{ initial_dom: el(1, 'form', {}, [
    el(3, 'input', { type: 'password', value: 'authored-in-markup' }),
  ]) }]);
  assert.match(String(run('password_floor', rec)), /keeps a value attribute on password node 3/);
});

test('password_floor: a field that BECOMES a password mid-span is covered', () => {
  // The second door. A producer that emits the type change and then the value
  // would otherwise be judged against the keyframe's reading of the node.
  const rec = recording([{ initial_dom: el(1, 'form', {}, [el(2, 'input', { type: 'text' })]), events: [
    { type: 'dom.attr', t: 1, node: 2, name: 'type', value: 'password' },
    { type: 'input.value', t: 2, node: 2, value: 'hunter2' },
  ] }]);
  assert.match(String(run('password_floor', rec)), /non-redacted input\.value on password node 2/);
});

test('password_floor: ids are span-scoped, so a later span\'s text input is not accused', () => {
  // Node ids restart at each keyframe (§4). A session-wide id set would let
  // span 0's password id convict span 1's ordinary <input type=text>.
  const rec = recording([
    { initial_dom: PW_KEYFRAME },
    { index: 1, initial_dom: el(1, 'form', {}, [el(3, 'input', { type: 'text' })]),
      events: [{ type: 'input.value', t: 1, node: 3, value: 'ordinary' }] },
  ]);
  assert.equal(run('password_floor', rec), null);
});

test('the privacy set is exactly the two §8 scans', () => {
  // PRIVACY_INVARIANTS is what `expect_leak` inverts. A check that lands in the
  // table without landing here fails a leaking fixture with no way to declare
  // it; one that lands here without being a privacy check lets a structural
  // defect be waved through as a declared leak.
  assert.deepEqual([...PRIVACY_INVARIANTS].sort(), ['no_redaction_leak', 'password_floor']);
  for (const n of PRIVACY_INVARIANTS) assert.ok(INVARIANT_NAMES.includes(n), `${n} is not an invariant`);
});

// ── §5.7: truncation mirrors capture_stopped ───────────────────────────────

test('truncation_mirrors_capture_stopped: each half without the other is refused', () => {
  const stopped = { type: 'recording.capture_stopped', t: 9, reason: 'buffer_limit' };
  assert.match(String(run('truncation_mirrors_capture_stopped', recording([{ events: [] }], { truncated: true }))),
    /truncated: true with no recording\.capture_stopped/);
  assert.match(String(run('truncation_mirrors_capture_stopped', recording([{ events: [stopped] }]))),
    /is not mirrored by truncated: true/);
  assert.equal(run('truncation_mirrors_capture_stopped',
    recording([{ events: [stopped] }], { truncated: true })), null);
  // "emitted once" is a MUST, and two of them means two stop times for one stop.
  assert.match(String(run('truncation_mirrors_capture_stopped',
    recording([{ events: [stopped, { ...stopped, t: 10 }] }], { truncated: true }))),
    /emitted once .* found 2/);
});

// ── §4/§7: references and ids ──────────────────────────────────────────────

test('references_resolve: a dangling id is refused, and a re-added one is not', () => {
  const kf = el(1, 'div', {}, [el(2, 'p', {}, [txt(3, 'hi')])]);
  const dangling = recording([{ initial_dom: kf, events: [{ type: 'dom.text', t: 1, node: 99, text: 'x' }] }]);
  assert.match(String(run('references_resolve', dangling)), /node 99, which the keyframe span never emitted/);
  // Forward references are the same defect with a different cause: the dom.add
  // that introduces node 4 comes AFTER the dom.attr that addresses it.
  const forward = recording([{ initial_dom: kf, events: [
    { type: 'dom.attr', t: 1, node: 4, name: 'class', value: 'x' },
    { type: 'dom.add', t: 2, parent: 1, before: null, node: el(4, 'span', {}, []) },
  ] }]);
  assert.match(String(run('references_resolve', forward)), /node 4, which the keyframe span never emitted/);
  const ok = recording([{ initial_dom: kf, events: [
    { type: 'dom.add', t: 1, parent: 1, before: null, node: el(4, 'span', {}, []) },
    { type: 'dom.attr', t: 2, node: 4, name: 'class', value: 'x' },
    { type: 'mouse.click', t: 3, x: 1, y: 2, button: 0, target: null },
  ] }]);
  assert.equal(run('references_resolve', ok), null);
});

test('references_resolve: a continuation carries the previous segment\'s ids', () => {
  const rec = recording([
    { initial_dom: el(1, 'div', {}, [el(2, 'p', {}, [])]) },
    { index: 1, initial_dom: null, events: [{ type: 'dom.text', t: 1, node: 2, text: 'still here' }] },
  ]);
  assert.equal(run('references_resolve', rec), null);
});

test('unique_node_ids: a duplicate inside one keyframe tree is refused', () => {
  const rec = recording([{ initial_dom: el(1, 'div', {}, [el(2, 'p', {}, []), el(2, 'span', {}, [])]) }]);
  assert.match(String(run('unique_node_ids', rec)), /node id 2 is already live/);
});

test('unique_node_ids: the M5 carve-out — a move re-adds a removed id legally', () => {
  // remove + add of the SAME id inside one span is how a move encodes, and the
  // check must not call it a duplicate. Without the carve-out every recording
  // of a reparented node is a negative fixture.
  const rec = recording([{ initial_dom: el(1, 'div', {}, [el(2, 'p', {}, [txt(3, 'x')])]), events: [
    { type: 'dom.remove', t: 1, node: 2 },
    { type: 'dom.add', t: 2, parent: 1, before: null, node: el(2, 'p', {}, [txt(3, 'x')]) },
  ] }]);
  assert.equal(run('unique_node_ids', rec), null);
  // …but re-adding it while it is still mounted is two nodes holding one id.
  const live = recording([{ initial_dom: el(1, 'div', {}, [el(2, 'p', {}, [])]), events: [
    { type: 'dom.add', t: 1, parent: 1, before: null, node: el(2, 'p', {}, []) },
  ] }]);
  assert.match(String(run('unique_node_ids', live)), /node id 2 is already live/);
});

test('unique_node_ids: removing a node frees its whole subtree', () => {
  // A remove takes the subtree with it (spec §5.1 has no per-child remove), so
  // a child's id is re-addable afterwards. Tracking only the named id would
  // report the re-add of node 3 as a duplicate.
  const rec = recording([{ initial_dom: el(1, 'div', {}, [el(2, 'p', {}, [txt(3, 'x')])]), events: [
    { type: 'dom.remove', t: 1, node: 2 },
    { type: 'dom.add', t: 2, parent: 1, before: null, node: el(3, 'span', {}, []) },
  ] }]);
  assert.equal(run('unique_node_ids', rec), null);
});

test('unique_node_ids: a child added by dom.add leaves with its parent', () => {
  // FOUND ON A REAL CAPTURE, not reasoned about. `redacted.json` writes into a
  // <p> inside the redacted subtree (dom.remove of the old text node, dom.add
  // of a withheld new one, id 42), then moves the <p> out of that subtree
  // (dom.remove of the <p>, dom.add of it again carrying 42). If the live tree
  // only knows the KEYFRAME's parent→child edges, node 42 is still live when
  // the <p> comes back with it, and a legal move reads as a duplicate.
  const rec = recording([{ initial_dom: el(1, 'div', {}, [el(2, 'p', {}, [txt(3, 'old')])]), events: [
    { type: 'dom.remove', t: 1, node: 3 },
    { type: 'dom.add', t: 2, parent: 2, before: null, node: txt(4, 'new') },
    { type: 'dom.remove', t: 3, node: 2 },
    { type: 'dom.add', t: 4, parent: 1, before: null, node: el(2, 'p', {}, [txt(4, 'new')]) },
  ] }]);
  assert.equal(run('unique_node_ids', rec), null);
});

// ── §7: which clock ended_at_perf is on ────────────────────────────────────

test('perf_frame: a zero origin cannot discriminate, and saying otherwise is refused', () => {
  const rec = recording([{ t_end: 1000, events: [] }], { recording_started_at_perf: 0, ended_at_perf: 1000 });
  assert.equal(run('perf_frame', rec, { perf_frame: 'undiscriminating' }), null);
  assert.match(String(run('perf_frame', rec, { perf_frame: 'absolute' })), /cannot be read off a zero perf origin/);
  assert.match(String(run('perf_frame', rec, {})), /expectations must declare perf_frame/);
});

test('perf_frame: the absolute and relative readings are told apart by a non-zero origin', () => {
  // The same session, stated both ways. Absolute: ended_at_perf sits on the
  // capture clock, so subtracting the origin gives the wire-time extent.
  const abs = recording([{ t_end: 1000, events: [] }],
    { recording_started_at_perf: 5000, ended_at_perf: 6000 });
  assert.equal(run('perf_frame', abs, { perf_frame: 'absolute' }), null);
  assert.match(String(run('perf_frame', abs, { perf_frame: 'relative' })), /the absolute reading also fits/);
  // Relative: ended_at_perf is already on the wire clock, and the absolute
  // reading would put the end of the recording before its last segment.
  const rel = recording([{ t_end: 1000, events: [] }],
    { recording_started_at_perf: 5000, ended_at_perf: 1000 });
  assert.equal(run('perf_frame', rel, { perf_frame: 'relative' }), null);
  assert.match(String(run('perf_frame', rel, { perf_frame: 'absolute' })),
    /ended_at_perf − recording_started_at_perf = -4000/);
});
