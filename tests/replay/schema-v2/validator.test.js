import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectGzip, validateTolerant, validateStrict } from './validator.js';

test('detectGzip: true for gzipped bytes, false for JSON text and short input', () => {
  const gz = gzipSync(Buffer.from('{"schema_version":2}'));
  assert.equal(detectGzip(gz), true);
  assert.equal(detectGzip(Buffer.from('{"schema_version":2}')), false);
  assert.equal(detectGzip(Buffer.from([0x1f])), false);
  assert.equal(detectGzip(null), false);
});

const MIN_VALID = {
  schema_version: 2,
  recorder: { name: 'test', version: '0.0.1' },
  segments: [{ index: 0, events: [] }],
};

test('tolerant: accepts a minimal recording and fills defaults', () => {
  const r = validateTolerant(structuredClone(MIN_VALID));
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.recording.truncated, false);
  assert.equal(r.recording.extensions, null);
  assert.ok(r.warnings.some(w => w.includes('user_agent')), 'missing advisory fields warn');
});

test('tolerant: rejects only the four fatal defects', () => {
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), schema_version: 1 }).ok, false);
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), recorder: { name: 'x' } }).ok, false);
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), segments: 'nope' }).ok, false);
  assert.equal(validateTolerant({ ...structuredClone(MIN_VALID), segments: [{ index: 0 }] }).ok, false);
});

test('tolerant: array defaults are not shared between recordings', () => {
  const a = validateTolerant(structuredClone(MIN_VALID)).recording;
  const b = validateTolerant(structuredClone(MIN_VALID)).recording;
  a.stylesheets.push('contaminant');
  assert.deepEqual(b.stylesheets, []);
  assert.deepEqual(b.stylesheet_events, []);
  assert.deepEqual(b.viewport_changes, []);
});

test('tolerant: parses JSON strings and rejects invalid JSON', () => {
  assert.equal(validateTolerant(JSON.stringify(MIN_VALID)).ok, true);
  assert.equal(validateTolerant('{not json').ok, false);
});

function strictBase() {
  return {
    schema_version: 2,
    recorder: { name: 'test', version: '0.0.1' },
    host: null, participant_id: null,
    recording_started_at: '2026-08-09T12:00:00.000Z',
    recording_started_at_perf: 0,
    user_agent: 'test-agent',
    viewport: { w: 1280, h: 800, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
    observed_root: null,
    stylesheets: [], stylesheet_events: [], viewport_changes: [],
    rng: null, rng_calls: null,
    ended_at_perf: 100, end_reason: 'finished', truncated: false, extensions: null,
    segments: [{ index: 0, label: null, plugin: null, t_start: 0, t_dom_ready: null,
                 t_load: null, t_end: 100, initial_dom: null, initial_state: null,
                 events: [], host_data: null, extensions: null }],
  };
}

test('strict: accepts a fully-typed recording', () => {
  const r = validateStrict(strictBase());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('strict: flags top-level type violations exhaustively', () => {
  const bad = strictBase();
  bad.user_agent = 42;
  bad.viewport = { w: 1280 };
  bad.end_reason = 'quit';
  const r = validateStrict(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('user_agent')));
  assert.ok(r.errors.some(e => e.includes('viewport')));
  assert.ok(r.errors.some(e => e.includes('end_reason')));
});

test('strict: rng pairing — rng_calls non-null iff rng non-null', () => {
  const a = strictBase(); a.rng_calls = [];
  assert.ok(validateStrict(a).errors.some(e => e.includes('rng_calls')));
  const b = strictBase(); b.rng = { seed: null, math_random_patched: false }; b.rng_calls = null;
  assert.ok(validateStrict(b).errors.some(e => e.includes('rng_calls')));
  const c = strictBase(); c.rng = { seed: null, math_random_patched: false }; c.rng_calls = [];
  assert.deepEqual(validateStrict(c).errors, []);
});

test('strict: session-level event arrays must be time-sorted', () => {
  const bad = strictBase();
  bad.viewport_changes = [
    { t: 50, w: 1280, h: 800, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
    { t: 10, w: 1280, h: 800, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
  ];
  assert.ok(validateStrict(bad).errors.some(e => e.includes('viewport_changes') && e.includes('sorted')));
});

function seg(overrides) {
  return { index: 0, label: null, plugin: null, t_start: null, t_dom_ready: null,
           t_load: null, t_end: null, initial_dom: null, initial_state: null,
           events: [], host_data: null, extensions: null, ...overrides };
}
const KEYFRAME_DOM = { id: 1, kind: 'element', tag: 'div', attrs: {}, children: [] };

test('strict: segment index must equal array position', () => {
  const r = strictBase();
  r.segments = [seg({ index: 0 }), seg({ index: 5 })];
  assert.ok(validateStrict(r).errors.some(e => e.includes('index') && e.includes('position')));
});

test('strict: continuation with dom.* events before any keyframe is illegal', () => {
  const r = strictBase();
  r.segments = [seg({ events: [{ type: 'dom.attr', t: 1, node: 3, name: 'class', value: 'x' }] })];
  assert.ok(validateStrict(r).errors.some(e => e.includes('keyframe')));
  const ok = strictBase();
  ok.segments = [
    seg({ initial_dom: KEYFRAME_DOM }),
    seg({ index: 1, events: [{ type: 'dom.attr', t: 1, node: 1, name: 'class', value: 'x' }] }),
  ];
  assert.deepEqual(validateStrict(ok).errors, []);
});

test('strict: segment events must be time-sorted and known-typed', () => {
  const r = strictBase();
  r.segments = [seg({
    initial_dom: KEYFRAME_DOM,
    events: [
      { type: 'mouse.move', t: 20, x: 1, y: 2 },
      { type: 'mouse.move', t: 10, x: 1, y: 2 },
      { type: 'ch:mystery', t: 30 },
    ],
  })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('time-sorted')));
  assert.ok(res.errors.some(e => e.includes('unknown top-level event type')));
});

test('strict: core event field checks (mouse.click, key.down, input.value redacted)', () => {
  const r = strictBase();
  r.segments = [seg({
    initial_dom: KEYFRAME_DOM,
    events: [
      { type: 'mouse.click', t: 1, x: 1, y: 2 },                       // missing button
      { type: 'key.down', t: 2, key: 'a' },                            // missing code+mods, not redacted
      { type: 'key.down', t: 3, redacted: true },                      // valid redacted variant
      { type: 'input.value', t: 4, node: 1, redacted: true },          // missing value_len
      { type: 'visibility.hidden', t: 5 },                             // valid
    ],
  })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('events[0]') && e.includes('button')));
  assert.ok(res.errors.some(e => e.includes('events[1]')));
  assert.ok(!res.errors.some(e => e.includes('events[2]')));
  assert.ok(res.errors.some(e => e.includes('events[3]') && e.includes('value_len')));
  assert.ok(!res.errors.some(e => e.includes('events[4]')));
});

test('strict: a non-object initial_dom is not a keyframe', () => {
  const r = strictBase();
  r.segments = [seg({
    initial_dom: 1,
    events: [{ type: 'dom.attr', t: 1, node: 1, name: 'class', value: 'x' }],
  })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('initial_dom') && e.includes('DomNode')));
  assert.ok(res.errors.some(e => e.includes('keyframe')));
});

test('strict: an array initial_dom is not a keyframe', () => {
  // `typeof [] === "object"`, so the object test alone lets an array through
  // and the segment silently counts as a keyframe — licensing every later
  // dom.* patch against a snapshot that has no nodes to patch.
  const r = strictBase();
  r.segments = [seg({
    initial_dom: [],
    events: [{ type: 'dom.attr', t: 1, node: 1, name: 'class', value: 'x' }],
  })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('initial_dom') && e.includes('DomNode')));
  assert.ok(res.errors.some(e => e.includes('keyframe')));
});

test('strict: redacted input.value must not carry the plaintext value', () => {
  const r = strictBase();
  r.segments = [seg({ events: [
    { type: 'input.value', t: 1, node: 1, redacted: true, value_len: 6, value: 'secret' },
    { type: 'input.value', t: 2, node: 1, redacted: true, value_len: 6 },
  ] })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('events[0]')));
  assert.ok(!res.errors.some(e => e.includes('events[1]')));
});

test('strict: `redacted` must be the boolean true, never a string or false', () => {
  // The field is a variant marker, not a toggle: it selects the redacted event
  // shape. A truthy string would otherwise fail the `=== true` variant test,
  // fall through to the plaintext branch, and license the very `value` the
  // redaction was meant to remove. `redacted: false` is rejected for the same
  // reason — absence, not a false flag, is how a non-redacted event says so.
  const r = strictBase();
  r.segments = [seg({ events: [
    { type: 'input.value', t: 1, node: 1, redacted: 'true', value: 'secret' },
    { type: 'input.value', t: 2, node: 1, redacted: false, value: 'plain' },
    { type: 'input.value', t: 3, node: 1, value: 'plain' },
  ] })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('events[0]') && e.includes('redacted')));
  assert.ok(res.errors.some(e => e.includes('events[1]') && e.includes('redacted')));
  assert.ok(!res.errors.some(e => e.includes('events[2]')), 'an absent marker is the normal case');
});

test('strict: `redacted` is illegal on event types with no redacted variant', () => {
  // Spec §5.2 defines a redacted shape for four event types only. On any other
  // type the marker is a claim the validator cannot honour: nothing in that
  // type's check removes content, so the event asserts redaction while keeping
  // the payload. A redacted canvas.snapshot still carrying its data_url is the
  // concrete case — strict has to refuse the marker, not just type-check it.
  const r = strictBase();
  r.segments = [seg({ initial_dom: KEYFRAME_DOM, events: [
    { type: 'canvas.snapshot', t: 1, node: 2, data_url: 'data:image/png;base64,AAA', redacted: true },
    { type: 'dom.text', t: 2, node: 5, text: 'still here', redacted: true },
    { type: 'key.down', t: 3, redacted: true },
  ] })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('events[0]') && e.includes('canvas.snapshot')
    && e.includes('no redacted variant')));
  assert.ok(res.errors.some(e => e.includes('events[1]') && e.includes('no redacted variant')));
  assert.ok(!res.errors.some(e => e.includes('events[2]')), 'the spec-defined variants stay legal');
});

test('strict: media, canvas, and clipboard event checks', () => {
  const r = strictBase();
  r.segments = [seg({
    events: [
      { type: 'media.play', t: 1, node: 1, current_time: 0 },
      { type: 'canvas.snapshot', t: 2, node: 2, data_url: 'data:,', region: { x: 0, y: 0, w: 10, h: 10 } },
      { type: 'clipboard.paste', t: 3, target: null, text: null, html: null, len: 5 },
      { type: 'clipboard.paste', t: 4, target: null, text: 'leak', html: null, len: null, redacted: true },
      { type: 'media.play', t: 5, node: 1 },                            // missing current_time
      { type: 'canvas.snapshot', t: 6, node: 2, data_url: 'data:,',     // non-numeric region.w
        region: { x: 0, y: 0, w: '10', h: 10 } },
    ],
  })];
  const res = validateStrict(r);
  assert.ok(!res.errors.some(e => e.includes('events[0]')));
  assert.ok(!res.errors.some(e => e.includes('events[1]')));
  assert.ok(!res.errors.some(e => e.includes('events[2]')));
  assert.ok(res.errors.some(e => e.includes('events[3]')));
  // Reject direction: an accept-only test passes just as well against a check
  // that returns true unconditionally.
  assert.ok(res.errors.some(e => e.includes('events[4]') && e.includes('media.play')));
  assert.ok(res.errors.some(e => e.includes('events[5]') && e.includes('canvas.snapshot')));
});

// ── §5.3 clipboard strictness: SETTLED as required-but-nullable (T7) ───────

test('strict: clipboard fields are required-but-nullable, not typed-only-if-present', () => {
  // The parked design question, decided and pinned. §5.3 defines its two
  // producer modes by which fields are NULL — content mode nulls `len`,
  // length-only nulls `text`/`html` — so an absent key makes "withheld" and
  // "forgotten" the same file and a player cannot tell which mode it is
  // rendering. If a conforming jsPsych content-mode recording turns out to omit
  // `len`, this is the check that flips, and it flips in r3 rather than at
  // whoever hits the failure.
  const r = strictBase();
  r.segments = [seg({ events: [
    { type: 'clipboard.paste', t: 1, target: null, len: 5 },                       // no text/html
    { type: 'clipboard.copy', t: 2, target: 3, text: null, html: null, len: null }, // all four, all null
  ] })];
  const res = validateStrict(r);
  assert.ok(res.errors.some(e => e.includes('events[0]') && e.includes('"text" is absent')));
  assert.ok(!res.errors.some(e => e.includes('events[1]')),
    'copy/cut legitimately carry len: null — the clipboard is not populated when they fire');
});

// ── error-text pass: forbidden PRESENCE reads as presence ──────────────────

test('strict: redaction violations say a field must be REMOVED, not added', () => {
  // The old message for all three was "missing/invalid required fields (e.g.
  // value or value_len)", which points a producer at the wrong half of the
  // defect: the field is present and must not be.
  const r = strictBase();
  r.segments = [seg({ events: [
    { type: 'input.value', t: 1, node: 1, redacted: true, value_len: 6, value: 'secret' },
    { type: 'key.down', t: 2, redacted: true, code: 'KeyA', target: 4 },
    { type: 'clipboard.paste', t: 3, target: null, text: 'secret', html: null, len: 6, redacted: true },
  ] })];
  const errors = validateStrict(r).errors;
  assert.ok(errors.some(e => e.includes('events[0]') && e.includes('must not carry `value`')));
  const key = errors.find(e => e.includes('events[1]'));
  assert.match(key, /carry no identity/);
  assert.match(key, /`code`/);
  assert.match(key, /`target`/);
  assert.ok(errors.some(e => e.includes('events[2]') && e.includes('must null both `text` and `html`')));
});

test('strict: hintFor names real fields for every event type it covers', () => {
  // The hint is the only guidance a producer gets on a boolean-false check, and
  // an event type with no entry got "see spec §5" — which is where they already
  // were. Media, canvas and clipboard were the three families the review named.
  const r = strictBase();
  r.segments = [seg({ events: [
    { type: 'media.seeked', t: 1, node: 1 },
    { type: 'canvas.snapshot', t: 2, node: 1 },
    { type: 'touch.start', t: 3, touches: [{ id: 1, x: 2 }] },
    { type: 'input.select', t: 4, node: 1, values: [1, 2] },
  ] })];
  const errors = validateStrict(r).errors;
  assert.ok(errors.some(e => e.includes('events[0]') && e.includes('node/current_time')));
  assert.ok(errors.some(e => e.includes('events[1]') && e.includes('data_url')));
  assert.ok(errors.some(e => e.includes('events[2]') && e.includes('{id,x,y}')));
  assert.ok(errors.some(e => e.includes('events[3]') && e.includes('array of strings')));
});

// ── tolerant profile: warn on malformed known fields, never coerce ─────────

test('tolerant: a present-but-malformed known field warns and is kept as-is', () => {
  // Settled here (T7). Before this, `stylesheets: null` loaded in total silence
  // — defaults fill ABSENT keys only — so the analyst got no signal and the
  // value reached every consumer untyped.
  const bad = { ...structuredClone(MIN_VALID), stylesheets: null, truncated: 'yes', end_reason: 'quit' };
  const r = validateTolerant(bad);
  assert.equal(r.ok, true, 'a malformed known field is not one of the four fatal defects');
  for (const k of ['stylesheets', 'truncated', 'end_reason']) {
    assert.ok(r.warnings.some(w => w.includes(k)), `no warning names ${k}`);
  }
  // NEVER COERCE: overwriting participant data at load time is the loss this
  // profile exists to avoid, and a coerced value would also hide the defect
  // from the strict profile, which type-checks tolerant's output.
  assert.equal(r.recording.stylesheets, null);
  assert.equal(r.recording.truncated, 'yes');
  assert.equal(r.recording.end_reason, 'quit');
  assert.ok(validateStrict(bad).errors.some(e => e.includes('stylesheets')));
});

test('tolerant: a well-formed recording produces no malformed-field warnings', () => {
  // The reject direction of the warning itself. A probe that warned on healthy
  // values would make the accept-mode fixtures (which assert an empty warning
  // list) fail, but only after someone added one — so it is asserted directly.
  const r = validateTolerant(strictBase());
  assert.deepEqual(r.warnings, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATOR BREADTH (T7) — §11's "every declared field type-checked"
//
// Everything below closes a field the validator declared and never looked at.
// Each block states what got through BEFORE, because a type check with no
// witness of what it catches is indistinguishable from a comment.
// ═══════════════════════════════════════════════════════════════════════════

test('strict: host is {name, version} strings or null', () => {
  // T3 Task-7 finding: `host` appeared ONCE in this file, in TOP_DEFAULTS, so
  // `host: {name: 42}` was strict-valid and every consumer read a number where
  // §2 declares a runtime name.
  const bad = strictBase(); bad.host = { name: 42, version: '1' };
  assert.ok(validateStrict(bad).errors.some(e => e.includes('host')));
  const noVersion = strictBase(); noVersion.host = { name: 'jspsych' };
  assert.ok(validateStrict(noVersion).errors.some(e => e.includes('host')));
  const ok = strictBase(); ok.host = { name: 'jspsych', version: '8.2.3' };
  assert.deepEqual(validateStrict(ok).errors, []);
});

test('strict: rng and rng_calls element shapes', () => {
  const shaped = (over) => Object.assign(strictBase(),
    { rng: { seed: null, math_random_patched: false }, rng_calls: [] }, over);
  assert.deepEqual(validateStrict(shaped()).errors, []);
  assert.ok(validateStrict(shaped({ rng: { seed: null } })).errors.some(e => e.includes('rng must be')));
  assert.ok(validateStrict(shaped({ rng: { seed: 7, math_random_patched: true } }))
    .errors.some(e => e.includes('rng must be')));
  assert.ok(validateStrict(shaped({ rng_calls: [{ fn: 'Math.random', args: [], result: 0.5 }] }))
    .errors.some(e => e.includes('rng_calls[0]')));
  // args/result are JsonValue by §2 — anything JSON can hold — so only the two
  // identifying fields are typed, and an arbitrary payload must pass.
  assert.deepEqual(validateStrict(shaped({ rng_calls: [
    { t: 1, fn: 'Math.random', args: [], result: 0.5 },
    { t: 2, fn: 'crypto.getRandomValues', args: { n: 4 }, result: [1, 2, 3, 4] },
  ] })).errors, []);
  assert.ok(validateStrict(shaped({ rng_calls: [{ t: 5, fn: 'a' }, { t: 1, fn: 'b' }] }))
    .errors.some(e => e.includes('rng_calls') && e.includes('sorted')));
});

test('strict: stylesheet element shapes discriminate inline from link', () => {
  const sheets = (arr) => Object.assign(strictBase(), { stylesheets: arr });
  assert.deepEqual(validateStrict(sheets([
    { id: 1, kind: 'inline', css: 'p{}', media: null },
    { id: 2, kind: 'link', href: 'a.css', css: null, media: 'screen' },
  ])).errors, []);
  // An inline sheet with no css carries no styling at all — the one thing its
  // kind promises.
  assert.ok(validateStrict(sheets([{ id: 1, kind: 'inline', media: null }]))
    .errors.some(e => e.includes('stylesheets[0].css')));
  assert.ok(validateStrict(sheets([{ id: 1, kind: 'link', css: null, media: null }]))
    .errors.some(e => e.includes('stylesheets[0].href')));
  assert.ok(validateStrict(sheets([{ id: 1, kind: 'imported', css: 'p{}', media: null }]))
    .errors.some(e => e.includes('stylesheets[0].kind')));
  assert.ok(validateStrict(sheets([{ kind: 'inline', css: 'p{}', media: null }]))
    .errors.some(e => e.includes('numeric id')));
});

test('strict: stylesheet_events shapes, per event type', () => {
  const evs = (arr) => Object.assign(strictBase(), { stylesheet_events: arr });
  assert.deepEqual(validateStrict(evs([
    { type: 'stylesheet.add', t: 1, sheet: { id: 2, kind: 'inline', css: 'p{}', media: null } },
    { type: 'stylesheet.update', t: 2, id: 2, css: 'p{color:red}' },
    { type: 'stylesheet.remove', t: 3, id: 2 },
  ])).errors, []);
  assert.ok(validateStrict(evs([{ type: 'stylesheet.add', t: 1, sheet: { id: 2, kind: 'inline', media: null } }]))
    .errors.some(e => e.includes('stylesheet_events[0].sheet.css')));
  assert.ok(validateStrict(evs([{ type: 'stylesheet.update', t: 1, id: 2 }]))
    .errors.some(e => e.includes('stylesheet_events[0].css')));
  assert.ok(validateStrict(evs([{ type: 'stylesheet.swap', t: 1, id: 2 }]))
    .errors.some(e => e.includes('stylesheet_events[0].type')));
});

test('strict: viewport_changes elements carry a t plus the full ViewportState', () => {
  const vp = (arr) => Object.assign(strictBase(), { viewport_changes: arr });
  assert.deepEqual(validateStrict(vp([
    { t: 10, w: 800, h: 600, dpr: 2, scale: 1, offset_x: 0, offset_y: 0 },
  ])).errors, []);
  // A partial change is the trap: a player merging it over the previous state
  // reads the missing axis as unchanged, when the recording never said so.
  assert.ok(validateStrict(vp([{ t: 10, w: 800, h: 600 }]))
    .errors.some(e => e.includes('viewport_changes[0]')));
  assert.ok(validateStrict(vp([{ w: 800, h: 600, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 }]))
    .errors.some(e => e.includes('viewport_changes[0]')));
});

test('strict: extensions are objects keyed by lowercase vendor slugs, at all three levels', () => {
  // §9 puts extensions at session, segment AND event level, and the namespace
  // only works as an ignore-list if the keys are predictable.
  const r = strictBase();
  r.extensions = { 'Cyborg Hunter': {} };
  r.segments = [seg({ initial_dom: KEYFRAME_DOM, extensions: ['nope'], events: [
    { type: 'mouse.move', t: 1, x: 0, y: 0, extensions: { 'VENDOR': {} } },
  ] })];
  const errors = validateStrict(r).errors;
  assert.ok(errors.some(e => e.includes('extensions vendor key "Cyborg Hunter"')));
  assert.ok(errors.some(e => e.includes('segments[0].extensions must be an object')));
  assert.ok(errors.some(e => e.includes('events[0].extensions vendor key "VENDOR"')));
  const ok = strictBase();
  ok.extensions = { 'cyborg-hunter': { a: 1 }, jspsych: {} };
  assert.deepEqual(validateStrict(ok).errors, []);
});

test('strict: initial_state shape, including the optional form fields', () => {
  const withState = (s) => Object.assign(strictBase(),
    { segments: [seg({ initial_dom: KEYFRAME_DOM, initial_state: s })] });
  // Task-4 carry: ZERO initial_state code paths existed, so every one of these
  // loaded and only failed inside a player trying to seed the reconstruction.
  assert.deepEqual(validateStrict(withState({
    scroll: { x: 0, y: 120 },
    element_scroll: [{ node: 2, x: 0, y: 40 }],
    media: [{ node: 3, current_time: 1.5, paused: true }],
    form: [{ node: 4, value: 'ab' }, { node: 5, checked: true }, { node: 6, selected: ['a', 'b'] }],
  })).errors, []);
  assert.ok(validateStrict(withState({ scroll: { x: 0 }, element_scroll: [], media: [], form: [] }))
    .errors.some(e => e.includes('initial_state.scroll')));
  assert.ok(validateStrict(withState({ scroll: { x: 0, y: 0 }, element_scroll: [{ node: 2, x: 0 }], media: [], form: [] }))
    .errors.some(e => e.includes('initial_state.element_scroll[0]')));
  // `paused` is what separates "stopped here" from "playing from here", and a
  // media seed missing it seeds neither.
  assert.ok(validateStrict(withState({ scroll: { x: 0, y: 0 }, element_scroll: [],
    media: [{ node: 3, current_time: 0 }], form: [] }))
    .errors.some(e => e.includes('initial_state.media[0]')));
  assert.ok(validateStrict(withState({ scroll: { x: 0, y: 0 }, element_scroll: [], media: [],
    form: [{ node: 4, value: 42 }] }))
    .errors.some(e => e.includes('initial_state.form[0].value')));
  assert.ok(validateStrict(withState({ scroll: { x: 0, y: 0 }, element_scroll: [], media: [],
    form: [{ node: 4, selected: 'a' }] }))
    .errors.some(e => e.includes('initial_state.form[0].selected')));
  assert.deepEqual(validateStrict(withState(null)).errors, []);
});

test('strict: touch events type every touch point', () => {
  const r = strictBase();
  r.segments = [seg({ events: [
    { type: 'touch.start', t: 1, touches: [{ id: 1, x: 10, y: 20 }] },
    { type: 'touch.move', t: 2, touches: [{ id: 1, x: 10 }] },
    { type: 'touch.end', t: 3, touches: [] },
  ] })];
  const errors = validateStrict(r).errors;
  assert.ok(!errors.some(e => e.includes('events[0]')));
  assert.ok(errors.some(e => e.includes('events[1]') && e.includes('{id,x,y}')));
  // An empty touches array is the correct encoding of the last finger lifting.
  assert.ok(!errors.some(e => e.includes('events[2]')));
});

test('strict: §6 camera and anchor blocks are complete or absent', () => {
  const withEvent = (e) => Object.assign(strictBase(),
    { segments: [seg({ initial_dom: KEYFRAME_DOM, events: [e] })] });
  const CAMERA = { scroll_x: 0, scroll_y: 0, viewport_w: 8, viewport_h: 6, client_w: 8,
    client_h: 6, dpr: 1, vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0 };
  const click = (over) => Object.assign({ type: 'mouse.click', t: 1, x: 1, y: 2, button: 0, target: 1 }, over);
  assert.deepEqual(validateStrict(withEvent(click({ camera: CAMERA }))).errors, []);
  // "each anchored event carries complete blocks or none (no delta encoding)".
  const { dpr, ...partial } = CAMERA;
  assert.ok(validateStrict(withEvent(click({ camera: partial }))).errors.some(e => e.includes('.camera')));
  const anchor = { tag: 'button', id: 'go', rect: { x: 1, y: 2, w: 3, h: 4 }, node: 1 };
  assert.deepEqual(validateStrict(withEvent(click({ anchor }))).errors, []);
  // §8: an anchor on a redacted target OMITS `id`. Absent is legal; a non-string
  // is not, and `id: null` is the different claim "the element had no id".
  assert.deepEqual(validateStrict(withEvent(click({ anchor: { tag: 'input', rect: anchor.rect, node: 1 } }))).errors, []);
  assert.deepEqual(validateStrict(withEvent(click({ anchor: { ...anchor, id: null } }))).errors, []);
  assert.ok(validateStrict(withEvent(click({ anchor: { ...anchor, id: 7 } }))).errors.some(e => e.includes('.anchor.id')));
  assert.ok(validateStrict(withEvent(click({ anchor: { ...anchor, rect: { x: 1, y: 2, w: 3 } } })))
    .errors.some(e => e.includes('.anchor.rect')));
  // `rect` is typed WHEN PRESENT, not required: CH's capture omits it where
  // getBoundingClientRect is unavailable ("viewer treats as unverifiable"), and
  // the viewer's alignment check has a branch for that. Requiring it would make
  // CH's own capture non-conformant in every context without layout.
  assert.deepEqual(validateStrict(withEvent(click({ anchor: { tag: 'button', id: 'go', node: 1 } }))).errors, []);
  // §6: alignment fields never ride mouse.move.
  assert.ok(validateStrict(withEvent({ type: 'mouse.move', t: 1, x: 1, y: 2, camera: CAMERA }))
    .errors.some(e => e.includes('never ride mouse.move')));
});

test('strict: target is REQUIRED on mouse and key events, and may be null', () => {
  // §7 gives `target` three distinguishable readings — null (no applicable
  // target), a placeholder id (excluded), a live id whose anchor omits identity
  // (redacted). An ABSENT key is a fourth state the spec does not define.
  const r = strictBase();
  r.segments = [seg({ initial_dom: KEYFRAME_DOM, events: [
    { type: 'mouse.click', t: 1, x: 1, y: 2, button: 0 },
    { type: 'mouse.click', t: 2, x: 1, y: 2, button: 0, target: null },
    { type: 'key.down', t: 3, key: 'a', code: 'KeyA',
      mods: { ctrl: false, shift: false, alt: false, meta: false }, repeat: false },
    { type: 'key.down', t: 4, key: 'a', code: 'KeyA',
      mods: { ctrl: false, shift: false, alt: false, meta: false }, repeat: false, target: 1 },
  ] })];
  const errors = validateStrict(r).errors;
  assert.ok(errors.some(e => e.includes('events[0]')));
  assert.ok(!errors.some(e => e.includes('events[1]')));
  assert.ok(errors.some(e => e.includes('events[2]')));
  assert.ok(!errors.some(e => e.includes('events[3]')));
});

test('strict: input.select values must be strings', () => {
  const r = strictBase();
  r.segments = [seg({ initial_dom: KEYFRAME_DOM, events: [
    { type: 'input.select', t: 1, node: 1, values: ['a', 'b'] },
    { type: 'input.select', t: 2, node: 1, values: [{ value: 'a' }] },
  ] })];
  const errors = validateStrict(r).errors;
  assert.ok(!errors.some(e => e.includes('events[0]')));
  // An untyped array let a <select multiple> ship option OBJECTS, which no
  // player can set back onto the control.
  assert.ok(errors.some(e => e.includes('events[1]')));
});

test('strict: DomNode trees are validated recursively, in keyframes and in dom.add', () => {
  const tree = (kids) => ({ id: 1, kind: 'element', tag: 'div', attrs: {}, children: kids });
  const withDom = (dom) => Object.assign(strictBase(), { segments: [seg({ initial_dom: dom })] });
  assert.deepEqual(validateStrict(withDom(tree([
    { id: 2, kind: 'text', text: 'hi' },
    { id: 3, kind: 'comment', text: 'note' },
    { id: 4, kind: 'element', tag: 'canvas', attrs: {}, children: [], canvas_size: { w: 10, h: 5 } },
  ]))).errors, []);
  // Everything below was strict-valid before T7: the validator asked whether
  // initial_dom was an object and stopped there.
  assert.ok(validateStrict(withDom(tree(['just a string']))).errors
    .some(e => e.includes('children[0] must be a DomNode object')));
  assert.ok(validateStrict(withDom(tree([{ kind: 'text', text: 'hi' }]))).errors
    .some(e => e.includes('children[0].id')));
  assert.ok(validateStrict(withDom(tree([{ id: 2, kind: 'fragment' }]))).errors
    .some(e => e.includes('children[0].kind')));
  assert.ok(validateStrict(withDom(tree([{ id: 2, kind: 'text' }]))).errors
    .some(e => e.includes('children[0].text')));
  assert.ok(validateStrict(withDom(tree([{ id: 2, kind: 'element', tag: 'p', attrs: { a: 7 }, children: [] }]))).errors
    .some(e => e.includes('children[0].attrs["a"]')));
  assert.ok(validateStrict(withDom(tree([{ id: 2, kind: 'element', tag: 'canvas', attrs: {}, children: [],
    canvas_size: { w: 10 } }]))).errors.some(e => e.includes('canvas_size')));
  // The mid-span twin: dom.add carries a whole subtree and CORE_EVENT_CHECKS
  // only asks whether it is an object.
  const add = Object.assign(strictBase(), { segments: [seg({
    initial_dom: tree([]),
    events: [{ type: 'dom.add', t: 1, parent: 1, before: null,
      node: { id: 2, kind: 'element', tag: 'p', attrs: {}, children: [{ id: 3, kind: 'text' }] } }],
  })] });
  assert.ok(validateStrict(add).errors.some(e => e.includes('events[0].node.children[0].text')));
});

test('strict: the §4 exclusion placeholder is attrs AND children absent, never one of the two', () => {
  // The placeholder is why attrs/children are checked as a PAIR. §4: an
  // excluded element appears with "its id, kind, and tag" and nothing else, and
  // CH's snapshot emits exactly {id, kind, tag}. One of the two present is a
  // producer that half-built one or half-stripped the other — the shape a
  // player's instantiateDom crashes on.
  const withKid = (kid) => Object.assign(strictBase(), { segments: [seg({
    initial_dom: { id: 1, kind: 'element', tag: 'div', attrs: {}, children: [kid] } })] });
  assert.deepEqual(validateStrict(withKid({ id: 2, kind: 'element', tag: 'input' })).errors, []);
  assert.ok(validateStrict(withKid({ id: 2, kind: 'element', tag: 'input', attrs: {} })).errors
    .some(e => e.includes('carries only attrs')));
  assert.ok(validateStrict(withKid({ id: 2, kind: 'element', tag: 'input', children: [] })).errors
    .some(e => e.includes('carries only children')));
});

test('strict: the DomNode walk is depth-bounded rather than stack-overflowing', () => {
  // §12 makes recording content untrusted input, and this validator is the
  // first thing that touches it. An unbounded recursive descent turns a deep
  // tree into a RangeError that reads like a validator crash rather than a
  // rejected file.
  let deep = { id: 9999, kind: 'text', text: 'bottom' };
  for (let i = 0; i < 400; i++) {
    deep = { id: 1000 + i, kind: 'element', tag: 'div', attrs: {}, children: [deep] };
  }
  const r = Object.assign(strictBase(), { segments: [seg({ initial_dom: deep })] });
  let res;
  assert.doesNotThrow(() => { res = validateStrict(r); });
  assert.ok(res.errors.some(e => e.includes('depth bound')));
  // …and an ordinary tree is nowhere near it: jspsych-full's deepest keyframe
  // is 9 levels.
  let fine = { id: 999, kind: 'text', text: 'bottom' };
  for (let i = 0; i < 20; i++) fine = { id: i + 1, kind: 'element', tag: 'div', attrs: {}, children: [fine] };
  assert.deepEqual(validateStrict(Object.assign(strictBase(), { segments: [seg({ initial_dom: fine })] })).errors, []);
});

test('strict: segments must not overlap (§3), measured against the next segment ORIGIN', () => {
  const two = (a, b) => Object.assign(strictBase(), { segments: [seg(a), seg({ index: 1, ...b })] });
  // Touching is legal — t_end[n] ≤ next origin — and is what every real
  // recording does.
  assert.deepEqual(validateStrict(two(
    { initial_dom: KEYFRAME_DOM, t_start: 0, t_end: 500 },
    { t_start: 500, t_end: 1000 })).errors, []);
  assert.ok(validateStrict(two(
    { initial_dom: KEYFRAME_DOM, t_start: 0, t_end: 800 },
    { t_start: 500, t_end: 1000 })).errors.some(e => e.includes('overlaps segments[1]')));
  // The bound is §3's ORIGIN (first non-null of t_load, t_dom_ready, t_start),
  // not t_start: a segment whose t_start is null still opens somewhere.
  assert.deepEqual(validateStrict(two(
    { initial_dom: KEYFRAME_DOM, t_start: 0, t_end: 505 },
    { t_start: null, t_dom_ready: 510, t_end: 1000 })).errors, []);
  assert.ok(validateStrict(two(
    { initial_dom: KEYFRAME_DOM, t_start: 0, t_end: 520 },
    { t_start: null, t_dom_ready: 510, t_end: 1000 })).errors.some(e => e.includes('origin is 510')));
  // An open segment (t_end null) has no upper bound to compare, so the pair is
  // skipped rather than guessed at.
  assert.deepEqual(validateStrict(two(
    { initial_dom: KEYFRAME_DOM, t_start: 0, t_end: null },
    { t_start: 500, t_end: 1000 })).errors, []);
});

const HERE = dirname(fileURLToPath(import.meta.url));

test('canonical-core fixture is strict-valid', () => {
  const raw = readFileSync(join(HERE, 'fixtures', 'canonical-core.json'), 'utf8');
  const res = validateStrict(raw);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});
