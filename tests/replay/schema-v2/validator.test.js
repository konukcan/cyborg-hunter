import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { detectGzip } from './validator.js';

test('detectGzip: true for gzipped bytes, false for JSON text and short input', () => {
  const gz = gzipSync(Buffer.from('{"schema_version":2}'));
  assert.equal(detectGzip(gz), true);
  assert.equal(detectGzip(Buffer.from('{"schema_version":2}')), false);
  assert.equal(detectGzip(Buffer.from([0x1f])), false);
  assert.equal(detectGzip(null), false);
});

import { validateTolerant } from './validator.js';

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

import { validateStrict } from './validator.js';

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

test('strict: media, canvas, and clipboard event checks', () => {
  const r = strictBase();
  r.segments = [seg({
    events: [
      { type: 'media.play', t: 1, node: 1, current_time: 0 },
      { type: 'canvas.snapshot', t: 2, node: 2, data_url: 'data:,', region: { x: 0, y: 0, w: 10, h: 10 } },
      { type: 'clipboard.paste', t: 3, target: null, len: 5 },
      { type: 'clipboard.paste', t: 4, redacted: true, text: 'leak' },
    ],
  })];
  const res = validateStrict(r);
  assert.ok(!res.errors.some(e => e.includes('events[0]')));
  assert.ok(!res.errors.some(e => e.includes('events[1]')));
  assert.ok(!res.errors.some(e => e.includes('events[2]')));
  assert.ok(res.errors.some(e => e.includes('events[3]')));
});
