// demo/payload.js
// Pure payload assembler (no DOM) — builds the Shape-1 object src/cli/
// ingest.js's extractIntegrityData() reads:
//   { participantId, trials: [...], metadata: { integritySession,
//     integrityScore } } + a top-level guardFriction.violations[] override.
//
// Verified conventions (src/cli/ingest.js):
//   - participantId: raw[participantIdField] ('participantId' by default).
//   - trials[]: each entry carries its per-trial report under `integrity`
//     (config.integrityField default 'integrity') — mirrors what the
//     jsPsych extension's on_finish() returns: `{ integrity: report }`
//     (src/jspsych/extension-cyborg-hunter.js). buildPayload does not
//     reshape trial entries; callers pass them already in that shape.
//   - metadata.integritySession: the session-report object itself (the
//     "metadata convention", ingest.js findSessionData() priority #1).
//   - metadata.integrityScore: mirrors extension-cyborg-hunter.js's
//     finalize(), which writes `{ hardScore, softScore, anyHardTriggered,
//     trialsCompleted, softScoreThreshold }` alongside integritySession.
//     Included only when sessionReport actually exposes a score field —
//     ingest.js synthesizes the score from the session object otherwise
//     (scoreFromSession()), so this is a convenience mirror, not required.
//   - guardFriction: "app-written top-level guardFriction wins" over
//     ingest's own honeypot-log synthesis (extractIntegrityData()). Exact
//     path is raw.guardFriction.violations[]. Omitted entirely when there
//     are no violations — ingest.js reads it with `??`, which only checks
//     for null/undefined, so a present-but-empty override would still
//     shadow (and defeat) its synthesis fallback.

export function buildPayload({ pid, trials, sessionReport, violations }) {
  var metadata = { integritySession: sessionReport };

  if (sessionReport && (
    sessionReport.softScore !== undefined ||
    sessionReport.hardScore !== undefined ||
    sessionReport.anyHardTriggered !== undefined
  )) {
    metadata.integrityScore = {
      hardScore: sessionReport.hardScore,
      softScore: sessionReport.softScore,
      anyHardTriggered: sessionReport.anyHardTriggered,
      trialsCompleted: sessionReport.trialsCompleted,
      softScoreThreshold: sessionReport.softScoreThreshold,
    };
  }

  var payload = {
    participantId: pid,
    trials: trials,
    metadata: metadata,
  };

  if (violations && violations.length > 0) {
    payload.guardFriction = { violations: violations };
  }

  return payload;
}
