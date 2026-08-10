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
