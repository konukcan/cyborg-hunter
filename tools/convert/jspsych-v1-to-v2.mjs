// tools/convert/jspsych-v1-to-v2.mjs
//
// jsPsych `schema_version: 1` SessionRecording → SessionRecording v2
// (docs/plans/2026-08-09-session-recording-v2-spec-draft.md, §14 migration).
// This tool IS the migration path: players stay v2-only, there is no dual-read,
// and there is no v2 → v1 direction.
//
// v1 source of truth: the fork's pre-flip `src/schema/types.ts`
//   git -C <jspsych-replay-fork> show ed4bc08~1:src/schema/types.ts
// itself copied from jspsych/jsPsych packages/jspsych/src/modules/recording.ts.
// The key tables below are that interface, transcribed. They are the whole
// shape contract: a recording whose top-level or per-trial key set differs from
// them is REFUSED, in both directions (unknown keys and missing keys alike).
//
// Why refuse instead of coping. A converter that defaults a missing field is
// guessing about unrepeatable participant data, and a converter that renumbers
// a disagreeing `trial_index` silently rewrites the experiment's own record of
// what ran when. Both failures are invisible downstream — the output validates
// either way. So every deviation from the v1 shape stops the conversion and
// names itself. (Note the deliberate contrast with the v2 *loader*, which is
// tolerant by design, spec §11: tolerance protects an analyst opening a file;
// strictness protects a producer manufacturing one, and this is a producer.)
//
// What the mapping does NOT touch: `initial_dom`, `events`, `trial_data`,
// stylesheets, viewport changes and RNG records are participant data and are
// copied through value-for-value. Their internal key order is theirs, not ours.
//
// Usage:
//   node tools/convert/jspsych-v1-to-v2.mjs <v1.json> --stdout
//   node tools/convert/jspsych-v1-to-v2.mjs <v1.json> --out <v2.json>
//   cat v1.json | node tools/convert/jspsych-v1-to-v2.mjs --stdout
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Inward import, sanctioned by the T4 design §2: the converter is a CH tool and
// the schema-v2 directory is a would-be shared package. Only the CLI uses it —
// `convertRecording` stays a pure mapping and leaves validation to its caller.
import { validateStrict } from '../../tests/replay/schema-v2/validator.js';

// Stamped into every converted file. Bump it deliberately: the goldens carry
// this string, so a bump fails the golden tests until they are regenerated,
// which is exactly the review moment a mapping change deserves.
export const CONVERTER_VERSION = '1.0.0';
const CONVERTER_TOOL = 'jspsych-v1-to-v2';

// Transcribed from v1 `interface SessionRecording` / `interface TrialRecording`.
const V1_TOP_KEYS = [
  'schema_version', 'jspsych_version', 'recording_started_at',
  'recording_started_at_perf', 'user_agent', 'viewport', 'rng',
  'display_element_id', 'stylesheets', 'stylesheet_events', 'trials',
  'viewport_changes', 'rng_calls', 'ended_at_perf', 'end_reason',
];
const V1_TRIAL_KEYS = [
  'trial_index', 't_start', 't_dom_ready', 't_end', 'plugin',
  'initial_dom', 'events', 'trial_data',
];

// ── conversion ──────────────────────────────────────────────────────────────

/**
 * Convert a jsPsych-v1 SessionRecording object to v2. Pure: the input is never
 * mutated and the output shares no structure with it (one clone up front), so
 * a caller can keep using either independently.
 *
 * Throws on ANY deviation from the v1 shape. The Error carries `.reasons`
 * (string[]) with every problem found, not just the first.
 */
export function convertRecording(input) {
  const reasons = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw refusal(['input must be a JSON object (got ' + describe(input) + ')']);
  }

  if (input.schema_version !== 1) {
    reasons.push(`schema_version must be the integer 1 (got ${describe(input.schema_version)})`);
  }
  checkKeySet(input, V1_TOP_KEYS, 'top-level', '', reasons);

  if (typeof input.jspsych_version !== 'string') {
    reasons.push(`jspsych_version must be a string (got ${describe(input.jspsych_version)})`);
  }
  if (typeof input.display_element_id !== 'string' || input.display_element_id === '') {
    reasons.push(
      `display_element_id must be a non-empty string (got ${describe(input.display_element_id)})`
    );
  }

  // Trial checks only run when there is an array to walk; otherwise every
  // per-trial message would be noise on top of the real problem.
  if (!Array.isArray(input.trials)) {
    reasons.push(`trials must be an array (got ${describe(input.trials)})`);
  } else {
    input.trials.forEach((t, i) => checkTrial(t, i, reasons));
  }

  // Nothing below runs for a refused recording, so a bad file costs neither the
  // clone nor the hash.
  if (reasons.length) throw refusal(reasons);

  const v1 = structuredClone(input);
  // Hashed canonically (see canonicalize) so that two files differing only in
  // key order or indentation carry the same provenance stamp.
  const sourceHash = sha256(JSON.stringify(canonicalize(input)));

  return {
    schema_version: 2,
    // v1 states one version for the recorder and the runtime because in v1 they
    // are the same program. v2 splits the roles, so both get the same identity
    // here rather than one of them getting a guess.
    recorder: { name: 'jspsych', version: v1.jspsych_version },
    host: { name: 'jspsych', version: v1.jspsych_version },
    participant_id: null,          // v1 records none, so the converter invents none
    recording_started_at: v1.recording_started_at,
    recording_started_at_perf: v1.recording_started_at_perf,
    user_agent: v1.user_agent,
    viewport: v1.viewport,
    observed_root: '#' + v1.display_element_id,   // v2 wants a selector, §2
    stylesheets: v1.stylesheets,
    stylesheet_events: v1.stylesheet_events,
    viewport_changes: v1.viewport_changes,
    rng: v1.rng,
    rng_calls: v1.rng_calls,
    ended_at_perf: v1.ended_at_perf,
    end_reason: v1.end_reason,
    truncated: false,              // v1 has no early-stop channel to report
    extensions: {
      converter: { tool: CONVERTER_TOOL, version: CONVERTER_VERSION, source_sha256: sourceHash },
    },
    segments: v1.trials.map(convertTrial),
  };
}

// jsPsych wipes the display between trials, so every v1 trial is a v2 keyframe:
// `initial_dom` is always a fresh snapshot and node numbering always restarts.
// That is why `initial_state` is null (spec §3 exempts wiping hosts) and why no
// continuation bookkeeping is needed here.
function convertTrial(t) {
  return {
    index: t.trial_index,
    label: String(t.trial_index),  // v1 has no host label; the index is the only one
    plugin: t.plugin,
    t_start: t.t_start,
    t_dom_ready: t.t_dom_ready,
    t_load: null,                  // v1 never recorded a load milestone
    t_end: t.t_end,
    initial_dom: t.initial_dom,    // v1's DomNode encoding IS v2's (§4)
    initial_state: null,
    events: t.events,              // v1's dotted event vocabulary IS v2's (§5)
    host_data: t.trial_data,
    extensions: null,
  };
}

// ── refusals ────────────────────────────────────────────────────────────────

function checkTrial(t, i, reasons) {
  const at = `trials[${i}]`;
  if (typeof t !== 'object' || t === null || Array.isArray(t)) {
    reasons.push(`${at} must be a JSON object (got ${describe(t)})`);
    return;
  }
  checkKeySet(t, V1_TRIAL_KEYS, 'trial-level', at + ': ', reasons);

  if (!Number.isInteger(t.trial_index)) {
    reasons.push(`${at}.trial_index must be an integer (got ${describe(t.trial_index)})`);
  } else if (t.trial_index !== i) {
    // Never renumbered. v2 §7 requires index === array position, and the only
    // safe way to satisfy it is to make a human decide which one is wrong.
    reasons.push(`${at}.trial_index (${t.trial_index}) must equal its array position (${i})`);
  }
}

function checkKeySet(obj, known, what, prefix, reasons) {
  const present = Object.keys(obj);
  const unknown = present.filter(k => !known.includes(k)).sort();
  const missing = known.filter(k => !present.includes(k)).sort();
  if (unknown.length) reasons.push(`${prefix}unknown ${what} key(s): ${unknown.join(', ')}`);
  if (missing.length) reasons.push(`${prefix}missing ${what} key(s): ${missing.join(', ')}`);
}

function refusal(reasons) {
  const err = new Error(
    `${CONVERTER_TOOL} refused this recording (${reasons.length} problem` +
    `${reasons.length === 1 ? '' : 's'}):\n` +
    reasons.map(r => '  - ' + r).join('\n')
  );
  err.reasons = reasons;
  return err;
}

function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  return JSON.stringify(v);
}

// ── provenance hash ─────────────────────────────────────────────────────────

// Recursively key-sorted copy. Hashing THIS rather than the raw bytes makes the
// provenance stamp identify the recording's content, not its formatting: the
// same recording re-serialized with different key order or indentation gets the
// same hash, and any change to a value gets a different one.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node tools/convert/jspsych-v1-to-v2.mjs [<v1.json>] [--stdout | --out <v2.json>]

Converts a jsPsych schema_version:1 SessionRecording to SessionRecording v2.
Reads stdin when no input path is given; writes stdout unless --out is passed.
Refuses anything that is not exactly v1-shaped, and refuses to emit output that
fails schema-v2 strict validation.`;

// writeSync on fd 2 rather than process.stderr.write: on macOS a piped stderr
// is asynchronous, so an immediate process.exit() can truncate the very message
// that explains the refusal.
function die(message) {
  writeSync(2, message + '\n');
  process.exit(1);
}

function main(argv) {
  let inputPath = null;
  let outPath = null;
  let explicitStdout = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE + '\n');
      return;
    } else if (arg === '--stdout') {
      explicitStdout = true;
    } else if (arg === '--out' || arg === '-o') {
      outPath = argv[++i];
      if (outPath === undefined) die(`${CONVERTER_TOOL}: --out needs a path\n\n${USAGE}`);
    } else if (arg.startsWith('-') && arg !== '-') {
      die(`${CONVERTER_TOOL}: unknown option "${arg}"\n\n${USAGE}`);
    } else if (inputPath === null) {
      inputPath = arg;
    } else {
      die(`${CONVERTER_TOOL}: more than one input path given\n\n${USAGE}`);
    }
  }
  if (explicitStdout && outPath !== null) {
    die(`${CONVERTER_TOOL}: --stdout and --out are mutually exclusive`);
  }

  // fd 0 covers both the piped and the redirected case; "-" is the conventional
  // spelling of "stdin" when a path would otherwise be expected.
  const source = inputPath === null || inputPath === '-' ? 0 : inputPath;
  let raw;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (e) {
    die(`${CONVERTER_TOOL}: cannot read ${inputPath ?? 'stdin'}: ${e.message}`);
  }

  let v1;
  try {
    v1 = JSON.parse(raw);
  } catch (e) {
    die(`${CONVERTER_TOOL}: input is not valid JSON: ${e.message}`);
  }

  let v2;
  try {
    v2 = convertRecording(v1);
  } catch (e) {
    die(e.message);
  }

  // The design's validation duty: a converted file that does not strict-validate
  // is not a v2 recording, so it never reaches disk or a pipe.
  const verdict = validateStrict(v2);
  if (!verdict.ok) {
    die(
      `${CONVERTER_TOOL}: converted output failed schema-v2 strict validation ` +
      `(${verdict.errors.length} error${verdict.errors.length === 1 ? '' : 's'}):\n` +
      verdict.errors.map(e => '  - ' + e).join('\n')
    );
  }

  const text = JSON.stringify(v2, null, 2) + '\n';
  if (outPath !== null) {
    writeFileSync(outPath, text);
    // Progress chatter goes to stderr so stdout carries recordings and nothing
    // else, whichever output mode is in use.
    process.stderr.write(`Wrote ${outPath}\n`);
  } else {
    process.stdout.write(text);
  }
}

// Runs only when this file is the entry point (not on import from the test).
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
