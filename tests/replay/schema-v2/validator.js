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
  // Clone: the array defaults must be fresh per recording, or two recordings
  // defaulted in the same process would share one mutable array.
  return { ok: true, recording: { ...structuredClone(TOP_DEFAULTS), ...obj }, errors, warnings };
}

const END_REASONS = new Set(['finished', 'aborted', 'unload']);
const VIEWPORT_KEYS = ['w', 'h', 'dpr', 'scale', 'offset_x', 'offset_y'];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function numOrNull(v) { return v === null || isNum(v); }
function strOrNull(v) { return v === null || typeof v === 'string'; }

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
  if ((r.rng === null) !== (r.rng_calls === null)) {
    errors.push('rng_calls must be non-null iff rng is non-null (spec §7)');
  }
  if (!Array.isArray(r.stylesheets)) errors.push('stylesheets must be an array');
  if (!Array.isArray(r.stylesheet_events)) errors.push('stylesheet_events must be an array');
  else checkSorted(r.stylesheet_events, 'stylesheet_events must be time-sorted', errors);
  if (!Array.isArray(r.viewport_changes)) errors.push('viewport_changes must be an array');
  else checkSorted(r.viewport_changes, 'viewport_changes must be time-sorted', errors);

  checkSegmentsStrict(r, errors);
  return { ok: errors.length === 0, errors, warnings: t.warnings };
}

// Event union checks (spec §5), covering every spec-defined top-level type.
// The table must stay complete: an omitted type is reported as unknown, so a
// gap here rejects conformant recordings. Unknown types are producer errors
// and vendor events belong in `extensions` (§5.8).
const CORE_EVENT_CHECKS = {
  'dom.add':    e => isNum(e.parent) && (e.before === null || isNum(e.before)) && e.node && typeof e.node === 'object',
  'dom.remove': e => isNum(e.node),
  'dom.attr':   e => isNum(e.node) && typeof e.name === 'string' && strOrNull(e.value),
  'dom.text':   e => isNum(e.node) && typeof e.text === 'string',
  'mouse.move': e => isNum(e.x) && isNum(e.y),
  'mouse.down': e => isNum(e.x) && isNum(e.y) && isNum(e.button),
  'mouse.up':   e => isNum(e.x) && isNum(e.y) && isNum(e.button),
  'mouse.click': e => isNum(e.x) && isNum(e.y) && isNum(e.button),
  'touch.start': e => Array.isArray(e.touches),
  'touch.move':  e => Array.isArray(e.touches),
  'touch.end':   e => Array.isArray(e.touches),
  'key.down': keyCheck, 'key.up': keyCheck,
  // The redacted variant carries a length and no content (spec §5.2). A
  // surviving `value` is a redaction leak, so reject it rather than ignore it,
  // matching keyCheck and clipboardCheck.
  'input.value': e => e.redacted === true
    ? isNum(e.node) && isNum(e.value_len) && e.value === undefined
    : isNum(e.node) && typeof e.value === 'string',
  'input.checked': e => isNum(e.node) && typeof e.checked === 'boolean',
  'input.select':  e => isNum(e.node) && Array.isArray(e.values),
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
const REDACTABLE_TYPES = new Set([
  'key.down', 'key.up', 'input.value',
  'clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'clipboard.drop',
]);

// Clipboard fields are all optional (a length-only record is the redacted
// shape), so each is typed only when present. Under `redacted: true` the
// content fields must be absent: a surviving text/html is a redaction leak.
function clipboardCheck(e) {
  const typed = (e.target === undefined || numOrNull(e.target))
    && (e.text === undefined || strOrNull(e.text))
    && (e.html === undefined || strOrNull(e.html))
    && (e.len === undefined || numOrNull(e.len));
  if (!typed) return false;
  return e.redacted !== true || ((e.text ?? null) === null && (e.html ?? null) === null);
}

function mediaCheck(e) { return isNum(e.node) && isNum(e.current_time); }

function keyCheck(e) {
  if (e.redacted === true) {
    // Redacted variant: NO identity fields allowed (spec §5.2/§8).
    return e.key === undefined && e.code === undefined && e.mods === undefined
        && e.repeat === undefined && e.target === undefined;
  }
  return typeof e.key === 'string' && typeof e.code === 'string'
      && e.mods && typeof e.mods === 'object' && typeof e.repeat === 'boolean';
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
      const check = CORE_EVENT_CHECKS[e.type];
      if (!check) errors.push(`${eAt}: unknown top-level event type "${e.type}" (vendor events belong in extensions, spec §5.8)`);
      else if (!check(e)) errors.push(`${eAt}: ${e.type} missing/invalid required fields (e.g. ${hintFor(e.type)})`);
    });
  });
}

function hintFor(type) {
  return { 'mouse.click': 'button', 'key.down': 'key/code/mods/repeat', 'key.up': 'key/code/mods/repeat',
           'input.value': 'value or value_len' }[type] ?? 'see spec §5';
}
