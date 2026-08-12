// Loads JSON or CSV participant files, extracts integrity data, validates schema.
//
// Three input shapes:
//   1. JSON Shape 1 — { participantId: 'P1', trials: [{ integrity: {...} }] }
//      jsPsych extension data with one file per participant.
//   2. JSON Shape 2 — { metadata: {...}, responses: [{ mouseTrack, tabAwayEvents, ... }] }
//      The original legacy format. Signal data lives flat on each response
//      (no `integrity` wrapper). Pre-dates the standalone library.
//   3. CSV — jsPsych default save format. Each row is a trial; nested objects
//      (integrity, integritySession, integrityScore) are JSON-stringified into
//      single cells. We unwrap them and route through Shape 1.

import { readFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import { gunzipSync } from 'zlib';
import Papa from 'papaparse';
import { sanitizeId } from '../shared/constants.js';
import { getByPath } from '../shared/paths.js';
import { extractIntegrityData, ruleChronologicalCompare } from './extract-core.js';

// Replay artifacts saved by the replay extension:
//   <sanitizedPid>-replay-<sessionStartEpochMs>.json[.gz]
// They sit in dataDir (or replayDir) next to the participant files and must
// never enter the participant-file pass.
const REPLAY_FILE_RE = /-replay-\d+\.json(\.gz)?$/i;

// Content sniff: replay artifacts are identified by structure, not just
// filename. Three shapes qualify:
//   - SessionRecording v2 (spec r2, ANY producer): schema_version 2 with a
//     `recorder` identity and a `segments` array. Same three keys the §11
//     tolerant loader identifies a recording by (viewer-model.js), so the
//     sniff and the loader cannot disagree about what a recording is.
//   - the v1 era: our own `metadata.recorder` stamp, or
//   - a #3661-shaped `trials` array from jsPsych's in-development recorder.
// (T5 Task 10) The v2 arm is new, and without it a fresh capture matched
// nothing here: it was routed into the participant pass as a misnamed export
// and never reached the report. Attaching a v2 file is all this does — the
// rest of the v2 ingest work (ownership from the top-level participant_id,
// session pick from recording_started_at, jsPsych-v1 by conversion) is A3's.
function looksLikeReplayArtifact(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && 'schema_version' in j &&
      ((j.schema_version === 2 && !!j.recorder && typeof j.recorder.name === 'string' &&
          Array.isArray(j.segments)) ||
        String(j.metadata?.recorder || '').startsWith('cyborg-hunter-replay') ||
        (Array.isArray(j.trials) && j.trials.length > 0 &&
          j.trials.every(t => t && 'events' in t && 'initial_dom' in t)));
  } catch (e) {
    return true;   // unparseable + replay-named → let the replay pass report it
  }
}

// Identity fields moved between the two wire versions: v1 kept them in a
// `metadata` block, v2 states them at the top level under different names.
// The read is VERSION-AWARE on purpose — a chain like `metadata?.x ?? x`
// would let a stray `metadata` block on a v2 file (junk: v2 has no such
// block) override the authoritative field, and both of these decide which
// participant an artifact belongs to and which session is the latest.
function ownField(recording, which) {
  const v2 = recording.schema_version === 2;
  if (which === 'participant_id') {
    return v2 ? recording.participant_id : recording.metadata?.participant_id;
  }
  // 'start_time'
  return v2 ? recording.recording_started_at : recording.metadata?.start_time;
}

export async function ingest(config) {
  const allFiles = findFiles(config.dataDir, config.filePattern);
  const participants = [];
  const warnings = [];

  // Replay artifacts are excluded from the participant pass by filename —
  // but only after a content check, so a participant export that happens to
  // match the naming pattern is never silently dropped.
  const files = [];
  for (const file of allFiles) {
    if (REPLAY_FILE_RE.test(file)) {
      let text = null;
      try { text = readFileSync(file, 'utf8'); } catch (e) { text = null; }
      let parseable = true;
      if (text !== null) {
        try { JSON.parse(text); } catch (e) { parseable = false; }
      }
      if (text === null || !parseable) {
        // Never let a replay-named file vanish silently: if its pid maps to
        // a discovered participant the attach pass warns again with more
        // context, but an orphan (no matching participant) would otherwise
        // disappear without a trace.
        warnings.push({ file,
          warnings: ['Replay-named file could not be parsed (truncated upload or a misnamed participant export?) — skipped from the participant pass; if a matching participant exists, the replay pass reports it too.'] });
        continue;
      }
      if (looksLikeReplayArtifact(text)) continue;
      warnings.push({ file,
        warnings: ['File matches the replay-artifact naming pattern (<pid>-replay-<epoch>.json) but contains participant data — parsed as a participant file. Consider renaming it to avoid ambiguity.'] });
    }
    files.push(file);
  }

  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      // Branch by extension. CSV is jsPsych's default save format; JSON is what
      // server-side-saving experiments use.
      const raw = extname(file).toLowerCase() === '.csv'
        ? parseCsvToRaw(text, config)
        : JSON.parse(text);
      const result = extractIntegrityData(raw, config);

      // --participant flag filters to a single participant
      if (config.singleParticipant && result.participantId !== config.singleParticipant) {
        continue;
      }

      if (result.warnings.length > 0) {
        warnings.push({ file, warnings: result.warnings });
      }
      if (result.trials.length > 0) {
        participants.push(result);
      }
    } catch (e) {
      warnings.push({ file, warnings: [`Failed to parse: ${e.message}`] });
    }
  }

  // Duplicate-upload guard. Two files resolving to the same participantId are
  // conflated downstream (triage/HTML/image outputs key by id), so the second
  // upload's evidence can silently overwrite or vanish. We do NOT auto-dedup —
  // the analyst must decide which upload is canonical — but we surface it.
  // (attachReplayArtifacts below adds its own duplicate-id note describing the
  // replay-association consequence specifically.)
  const idCounts = new Map();
  for (const p of participants) idCounts.set(p.participantId, (idCounts.get(p.participantId) || 0) + 1);
  for (const [id, n] of idCounts) {
    if (n > 1) {
      warnings.push({ file: '(multiple)', warnings: [
        `duplicate participantId "${id}" appears in ${n} files — downstream ` +
        `outputs key by id, so entries may be conflated. Keep one upload per participant.`
      ] });
    }
  }

  attachReplayArtifacts(participants, config, warnings);

  return { participants, warnings };
}

// Finds and attaches each participant's replay artifact (if any) as
// `participant.replay`:
//   { recording, file, meta }            — parsed and attached
//   { error: 'parse_failed', reason }    — artifact exists but unreadable
//   null                                 — no artifact (silent unless meta
//                                          says one went to 'download')
function attachReplayArtifacts(participants, config, warnings) {
  const dir = config.replayDir || config.dataDir;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (config.replayDir) {
      warnings.push({ file: dir, warnings: [`replayDir not readable: ${e.message}`] });
    }
  }

  // Sanitized-name census: filename sanitization is many-to-one, so a
  // no-embedded-id artifact may only attach when exactly one participant
  // maps to its sanitized name (otherwise ownership is ambiguous).
  // The census is keyed on LOWERCASED sanitized ids because the filename
  // match below is case-insensitive (macOS filesystems are) — both
  // mechanisms must share the same equivalence classes or an ownerless
  // artifact could attach to two case-variant participants at once.
  // Null-prototype maps: a participant id that collides with an
  // Object.prototype key ("__proto__", "constructor") must count like any
  // other id — on a literal {}, assigning a primitive to __proto__ is a
  // silent no-op, which skipped the duplicate warning AND the
  // ambiguous-association guard below.
  const sanitize = sanitizeId;
  const saneCounts = Object.create(null);
  const idCounts = Object.create(null);
  for (const p of participants) {
    const s = sanitize(p.participantId).toLowerCase();
    saneCounts[s] = (saneCounts[s] || 0) + 1;
    idCounts[p.participantId] = (idCounts[p.participantId] || 0) + 1;
  }

  // Duplicate participant ids (repeat runs, duplicate exports) are outside
  // the pipeline's data model — every renderer keys outputs by pid, so the
  // whole report already treats them as one person. Replay attachment
  // follows the same semantics (both records get the same latest artifact);
  // say so once per duplicated id instead of silently doing it.
  for (const [id, n] of Object.entries(idCounts)) {
    if (n > 1) {
      warnings.push({ file: dir,
        warnings: [`Duplicate participant id "${id}" across ${n} files — the report (including replay attachment) treats these as one person; per-session replay association is not attempted.`] });
    }
  }

  for (const p of participants) {
    // Same sanitization the browser-side filename builder applies. The
    // match is ANCHORED (^<sane>-replay-<digits>.json$): a bare prefix
    // would let participant "a" swallow "a-replay-replay-<epoch>.json",
    // which belongs to participant "a-replay".
    const sane = sanitize(p.participantId);
    const escaped = sane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactRe = new RegExp(`^${escaped}-replay-\\d+\\.json(\\.gz)?$`, 'i');
    const mine = entries.filter(f => exactRe.test(f));
    // The meta pointer rides on every trial row via addProperties.
    const meta = (p.trials && p.trials[0] && p.trials[0].integrityReplayMeta) || null;
    // Replay finalize failures ride the same way — surface them where the
    // analyst looks (they mean the artifact was probably never saved).
    const finErr = p.trials && p.trials[0] && p.trials[0].replayFinalizeError;
    if (finErr) {
      warnings.push({ file: dir,
        warnings: [`Replay finalize failed for ${p.participantId}: ${finErr} — the artifact was likely never saved.`] });
    }

    if (mine.length === 0) {
      p.replay = null;
      if (meta && meta.saved_to === 'download') {
        warnings.push({
          file: dir,
          warnings: [`Replay artifact for ${p.participantId} was downloaded to the participant's machine (autoSave mode "download") and is not recoverable from here — check the autosave configuration for future runs.`]
        });
      }
      continue;
    }

    const parsed = [];
    for (const f of mine) {
      try {
        const buf = readFileSync(join(dir, f));
        const json = f.toLowerCase().endsWith('.gz')
          ? gunzipSync(buf).toString('utf8')
          : buf.toString('utf8');
        // Same structural sniff as the participant pass: a misnamed
        // participant export was rescued as participant data there and
        // must not double as its own "replay" here.
        if (!looksLikeReplayArtifact(json)) continue;
        parsed.push({ file: f, recording: JSON.parse(json) });
      } catch (e) {
        parsed.push({ file: f, reason: e.message });
      }
    }
    if (parsed.length === 0) {
      p.replay = null;
      continue;
    }

    // Every unreadable artifact warns individually — a corrupt NEWEST
    // session must never be silently masked by an older readable one.
    for (const bad of parsed.filter(x => !x.recording)) {
      warnings.push({ file: join(dir, bad.file),
        warnings: [`Replay artifact ${bad.file} unreadable: ${bad.reason} — if this is the newest session, its replay is lost.`] });
    }
    const readable = parsed.filter(x => x.recording);
    if (readable.length === 0) {
      p.replay = { error: 'parse_failed', reason: parsed[0].reason, file: parsed[0].file };
      continue;
    }
    if (mine.length > 1) {
      warnings.push({ file: dir,
        warnings: [`Multiple replay artifacts for ${p.participantId} (page reload?) — using the latest by start_time.`] });
    }
    // Filename sanitization is many-to-one ('a/b' and 'a_b' both map to
    // 'a_b'), so ownership is verified against the UNsanitized
    // participant_id embedded in the recording. Artifacts without one
    // (e.g. plain #3661 recordings) attach with a soft warning.
    const owned = [];
    for (const cand of readable) {
      // v2 carries the id at the TOP LEVEL; v1 carried it in `metadata`.
      // Reading only the v1 site would send every v2 artifact down the
      // ownerless branch, which verifies by filename alone — and a file
      // recorded for 'a/b' but named for the sanitized 'a_b' would then
      // attach to the wrong participant, which is the one case this check
      // exists for. VERSION-AWARE rather than a fallback chain: a v2 file has
      // no `metadata` block (spec §2), so one appearing there is junk, and a
      // chain that consulted it first would let that junk decide ownership.
      const embedded = ownField(cand.recording, 'participant_id');
      if (embedded == null) {
        // Ownerless artifacts skip id verification entirely, so the filename
        // must match EXACT-case (our recorder writes sanitize(pid) verbatim).
        // Case-tolerant matching stays for discovery, where the embedded-id
        // check catches cross-case impostors.
        if (!cand.file.startsWith(sane + '-replay-')) {
          warnings.push({ file: join(dir, cand.file),
            warnings: [`Replay artifact has no embedded participant_id and its filename case does not match "${sane}" exactly — not attached.`] });
        } else if (saneCounts[sane.toLowerCase()] > 1) {
          warnings.push({ file: join(dir, cand.file),
            warnings: [`Replay artifact has no embedded participant_id and its filename is ambiguous (${saneCounts[sane.toLowerCase()]} participants sanitize to "${sane}") — not attached to anyone.`] });
        } else {
          warnings.push({ file: join(dir, cand.file),
            warnings: [`Replay artifact has no embedded participant_id — cannot verify ownership; attaching to ${p.participantId} by unique filename match.`] });
          owned.push(cand);
        }
      } else if (String(embedded) === String(p.participantId)) {
        owned.push(cand);
      } else {
        warnings.push({ file: join(dir, cand.file),
          warnings: [`Replay artifact participant_id mismatch: file matches ${p.participantId} by name but was recorded for ${embedded} (sanitization collision?) — not attached.`] });
      }
    }
    if (owned.length === 0) {
      p.replay = null;
      continue;
    }
    // Duplicate records for this id + multiple owned artifacts: the
    // per-session mapping is genuinely ambiguous. Attach nothing rather
    // than knowingly mis-associate a session's replay.
    if (idCounts[p.participantId] > 1 && owned.length > 1) {
      warnings.push({ file: dir,
        warnings: [`Cannot associate ${owned.length} replay artifacts with ${idCounts[p.participantId]} duplicate records of "${p.participantId}" — none attached. Separate the sessions into distinct data dirs (or ids) to view their replays.`] });
      p.replay = null;
      continue;
    }
    // Latest-session pick tolerates non-ISO start times in third-party
    // artifacts: the recording's own start field (per version, see ownField)
    // as an ISO string → a numeric epoch → the filename's own epoch. For a
    // CH artifact the filename epoch is DERIVED from the same field
    // (persistence.js), so the fallback agrees rather than guesses — but a
    // producer that names files differently would have been ordered by
    // whatever its filename happened to contain.
    const sessionEpoch = (cand) => {
      const v = ownField(cand.recording, 'start_time');
      const n = typeof v === 'number' ? v : Date.parse(v);
      if (Number.isFinite(n)) return n;
      const m = cand.file.match(/-replay-(\d+)\.json/i);
      return m ? Number(m[1]) : 0;
    };
    owned.sort((a, b) => sessionEpoch(a) - sessionEpoch(b));
    const chosen = owned[owned.length - 1];
    // (T5 Task 10) The targeted version is 2: the viewer is v2-only and a v1
    // artifact is skipped with a note when the report is built
    // (replay-assets.js). Warning "this CLI targets 1" was the previous
    // era's sentence and is now exactly backwards. Attach either way —
    // ingest never drops participant data on a version judgement.
    if (chosen.recording.schema_version !== 2) {
      warnings.push({ file: join(dir, chosen.file),
        warnings: [`Replay schema_version ${chosen.recording.schema_version} (this CLI targets 2) — attaching anyway; the viewer plays v2 only and will report this artifact as unloadable.`] });
    }
    p.replay = { recording: chosen.recording, file: chosen.file, meta };
  }
}

// Load-bearing re-exports:
//   - getByPath: html-index.js (and external adopters) import it from ingest.js.
//   - extractIntegrityData, ruleChronologicalCompare: moved to extract-core.js
//     (0.7.2 extraction — pure/no Node APIs so a browser demo can bundle it);
//     this file re-exports both for existing callers — trajectories.js imports
//     ruleChronologicalCompare from here, and tests/cli/*.test.js import
//     extractIntegrityData from here.
export { getByPath };
export { extractIntegrityData, ruleChronologicalCompare };

// Finds files matching a glob pattern in the given directory.
// Supports:
//   - `*.json`         (default, broadened to also match `*.csv`)
//   - `*.csv`          (CSV-only)
//   - `*.{json,csv}`   (explicit brace expansion)
//   - `gallery_*.json` (other simple wildcard patterns)
//
// The default `*.json` is broadened to JSON-or-CSV because jsPsych's `.csv()`
// save is the most common shape we'll see in the wild; users on JSON pipelines
// are unaffected.
function findFiles(dir, pattern) {
  const matchers = expandPatternToMatchers(pattern);
  const files = readdirSync(dir).filter(f => matchers.some(m => m.test(f)));
  return files.map(f => join(dir, f)).sort();
}

// Turns a single user-facing pattern into one or more anchored RegExp matchers.
// Brace expansion is the only "fancy" feature supported; everything else is the
// classic wildcard-to-regex conversion.
function expandPatternToMatchers(pattern) {
  // Default broadens to JSON + CSV.
  if (pattern === '*.json') return [/\.json$/i, /\.csv$/i];
  // Brace pattern: *.{json,csv} → expand to ['*.json', '*.csv'].
  const brace = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (brace) {
    const [, prefix, alts, suffix] = brace;
    return alts.split(',').map(a => globToRegex(prefix + a.trim() + suffix));
  }
  return [globToRegex(pattern)];
}

function globToRegex(pat) {
  // Convert glob pattern to anchored regex: * → .*, escape dots.
  return new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
}

// Parses jsPsych CSV output into a Shape-1 raw object that extractIntegrityData
// already understands: `{ [pidField]: ..., trials: [...rows...] }`.
//
// jsPsych saves CSV via Papa Parse's `unparse()`. Nested objects/arrays in trial
// data (e.g., the `integrity` field returned by the extension's on_finish, or
// the `integritySession` and `integrityScore` blobs attached to the last trial
// via addDataToLastTrial) get JSON-stringified into single cells. We reverse
// that here: any cell whose string value starts with `{` or `[` is run through
// JSON.parse, restoring the nested structure for downstream analyzers.
//
// Participant ID is hoisted from the first row to the top level so the Shape-1
// branch in extractIntegrityData picks it up via raw[pidField].
function parseCsvToRaw(text, config) {
  const pidField = config.participantIdField || 'participantId';
  // Papa Parse mis-handles a trailing newline on the final cell of the last
  // row (treats it as an unterminated quoted field). POSIX convention is to
  // end text files with a newline, so almost every CSV from the wild has one.
  // Trim trailing whitespace defensively.
  const result = Papa.parse(text.replace(/\s+$/, ''), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,  // numbers and booleans parsed natively, strings stay strings
  });
  const rows = result.data || [];

  // Walk every cell; if it looks like JSON, parse it. Leave non-JSON strings alone.
  for (const row of rows) {
    for (const [key, val] of Object.entries(row)) {
      if (typeof val !== 'string') continue;
      const trimmed = val.trim();
      if (trimmed.length === 0) continue;
      const first = trimmed[0];
      if (first !== '{' && first !== '[') continue;
      try {
        row[key] = JSON.parse(trimmed);
      } catch {
        // Cell looked like JSON but didn't parse — leave the raw string.
        // This is rare (e.g., a free-text response that happens to start with `{`)
        // and downstream code can handle string values gracefully.
      }
    }
  }

  // Hoist participant ID from the first row to the top level so Shape-1 ingest
  // finds it via raw[pidField]. Falls back to 'unknown' if the column isn't there.
  // getByPath supports dotted paths into JSON-parsed cells (e.g. a "metadata"
  // column that held a stringified object); Shape-1's flat-key-first lookup
  // then finds the hoisted value under the same (possibly dotted) key name.
  const participantId = getByPath(rows[0], pidField) ?? 'unknown';

  return {
    [pidField]: participantId,
    trials: rows,
  };
}
