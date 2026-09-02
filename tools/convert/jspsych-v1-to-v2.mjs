// tools/convert/jspsych-v1-to-v2.mjs
//
// jsPsych `schema_version: 1` SessionRecording → SessionRecording v2
// (docs/plans/2026-08-09-session-recording-v2-spec-draft.md, §14 migration).
// This tool IS the migration path: players stay v2-only, there is no dual-read,
// and there is no v2 → v1 direction.
//
// v1 source of truth: the fork's pre-flip `src/schema/types.ts`
//   git -C <jspsych-replay-fork> show 06dfa08~1:src/schema/types.ts
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
// names itself, with a remedy attached. (Note the deliberate contrast with the
// v2 *loader*, which is tolerant by design, spec §11: tolerance protects an
// analyst opening a file; strictness protects a producer manufacturing one.
// This tool is BOTH — a producer when it cuts a fixture, and an archive's only
// door when a researcher points it at a 2025 recording, since §14 makes
// conversion the sole migration path. Hence the one concession below.)
//
// What the mapping does NOT touch: `initial_dom`, `events`, `trial_data`,
// stylesheets, viewport changes and RNG records are participant data and are
// copied through value-for-value. Their internal key order is theirs, not ours.
//
// Packaging: `convertRecording` has no dependency outside node: builtins and
// runs from a bare copy of this file. The CLI additionally validates its output
// against the in-repo schema-v2 validator, which it imports lazily, so a missing
// `tests/` directory costs the CLI its output gate and costs the pure function
// nothing. (`validator.js:2` says that file lifts into a shared package one day;
// when it moves, only the dynamic specifier below needs updating.)
//
// Usage:
//   node tools/convert/jspsych-v1-to-v2.mjs <v1.json> --stdout
//   node tools/convert/jspsych-v1-to-v2.mjs <v1.json> --out <v2.json>
//   cat v1.json | node tools/convert/jspsych-v1-to-v2.mjs --stdout
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VALIDATOR_SPECIFIER = '../../src/shared/schema-v2-validator.js';

// Stamped into every converted file. Bump it deliberately: the goldens carry
// this string, so a bump fails the golden tests until they are regenerated,
// which is exactly the review moment a mapping change deserves.
// 1.1.0: stylesheets backfill + `backfilled` report, provenance moved under the
// `cyborg-hunter` vendor slug, `label` null instead of String(trial_index).
export const CONVERTER_VERSION = '1.1.0';
const CONVERTER_TOOL = 'jspsych-v1-to-v2';
// Spec §9 types `extensions` as { "<vendor>": JsonValue } with lowercase-slug
// vendor keys. "converter" is a role, not a vendor, so the stamp nests inside
// CH's existing namespace — the shape travels to the fork with the jspsych-full
// fixture, where a bare "converter" key would read as a second vendor.
const CH_VENDOR = 'cyborg-hunter';

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

// The ONLY concession to v1 history, mirroring the v1 reference validator
// (fork 06dfa08~1:src/schema/types.ts:219-224, "stylesheet fields were added
// later. Default to empty arrays so older recordings still load") — and those
// are its only two backfills, so this is a bounded concession, not the top of a
// slope. These two fields postdate the rest of the shape, so ABSENCE means the
// recorder had no stylesheet feature: `[]` records that fact rather than
// inventing one, which is why `viewport` or `rng_calls` cannot join the list.
// Absence only. A present-but-wrong-type value means something went wrong, and
// the converter has nothing true to say about it: it passes through and the
// strict profile stops it at the CLI boundary.
const V1_BACKFILL_KEYS = ['stylesheets', 'stylesheet_events'];

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
    throw refusal([
      `input must be a JSON object (got ${describe(input)}). ` +
      `Pass one jsPsych SessionRecording, not a list of them or a bare value.`,
    ]);
  }

  if (input.schema_version !== 1) {
    reasons.push(
      `schema_version must be the integer 1 (got ${describe(input.schema_version)}). ` +
      `Point this tool at a jsPsych v1 recording: a v2 file needs no conversion, and a ` +
      `Cyborg Hunter v1 file takes the separate CH migration path (spec §14).`
    );
  }

  const backfilled = V1_BACKFILL_KEYS.filter(k => !Object.keys(input).includes(k));
  const top = keySetDiff(input, V1_TOP_KEYS, backfilled);
  if (top.unknown.length) {
    reasons.push(
      `unknown top-level key(s): ${top.unknown.join(', ')}. ` +
      `Remove them from the recording, or extend V1_TOP_KEYS in this tool if jsPsych's ` +
      `v1 shape really grew a field.`
    );
  }
  if (top.missing.length) {
    reasons.push(
      `missing top-level key(s): ${top.missing.join(', ')}. ` +
      `Re-export the recording from its source; only ${V1_BACKFILL_KEYS.join('/')} have a ` +
      `safe default ([], applied automatically), so filling anything else in would invent data.`
    );
  }

  if (typeof input.jspsych_version !== 'string') {
    reasons.push(
      `jspsych_version must be a string (got ${describe(input.jspsych_version)}). ` +
      `Quote it ("8.2.1"): it becomes recorder.version and host.version.`
    );
  }
  if (typeof input.display_element_id !== 'string' || input.display_element_id === '') {
    reasons.push(
      `display_element_id must be a non-empty string (got ${describe(input.display_element_id)}). ` +
      `Name the element the session was recorded from; it becomes observed_root as "#"+id.`
    );
  }

  // Trial checks only run when there is an array to walk; otherwise every
  // per-trial message would be noise on top of the real problem.
  if (!Array.isArray(input.trials)) {
    reasons.push(
      `trials must be an array (got ${describe(input.trials)}). ` +
      `Pass the recording's own trials list, even when it is empty.`
    );
  } else {
    input.trials.forEach((t, i) => checkTrial(t, i, reasons));
  }

  // Nothing below runs for a refused recording, so a bad file costs neither the
  // clone nor the hash.
  if (reasons.length) throw refusal(reasons);

  const v1 = structuredClone(input);
  // Hashed canonically (see canonicalize) and BEFORE the backfill, so the stamp
  // identifies the source recording as it arrived; `backfilled` below says what
  // the converter added on top.
  const sourceHash = sha256(JSON.stringify(canonicalize(input)));
  for (const k of backfilled) v1[k] = [];

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
    // v2 wants a selector (§2). Not CSS-escaped: an id starting with a digit or
    // holding a `.`/`:`/space yields a selector querySelector rejects. Left as
    // is deliberately — CH's own recorder builds observed_root the same way
    // (src/replay/capture-dom.js:251-253), so escaping is a repo-wide
    // convention to change in both places or neither.
    observed_root: '#' + v1.display_element_id,
    stylesheets: v1.stylesheets,
    stylesheet_events: v1.stylesheet_events,
    viewport_changes: v1.viewport_changes,
    rng: v1.rng,
    rng_calls: v1.rng_calls,
    ended_at_perf: v1.ended_at_perf,
    end_reason: v1.end_reason,
    truncated: false,              // v1 has no early-stop channel to report
    extensions: {
      [CH_VENDOR]: {
        converter: {
          tool: CONVERTER_TOOL,
          version: CONVERTER_VERSION,
          source_sha256: sourceHash,
          // Present only when something was filled in, so its presence alone is
          // the signal that this file is not purely what the recorder wrote.
          ...(backfilled.length ? { backfilled } : {}),
        },
      },
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
    // null, not String(trial_index): spec §3 calls `label` host-assigned, and
    // jsPsych assigns none. Stringifying the index would duplicate `index` while
    // asserting a label the recording never carried.
    label: null,
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
    reasons.push(
      `${at} must be a JSON object (got ${describe(t)}). ` +
      `Drop the entry or restore the trial record; the converter will not invent one.`
    );
    return;
  }

  const keys = keySetDiff(t, V1_TRIAL_KEYS);
  if (keys.unknown.length) {
    reasons.push(
      `${at}: unknown trial-level key(s): ${keys.unknown.join(', ')}. ` +
      `Remove them, or extend V1_TRIAL_KEYS in this tool if the v1 trial shape really grew a field.`
    );
  }
  if (keys.missing.length) {
    reasons.push(
      `${at}: missing trial-level key(s): ${keys.missing.join(', ')}. ` +
      `Re-export the recording from its source; no trial-level field has a safe default.`
    );
  }

  if (!Number.isInteger(t.trial_index)) {
    reasons.push(
      `${at}.trial_index must be an integer (got ${describe(t.trial_index)}). ` +
      `Fix it at the source: it becomes the segment index, which v2 §7 requires to equal ` +
      `the array position.`
    );
  } else if (t.trial_index !== i) {
    // Never renumbered. v2 §7 requires index === array position, and the only
    // safe way to satisfy it is to make a human decide which one is wrong.
    reasons.push(
      `${at}.trial_index (${t.trial_index}) must equal its array position (${i}). ` +
      `Reorder the trials to match their own indices, or fix the indices at the source; ` +
      `this tool never renumbers, because that would rewrite the experiment's record of ` +
      `what ran when.`
    );
  }
}

// `exempt` names keys whose absence is being handled elsewhere (the stylesheets
// backfill), so they are not also reported as missing.
function keySetDiff(obj, known, exempt = []) {
  const present = Object.keys(obj);
  return {
    unknown: present.filter(k => !known.includes(k)).sort(),
    missing: known.filter(k => !present.includes(k) && !exempt.includes(k)).sort(),
  };
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

  <v1.json>           input path; "-" or omitted reads stdin
  --stdout            write the converted recording to stdout (the default)
  --out, -o <path>    write it to a file instead
  --help, -h          this message

Converts a jsPsych schema_version:1 SessionRecording to SessionRecording v2.
Refuses anything that is not exactly v1-shaped, and refuses to emit output that
fails schema-v2 strict validation. Absent stylesheets/stylesheet_events are the
one exception: they backfill to [] and say so in the provenance stamp.`;

// writeSync on fd 2 rather than process.stderr.write: on macOS a piped stderr
// is asynchronous, so an immediate process.exit() can truncate the very message
// that explains the refusal.
function die(message) {
  writeSync(2, message + '\n');
  process.exit(1);
}

async function main(argv) {
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
  // is not a v2 recording, so it never reaches disk or a pipe. Imported here
  // rather than at module scope so `convertRecording` never loads it (M1).
  let validateStrict;
  try {
    ({ validateStrict } = await import(VALIDATOR_SPECIFIER));
  } catch (e) {
    die(
      `${CONVERTER_TOOL}: cannot load the schema-v2 validator (${VALIDATOR_SPECIFIER}): ` +
      `${e.message}\nThe CLI strict-validates its ` +
      `own output; the exported convertRecording() has no such dependency.`
    );
  }
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => die(`${CONVERTER_TOOL}: ${e.stack ?? e.message}`));
}
