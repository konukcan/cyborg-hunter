// bench/adapters/roundtable-adapter.js
//
// Adapter: Roundtable API → CommonEvent[] / CommonEvent (see ./schema.json).
//
// Two functions, one per RT endpoint:
//   - roundtableEventsAdapter(payload) — normalizes GET /v1/sessions/{id}/events
//   - roundtableReportAdapter(payload) — normalizes GET /v1/sessions/{id}/report
//     into one synthetic 'session_flags' event.
//
// =============================================================================
// IMPORTANT — `t_ms` unit asymmetry between CH and RT adapters
// =============================================================================
// The CH adapter writes `t_ms` as SESSION-RELATIVE milliseconds (read directly
// from event-log.csv's `timestamp` column, which is relative to trial start in
// the jsPsych world).
//
// The RT adapter writes `t_ms` as UNIX EPOCH MILLISECONDS, because RT's
// `unix_timestamp` field is exactly that (13-digit epoch ms). We deliberately
// do NOT subtract `events[0].unix_timestamp` here — the matrix builder in v0.1
// doesn't do time-correlation between tools; it buckets events by
// scenario+guards+tool, so the unit mismatch is invisible to downstream code.
//
// If/when a pipeline needs to align CH and RT event streams on a shared
// timeline (e.g. interleaving paste-vs-edit timing), this asymmetry will need
// to be normalized at the call site. Documented as a design wart, not a bug.
// =============================================================================
//
// =============================================================================
// IMPORTANT — RT uses STRICT STRINGS, not booleans, for check results
// =============================================================================
// Every value in `biometric_checks` and `device_checks` is exactly the literal
// string `"Detected"` or `"Not detected"`. The naive truthy check is wrong:
//
//     if (checks.bot)           // BUG: "Not detected" is truthy → always true!
//     if (checks.bot === 'Detected')  // CORRECT
//
// `roundtableReportAdapter` is the boundary where these strings get converted
// to real JS booleans. Downstream code should never see the RT strings.
// =============================================================================

// ---------- /events adapter -------------------------------------------------

// Regex notes:
//   - `clickRegex` uses `[\s\S]+?` (non-greedy, dot-matches-newline) because
//     multi-line button labels embed literal `\n` characters between the outer
//     double quotes — see e.g. `User clicked "Not at all confident\nSomewhat\nVery confident"`.
//     A naive `[^"]+?` would also work here (the inner content has no escaped
//     quotes in observed data), but `[\s\S]+?` is explicit about the multiline
//     intent and immune to a future schema-notes addition like emoji-in-quotes
//     edge cases.
const navRegex    = /^User navigated to (.+)$/;
const clickRegex  = /^User clicked "([\s\S]+?)"$/;
const editRegex   = /^User edited #(\S+)$/;
const submitRegex = /^User submitted (\S+)$/;

/**
 * Normalize the response of GET /v1/sessions/{id}/events.
 *
 * Each `events[i]` entry becomes one CommonEvent. Unknown action strings fall
 * back to `type: 'other'` with the raw string preserved in `payload.raw_action`
 * so downstream auditing can spot vocabulary drift in the rt.js bundle.
 *
 * Note on text content: RT's `User edited #<id>` event carries ONLY the
 * element id — the actual text the participant typed is never transmitted by
 * RT (privacy-by-design). This is a real loss-of-fidelity signal for the
 * RT-vs-CH comparison writeup.
 *
 * @param {{event_count: number, events: Array<{action: string, user_time: string, unix_timestamp: number}>}} payload
 * @returns {Array<CommonEvent>} chronological CommonEvent stream, source='roundtable'.
 */
export function roundtableEventsAdapter(eventsPayload) {
  const rows = (eventsPayload && eventsPayload.events) || [];

  return rows.map(evt => {
    const action = evt.action;
    const base = {
      t_ms: evt.unix_timestamp, // unix epoch ms — see header comment on asymmetry
      source: 'roundtable',
      trialId: null,            // RT has no trial-bracketing concept
    };

    let m;
    if ((m = action.match(navRegex))) {
      return {
        ...base,
        type: 'other',
        payload: {
          subkind: 'navigation',
          url: m[1],
          raw_action: action,
        },
      };
    }

    if ((m = action.match(clickRegex))) {
      return {
        ...base,
        type: 'click',
        payload: {
          button_text: m[1],   // literal `\n` preserved for multi-line labels
          raw_action: action,
        },
      };
    }

    if ((m = action.match(editRegex))) {
      return {
        ...base,
        type: 'typing_burst',
        payload: {
          element_id: m[1],
          raw_action: action,
        },
      };
    }

    if ((m = action.match(submitRegex))) {
      return {
        ...base,
        type: 'other',
        payload: {
          subkind: 'form_submit',
          form_id: m[1],
          raw_action: action,
        },
      };
    }

    if (action === 'Page became hidden') {
      return { ...base, type: 'tab_away', payload: { raw_action: action } };
    }
    if (action === 'Page became visible') {
      return { ...base, type: 'tab_return', payload: { raw_action: action } };
    }

    // Unrecognized — preserve verbatim for audit.
    return {
      ...base,
      type: 'other',
      payload: { raw_action: action },
    };
  });
}

// ---------- /report adapter -------------------------------------------------

// Strict comparison against the literal "Detected" string. See header comment.
function isDetected(value) {
  return value === 'Detected';
}

function mapChecks(checks) {
  const out = {};
  for (const key of Object.keys(checks || {})) {
    out[key] = isDetected(checks[key]);
  }
  return out;
}

/**
 * Normalize the response of GET /v1/sessions/{id}/report into a single
 * synthetic 'session_flags' event carrying all session-level biometric +
 * device checks. Folding the report into the same CommonEvent stream means
 * downstream code (replay-quality, scoring, plotting) doesn't need a special
 * "session report" code path.
 *
 * `t_ms: 0` is used as a sentinel "session-level event" marker — keeps it
 * sortable before any per-event timestamp without claiming a real wall time.
 *
 * @param {{biometric_checks: Object, device_checks: Object, risk_score: number, risk_explanation: string, recommended_action: string}} payload
 * @returns {CommonEvent} single 'session_flags' event with all checks-as-booleans in payload.
 */
export function roundtableReportAdapter(reportPayload) {
  return {
    t_ms: 0,
    type: 'session_flags',
    source: 'roundtable',
    trialId: null,
    payload: {
      risk_score: reportPayload.risk_score,
      risk_explanation: reportPayload.risk_explanation,
      recommended_action: reportPayload.recommended_action,
      biometric: mapChecks(reportPayload.biometric_checks),
      device:    mapChecks(reportPayload.device_checks),
    },
  };
}
