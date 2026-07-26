// bench/adapters/ch-adapter.js
//
// Adapter: CH `pilot-report/event-log.csv` → CommonEvent[] (see ./schema.json).
//
// Why this exists: v1's CH adapter read per-trial AGGREGATE COUNTS from a
// summary CSV and then synthesized fake event rows at the same `time_elapsed`
// value, which destroyed the real timing structure (events appeared to
// "fire all at once" at the end of each trial). v2 reads CH's actual
// event-level log (`event-log.csv`), so every row already carries its real
// timestamp and we just normalize the shape.
//
// CSV parser choice: papaparse. It's already in this package's `dependencies`
// (used elsewhere in the project), it supports header-mode parsing returning
// rows as objects, and it works synchronously on a string. Avoids adding
// `csv-parse` as a second CSV library.
//
// event-log.csv header (verified from real pilot data):
//   participantId,trialId,eventType,timestamp,duration_ms,text

import Papa from 'papaparse';

// Map CH's eventType strings → CommonEvent `type` enum values (see schema.json).
//
// Legacy event types observed in the pre-merge pilot fixture:
//   paste, copy, synthetic, tabAway
//
// Guard-layer event types that *will* appear in post-merge runs (extension-
// guard-friction.js / extension-guard-honeypot.js):
//   guardViolation_fullscreen, guardViolation_sidebar, guardViolation_focus,
//   tamper, aiUseBait, aiReportBait, agenticBrowserDetected
//
// NOTE: the guard-layer key strings below are a v0 best-guess based on the
// extension source. The actual strings shipped by CH may differ (e.g. CH may
// use snake_case keys, or a different naming convention). Verify and adjust
// once a real post-merge event-log.csv lands; the schema-side `type` values
// are stable.
const EVENT_TYPE_MAP = {
  // Legacy (confirmed against real pilot data):
  paste:                       'paste',
  copy:                        'copy',
  synthetic:                   'programmatic_typing',
  tabAway:                     'tab_away',

  // Guard-layer (v0 best-guess — confirm with real post-merge run):
  guardViolation_fullscreen:   'guard_violation_fullscreen',
  guardViolation_sidebar:      'guard_violation_sidebar',
  guardViolation_focus:        'guard_violation_focus',
  tamper:                      'tamper_detected',
  aiUseBait:                   'ai_use_bait',
  aiReportBait:                'ai_report_bait',
  agenticBrowserDetected:      'agentic_browser_detected',
};

/**
 * Parse a CH event-log.csv string into CommonEvent[].
 *
 * Each CSV row becomes exactly one CommonEvent. Unknown `eventType` strings
 * fall back to `type: 'other'` with the raw value preserved in
 * `payload.rawEventType` so downstream auditing can spot mapping gaps.
 *
 * @param {string} csvText - Contents of event-log.csv (header row required).
 * @returns {Array<{
 *   t_ms: number,
 *   type: string,
 *   source: 'ch',
 *   trialId: string | null,
 *   payload: { rawEventType: string, duration_ms: number | null, text: string | null }
 * }>}
 */
export function chEventLogAdapter(csvText) {
  const { data } = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  return data.map(row => ({
    t_ms: Number(row.timestamp),
    type: EVENT_TYPE_MAP[row.eventType] || 'other',
    source: 'ch',
    trialId: row.trialId ? String(row.trialId) : null,
    payload: {
      rawEventType: row.eventType,
      duration_ms: row.duration_ms !== '' && row.duration_ms != null
        ? Number(row.duration_ms)
        : null,
      text: row.text !== '' && row.text != null ? String(row.text) : null,
    },
  }));
}
