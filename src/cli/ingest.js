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
import { join, extname, resolve } from 'path';
import { gunzipSync } from 'zlib';
import Papa from 'papaparse';
import { sanitizeId } from '../shared/constants.js';
import { getByPath } from '../shared/paths.js';
import { extractIntegrityData, ruleChronologicalCompare } from './extract-core.js';
// Spec §14 makes conversion the migration path for jsPsych-v1 recordings
// (players are v2-only, there is no dual-read), so the converter is a runtime
// dependency of the CLI rather than a developer tool. package.json's `files`
// list ships this one path for that reason, pinned by a test in
// tests/cli/replay-ingest.test.js. `convertRecording` is pure and imports
// nothing outside node: builtins; the tool's own CLI half (which reaches into
// tests/ for the strict validator) is never loaded by importing it.
import { convertRecording } from '../../tools/convert/jspsych-v1-to-v2.mjs';
import { detectGzip, validateStrict } from '../shared/schema-v2-validator.js';

// Replay artifacts saved by the replay extension:
//   <sanitizedPid>-replay-<sessionStartEpochMs>.json[.gz]
// They sit in dataDir (or replayDir) next to the participant files and must
// never enter the participant-file pass. Files from OTHER producers carry
// whatever name their tool chose and are found by content instead (A3, see
// the foreign-artifact pass in attachReplayArtifacts).
const REPLAY_FILE_RE = /-replay-\d+\.json(\.gz)?$/i;

// A recording is JSON on the wire (spec §2); `.gz` is CH's own transport
// compression. Everything else in a data directory (CSV above all) is skipped
// before it is ever read as a recording candidate.
const ARTIFACT_EXT_RE = /\.json(\.gz)?$/i;

// The filename route's claim for one participant. ANCHORED: a bare prefix
// would let participant "a" swallow "a-replay-replay-<epoch>.json", which
// belongs to participant "a-replay". Case-tolerant for discovery; ownership
// is verified against the embedded participant_id at attach time.
function participantArtifactRe(sanePid) {
  const escaped = sanePid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-replay-\\d+\\.json(\\.gz)?$`, 'i');
}

// Content sniff: which producer's vocabulary an artifact speaks, or null when
// the object is not a session recording at all. Three shapes qualify:
//   - 'v2'         SessionRecording v2 (spec r2, ANY producer): schema_version
//                  2 with a `recorder` identity and a `segments` array. Same
//                  three keys the §11 tolerant loader identifies a recording
//                  by (viewer-model.js), so the sniff and the loader cannot
//                  disagree about what a recording is.
//   - 'ch'         the CH v1 era: our own `metadata.recorder` stamp.
//   - 'jspsych-v1' a #3661-shaped `trials` array from jsPsych's recorder.
//
// THE ARM ORDER IS LOAD-BEARING. A CH v1 recording also carries a `trials`
// array whose entries have `events` and `initial_dom`, so it matches the
// jsPsych arm too. Reading the CH stamp first is what keeps CH v1 out of the
// jsPsych converter, which would refuse it — spec §14 gives CH v1 a different
// migration path, and A6's decision makes that path "regenerate the demo
// assets", not "convert" (stray old files stay playable at the 0.7.x tag).
function artifactKind(j) {
  if (!j || typeof j !== 'object' || !('schema_version' in j)) return null;
  if (j.schema_version === 2 && !!j.recorder && typeof j.recorder.name === 'string' &&
      Array.isArray(j.segments)) return 'v2';
  if (String(j.metadata?.recorder || '').startsWith('cyborg-hunter-replay')) return 'ch';
  // jsPsych v1 is identified by VERSION + shape, not by every trial being
  // well-formed: the converter owns trial validation and refuses with a remedy
  // sentence, and a shape-based sniff sent malformed files past it in silence
  // (A3 review, finding 2). An empty `trials` array is a recording too.
  if (j.schema_version === 1 && Array.isArray(j.trials)) return 'jspsych-v1';
  return null;
}

// Reads one file as a recording candidate: { json } or { error }.
// Gzip is decompressed HERE, not only at attach time: reading the compressed
// bytes as utf8 and JSON.parsing them made every readable `.json.gz` artifact
// announce itself as a truncated upload (T5 Task 10 review M-4).
function readArtifactJson(path) {
  let text;
  try {
    const buf = readFileSync(path);
    // Suffix OR magic bytes (RFC 1952): a gzip export renamed to `.json` is
    // still gzip, and decoding it as UTF-8 announced a truncated upload that
    // did not exist (A3 review, finding 4).
    const gz = /\.gz$/i.test(path) || detectGzip(buf);
    text = gz ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  } catch (e) {
    return { error: e.message };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (e) {
    return { error: e.message };
  }
}

// jsPsych-v1 recordings ingest BY CONVERSION (spec §14; the players are
// v2-only and there is no dual-read, so this tool is the only door — and
// ingest is where an analyst walks through it without needing to know it
// exists). Everything else passes through untouched.
//
// IN MEMORY, NEVER TO DISK. Ingest reads the analyst's data directory and
// writes nothing into it; a converted sibling would also be picked up by the
// NEXT run as a second artifact for the same participant, and it would rewrite
// fixtures other tasks own (the committed demo trio is v1 and A6 regenerates
// it). Provenance survives anyway: the converter stamps
// `extensions["cyborg-hunter"].converter` with its version and the canonical
// `source_sha256` of the input, and the source file stays byte-identical on
// disk, so file + hash + tool version reproduce the conversion exactly.
//
// Returns { recording, converted? } or { refusal }. The converter refuses
// rather than defaulting a missing field or renumbering a trial, and those
// refusals ARE its contract, so its message travels intact to the analyst.
// `convert` is injectable for tests only (the converter never throws a plain
// exception on any input we could construct, so the catch below can't be
// exercised through a file); production always uses convertRecording.
export function migrateArtifact(json, kind, convert = convertRecording) {
  if (kind !== 'jspsych-v1') return { recording: json };
  try {
    const recording = convert(json);
    // A2 (spec §11): the in-memory conversion is strict-validated like the
    // converter CLI validates its file output — but a failure WARNS and still
    // attaches. Refusing here would lose a participant's replay to a defect the
    // viewer's tolerant profile absorbs (e.g. `stylesheets: {}` → played
    // unstyled); before this, that absorption was silent (finding 6).
    const verdict = validateStrict(recording);
    return { recording, converted: true, strictErrors: verdict.ok ? null : verdict.errors };
  } catch (e) {
    // Only the converter's declared refusals (`.reasons`) are about the FILE.
    // Anything else is the converter failing, and blaming participant data
    // for it hid the stack from whoever has to fix the converter (finding 7).
    if (Array.isArray(e.reasons)) return { refusal: e.reasons.join('; ') };
    return { internal: e.stack || e.message };
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

  // Session recordings are excluded from the participant pass by CONTENT, not
  // by name (A3): v2 is producer-agnostic, so a conforming artifact can arrive
  // called `session.json` or anything else, and putting one through the
  // participant extractor produced a phantom "unknown" participant plus two
  // junk warnings. Files matching CH's own naming keep their extra guarantee —
  // a participant export that happens to be named like an artifact is rescued
  // with a rename hint rather than silently dropped.
  const files = [];
  for (const file of allFiles) {
    if (!ARTIFACT_EXT_RE.test(file)) { files.push(file); continue; }   // e.g. CSV
    const named = REPLAY_FILE_RE.test(file);
    const read = readArtifactJson(file);
    if (read.error) {
      // Only a replay-NAMED file is claimed here. Never let one vanish
      // silently: if its pid maps to a discovered participant the attach pass
      // warns again with more context, but an orphan (no matching participant)
      // would otherwise disappear without a trace. Anything else that fails to
      // parse belongs to the participant pass, which reports its own failure.
      if (named) {
        warnings.push({ file,
          warnings: ['Replay-named file could not be parsed (truncated upload or a misnamed participant export?) — skipped from the participant pass; if a matching participant exists, the replay pass reports it too.'] });
        continue;
      }
    } else if (artifactKind(read.json) !== null) {
      continue;                       // a session recording is never participant data
    } else if (named) {
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

  attachReplayArtifacts(participants, config, warnings, allFiles);

  return { participants, warnings };
}

// Finds and attaches each participant's replay artifact (if any) as
// `participant.replay`:
//   { recording, file, meta }            — parsed and attached
//   { error: 'parse_failed', reason }    — artifact exists but unreadable
//   null                                 — no artifact (silent unless meta
//                                          says one went to 'download')
// `participantPassFiles`: what findFiles handed the participant pass, so the
// foreign scan knows which unreadable files already reported themselves there.
function attachReplayArtifacts(participants, config, warnings, participantPassFiles = []) {
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

  // ── Discovery, second route: artifacts named by their own producer ───────
  // CH's recorder writes `<sanitizedPid>-replay-<epoch>.json[.gz]`
  // (persistence.js), which is what the per-participant filename match below
  // is built from. A v2 recording from anywhere else — jsPsych's recorder, a
  // browser download, a hand-copied `session.json` — carries a name CH cannot
  // read anything out of, so it is found by CONTENT here and attached by
  // IDENTITY ONLY: its embedded participant_id must name a participant in this
  // dataset. No filename fallback exists for these and none is invented, which
  // is what keeps Task 10's ownership defense whole for foreign producers.
  //
  // The scan keeps the NAME and the embedded id, never the recording: holding
  // every foreign artifact parsed at once would put a cohort's worth of
  // dom-tier recordings in memory simultaneously, where the filename route
  // holds one at a time. The matching files are loaded below, through the same
  // code path CH-named artifacts take, so there is one loading reading.
  const embeddedId = (rec) => {
    const v = ownField(rec, 'participant_id');
    return v == null ? null : String(v);
  };
  // Files the filename route will claim: `<sanitizedPid>-replay-<epoch>` for
  // a pid in THIS dataset. Anything else — including a foreign artifact whose
  // name merely LOOKS like CH's pattern (`download-replay-<epoch>.json`) — is
  // scanned by content. Excluding by REPLAY_FILE_RE alone let such a file
  // fall between both routes with no warning (A3 review, finding 1).
  const claimedByName = new Set();
  for (const p of participants) {
    const re = participantArtifactRe(sanitize(p.participantId));
    for (const f of entries) if (re.test(f)) claimedByName.add(f);
  }
  // Which unreadable files are ours to report: everything in an explicit
  // replayDir (nothing else lives there), plus anything in dataDir the
  // participant pass never saw (e.g. `session.json.gz` under a `*.json`
  // pattern). A file the participant pass DID read reports its own failure
  // there (finding 3).
  const seenByParticipantPass = new Set(participantPassFiles.map(f => resolve(f)));
  const foreign = [];
  for (const f of entries) {
    if (claimedByName.has(f)) continue;            // the filename route owns these
    if (!ARTIFACT_EXT_RE.test(f)) continue;
    const full = join(dir, f);
    const read = readArtifactJson(full);
    if (read.error) {
      if (config.replayDir || !seenByParticipantPass.has(resolve(full))) {
        warnings.push({ file: full,
          warnings: [`Replay candidate ${f} could not be read: ${read.error} — skipped; if it is a session recording, the participant it belongs to has no replay.`] });
      }
      continue;
    }
    const kind = artifactKind(read.json);
    if (kind === null) continue;
    foreign.push({ file: f, kind, id: embeddedId(read.json) });
  }
  const claimed = new Set();

  for (const p of participants) {
    // Same sanitization the browser-side filename builder applies. The
    // match is ANCHORED (^<sane>-replay-<digits>.json$): a bare prefix
    // would let participant "a" swallow "a-replay-replay-<epoch>.json",
    // which belongs to participant "a-replay".
    const sane = sanitize(p.participantId);
    const exactRe = participantArtifactRe(sane);
    const mine = entries.filter(f => exactRe.test(f));
    // Foreign-named artifacts that named THIS participant inside themselves.
    const mineForeign = foreign.filter(a => a.id !== null && a.id === String(p.participantId));
    // The meta pointer rides on every trial row via addProperties.
    const meta = (p.trials && p.trials[0] && p.trials[0].integrityReplayMeta) || null;
    // Replay finalize failures ride the same way — surface them where the
    // analyst looks (they mean the artifact was probably never saved).
    const finErr = p.trials && p.trials[0] && p.trials[0].replayFinalizeError;
    if (finErr) {
      warnings.push({ file: dir,
        warnings: [`Replay finalize failed for ${p.participantId}: ${finErr} — the artifact was likely never saved.`] });
    }

    if (mine.length === 0 && mineForeign.length === 0) {
      p.replay = null;
      if (meta && meta.saved_to === 'download') {
        warnings.push({
          file: dir,
          warnings: [`Replay artifact for ${p.participantId} was downloaded to the participant's machine (autoSave mode "download") and is not recoverable from here — check the autosave configuration for future runs.`]
        });
      }
      continue;
    }

    // ONE loading path for both discovery routes: read, sniff, migrate.
    const parsed = [];
    for (const a of mineForeign) claimed.add(a.file);
    for (const f of [...mine, ...mineForeign.map(a => a.file)]) {
      const read = readArtifactJson(join(dir, f));
      if (read.error) { parsed.push({ file: f, reason: read.error }); continue; }
      // Same structural sniff as the participant pass: a misnamed
      // participant export was rescued as participant data there and
      // must not double as its own "replay" here.
      const kind = artifactKind(read.json);
      if (kind === null) continue;
      parsed.push({ file: f, ...migrateArtifact(read.json, kind) });
    }
    if (parsed.length === 0) {
      p.replay = null;
      continue;
    }

    // Every unreadable artifact warns individually — a corrupt NEWEST
    // session must never be silently masked by an older readable one.
    for (const bad of parsed.filter(x => x.reason)) {
      warnings.push({ file: join(dir, bad.file),
        warnings: [`Replay artifact ${bad.file} unreadable: ${bad.reason} — if this is the newest session, its replay is lost.`] });
    }
    // A refused conversion is NOT a corruption: the file read fine and the
    // migration is what stopped. It carries the converter's own sentences
    // because they are the ones naming the remedy.
    for (const bad of parsed.filter(x => x.refusal)) {
      warnings.push({ file: join(dir, bad.file),
        warnings: [`Replay artifact ${bad.file} is a jsPsych v1 recording that could not be converted to v2: ${bad.refusal} — not playable in this report; the file on disk is unchanged.`] });
    }
    for (const bad of parsed.filter(x => x.internal)) {
      warnings.push({ file: join(dir, bad.file),
        warnings: [`Replay artifact ${bad.file}: internal conversion failure (a converter bug, not a data problem — please report it): ${bad.internal}`] });
    }
    for (const soft of parsed.filter(x => x.strictErrors)) {
      warnings.push({ file: join(dir, soft.file),
        warnings: [`Replay artifact ${soft.file} converted from jsPsych v1 but fails schema-v2 strict validation (${soft.strictErrors.length}): ${soft.strictErrors.join('; ')} — attached anyway (spec §11 tolerant load); the viewer applies documented defaults, so what is malformed here is what will look wrong there.`] });
    }
    const readable = parsed.filter(x => x.recording);
    if (readable.length === 0) {
      // A refusal outranks a parse failure when both are present: it is the
      // more specific diagnosis, and "corrupted" would send the analyst
      // hunting a truncated upload that does not exist.
      const refused = parsed.find(x => x.refusal) || parsed.find(x => x.internal);
      p.replay = refused
        ? { error: 'unloadable', reason: refused.refusal || refused.internal, file: refused.file }
        : { error: 'parse_failed', reason: parsed[0].reason, file: parsed[0].file };
      continue;
    }
    if (parsed.length > 1) {
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
    // (persistence.js), so the fallback agrees rather than guesses. A
    // producer-named artifact has no epoch in its name to fall back TO, so one
    // whose start field is unreadable sorts oldest — which is the conservative
    // direction: it can lose to a dated sibling, never beat one.
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
    // A converted recording is a DERIVED artifact: what plays in the report is
    // something ingest built, not the bytes the recorder wrote. Say so once,
    // with the link that reproduces it — the source is untouched on disk and
    // the stamp carries the canonical hash of its content.
    if (chosen.converted) {
      const prov = chosen.recording.extensions['cyborg-hunter'].converter;
      warnings.push({ file: join(dir, chosen.file),
        warnings: [`Replay artifact ${chosen.file} is a jsPsych v1 recording, converted to SessionRecording v2 in memory for this report (${prov.tool} ${prov.version}, source_sha256 ${prov.source_sha256}) — spec §14 makes conversion the migration path and the viewer plays v2 only. The file on disk is unchanged; \`node tools/convert/${prov.tool}.mjs ${chosen.file}\` reproduces the conversion.`] });
    }
    // `converted` rides along so report surfaces (and tests) can tell a
    // converted jsPsych recording from a native one.
    p.replay = { recording: chosen.recording, file: chosen.file, meta, converted: !!chosen.converted };
  }

  // A recording found by CONTENT that attached to nobody must not vanish
  // silently: unlike a CH-named artifact, its filename gives an analyst
  // nothing to notice its absence by. Suppressed under --participant, where
  // every other participant's artifact is out of scope by construction and
  // would otherwise warn on every single-participant run.
  if (!config.singleParticipant) {
    for (const a of foreign) {
      if (claimed.has(a.file)) continue;
      let why;
      if (a.id !== null) {
        why = `was recorded for "${a.id}", which matches no participant in this dataset — not attached.`;
      } else if (a.kind === 'jspsych-v1') {
        // Worth naming the format: jsPsych v1 records no participant_id at
        // all, so renaming is the ONLY way to attach one, and an analyst who
        // does rename it gets the conversion for free.
        why = 'is a jsPsych v1 session recording, and the v1 format carries no participant_id — ' +
          'with a filename outside the <participantId>-replay-<epoch>.json convention there is nothing ' +
          'to identify its owner, so it is not attached. Rename it after the participant; ingest ' +
          'converts it to v2 on the way in.';
      } else {
        why = 'carries no participant_id, and its name does not follow the ' +
          '<participantId>-replay-<epoch>.json convention — nothing identifies its owner, so it is ' +
          'not attached. Rename it after the participant to attach it.';
      }
      warnings.push({ file: join(dir, a.file), warnings: [`Replay artifact ${a.file} ${why}`] });
    }
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
