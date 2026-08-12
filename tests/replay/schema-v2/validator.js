// SessionRecording v2 validator — dual profiles per spec §11.
// Zero dependencies; this file lifts into the shared schema package.

// Gzip magic bytes (RFC 1952): 0x1f 0x8b.
export function detectGzip(bytes) {
  return bytes != null && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

const TOP_DEFAULTS = {
  host: null, participant_id: null, observed_root: null,
  stylesheets: [], stylesheet_events: [], viewport_changes: [],
  rng: null, rng_calls: null, ended_at_perf: null, end_reason: null,
  truncated: false, extensions: null,
};
const ADVISORY_TOP = ['recording_started_at', 'recording_started_at_perf', 'user_agent', 'viewport'];

// Tolerant loader profile (spec §11): recordings are unrepeatable participant
// data, so runtime rejection is data loss. Only four defects are fatal;
// everything else loads with warnings and documented defaults.
// Defaults fill *absent* keys only — a present-but-malformed known field
// (e.g. `stylesheets: null`) passes through untouched by design: the strict
// profile type-checks the tolerant output, so coercing here would hide the
// defect from CI, and overwriting participant data at load time is exactly
// the data loss this profile exists to avoid.
export function validateTolerant(input) {
  const warnings = [];
  let obj = input;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); }
    catch (e) { return { ok: false, recording: null, errors: ['invalid JSON: ' + e.message], warnings }; }
  }
  const errors = [];
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, recording: null, errors: ['recording must be a JSON object'], warnings };
  }
  if (obj.schema_version !== 2) errors.push('schema_version must be the integer 2');
  if (!obj.recorder || typeof obj.recorder.name !== 'string' || typeof obj.recorder.version !== 'string') {
    errors.push('recorder {name, version} strings are required');
  }
  if (!Array.isArray(obj.segments)) {
    errors.push('segments array is required');
  } else {
    obj.segments.forEach((s, i) => {
      if (!s || typeof s !== 'object' || !Array.isArray(s.events)) {
        errors.push(`segments[${i}] must carry an events array`);
      }
    });
  }
  if (errors.length) return { ok: false, recording: null, errors, warnings };
  for (const k of ADVISORY_TOP) if (!(k in obj)) warnings.push(`missing advisory field: ${k}`);
  // WARN ON MALFORMED KNOWN FIELDS — WARN, NEVER COERCE (T7 settles this; it
  // was parked from two reviews). Before this, a present-but-malformed known
  // field (`stylesheets: null`, `truncated: "yes"`) passed through in total
  // silence: defaults fill ABSENT keys only, and the analyst opening the file
  // got no signal at all. Coercing is the wrong repair — overwriting
  // participant data at load time is exactly the loss this profile exists to
  // avoid, and it would hide the defect from the strict profile that
  // type-checks tolerant's output. So the value survives untouched and the
  // loader says what it saw. Presence is read off the INPUT, not the defaulted
  // output, or every default would report itself as malformed.
  for (const [k, ok] of Object.entries(TOP_SHAPES)) {
    if (k in obj && !ok(obj[k])) warnings.push(`malformed known field (kept as-is, not coerced): ${k}`);
  }
  // Clone: the array defaults must be fresh per recording, or two recordings
  // defaulted in the same process would share one mutable array.
  return { ok: true, recording: { ...structuredClone(TOP_DEFAULTS), ...obj }, errors, warnings };
}

// Shape probes for the tolerant profile's warn-on-malformed pass. Deliberately
// SHALLOW — an array must be an array, an object must be an object — because
// the strict profile is where depth lives and a tolerant loader duplicating it
// would be a second implementation of the schema, drifting.
const TOP_SHAPES = {
  host: v => v === null || (isPlainObject(v) && typeof v.name === 'string' && typeof v.version === 'string'),
  participant_id: v => strOrNull(v),
  observed_root: v => strOrNull(v),
  stylesheets: Array.isArray,
  stylesheet_events: Array.isArray,
  viewport_changes: Array.isArray,
  rng: v => v === null || isPlainObject(v),
  rng_calls: v => v === null || Array.isArray(v),
  ended_at_perf: v => numOrNull(v),
  end_reason: v => v === null || END_REASONS.has(v),
  truncated: v => typeof v === 'boolean',
  extensions: v => v === null || isPlainObject(v),
  recording_started_at: v => typeof v === 'string',
  recording_started_at_perf: v => isNum(v),
  user_agent: v => typeof v === 'string',
  viewport: v => isPlainObject(v) && VIEWPORT_KEYS.every(k => isNum(v[k])),
};

const END_REASONS = new Set(['finished', 'aborted', 'unload']);
const VIEWPORT_KEYS = ['w', 'h', 'dpr', 'scale', 'offset_x', 'offset_y'];
const CAMERA_KEYS = ['scroll_x', 'scroll_y', 'viewport_w', 'viewport_h',
  'client_w', 'client_h', 'dpr', 'vv_scale', 'vv_offset_x', 'vv_offset_y'];
const RECT_KEYS = ['x', 'y', 'w', 'h'];

// Recursion ceiling for the DomNode walk. A recording is untrusted input (spec
// §12) and this validator is the first thing that touches it, so the walk must
// not be the place a hostile file gets a stack overflow — an unbounded
// recursive descent turns a 100k-deep tree into a RangeError that reads like a
// validator crash rather than a rejected file. The bound is far above anything
// a browser produces (jspsych-full's deepest keyframe is 9 levels; Chromium
// itself stops parsing nested markup around 512) and below Node's default
// stack, so a tree that trips it is a defect either way.
const DOM_DEPTH_LIMIT = 256;

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function numOrNull(v) { return v === null || isNum(v); }
function strOrNull(v) { return v === null || typeof v === 'string'; }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isStrArray(v) { return Array.isArray(v) && v.every(s => typeof s === 'string'); }
function hasNumKeys(o, keys) { return isPlainObject(o) && keys.every(k => isNum(o[k])); }

// Spec §9: vendor keys are lowercase slugs. Enforced because the namespace only
// works as an ignore-list if the names are predictable — `extensions` keyed by
// a display string is a vendor bag no other player can route.
const VENDOR_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function checkExtensions(v, at, errors) {
  if (v === undefined || v === null) return;
  if (!isPlainObject(v)) { errors.push(`${at} must be an object keyed by vendor slug or null (spec §9)`); return; }
  for (const k of Object.keys(v)) {
    if (!VENDOR_SLUG.test(k)) errors.push(`${at} vendor key "${k}" is not a lowercase slug (spec §9)`);
  }
}

// ── §4 DomNode ─────────────────────────────────────────────────────────────
// The exclusion placeholder is the reason `attrs`/`children` are checked as a
// PAIR rather than as two required fields. Spec §4 declares both on
// ElementNode, and then §4's exclusion rule says an excluded element appears
// with "its id, kind, and tag" and nothing else — CH's snapshot emits exactly
// `{id, kind, tag}`, no empty `attrs: {}` and no empty `children: []`. Both
// present is a normal element; both absent is a placeholder; ONE of the two is
// a producer that half-built one or half-stripped the other, and that is the
// shape a player's instantiateDom crashes on.
function checkDomNode(n, at, errors, depth) {
  if (depth > DOM_DEPTH_LIMIT) {
    errors.push(`${at}: DomNode nesting exceeds the ${DOM_DEPTH_LIMIT}-level depth bound`);
    return;
  }
  if (!isPlainObject(n)) { errors.push(`${at} must be a DomNode object`); return; }
  if (!isNum(n.id) || !Number.isInteger(n.id)) errors.push(`${at}.id must be an integer node id`);
  if (n.kind === 'text' || n.kind === 'comment') {
    if (typeof n.text !== 'string') errors.push(`${at}.text must be a string on a ${n.kind} node`);
    return;
  }
  if (n.kind !== 'element') {
    errors.push(`${at}.kind must be "element" | "text" | "comment" (spec §4)`);
    return;
  }
  if (typeof n.tag !== 'string') errors.push(`${at}.tag must be a string`);
  const hasAttrs = 'attrs' in n, hasChildren = 'children' in n;
  if (hasAttrs !== hasChildren) {
    errors.push(`${at}: an element node carries attrs AND children, or neither ` +
      `(neither = the §4 exclusion placeholder); it carries only ${hasAttrs ? 'attrs' : 'children'}`);
  }
  if (hasAttrs) {
    if (!isPlainObject(n.attrs)) errors.push(`${at}.attrs must be an object of string attribute values`);
    else for (const [k, v] of Object.entries(n.attrs)) {
      if (typeof v !== 'string') errors.push(`${at}.attrs["${k}"] must be a string`);
    }
  }
  if (n.canvas_size !== undefined && !hasNumKeys(n.canvas_size, ['w', 'h'])) {
    errors.push(`${at}.canvas_size must carry numeric w/h`);
  }
  if (n.media_src !== undefined && typeof n.media_src !== 'string') {
    errors.push(`${at}.media_src must be a string`);
  }
  if (hasChildren) {
    if (!Array.isArray(n.children)) { errors.push(`${at}.children must be an array of DomNodes`); return; }
    n.children.forEach((c, i) => checkDomNode(c, `${at}.children[${i}]`, errors, depth + 1));
  }
}

// ── §3 InitialState ────────────────────────────────────────────────────────
function checkInitialState(s, at, errors) {
  if (s === undefined || s === null) return;
  if (!isPlainObject(s)) { errors.push(`${at} must be an InitialState object or null`); return; }
  if (!hasNumKeys(s.scroll, ['x', 'y'])) errors.push(`${at}.scroll must carry numeric x/y`);
  const arr = (k) => {
    if (!Array.isArray(s[k])) { errors.push(`${at}.${k} must be an array`); return null; }
    return s[k];
  };
  (arr('element_scroll') ?? []).forEach((e, i) => {
    if (!hasNumKeys(e, ['node', 'x', 'y'])) errors.push(`${at}.element_scroll[${i}] must carry numeric node/x/y`);
  });
  (arr('media') ?? []).forEach((e, i) => {
    if (!hasNumKeys(e, ['node', 'current_time']) || typeof e.paused !== 'boolean') {
      errors.push(`${at}.media[${i}] must carry numeric node/current_time and boolean paused`);
    }
  });
  (arr('form') ?? []).forEach((e, i) => {
    const eAt = `${at}.form[${i}]`;
    if (!isPlainObject(e) || !isNum(e.node)) { errors.push(`${eAt} must carry a numeric node`); return; }
    if (e.value !== undefined && typeof e.value !== 'string') errors.push(`${eAt}.value must be a string`);
    if (e.checked !== undefined && typeof e.checked !== 'boolean') errors.push(`${eAt}.checked must be a boolean`);
    if (e.selected !== undefined && !isStrArray(e.selected)) errors.push(`${eAt}.selected must be an array of strings`);
  });
}

// ── §2 session-level arrays ────────────────────────────────────────────────
function checkStylesheet(s, at, errors) {
  if (!isPlainObject(s) || !isNum(s.id)) { errors.push(`${at} must carry a numeric id`); return; }
  if (!strOrNull(s.media ?? null)) errors.push(`${at}.media must be a string or null`);
  if (s.kind === 'inline') {
    if (typeof s.css !== 'string') errors.push(`${at}.css must be a string on an inline sheet`);
  } else if (s.kind === 'link') {
    if (typeof s.href !== 'string') errors.push(`${at}.href must be a string on a link sheet`);
    if (!strOrNull(s.css ?? null)) errors.push(`${at}.css must be a string or null on a link sheet`);
  } else {
    errors.push(`${at}.kind must be "inline" | "link" (spec §2)`);
  }
}

// `label` is the full message prefix (callers phrase it as "<what> must be
// time-sorted") so one implementation serves both top-level and per-segment
// call sites without composing garbled text.
function checkSorted(arr, label, errors) {
  for (let i = 1; i < arr.length; i++) {
    if (isNum(arr[i - 1]?.t) && isNum(arr[i]?.t) && arr[i].t < arr[i - 1].t) {
      errors.push(`${label} (index ${i})`);
      return;
    }
  }
}

// Strict conformance profile (spec §11): full checks, exhaustive error list.
// Producers prove themselves here (CI); runtime loading stays tolerant.
// Two layers: the top-level fields here, segment/keyframe/event rules in
// checkSegmentsStrict below.
// Presence-checking of defaulted top-level fields is deliberately out of scope
// here (strict sees the normalized recording); producer-side presence
// strictness is decided with the negative-fixture corpus.
export function validateStrict(input) {
  const t = validateTolerant(input);
  if (!t.ok) return { ok: false, errors: t.errors, warnings: t.warnings };
  const r = t.recording;
  const errors = [];

  if (typeof r.recording_started_at !== 'string') errors.push('recording_started_at must be an ISO 8601 string');
  if (!isNum(r.recording_started_at_perf)) errors.push('recording_started_at_perf must be a number');
  if (typeof r.user_agent !== 'string') errors.push('user_agent must be a string');
  if (!r.viewport || !VIEWPORT_KEYS.every(k => isNum(r.viewport[k]))) {
    errors.push(`viewport must carry numeric ${VIEWPORT_KEYS.join('/')}`);
  }
  if (!strOrNull(r.observed_root)) errors.push('observed_root must be a string or null');
  if (!strOrNull(r.participant_id)) errors.push('participant_id must be a string or null');
  if (!numOrNull(r.ended_at_perf)) errors.push('ended_at_perf must be a number or null');
  if (r.end_reason !== null && !END_REASONS.has(r.end_reason)) {
    errors.push('end_reason must be "finished" | "aborted" | "unload" | null');
  }
  if (typeof r.truncated !== 'boolean') errors.push('truncated must be a boolean');
  // `host` appeared ONCE in this file before T7 — in TOP_DEFAULTS — so
  // `host: {name: 42}` was strict-valid (T3 Task-7).
  if (r.host !== null && !(isPlainObject(r.host)
      && typeof r.host.name === 'string' && typeof r.host.version === 'string')) {
    errors.push('host must be {name, version} strings or null');
  }
  if ((r.rng === null) !== (r.rng_calls === null)) {
    errors.push('rng_calls must be non-null iff rng is non-null (spec §7)');
  }
  if (r.rng !== null && !(isPlainObject(r.rng) && strOrNull(r.rng.seed ?? null)
      && typeof r.rng.math_random_patched === 'boolean')) {
    errors.push('rng must be {seed: string|null, math_random_patched: boolean} or null');
  }
  if (r.rng_calls !== null) {
    if (!Array.isArray(r.rng_calls)) errors.push('rng_calls must be an array or null');
    else {
      r.rng_calls.forEach((c, i) => {
        // `args`/`result` are JsonValue by §2 — anything JSON can hold — so
        // only the two identifying fields are typed.
        if (!isPlainObject(c) || !isNum(c.t) || typeof c.fn !== 'string') {
          errors.push(`rng_calls[${i}] must carry a numeric t and a string fn`);
        }
      });
      checkSorted(r.rng_calls, 'rng_calls must be time-sorted', errors);
    }
  }
  checkExtensions(r.extensions, 'extensions', errors);
  if (!Array.isArray(r.stylesheets)) errors.push('stylesheets must be an array');
  else r.stylesheets.forEach((s, i) => checkStylesheet(s, `stylesheets[${i}]`, errors));
  if (!Array.isArray(r.stylesheet_events)) errors.push('stylesheet_events must be an array');
  else {
    checkSorted(r.stylesheet_events, 'stylesheet_events must be time-sorted', errors);
    r.stylesheet_events.forEach((e, i) => {
      const at = `stylesheet_events[${i}]`;
      if (!isPlainObject(e) || !isNum(e.t)) { errors.push(`${at} must carry a numeric t`); return; }
      if (e.type === 'stylesheet.add') checkStylesheet(e.sheet, `${at}.sheet`, errors);
      else if (e.type === 'stylesheet.remove') { if (!isNum(e.id)) errors.push(`${at}.id must be a number`); }
      else if (e.type === 'stylesheet.update') {
        if (!isNum(e.id)) errors.push(`${at}.id must be a number`);
        if (typeof e.css !== 'string') errors.push(`${at}.css must be a string`);
      } else errors.push(`${at}.type must be stylesheet.add | stylesheet.remove | stylesheet.update`);
    });
  }
  if (!Array.isArray(r.viewport_changes)) errors.push('viewport_changes must be an array');
  else {
    checkSorted(r.viewport_changes, 'viewport_changes must be time-sorted', errors);
    r.viewport_changes.forEach((c, i) => {
      if (!isNum(c?.t) || !hasNumKeys(c, VIEWPORT_KEYS)) {
        errors.push(`viewport_changes[${i}] must carry a numeric t plus ${VIEWPORT_KEYS.join('/')}`);
      }
    });
  }

  checkSegmentsStrict(r, errors);
  return { ok: errors.length === 0, errors, warnings: t.warnings };
}

// Event union checks (spec §5), covering every spec-defined top-level type.
// The table must stay complete: an omitted type is reported as unknown, so a
// gap here rejects conformant recordings. Unknown types are producer errors
// and vendor events belong in `extensions` (§5.8).
// `target` is DECLARED on every mouse/key record in §5.2 as `number | null`,
// and its three readings are distinguishable only if it is actually there
// (§7: null = no applicable target; a placeholder id = excluded; a live id
// with an anchor missing `id` = redacted). An absent key is a fourth state the
// spec does not define, so presence is required rather than defaulted.
const targetPresent = e => 'target' in e && numOrNull(e.target);
const touchesCheck = e => Array.isArray(e.touches)
  && e.touches.every(t => hasNumKeys(t, ['id', 'x', 'y']));

const CORE_EVENT_CHECKS = {
  'dom.add':    e => isNum(e.parent) && (e.before === null || isNum(e.before)) && e.node && typeof e.node === 'object',
  'dom.remove': e => isNum(e.node),
  'dom.attr':   e => isNum(e.node) && typeof e.name === 'string' && strOrNull(e.value),
  'dom.text':   e => isNum(e.node) && typeof e.text === 'string',
  'mouse.move': e => isNum(e.x) && isNum(e.y),
  'mouse.down': e => isNum(e.x) && isNum(e.y) && isNum(e.button) && targetPresent(e),
  'mouse.up':   e => isNum(e.x) && isNum(e.y) && isNum(e.button) && targetPresent(e),
  'mouse.click': e => isNum(e.x) && isNum(e.y) && isNum(e.button) && targetPresent(e),
  'touch.start': touchesCheck,
  'touch.move':  touchesCheck,
  'touch.end':   touchesCheck,
  'key.down': keyCheck, 'key.up': keyCheck,
  // The redacted variant carries a length and no content (spec §5.2). A
  // surviving `value` is a redaction leak, so reject it rather than ignore it,
  // matching keyCheck and clipboardCheck — and say WHY, because "missing/invalid
  // required fields (e.g. value or value_len)" told a producer to add something
  // when the defect was that it had added too much.
  'input.value': e => {
    if (e.redacted !== true) return isNum(e.node) && typeof e.value === 'string';
    if (e.value !== undefined) {
      return 'redacted input.value must not carry `value` — it is the plaintext the redaction ' +
        'removed (spec §5.2/§8); the variant is {t, node, redacted, value_len}';
    }
    return isNum(e.node) && isNum(e.value_len);
  },
  'input.checked': e => isNum(e.node) && typeof e.checked === 'boolean',
  // `values` is `string[]` in §5.2. An untyped array let a `<select multiple>`
  // ship option objects, which no player can set back onto the control.
  'input.select':  e => isNum(e.node) && isStrArray(e.values),
  'scroll.window':  e => isNum(e.x) && isNum(e.y),
  'scroll.element': e => isNum(e.node) && isNum(e.x) && isNum(e.y),
  'focus': () => true, 'blur': () => true,
  'fullscreen.enter': () => true, 'fullscreen.exit': () => true,
  'visibility.hidden': () => true, 'visibility.visible': () => true,
  'clipboard.copy': clipboardCheck, 'clipboard.cut': clipboardCheck,
  'clipboard.paste': clipboardCheck, 'clipboard.drop': clipboardCheck,
  'media.play':   mediaCheck, 'media.pause': mediaCheck, 'media.ended': mediaCheck,
  'media.seeked': mediaCheck, 'media.time':  mediaCheck,
  'canvas.snapshot': e => isNum(e.node) && typeof e.data_url === 'string'
    && (e.region === undefined
        || (e.region && isNum(e.region.x) && isNum(e.region.y) && isNum(e.region.w) && isNum(e.region.h))),
  'recording.capture_stopped': e => e.reason === 'buffer_limit' || e.reason === 'error',
};

// The event types spec §5.2 gives a redacted variant. These are exactly the
// types whose check above has a `redacted === true` branch that strips
// content, so the set and the branches must be extended together: a type
// listed here without such a branch would accept the marker and the payload.
// Exported so the conformance runner can hold its own §8 allowlist
// (REDACTED_SHAPES) against it. The two tables encode the same spec sentence
// from opposite directions — this one says which types may CLAIM redaction,
// that one says what a claimed event may CARRY — and the failure mode of a
// dual encoding is that one grows and the other does not. The drift guard in
// corpus-invariants.test.js is what makes that a red test rather than a hole.
export const REDACTABLE_TYPES = new Set([
  'key.down', 'key.up', 'input.value',
  'clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'clipboard.drop',
]);

// ── §5.3 clipboard: REQUIRED-BUT-NULLABLE, settled here (T7) ───────────────
// The parked question was whether §5.3's four fields are required-but-nullable
// or typed-only-if-present. Settled as REQUIRED, for one reason that is not
// about strictness for its own sake: §5.3 defines its TWO PRODUCER MODES by
// which fields are null. Content mode sets text/html and nulls len; length-only
// sets len and nulls text/html. If a field may simply be absent, "this producer
// withheld the content" and "this producer forgot the key" become the same
// file, and a player cannot tell which mode it is rendering. An explicit null
// is a claim; an absent key is silence. §5.3 is written as an interface, not a
// union, and every field carries an explicit `| null` — this reads that
// literally.
//
// THE RISK, STATED: the corpus has exactly one clipboard producer
// (length-only-clipboard.json, a real CH capture, which emits all four on every
// event including copy/cut). jsPsych's content-mode recorder is unexercised
// here because its demo timeline has no clipboard trial. If a conforming
// jsPsych recording turns out to omit `len`, THIS is the check that flips to
// fields-if-present, and the decision belongs in r3 rather than to whoever
// hits the failure. Strict is CI-only, so the cost of being wrong is a
// producer conversation, not an analyst losing data.
const CLIPBOARD_FIELDS = ['target', 'text', 'html', 'len'];
function clipboardCheck(e) {
  for (const k of CLIPBOARD_FIELDS) {
    if (!(k in e)) {
      return `clipboard events state all of ${CLIPBOARD_FIELDS.join('/')} explicitly, nulling what ` +
        `the mode withholds (spec §5.3); "${k}" is absent, which is silence rather than a claim`;
    }
  }
  const typed = numOrNull(e.target) && strOrNull(e.text) && strOrNull(e.html) && numOrNull(e.len);
  if (!typed) return false;
  if (e.redacted === true && (e.text !== null || e.html !== null)) {
    return 'redacted clipboard events must null both `text` and `html` — a surviving payload is ' +
      'the content the redaction removed (spec §5.3/§8); `len` may stay';
  }
  return true;
}

function mediaCheck(e) { return isNum(e.node) && isNum(e.current_time); }

const KEY_IDENTITY_FIELDS = ['key', 'code', 'mods', 'repeat', 'target'];
function keyCheck(e) {
  if (e.redacted === true) {
    // Redacted variant: NO identity fields allowed (spec §5.2/§8). Named, not
    // counted: "missing/invalid required fields" sent a producer looking for
    // something to add when the defect is a field to remove.
    const present = KEY_IDENTITY_FIELDS.filter(k => e[k] !== undefined);
    if (present.length === 0) return true;
    return `redacted key events carry no identity — the variant is {t, type, redacted} and ` +
      `nothing else (spec §5.2/§8); this one keeps ${present.map(k => `\`${k}\``).join(', ')}`;
  }
  return typeof e.key === 'string' && typeof e.code === 'string'
      && e.mods && typeof e.mods === 'object' && typeof e.repeat === 'boolean'
      && 'target' in e && numOrNull(e.target);
}

// Spec §3's segment time origin: first non-null of t_load, t_dom_ready,
// t_start; else the first event's t. Exported nowhere — the viewer has its own
// copy and a shared one would make this file part of the player.
function segmentOrigin(s) {
  for (const k of ['t_load', 't_dom_ready', 't_start']) {
    if (isNum(s?.[k])) return s[k];
  }
  const first = s?.events?.[0];
  return isNum(first?.t) ? first.t : null;
}

function checkSegmentsStrict(r, errors) {
  let sawKeyframe = false;
  r.segments.forEach((s, i) => {
    const at = `segments[${i}]`;
    if (s.index !== i) errors.push(`${at}.index (${s.index}) must equal array position ${i}`);
    for (const k of ['t_start', 't_dom_ready', 't_load', 't_end']) {
      if (k in s && !numOrNull(s[k])) errors.push(`${at}.${k} must be a number or null`);
    }
    if (!strOrNull(s.label ?? null)) errors.push(`${at}.label must be a string or null`);
    if (!strOrNull(s.plugin ?? null)) errors.push(`${at}.plugin must be a string or null`);
    checkInitialState(s.initial_state, `${at}.initial_state`, errors);
    checkExtensions(s.extensions, `${at}.extensions`, errors);
    // Spec §3: "segments are ordered and non-overlapping (t_end[n] ≤ next
    // segment's origin)". Unchecked, a recording can state two segments that
    // both own the same instant, and every player resolves the tie its own way.
    // Skipped where either side is unstated: a null t_end is an open segment,
    // and an originless segment has no instant to overlap with.
    const next = r.segments[i + 1];
    if (next) {
      const nextOrigin = segmentOrigin(next);
      if (isNum(s.t_end) && isNum(nextOrigin) && s.t_end > nextOrigin) {
        errors.push(`${at}.t_end (${s.t_end}) overlaps segments[${i + 1}], whose origin is ${nextOrigin} (spec §3)`);
      }
    }
    const hasDomEvents = s.events.some(e => typeof e?.type === 'string' && e.type.startsWith('dom.'));
    // A keyframe is a DomNode object. A primitive here is a producer bug, and
    // so is an array — `typeof [] === 'object'`, but an array carries none of
    // a DomNode's fields. Either way, treating it as a keyframe would license
    // later dom.* patches against a snapshot the player cannot reconstruct,
    // so the keyframe status and the shape error read off one test.
    const isKeyframe = s.initial_dom != null && typeof s.initial_dom === 'object'
      && !Array.isArray(s.initial_dom);
    if (s.initial_dom != null && !isKeyframe) {
      errors.push(`${at}.initial_dom must be a DomNode object or null`);
    }
    // The keyframe tree itself, recursively (spec §4). Until T7 the validator
    // stopped at "is an object": a keyframe whose children were strings, or
    // whose ids were absent, was strict-valid and only failed inside a player.
    if (isKeyframe) checkDomNode(s.initial_dom, `${at}.initial_dom`, errors, 1);
    if (isKeyframe) sawKeyframe = true;
    else if (hasDomEvents && !sawKeyframe) {
      errors.push(`${at}: continuation carries dom.* events before any keyframe (spec §3)`);
    }
    checkSorted(s.events, `${at}.events must be time-sorted`, errors);
    s.events.forEach((e, j) => {
      const eAt = `${at}.events[${j}]`;
      if (!e || typeof e.type !== 'string' || !isNum(e.t)) { errors.push(`${eAt}: events need string type and numeric t`); return; }
      // `redacted` is a variant marker, not a toggle. Every per-type check
      // selects the redacted shape on `=== true`, so a truthy non-boolean
      // (`"true"`, `1`) would fall through to the plaintext branch and license
      // exactly the content the redaction removed. `false` is rejected too:
      // absence is how a non-redacted event says so, and a false marker only
      // invites producers to emit the field on events that never redact.
      // On a type outside REDACTABLE_TYPES the marker is a claim nothing
      // enforces: that type's check has no redacted branch, so the event
      // asserts redaction and keeps its payload (a canvas.snapshot with both
      // `redacted: true` and its data_url). Strict refuses the marker there.
      if ('redacted' in e) {
        if (e.redacted !== true) {
          errors.push(`${eAt}: redacted must be the boolean true when present (it marks the redacted variant; omit it on non-redacted events)`);
        } else if (!REDACTABLE_TYPES.has(e.type)) {
          errors.push(`${eAt}: ${e.type} has no redacted variant (spec §5.2/§8); the marker must not appear on it`);
        }
      }
      checkExtensions(e.extensions, `${eAt}.extensions`, errors);
      checkAlignment(e, eAt, errors);
      const check = CORE_EVENT_CHECKS[e.type];
      if (!check) {
        errors.push(`${eAt}: unknown top-level event type "${e.type}" (vendor events belong in extensions, spec §5.8)`);
      } else {
        // A check returns `true`, `false`, or a SPECIFIC MESSAGE. The third
        // case exists for the redaction branches: telling a producer its
        // redacted event has "missing/invalid required fields (e.g. value or
        // value_len)" points at the wrong half of the defect — the field is
        // present and must not be — and that message cost a review round.
        const verdict = check(e);
        if (typeof verdict === 'string') errors.push(`${eAt}: ${verdict}`);
        else if (!verdict) errors.push(`${eAt}: ${e.type} missing/invalid required fields (e.g. ${hintFor(e.type)})`);
      }
      // The keyframe walk's mid-span twin: a dom.add carries a whole subtree,
      // and CORE_EVENT_CHECKS only asks whether it is an object.
      if (e.type === 'dom.add' && isPlainObject(e.node)) checkDomNode(e.node, `${eAt}.node`, errors, 1);
    });
  });
}

// ── §6 alignment fields ────────────────────────────────────────────────────
// Optional, but each anchored event "carries complete blocks or none (no delta
// encoding)" — so a half-filled camera is a producer bug, not a cheaper event.
// `anchor.id` is the one field that may be ABSENT rather than null: §8 has
// anchors on redacted targets omit identity, and an explicit `id: null` is the
// different claim "the element had no id".
function checkAlignment(e, at, errors) {
  if (e.camera !== undefined) {
    if (!hasNumKeys(e.camera, CAMERA_KEYS)) {
      errors.push(`${at}.camera must carry numeric ${CAMERA_KEYS.join('/')} (spec §6)`);
    }
    if (e.type === 'mouse.move') errors.push(`${at}: alignment fields never ride mouse.move (spec §6)`);
  }
  if (e.anchor !== undefined) {
    const a = e.anchor;
    if (!isPlainObject(a)) errors.push(`${at}.anchor must be an object (spec §6)`);
    else {
      if (typeof a.tag !== 'string') errors.push(`${at}.anchor.tag must be a string`);
      if ('id' in a && !strOrNull(a.id)) errors.push(`${at}.anchor.id must be a string or null when present`);
      // `rect` is typed WHEN PRESENT rather than required, and that is a
      // deliberate concession to an existing producer contract rather than
      // laxity. §6 declares it without a `?`, but CH's capture omits it when
      // `getBoundingClientRect` is unavailable or throws — "rect stays absent —
      // viewer treats as unverifiable" (capture-trace.js) — and the viewer's
      // alignment check has a real branch for that state. Requiring it here
      // would make CH's own capture non-conformant in every context without
      // layout, which is a producer decision and not a validator's to force.
      // Routed to r3 with the other two strictness questions: either §6 gains
      // "rect MAY be omitted when capture-time geometry was unreadable", or CH
      // emits a null rect and this becomes required-but-nullable like §5.3's
      // clipboard fields.
      if ('rect' in a && !hasNumKeys(a.rect, RECT_KEYS)) {
        errors.push(`${at}.anchor.rect must carry numeric ${RECT_KEYS.join('/')} when present`);
      }
      if (!numOrNull(a.node ?? null)) errors.push(`${at}.anchor.node must be a number or null`);
    }
    if (e.type === 'mouse.move') errors.push(`${at}: alignment fields never ride mouse.move (spec §6)`);
  }
}

function hintFor(type) {
  return {
    'mouse.down': 'x/y/button/target', 'mouse.up': 'x/y/button/target', 'mouse.click': 'x/y/button/target',
    'key.down': 'key/code/mods/repeat/target', 'key.up': 'key/code/mods/repeat/target',
    'input.value': 'value or value_len', 'input.select': 'values as an array of strings',
    'touch.start': 'touches[] of {id,x,y}', 'touch.move': 'touches[] of {id,x,y}',
    'touch.end': 'touches[] of {id,x,y}',
    'media.play': 'node/current_time', 'media.pause': 'node/current_time',
    'media.ended': 'node/current_time', 'media.seeked': 'node/current_time',
    'media.time': 'node/current_time',
    'canvas.snapshot': 'node/data_url, optional numeric region x/y/w/h',
    'clipboard.copy': 'target/text/html/len, content withheld under redacted',
    'clipboard.cut': 'target/text/html/len, content withheld under redacted',
    'clipboard.paste': 'target/text/html/len, content withheld under redacted',
    'clipboard.drop': 'target/text/html/len, content withheld under redacted',
    'recording.capture_stopped': 'reason "buffer_limit" | "error"',
  }[type] ?? 'see spec §5';
}
