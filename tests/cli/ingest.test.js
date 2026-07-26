import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractIntegrityData, ingest } from '../../src/cli/ingest.js';

describe('ingest', () => {
  it('extracts integrity field from trial data', () => {
    const raw = {
      participantId: 'P001',
      trials: [
        { trialId: 'r1', response: 'hello', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } },
        { trialId: 'r2', response: 'world', integrity: { trialId: 'r2', pasteEvents: [{ t: 100 }], trialSoftScore: 1 } }
      ]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.participantId, 'P001');
    assert.equal(result.trials.length, 2);
    assert.equal(result.trials[1].pasteEvents.length, 1);
  });

  // P3: structural time-basis fix. When every trial carries trialStart_perfNow
  // (the on_load anchor emitted by the jsPsych extension), ingest must compute
  // trial-relative startRel_ms by direct subtraction and skip the legacy
  // session-offset estimator. Mixing the two would silently drift.
  it('prefers trialStart_perfNow when present on every trial (P3 fast path)', () => {
    // trialStart_perfNow on the same monotonic clock as tabAwayEvents[*].start.
    // Trial 1 starts at 10_000ms, tab at 13_500ms → startRel_ms = 3_500.
    // Trial 2 starts at 40_000ms, tab at 45_250ms → startRel_ms = 5_250.
    const raw = {
      metadata: {
        subjectId: 'P-P3',
        // Deliberately wrong/missing to prove estimator is NOT consulted.
        startTime: undefined
      },
      responses: [
        {
          ruleId: 'r1', timestamp: '2026-04-14T12:00:05.000Z', responseTime_ms: 5000,
          trialStart_perfNow: 10000,
          tabAwayEvents: [{ start: 13500, duration_ms: 500, type: 'blur' }]
        },
        {
          ruleId: 'r2', timestamp: '2026-04-14T12:00:50.000Z', responseTime_ms: 10000,
          trialStart_perfNow: 40000,
          tabAwayEvents: [{ start: 45250, duration_ms: 2000, type: 'blur' }]
        }
      ]
    };
    const result = extractIntegrityData(raw, { participantIdField: 'subjectId' });
    assert.equal(result.trials[0].tabAwayEvents[0].startRel_ms, 3500);
    assert.equal(result.trials[1].tabAwayEvents[0].startRel_ms, 5250);
  });

  // Regression for the bug found in quillien-2a verification (April 2026):
  // Shape 1 (jsPsych extension data — raw.trials with integrity sub-objects)
  // was never running the P3 normalization, so tabAwayEvents[*].start stayed
  // in session-absolute performance.now() time. Renderers tried to plot them
  // on a trial-relative axis (0–N ms) and the markers ended up far off-canvas
  // — silently invisible.
  it('normalizes tabAwayEvents for Shape 1 jsPsych-extension data (P3 fast path)', () => {
    const raw = {
      trials: [
        {
          subject_ID: 'P1',
          integrity: {
            trialId: 'r1',
            trialStart_perfNow: 20000,
            tabAwayEvents: [{ start: 27200, duration_ms: 2767, type: 'windowBlur' }]
          }
        },
        {
          subject_ID: 'P1',
          integrity: {
            trialId: 'r2',
            trialStart_perfNow: 30000,
            tabAwayEvents: [{ start: 35280, duration_ms: 1375, type: 'windowBlur' }]
          }
        }
      ]
    };
    const result = extractIntegrityData(raw, { participantIdField: 'subject_ID' });
    assert.equal(result.trials[0].tabAwayEvents[0].startRel_ms, 7200,
      'r1 tab at 27200 with trialStart 20000 → startRel_ms 7200');
    assert.equal(result.trials[1].tabAwayEvents[0].startRel_ms, 5280,
      'r2 tab at 35280 with trialStart 30000 → startRel_ms 5280');
    // Original `start` should be preserved (renderers fall back to it).
    assert.equal(result.trials[0].tabAwayEvents[0].start, 27200);
  });

  it('falls back to session-offset estimator when trialStart_perfNow is missing (legacy data)', () => {
    // No trialStart_perfNow → estimator runs on session wall-clock anchors.
    // The estimator's output isn't checked exactly here — the point is that
    // startRel_ms is populated *somehow* (i.e., the fallback path still runs).
    const raw = {
      metadata: { subjectId: 'P-LEGACY', startTime: '2026-04-14T12:00:00.000Z' },
      responses: [
        {
          ruleId: 'r1', timestamp: '2026-04-14T12:00:05.000Z', responseTime_ms: 5000,
          tabAwayEvents: [{ start: 1000000, duration_ms: 500, type: 'blur' }]
        }
      ]
    };
    const result = extractIntegrityData(raw, { participantIdField: 'subjectId' });
    // Estimator produced *some* startRel_ms (not necessarily accurate — the
    // point is merely that the fallback path fires when the field is absent).
    assert.ok(typeof result.trials[0].tabAwayEvents[0].startRel_ms === 'number');
  });

  it('handles missing integrity field gracefully', () => {
    const raw = { participantId: 'P002', trials: [{ trialId: 'r1', response: 'test' }] };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.trials.length, 0);
    assert.equal(result.warnings.length, 1);
  });

  it('maps legacy mouseTrack to mouseEvents', () => {
    const raw = {
      metadata: { subjectId: 'P003' },
      responses: [{ ruleId: 'r1', mouseTrack: [{ x: 10, y: 20, t: 0 }], tabAwayEvents: [] }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'subjectId' });
    assert.equal(result.participantId, 'P003');
    assert.equal(result.trials.length, 1);
    assert.ok(result.trials[0].mouseEvents, 'mouseTrack should be mapped to mouseEvents');
    assert.equal(result.trials[0].mouseTrack, undefined, 'old field name should be removed');
  });

  it('extractIntegrityData attaches session-level metadata when present', () => {
    const raw = JSON.parse(readFileSync('./tests/cli/fixtures/with_session_metadata.json', 'utf8'));
    const result = extractIntegrityData(raw, { participantIdField: 'subjectId' });
    assert.equal(result.session.pasteCount, 2);
    assert.equal(result.session.sidebarEvents.length, 2);
    // Close event (Task P6) carries signed deltaIW: negative because innerWidth
    // grew back when the sidebar vanished. Pairs with the positive open delta.
    const closeEv = result.session.sidebarEvents.find(e => e.type === 'closed');
    assert.ok(closeEv, 'fixture should include a closed sidebar event');
    assert.equal(closeEv.deltaIW, -308);
    assert.equal(closeEv.duration_ms, 33000);
    assert.equal(result.session.aiExtensionsFound[0].name, 'ChatGPT Sidebar');
    assert.equal(result.score.anyHardTriggered, true);
    assert.equal(result.score.hardScore.paste.triggered, true);
  });

  // T1 — CSV adapter. jsPsych's default save format unparses each trial as a
  // row, with nested objects (the integrity report, integritySession,
  // integrityScore) JSON-stringified into single cells. The CSV branch in
  // ingest() uses Papa Parse + a JSON-cell unwrap pass so the same downstream
  // extractor handles both shapes uniformly.
  it('ingests a jsPsych-style CSV (Papa-unparsed nested cells) end-to-end', async () => {
    // Drop the fixture into a fresh temp dir so ingest()'s readdirSync sees
    // only this one file — no cross-contamination from sibling fixtures.
    const dir = mkdtempSync(join(tmpdir(), 'ch-csv-test-'));
    copyFileSync('./tests/cli/fixtures/conj-disj-sample.csv', join(dir, 'conj-disj-sample.csv'));

    const { participants, warnings } = await ingest({
      dataDir: dir,
      filePattern: '*.json',  // default broadens to JSON-or-CSV; the .csv file is picked up
      participantIdField: 'subjectId',
    });

    assert.equal(participants.length, 1, 'one CSV file → one participant');
    const p = participants[0];
    assert.equal(p.participantId, 'P-CSV-1');
    assert.equal(p.trials.length, 2, 'CSV had two rows → two trials');

    // Per-trial nested integrity object came through (cell was JSON-parsed).
    assert.equal(p.trials[0].trialId, 't1');
    assert.equal(p.trials[1].trialId, 't2');
    assert.equal(p.trials[1].pasteEvents.length, 2, 'paste events array survived round-trip');
    assert.equal(p.trials[1].tabAwayEvents[0].type, 'blur');

    // Session-level data lives on the LAST row (Option A, addDataToLastTrial).
    // findSessionData() locates it via branch 2.
    assert.ok(p.session, 'session data found via last-trial fallback');
    assert.equal(p.session.pasteCount, 2);
    assert.ok(Array.isArray(p.session.sidebarEvents));

    // Score data parsed and surfaced too.
    assert.ok(p.score);
    assert.equal(p.score.anyHardTriggered, true);
    assert.equal(p.score.hardScore.paste.triggered, true);

    // No warnings for missing required fields, no session-missing warning.
    const fileWarnings = warnings.filter(w => w.file?.endsWith('conj-disj-sample.csv'));
    assert.equal(fileWarnings.length, 0, 'CSV ingest should produce no warnings on a valid fixture');
  });

  it('emits exactly one warning when session is null but trials are non-empty, and none when session is present', () => {
    // Case 1: no session, non-empty trials → exactly one warning with expected message
    const rawNoSession = {
      participantId: 'P-NO-SESSION',
      trials: [
        { trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } },
        { trialId: 'r2', integrity: { trialId: 'r2', pasteEvents: [], trialSoftScore: 0 } }
      ]
    };
    const resultNoSession = extractIntegrityData(rawNoSession, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(resultNoSession.session, null);
    const expectedMsg = 'No session-level integrity data — some signals unavailable (did the experiment call getSessionReport()?)';
    const matching = resultNoSession.warnings.filter(w => w === expectedMsg);
    assert.equal(matching.length, 1, 'should emit exactly one session-missing warning');

    // Case 2: session present → no such warning
    const rawWithSession = JSON.parse(readFileSync('./tests/cli/fixtures/with_session_metadata.json', 'utf8'));
    const resultWithSession = extractIntegrityData(rawWithSession, { participantIdField: 'subjectId' });
    const shouldBeNone = resultWithSession.warnings.filter(w => w === expectedMsg);
    assert.equal(shouldBeNone.length, 0, 'should not emit session-missing warning when session is present');
  });

  // Round 1 fix: getSessionReport() embeds the scoring summary in the session
  // object. When no separate integrityScore blob is saved, the authoritative
  // score must be synthesized from the session — otherwise summary.js falls back
  // to a per-trial trialHits>0 rule that overstates hard flags.
  it('synthesizes score from integritySession when no integrityScore blob is present', () => {
    const raw = {
      participantId: 'P-SESS-ONLY',
      trials: [
        { trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } },
        {
          trialId: 'r2', integrity: { trialId: 'r2', pasteEvents: [], trialSoftScore: 0 },
          // addDataToLastTrial wrote integritySession but the app dropped the
          // separate integrityScore field. The score fields live inside session.
          integritySession: {
            pasteCount: 1, sidebarEvents: [],
            hardScore: { paste: { count: 1, threshold: 2, triggered: false } },
            softScore: 4, anyHardTriggered: false, softScoreThreshold: 6, trialsCompleted: 2
          }
        }
      ]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.score, 'score synthesized from session');
    assert.equal(result.score.softScore, 4);
    assert.equal(result.score.anyHardTriggered, false,
      'must NOT overstate hard flag — count 1 is below threshold 2');
  });

  it('synthesizes score from raw.cyborgHunter (raw-DOM native top-level session)', () => {
    const raw = {
      participantId: 'P-SE',
      trials: [{ trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } }],
      cyborgHunter: {
        pasteCount: 3, sidebarEvents: [],
        hardScore: { paste: { count: 3, threshold: 2, triggered: true } },
        softScore: 7, anyHardTriggered: true, softScoreThreshold: 6, trialsCompleted: 1
      }
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.session, 'session located at raw.cyborgHunter');
    assert.ok(result.score, 'score synthesized from raw.cyborgHunter');
    assert.equal(result.score.anyHardTriggered, true);
    assert.equal(result.score.softScore, 7);
  });

  // Round 1 fix: the guard-honeypot extension writes the friction violation log
  // as a stringified guard_assistance_violations_session field. Ingest must
  // normalize it into the { violations: [{ t, reason, phase }] } shape the
  // session-timeline guard lane expects (mapping start → t).
  it('normalizes guard_assistance_violations_session into guardFriction.violations', () => {
    const raw = {
      participantId: 'P-GUARD',
      trials: [
        { trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } },
        {
          trialId: 'r2', integrity: { trialId: 'r2', pasteEvents: [], trialSoftScore: 0 },
          // addProperties stamps this on every row; here it's already an array
          // (JSON path) — the CSV path JSON-parses the stringified cell upstream.
          guard_assistance_violations_session: [
            { reason: 'sidebar_open', start: 12000, end: 15000, duration: 3000, in_progress: false },
            { reason: 'window_blurred', start: 40000, end: null, duration: 500, in_progress: true }
          ]
        }
      ]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.guardFriction, 'guardFriction synthesized from honeypot session field');
    assert.equal(result.guardFriction.violations.length, 2);
    assert.equal(result.guardFriction.violations[0].t, 12000, 'start mapped to t');
    assert.equal(result.guardFriction.violations[0].reason, 'sidebar_open');
  });

  it('app-written top-level raw.guardFriction takes precedence over honeypot synthesis', () => {
    const raw = {
      participantId: 'P-GUARD2',
      guardFriction: { violations: [{ t: 1, reason: 'app_written', phase: 'gallery' }] },
      trials: [{
        trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
        guard_assistance_violations_session: [{ reason: 'sidebar_open', start: 9, duration: 1 }]
      }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.guardFriction.violations[0].reason, 'app_written');
  });

  // Round 2 fix: findGuardViolations short-circuited on the first candidate that
  // parsed to ANY array — including an empty one — instead of falling through the
  // 4-source priority list. A divergent saver leaving an empty metadata mirror
  // ([]) while real violations live on the trial rows would lose them entirely.
  it('falls through an empty metadata mirror to trial-row guard violations', () => {
    const raw = {
      participantId: 'P-GUARD3',
      metadata: { guard_assistance_violations_session: [] },  // empty placeholder mirror
      trials: [
        { trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
          guard_assistance_violations_session: [{ reason: 'sidebar_open', start: 12000, duration: 3000 }] },
        { trialId: 'r2', integrity: { trialId: 'r2', pasteEvents: [], trialSoftScore: 0 } }  // last trial: clean
      ]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.guardFriction, 'guard violations recovered from a trial row, not shadowed by the empty mirror');
    assert.equal(result.guardFriction.violations.length, 1);
    assert.equal(result.guardFriction.violations[0].t, 12000);
  });

  // Round 3 fix: scoreFromSession derives anyHardTriggered from hardScore when
  // the rolled-up boolean is missing, so summary.js doesn't regress to the
  // per-trial trialHits>0 fallback.
  it('derives anyHardTriggered from hardScore when the boolean is absent', () => {
    const raw = {
      participantId: 'P-DERIVE',
      trials: [{
        trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
        integritySession: {
          // hardScore says paste triggered, but anyHardTriggered is omitted.
          hardScore: { paste: { count: 3, threshold: 2, triggered: true } },
          softScore: 2, softScoreThreshold: 6, trialsCompleted: 1
        }
      }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.score.anyHardTriggered, true, 'derived from hardScore[*].triggered');
  });

  it('derived anyHardTriggered is false when no hard signal triggered', () => {
    const raw = {
      participantId: 'P-DERIVE2',
      trials: [{
        trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
        integritySession: {
          hardScore: { paste: { count: 1, threshold: 2, triggered: false } },
          softScore: 0, softScoreThreshold: 6, trialsCompleted: 1
        }
      }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.score.anyHardTriggered, false);
  });

  // Round 3 fix: guard-honeypot self-disclosure (ai_use / ai_report) is now
  // surfaced onto the participant so the report can render it.
  it('surfaces honeypot ai_use / ai_report disclosure', () => {
    const raw = {
      participantId: 'P-HP',
      trials: [
        { trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } },
        {
          trialId: 'r2', integrity: { trialId: 'r2', pasteEvents: [], trialSoftScore: 0 },
          ai_use_session: true, ai_report_session: 'I asked ChatGPT for the rule'
        }
      ]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.honeypot);
    assert.equal(result.honeypot.aiUse, true);
    assert.equal(result.honeypot.aiReport, 'I asked ChatGPT for the rule');
  });

  it('honeypot disclosure is null when the honeypot was not used', () => {
    const raw = {
      participantId: 'P-NOHP',
      trials: [{ trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.honeypot, null);
  });

  it('honeypot present-but-unticked yields aiUse:false (negative evidence), not null', () => {
    const raw = {
      participantId: 'P-HP-CLEAN',
      trials: [{
        trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
        ai_use_session: false, ai_report_session: ''
      }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.honeypot, 'honeypot object present (extension was used)');
    assert.equal(result.honeypot.aiUse, false, 'distinguishes present-but-clean from absent');
  });

  it('surfaces report-box text from a non-final trial without auto-flagging aiUse', () => {
    const raw = {
      participantId: 'P-HP-REPORT',
      trials: [
        {
          trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
          // report text but no ai_use checkbox, and NOT on the final trial
          ai_report: 'used a sidebar LLM'
        },
        { trialId: 'r2', integrity: { trialId: 'r2', pasteEvents: [], trialSoftScore: 0 } }
      ]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.honeypot, 'report-box text is not dropped');
    assert.equal(result.honeypot.aiReport, 'used a sidebar LLM', 'text surfaced for review');
    assert.equal(result.honeypot.aiUse, false,
      'aiUse follows the checkbox only; the text is surfaced for the reviewer to judge');
  });

  it('does not auto-flag aiUse from a negative report ("none") with the box unticked', () => {
    const raw = {
      participantId: 'P-HP-NONE',
      trials: [{
        trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
        ai_use_session: false, ai_report_session: "none, I didn't use AI"
      }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.honeypot.aiUse, false, 'a negative report is not a positive disclosure');
    assert.equal(result.honeypot.aiReport, "none, I didn't use AI", 'text still surfaced');
  });

  it('a blank final trial does not mask a positive disclosure on an earlier trial', () => {
    // addProperties stamps ai_use_session=false / '' onto every row; the LAST
    // trial here is blank-but-present, while an earlier trial recorded a tick.
    const raw = {
      participantId: 'P-HP-MASK',
      trials: [
        {
          trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
          ai_use_session: true, ai_report_session: 'used AI early'
        },
        {
          trialId: 'r2', integrity: { trialId: 'r2', pasteEvents: [], trialSoftScore: 0 },
          ai_use_session: false, ai_report_session: ''
        }
      ]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.honeypot.aiUse, true, 'aggregates positive disclosure across all trials');
    assert.equal(result.honeypot.aiReport, 'used AI early');
  });

  it('treats CSV string-boolean ai_use ("true") as a positive disclosure', () => {
    const raw = {
      participantId: 'P-HP-STR',
      trials: [{
        trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
        ai_use_session: 'true', ai_report_session: ''
      }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.honeypot.aiUse, true, 'string "true" counts as ticked');
  });

  it('surfaces a cyborgHunterFinalizeError marker as a warning', () => {
    const raw = {
      participantId: 'P-FE',
      cyborgHunterFinalizeError: 'TypeError: cannot read x',
      trials: [{ trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.ok(result.warnings.some(w => w.includes('finalize() failed') && w.includes('TypeError')),
      'finalize error must be surfaced, not left dead in the data');
  });

  it('blank shared-header honeypot cells are treated as absent (null), not "no"', () => {
    // Participant never had the honeypot, but shares a CSV header so the columns
    // exist as empty cells. Must read as absent (null → empty column), not as
    // present-but-clean ("no"), which would manufacture negative evidence.
    const raw = {
      participantId: 'P-HP-SHARED',
      trials: [{
        trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 },
        ai_use_session: '', ai_report_session: ''
      }]
    };
    const result = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(result.honeypot, null, 'blank cells => honeypot absent');
  });
});

// 0.6.1 — dot-path support for participantIdField (retro item 5) and the
// sessionIntegrityPath config knob (upstream-feedback item).
describe('ingest 0.6.1 — dot-paths', () => {
  const trials = [{ trialId: 'r1', integrity: { trialId: 'r1', pasteEvents: [], trialSoftScore: 0 } }];

  it('resolves a dotted participantIdField like "metadata.sessionId"', () => {
    const raw = { metadata: { sessionId: 'SID-42' }, trials };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'metadata.sessionId'
    });
    assert.equal(result.participantId, 'SID-42');
  });

  it('resolves nested paths deeper than one level', () => {
    const raw = { payload: { meta: { pid: 'DEEP-1' } }, trials };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'payload.meta.pid'
    });
    assert.equal(result.participantId, 'DEEP-1');
  });

  it('keeps the historical plain-name behavior: top level, then metadata fallback', () => {
    const atTop = extractIntegrityData({ sessionId: 'TOP-1', trials },
      { integrityField: 'integrity', participantIdField: 'sessionId' });
    assert.equal(atTop.participantId, 'TOP-1');
    const inMeta = extractIntegrityData({ metadata: { sessionId: 'META-1' }, trials },
      { integrityField: 'integrity', participantIdField: 'sessionId' });
    assert.equal(inMeta.participantId, 'META-1');
  });

  it('a literal flat key containing a dot wins over the dotted walk', () => {
    const raw = { 'metadata.sessionId': 'FLAT-1', metadata: { sessionId: 'WALK-1' }, trials };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'metadata.sessionId'
    });
    assert.equal(result.participantId, 'FLAT-1');
  });

  it('sessionIntegrityPath reads session data from a custom dotted location', () => {
    const raw = {
      participantId: 'P-SIP',
      trials,
      payload: {
        cyborgHunter: {
          tabAwaySums: [4000], softScore: 3, softScoreThreshold: 6,
          anyHardTriggered: false, trialsCompleted: 1,
          hardScore: { paste: { count: 0, threshold: 2, triggered: false } }
        }
      }
    };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'participantId',
      sessionIntegrityPath: 'payload.cyborgHunter'
    });
    assert.ok(result.session, 'session must be found at the custom path');
    assert.deepEqual(result.session.tabAwaySums, [4000]);
    // Score is synthesized from the embedded scoring fields.
    assert.equal(result.score.softScore, 3);
    assert.equal(result.score.anyHardTriggered, false);
  });

  it('sessionIntegrityPath falls through to built-in conventions when empty', () => {
    const raw = {
      participantId: 'P-SIP-FALL',
      trials,
      metadata: { integritySession: { tabAwaySums: [1234], softScore: 0 } }
    };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'participantId',
      sessionIntegrityPath: 'payload.cyborgHunter'   // resolves to nothing
    });
    assert.deepEqual(result.session.tabAwaySums, [1234],
      'must fall back to metadata.integritySession');
  });

  it('default config (no sessionIntegrityPath) behaves exactly as before', () => {
    const raw = {
      participantId: 'P-DEFAULT',
      trials,
      cyborgHunter: { tabAwaySums: [500], softScore: 1 }
    };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'participantId'
    });
    assert.deepEqual(result.session.tabAwaySums, [500]);
  });

  // Regression for dossier finding F1: sessionIntegrityPath used to accept
  // ANY object (typeof === 'object'), so a near-miss path landing one level
  // above the real session object silently won, shadowing the real data at
  // the built-in metadata.integritySession location and zeroing every
  // downstream signal with no warning.
  it('sessionIntegrityPath falls through when the resolved value is a near-miss wrapper, not a session object', () => {
    const raw = {
      participantId: 'P-SIP-NEARMISS',
      trials,
      metadata: {
        // The real session data — the path below points one level too high,
        // at `metadata` itself rather than `metadata.integritySession`.
        integritySession: {
          tabAwaySums: [9000], softScore: 9, softScoreThreshold: 6,
          anyHardTriggered: true,
          hardScore: { paste: { count: 3, threshold: 2, triggered: true } }
        }
      }
    };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'participantId',
      sessionIntegrityPath: 'metadata'   // near-miss: resolves to an object, but not a session report
    });
    assert.ok(result.session, 'must fall through to the metadata.integritySession convention');
    assert.deepEqual(result.session.tabAwaySums, [9000]);
    assert.equal(result.score.softScore, 9);
    assert.equal(result.score.anyHardTriggered, true, 'the hard trigger must not be silently lost');
    assert.ok(!result.warnings.some(w => w.includes('No session-level integrity data')),
      'a session was found via fallthrough, so the missing-session warning must not fire');
  });

  it('sessionIntegrityPath still warns when the near-miss has no fallback to land on', () => {
    const raw = { participantId: 'P-SIP-NEARMISS-NOFALLBACK', trials, metadata: { note: 'not a session' } };
    const result = extractIntegrityData(raw, {
      integrityField: 'integrity', participantIdField: 'participantId',
      sessionIntegrityPath: 'metadata'
    });
    assert.equal(result.session, null);
    assert.ok(result.warnings.some(w => w.includes('No session-level integrity data')),
      'an unresolved session must still surface the warning, not silently pass with a wrong object');
  });
});
