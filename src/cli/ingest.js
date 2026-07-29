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
import { TRIAL_REPORT_FIELDS } from '../shared/schema.js';
import { sanitizeId } from '../shared/constants.js';
import { getByPath } from '../shared/paths.js';

// Replay artifacts saved by the replay extension:
//   <sanitizedPid>-replay-<sessionStartEpochMs>.json[.gz]
// They sit in dataDir (or replayDir) next to the participant files and must
// never enter the participant-file pass.
const REPLAY_FILE_RE = /-replay-\d+\.json(\.gz)?$/i;

// Content sniff: replay artifacts (ours or #3661's) are identified by
// structure, not just filename — schema_version plus either our recorder
// stamp or a #3661-shaped trials array.
function looksLikeReplayArtifact(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && 'schema_version' in j &&
      (String(j.metadata?.recorder || '').startsWith('cyborg-hunter-replay') ||
        (Array.isArray(j.trials) && j.trials.length > 0 &&
          j.trials.every(t => t && 'events' in t && 'initial_dom' in t)));
  } catch (e) {
    return true;   // unparseable + replay-named → let the replay pass report it
  }
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
      const embedded = cand.recording.metadata?.participant_id;
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
    // Latest-session pick tolerates non-ISO start_time in third-party
    // artifacts: ISO string → numeric epoch → the filename's own epoch.
    const sessionEpoch = (cand) => {
      const v = cand.recording.metadata?.start_time;
      const n = typeof v === 'number' ? v : Date.parse(v);
      if (Number.isFinite(n)) return n;
      const m = cand.file.match(/-replay-(\d+)\.json/i);
      return m ? Number(m[1]) : 0;
    };
    owned.sort((a, b) => sessionEpoch(a) - sessionEpoch(b));
    const chosen = owned[owned.length - 1];
    if (chosen.recording.schema_version !== 1) {
      warnings.push({ file: join(dir, chosen.file),
        warnings: [`Replay schema_version ${chosen.recording.schema_version} (this CLI targets 1) — attaching anyway; the viewer may degrade.`] });
    }
    p.replay = { recording: chosen.recording, file: chosen.file, meta };
  }
}

// Load-bearing re-export: html-index.js (and external adopters) import getByPath from ingest.js.
export { getByPath };

// Extracts integrity trial data from a single participant's raw JSON.
// Returns { participantId, trials, warnings, metadata }.
export function extractIntegrityData(raw, config) {
  const warnings = [];
  const pidField = config.participantIdField || 'participantId';
  const intField = config.integrityField || 'integrity';

  // Determine participant ID — check top level, then metadata sub-object.
  // Since 0.6.1 the field supports dot-paths ("metadata.sessionId"); plain
  // names keep the historical top-level → metadata fallback. `||` (not `??`)
  // preserves the pre-0.6.1 treatment of empty-string IDs as missing.
  const participantId = getByPath(raw, pidField) || getByPath(raw.metadata, pidField) || 'unknown';
  // An id field that resolves to nothing yields 'unknown'. Silently, that both
  // loses the real id AND collides every such file under one 'unknown' bucket
  // downstream (see the duplicate-id check in ingest()). Warn so a mistyped
  // participantIdField is visible instead of producing an all-'unknown' cohort.
  if (participantId === 'unknown') {
    warnings.push(
      `participantId unresolved (field "${pidField}" not found at top level or in ` +
      `metadata) — defaulted to "unknown". Check participantIdField.`
    );
  }

  let trials = [];

  // Shape 1: { trials: [{ integrity: {...} }, ...] } — jsPsych extension data.
  // Each trial has an `integrity` sub-object added by CyborgHunter.endTrial().
  // We merge the trial's own fields (ruleId, timestamp, rt, rulePosition, etc.)
  // with the integrity sub-object's fields (tabAwayEvents, copyEvents, etc.).
  // On a key collision the integrity sub-object wins, since it's the more
  // authoritative source for those fields. This preserves both the renderer-
  // needed experiment metadata AND the cyborg-hunter signal data on the same
  // trial object.
  if (Array.isArray(raw.trials)) {
    trials = raw.trials
      .filter(t => t && t[intField])
      .map(t => ({ ...t, ...t[intField] }));
    // jsPsych extension data carries trialStart_perfNow per trial (set by the
    // wrapper's on_load), so normalization takes the exact-subtraction fast
    // path. Without it, renderers see only session-absolute `start` values
    // and plot tab-away markers far off the per-trial axis.
    normalizeTabAwayTimestamps(trials, raw);
  }

  // Phase-trial extension: per-phase integrity reports for
  // gallery / post-gallery-query / end-requery phases live on raw.phaseTrials,
  // mirroring the per-classification-trial shape so the renderer can place
  // gallery mouse trajectories and tab-away events on the same axes.
  //
  // After merging, sort by (rulePosition, phase-rank, trialNumber) so the
  // trajectories grid shows trials in the chronological order each rule was
  // actually experienced: gallery → post-gallery query → classification t1..t6.
  // End-requery trials carry rulePosition=null and sort to the very end of
  // the array, matching their session-end timing.
  if (Array.isArray(raw.phaseTrials) && raw.phaseTrials.length > 0) {
    const phaseTrials = raw.phaseTrials
      .filter(t => t && t[intField])
      .map(t => ({ ...t, ...t[intField] }));
    normalizeTabAwayTimestamps(phaseTrials, raw);
    trials = trials.concat(phaseTrials);
    trials.sort(ruleChronologicalCompare);
  }

  // Shapes 2 and 3 are ALTERNATIVE top-level layouts, tried only when the
  // Shape-1 trials/phaseTrials path produced nothing. Previously the Shape-2
  // branch was chained as `else if` off the phaseTrials `if`, so a payload
  // carrying both `trials` (real integrity) and `responses` — or even a stray
  // empty `responses: []` — had its already-extracted integrity trials clobbered
  // (or the participant silently dropped). Gate on trials.length so Shape-1 wins.
  if (trials.length === 0) {
    // Shape 2: { responses: [{ mouseTrack, tabAwayEvents, ... }] } (legacy).
    // Signal data lives directly on the response — no integrity wrapper. We apply
    // field name mapping (mouseTrack → mouseEvents).
    if (Array.isArray(raw.responses)) {
      trials = raw.responses.map((r, i) => mapLegacyFields({
        ...r,
        _sourceIndex: i
      }));
      // Normalize tab-away timestamps from session-relative performance.now()
      // to trial-relative milliseconds so renderers can plot them on the
      // same x-axis as mouseEvents[].t (which is already trial-relative).
      normalizeTabAwayTimestamps(trials, raw);
    }
    // Shape 3: Top-level array of trials. Same merge contract as Shape 1:
    // outer trial fields survive, integrity wins on collision, and tab-away
    // timestamps get normalized. The spread builds OUR copy, so the
    // array-field coercion below mutates that copy — never a caller-owned or
    // frozen object (a frozen one would throw instead of coercing). The
    // outer-merge also keeps replay pointers (integrityReplayMeta /
    // replayFinalizeError ride the outer trial rows) visible to
    // attachReplayArtifacts.
    else if (Array.isArray(raw)) {
      trials = raw.filter(t => t && t[intField]).map(t => ({ ...t, ...t[intField] }));
      normalizeTabAwayTimestamps(trials, raw);
    }
  }

  if (trials.length === 0) {
    warnings.push(`No integrity data found (looked for "${intField}" field)`);
  }

  // Validate each trial has the minimum required fields from the schema.
  // Missing fields get a warning but don't prevent analysis. Array-typed signal
  // fields that arrive as a non-array (e.g. a hand-edited `pasteEvents: {}`) are
  // coerced to [] — otherwise a downstream `for (const e of trial.pasteEvents)`
  // throws "not iterable" and, because report.js has no per-renderer boundary,
  // one malformed file aborts the ENTIRE report. Coercing here keeps the run
  // alive and localizes the damage to a warning on that trial.
  for (const trial of trials) {
    const missing = [];
    for (const [field, spec] of Object.entries(TRIAL_REPORT_FIELDS)) {
      if (spec.required && trial[field] === undefined) {
        missing.push(field);
      }
      if (spec.type === 'array' && trial[field] != null && !Array.isArray(trial[field])) {
        warnings.push(
          `Trial ${trial.trialId ?? '?'}: field "${field}" is not an array ` +
          `(got ${typeof trial[field]}) — coerced to [] to keep analysis running.`
        );
        trial[field] = [];
      }
    }
    if (missing.length > 0) {
      warnings.push(`Trial ${trial.trialId || '?'}: missing fields: ${missing.join(', ')}`);
    }
  }

  const { session, score } = findSessionData(raw, config);
  if (session === null && trials.length > 0) {
    warnings.push('No session-level integrity data — some signals unavailable (did the experiment call getSessionReport()?)');
  }

  // The jsPsych adapter drops a `cyborgHunterFinalizeError` marker (via
  // addProperties) when finalize() throws, so analysts can tell a missing-session
  // run apart from a genuine finalize() failure. Surface it as a warning instead
  // of leaving it dead in the data behind a generic "no session data" message.
  const finalizeError = raw.cyborgHunterFinalizeError
    ?? raw.metadata?.cyborgHunterFinalizeError
    ?? (Array.isArray(raw.trials)
        ? raw.trials.find(t => t?.cyborgHunterFinalizeError)?.cyborgHunterFinalizeError
        : undefined);
  if (finalizeError) {
    warnings.push(`finalize() failed for this participant (cyborgHunterFinalizeError): ${finalizeError} — session data may be incomplete`);
  }

  return {
    participantId,
    trials,
    warnings,
    metadata: raw.metadata || {},
    session,
    score,
    // Surface a few top-level payload fields that some renderers need but
    // that aren't part of the session-level integrity object. Keeping the
    // list explicit (rather than exposing `raw` wholesale) avoids future
    // renderers silently coupling to payload internals.
    galleryStudyMs: Array.isArray(raw.galleryStudyMs) ? raw.galleryStudyMs : null,
    postGalleryGuesses: Array.isArray(raw.postGalleryGuesses) ? raw.postGalleryGuesses : null,
    // App-written top-level guardFriction wins; otherwise synthesize the guard
    // lane from the honeypot's session violation log (which the shipped guard
    // extensions actually emit) so the timeline renders for library-only data.
    guardFriction: raw.guardFriction ?? (() => {
      const v = findGuardViolations(raw);
      return v ? { violations: v } : null;
    })(),
    // Guard-honeypot self-disclosure (visible bait). null when the honeypot
    // extension was not used.
    honeypot: findHoneypotDisclosure(raw),
  };
}

// True when obj plausibly IS a getSessionReport() output — i.e. it carries at
// least one of the well-known top-level session-report keys (see
// src/core/monitor.js sessionData / getSessionReport()). Guards the
// analyst-supplied sessionIntegrityPath below: `typeof === 'object'` alone
// accepts any object the path happens to resolve to, including a near-miss
// wrapper one level up the tree (e.g. `metadata` instead of
// `metadata.integritySession`), which would otherwise silently zero out every
// downstream signal instead of falling through.
function looksLikeSessionData(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return ['tabAwaySums', 'hardScore', 'softScore', 'anyHardTriggered', 'trialsCompleted']
    .some(key => Object.prototype.hasOwnProperty.call(obj, key));
}

// Locates session-level integrity data. An analyst-supplied dotted path
// (config.sessionIntegrityPath, 0.6.1) is checked first; then the built-in
// conventions, in priority order:
//   1. raw.metadata.integritySession / integrityScore — the metadata convention.
//   2. Last trial's integritySession / integrityScore — jsPsych addDataToLastTrial (Option A).
//   3. Any trial's integritySession — fallback (Option B).
//   4. raw.cyborgHunter — native top-level location used by raw-DOM
//      adopters before they adopt the
//      metadata.integritySession mirror. Added 2026-05-26.
// Returns { session, score }, both null if not found.
function findSessionData(raw, config) {
  let session = null;
  let score = null;

  // 0. Analyst-specified location, e.g. "payload.cyborgHunter" for pipelines
  //    that nest the getSessionReport() output somewhere non-standard. Falls
  //    through to the built-in conventions when the path resolves to nothing
  //    OR to something that doesn't look like a session report (looksLikeSessionData,
  //    0.6.1 — a malformed/near-miss path used to be accepted on typeof alone),
  //    so a partially-migrated cohort still ingests. The score is synthesized
  //    from the session object below (getSessionReport() embeds it).
  const customSession = config?.sessionIntegrityPath
    ? getByPath(raw, config.sessionIntegrityPath) : null;
  if (looksLikeSessionData(customSession)) {
    session = customSession;
  }
  // 1. metadata convention
  else if (raw.metadata?.integritySession) {
    session = raw.metadata.integritySession;
    score = raw.metadata.integrityScore || null;
  }
  // 2. jsPsych addDataToLastTrial convention (Option A)
  else if (Array.isArray(raw.trials) && raw.trials.length > 0 &&
           raw.trials[raw.trials.length - 1]?.integritySession) {
    const last = raw.trials[raw.trials.length - 1];
    session = last.integritySession;
    score = last.integrityScore || null;
  }
  // 3. Any-trial fallback
  else if (Array.isArray(raw.trials) && raw.trials.find(x => x?.integritySession)) {
    const t = raw.trials.find(x => x?.integritySession);
    session = t.integritySession;
    score = t.integrityScore || null;
  }
  // 4. Native top-level location. An early raw-DOM adopter app
  //    writes the getSessionReport() output directly to `raw.cyborgHunter`.
  //    Sessions saved before the metadata.integritySession mirror landed
  //    (2026-05-24) have ONLY this top-level field. Without
  //    this fallback, the renderer can't find windowPositions and falls back
  //    to stale top-level metadata.windowWidth — visible as a misaligned
  //    "browser window" dashed rectangle in the trajectory PNGs.
  else if (raw.cyborgHunter && typeof raw.cyborgHunter === 'object') {
    session = raw.cyborgHunter;
    score = null;
  }

  // When no separate integrityScore blob was saved, synthesize the authoritative
  // score from the session object itself. getSessionReport() embeds the scoring
  // summary (hardScore/softScore/anyHardTriggered/softScoreThreshold/
  // trialsCompleted) directly in the session report, so integritySession-only
  // and raw.cyborgHunter payloads already carry it. Without this, summary.js
  // falls back to a per-trial `trialHits > 0` rule that OVERSTATES hard flags
  // (any single hit flags hard, ignoring the count threshold).
  if (!score && session) score = scoreFromSession(session);

  return { session, score };
}

// Builds a { hardScore, softScore, anyHardTriggered, softScoreThreshold,
// trialsCompleted } score object from a session report that embeds those
// fields. Returns null if the session carries no scoring fields at all.
function scoreFromSession(session) {
  if (!session || typeof session !== 'object') return null;
  const hasScore = session.softScore !== undefined
    || session.anyHardTriggered !== undefined
    || session.hardScore !== undefined;
  if (!hasScore) return null;
  // Derive anyHardTriggered from hardScore when the boolean is absent (some
  // session payloads carry the per-signal hardScore map but not the rolled-up
  // flag). Without this, summary.js would fall back to its per-trial trialHits>0
  // rule, which overstates hard flags.
  let anyHardTriggered = session.anyHardTriggered;
  if (anyHardTriggered === undefined && session.hardScore && typeof session.hardScore === 'object') {
    anyHardTriggered = Object.values(session.hardScore).some(s => s && s.triggered);
  }
  return {
    hardScore: session.hardScore,
    softScore: session.softScore,
    anyHardTriggered,
    softScoreThreshold: session.softScoreThreshold,
    trialsCompleted: session.trialsCompleted,
  };
}

// Normalizes guard-honeypot violation evidence into the { violations: [...] }
// shape the session-timeline renderer expects under `guardFriction`. The
// honeypot extension writes the friction violation log (it subscribes to
// guard-friction.onViolation) as a STRINGIFIED `guard_assistance_violations_session`
// field via addProperties, so on a saved payload it lands on the trial rows
// (or metadata). Each entry is { reason, start, end, duration, in_progress };
// the renderer keys off `t` (perfNow ms), so map start → t. Apps that hand-write
// a top-level `raw.guardFriction` object still take precedence over this.
function findGuardViolations(raw) {
  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return null;
  };
  // True when a candidate value parses to at least one REAL violation (an entry
  // with a numeric start). Used to scan trials for real data rather than the
  // first trial that merely has a truthy field.
  const hasReal = (v) => {
    const a = parseArr(v);
    return Array.isArray(a) && a.some(x => x && typeof x.start === 'number');
  };
  const candidates = [
    raw.metadata?.guard_assistance_violations_session,
    Array.isArray(raw.trials) && raw.trials.length > 0
      ? raw.trials[raw.trials.length - 1]?.guard_assistance_violations_session : null,
    // Scan ALL trials for one carrying REAL violations — not just the first trial
    // with a truthy field. A truthy-but-empty "[]" on an earlier trial used to
    // make .find() lock on, then the outer loop fell through to candidate 4 and
    // a later trial's real violations were never reached. Not live for the
    // shipped honeypot (it stamps this field identically on every trial), but a
    // latent bug for any non-uniform / merged producer. (Sol R2 candidate-3.)
    Array.isArray(raw.trials)
      ? raw.trials.map(t => t?.guard_assistance_violations_session).find(hasReal)
      : null,
    raw.guard_assistance_violations_session,
  ];
  for (const c of candidates) {
    const arr = parseArr(c);
    if (Array.isArray(arr)) {
      const violations = arr
        .filter(v => v && typeof v.start === 'number')
        .map(v => ({ t: v.start, reason: v.reason || 'unknown', phase: 'unknown', duration_ms: v.duration }));
      // Fall through to the next source on an empty/violation-less candidate
      // instead of locking onto it — otherwise an empty placeholder (e.g. a
      // metadata mirror set to []) would shadow real violations on the trial rows.
      if (violations.length > 0) return violations;
    }
  }
  return null;
}

// Surfaces the guard-honeypot self-disclosure fields (the visible bait: an "I used
// AI" checkbox and a free-text box). The honeypot writes ai_use_session /
// ai_report_session via addProperties and per-trial ai_use / ai_report via
// on_finish. The runtime emits them but no analyzer consumed them — this lifts
// them onto the participant so summary.csv / triage can surface them. Returns
// null when the honeypot was not used (fields absent everywhere).
function findHoneypotDisclosure(raw) {
  // Aggregate across every source rather than returning the first that carries a
  // honeypot key. addProperties stamps ai_use_session=false / ai_report_session=''
  // onto ALL trials, so the final trial is usually blank-but-present; returning it
  // first would mask a positive disclosure recorded on an earlier trial. A
  // disclosure anywhere (ticked checkbox OR non-empty report) makes the whole
  // participant positive.
  const sources = [];
  if (raw.metadata && typeof raw.metadata === 'object') sources.push(raw.metadata);
  if (Array.isArray(raw.trials)) sources.push(...raw.trials);
  sources.push(raw);

  // Accept the checkbox as a real boolean OR its CSV string form ("true"/"false"
  // survive Papa's dynamicTyping in some pipelines). Crucially, presence requires
  // an actual checkbox value or non-empty report text — NOT mere key existence:
  // shared-header CSVs give honeypot-less participants blank ('' / null) cells,
  // and counting those as "present" would manufacture a `no` instead of the
  // documented empty (honeypot-absent) state.
  const isBool = (v) => v === true || v === false || v === 'true' || v === 'false';
  const isTrue = (v) => v === true || v === 'true';
  const reportText = (v) => (typeof v === 'string' ? v : '');

  let present = false;
  let ticked = false;
  let sessionReport = '';  // authoritative *_session report text (prefer longest)
  let trialReport = '';    // longest per-trial report snapshot
  for (const obj of sources) {
    if (!obj || typeof obj !== 'object') continue;
    const repS = reportText(obj.ai_report_session);
    const repT = reportText(obj.ai_report);
    const hasDisclosureField = isBool(obj.ai_use_session) || isBool(obj.ai_use)
      || repS.length > 0 || repT.length > 0;
    if (!hasDisclosureField) continue;
    present = true;
    if (isTrue(obj.ai_use_session) || isTrue(obj.ai_use)) ticked = true;
    if (repS.length > sessionReport.length) sessionReport = repS;
    if (repT.length > trialReport.length) trialReport = repT;
  }
  if (!present) return null;
  const aiReport = sessionReport || trialReport;
  // aiUse reflects the explicit "I used AI" checkbox ONLY. The free-text box is
  // surfaced separately (aiReport / honeypot_ai_report) for the reviewer to read
  // and judge — auto-classifying any non-empty text as a positive would
  // false-flag entries like "none" / "didn't use AI" and contradicts the
  // documented "YES = ticked" semantics. The tool produces evidence, not verdicts.
  return { aiUse: ticked, aiReport };
}

// Chronological-by-rule trial ordering: (rulePosition, phase-rank,
// trialNumber). Shows trials in the order each rule was actually
// experienced — gallery → post-gallery query → classification t1..t6 — with
// end-requery trials (rulePosition=null → Infinity) sorting to the very end,
// matching their session-end timing. Used by the phaseTrials merge above and
// by the trajectories renderer's default displayOrder. Stable-sort friendly:
// trials without any of these fields compare equal and keep their input order.
export function ruleChronologicalCompare(a, b) {
  const phaseRank = (ph) => {
    if (ph === 'gallery') return 0;
    if (ph === 'post_gallery_query') return 1;
    if (ph === 'end_requery') return 99;
    return 2; // classification or unspecified
  };
  const aPos = a.rulePosition ?? Infinity;
  const bPos = b.rulePosition ?? Infinity;
  if (aPos !== bPos) return aPos - bPos;
  const aP = phaseRank(a.phase);
  const bP = phaseRank(b.phase);
  if (aP !== bP) return aP - bP;
  return (a.trialNumber ?? 0) - (b.trialNumber ?? 0);
}

// Maps Shape-2 legacy field names to CyborgHunter schema names.
// The CLI can then use a single set of field names downstream.
const LEGACY_FIELD_MAP = {
  mouseTrack: 'mouseEvents',
};

// Normalizes tabAwayEvents[*].start from session-relative performance.now()
// (ms since browser navigation) to trial-relative ms (ms since this trial
// began), stored as a new `startRel_ms` field. Renderers plot per-trial
// against trial-relative time; without normalization, tab-away markers
// land tens of thousands of ms off the right edge — invisible.
//
// Two paths:
//   FAST PATH — every trial has a per-trial performance.now() anchor (either
//     trialStart_perfNow set by the jsPsych wrapper, or startTime set by the
//     standalone monitor). Subtract directly; result is exact.
//   ESTIMATOR PATH — Shape-2 / pre-monitor data has neither anchor.
//     We infer the session-start performance.now() value from the
//     relationship between trial-end wall-clocks (`timestamp`),
//     `responseTime_ms`, and the first tab-away's session-relative `start`,
//     then subtract the inferred offset to get a trial-relative value.
//     Less precise than the fast path; used only when nothing better exists.
function normalizeTabAwayTimestamps(trials, raw) {
  // Fast path — every trial has a usable anchor.
  const everyTrialHasAnchor = trials.length > 0 && trials.every(t =>
    typeof (t.trialStart_perfNow ?? t.startTime) === 'number'
  );
  if (everyTrialHasAnchor) {
    for (const trial of trials) {
      const tabs = trial.tabAwayEvents;
      if (!Array.isArray(tabs) || tabs.length === 0) continue;
      const trialStart = trial.trialStart_perfNow ?? trial.startTime;
      trial.tabAwayEvents = tabs.map(ta => ({
        ...ta,
        startRel_ms: typeof ta.start === 'number' ? ta.start - trialStart : null
      }));
    }
    return;
  }

  // Estimator path. Need a session-start wall-clock anchor; if there isn't
  // one, we have no way to relate trial-end timestamps to a 0 reference.
  const sessStartIso = raw.metadata?.startTime;
  if (!sessStartIso) return;
  const sessStartMs = Date.parse(sessStartIso);
  if (!Number.isFinite(sessStartMs)) return;

  // For each trial, compute trial-start in ms-since-session-start (wall-clock).
  // trial-end is response.timestamp; trial-start = trial-end − duration.
  const trialStartRels = trials.map(t => {
    if (!t.timestamp || t.responseTime_ms == null) return null;
    const endMs = Date.parse(t.timestamp);
    if (!Number.isFinite(endMs)) return null;
    return (endMs - sessStartMs) - t.responseTime_ms;
  });

  // For each trial that has ≥1 tab-away, estimate the session offset:
  //   sessionOffset = (performance.now value at session start, in ms)
  // The first tab-away of the trial must fall inside the trial's response
  // window, so:
  //   firstTabStart ∈ [sessionOffset + trialStartRel,
  //                    sessionOffset + trialStartRel + trialDuration]
  // Solving for sessionOffset gives an interval; we use the midpoint as
  // each trial's candidate, then take the median across trials as the
  // robust estimate. This is approximate but converges quickly with even
  // a few tab-away-bearing trials.
  const candidates = [];
  for (let i = 0; i < trials.length; i++) {
    const tabs = trials[i].tabAwayEvents;
    if (!Array.isArray(tabs) || tabs.length === 0) continue;
    const trialStartRel = trialStartRels[i];
    const trialDurationMs = trials[i].responseTime_ms;
    if (trialStartRel == null || trialDurationMs == null) continue;
    const firstTabStart = tabs[0].start;
    if (typeof firstTabStart !== 'number') continue;
    candidates.push(firstTabStart - trialStartRel - trialDurationMs / 2);
  }

  if (candidates.length === 0) return;

  candidates.sort((a, b) => a - b);
  const sessionOffset = candidates[Math.floor(candidates.length / 2)];

  // Apply normalization. Original `start` is preserved alongside `startRel_ms`
  // so consumers can still see the absolute time if they want it.
  for (let i = 0; i < trials.length; i++) {
    const tabs = trials[i].tabAwayEvents;
    if (!Array.isArray(tabs) || tabs.length === 0) continue;
    const trialStartRel = trialStartRels[i];
    if (trialStartRel == null) continue;
    trials[i].tabAwayEvents = tabs.map(ta => ({
      ...ta,
      startRel_ms: typeof ta.start === 'number'
        ? ta.start - sessionOffset - trialStartRel
        : null
    }));
  }
}

function mapLegacyFields(trial) {
  const mapped = { ...trial };
  for (const [oldName, newName] of Object.entries(LEGACY_FIELD_MAP)) {
    if (mapped[oldName] !== undefined && mapped[newName] === undefined) {
      mapped[newName] = mapped[oldName];
      delete mapped[oldName];
    }
  }
  // Flag distinguishes "no tracking hardware" from "tracked, zero events"
  mapped.mouseDataAvailable = Array.isArray(mapped.mouseEvents) && mapped.mouseEvents.length > 0;
  return mapped;
}

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
