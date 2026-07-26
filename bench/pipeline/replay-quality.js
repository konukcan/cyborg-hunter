// replay-quality.js
//
// Three pure scoring functions (1-5) that feed the bench writeup's secondary
// axis on replay quality, plus a rollup helper.
//
//   - eventCompleteness:    fraction of operator-asserted behaviors observed
//   - temporalGranularity:  smallest non-zero inter-event delta, bucketed
//   - inspectabilityScore:  hand-rated tool metadata (local files / auth / OSS)
//
// All functions are pure: no I/O, no globals, no mutation of inputs.

/**
 * Event completeness: 1-5 score. What fraction of operator-asserted behaviors
 * appear in the tool's event stream?
 *
 * Mapping is linear over [0, 1]:
 *   0   → 1
 *   0.5 → 3
 *   1   → 5
 *
 * @param {Array<{type: string}>} events - tool's normalized event stream
 * @param {Array<string>} expectedBehaviors - taxonomy ids that should appear
 * @returns {number} score 1-5
 */
export function eventCompleteness(events, expectedBehaviors) {
  if (!expectedBehaviors || expectedBehaviors.length === 0) return 5;
  const observed = new Set((events || []).map((e) => e.type));
  const hits = expectedBehaviors.filter((b) => observed.has(b)).length;
  const fraction = hits / expectedBehaviors.length;
  return Math.round(1 + 4 * fraction);
}

/**
 * Temporal granularity: 1-5 score based on the minimum non-zero inter-event
 * delta in the (sorted-by-time) event stream.
 *
 *   <100ms  → 5
 *   <1s     → 4
 *   <10s    → 3
 *   <60s    → 2
 *   else    → 1
 *
 * Identical timestamps (delta=0) are skipped — they don't tell us anything
 * about the tool's clock resolution.
 *
 * @param {Array<{t_ms: number}>} events
 * @returns {number} score 1-5
 */
export function temporalGranularity(events) {
  if (!events || events.length < 2) return 1;
  const sorted = events
    .map((e) => e.t_ms)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  let minDelta = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0 && d < minDelta) minDelta = d;
  }
  if (!Number.isFinite(minDelta)) return 1;
  if (minDelta < 100) return 5;
  if (minDelta < 1000) return 4;
  if (minDelta < 10000) return 3;
  if (minDelta < 60000) return 2;
  return 1;
}

/**
 * Researcher inspectability: 1-5. NOT derived from events — bundled here so
 * the writeup has a single source of truth for replay scores. Caller passes
 * a small descriptor; this validates and computes.
 *
 * Scoring:
 *   base                     = 1
 *   + 2 if localFiles        (raw CSV/JSON exports available locally)
 *   + 1 if !authGated        (no API auth wall to inspect events)
 *   + 1 if openSource        (tool source is open)
 *   clamped to 5
 *
 * @param {Object} toolMetadata
 * @param {boolean} [toolMetadata.localFiles=false]
 * @param {boolean} [toolMetadata.authGated=true]
 * @param {boolean} [toolMetadata.openSource=false]
 * @returns {number} score 1-5
 */
export function inspectabilityScore(
  { localFiles = false, authGated = true, openSource = false } = {}
) {
  let s = 1;
  if (localFiles) s += 2;
  if (!authGated) s += 1;
  if (openSource) s += 1;
  return Math.min(s, 5);
}

/**
 * Roll up all three scores for a tool on a run.
 *
 * @param {Object} args
 * @param {Array<{type: string, t_ms: number}>} args.events
 * @param {Array<string>} args.expectedBehaviors
 * @param {Object} args.toolMetadata
 * @returns {{eventCompleteness: number, temporalGranularity: number, inspectability: number}}
 */
export function scoreRun({ events, expectedBehaviors, toolMetadata }) {
  return {
    eventCompleteness: eventCompleteness(events, expectedBehaviors),
    temporalGranularity: temporalGranularity(events),
    inspectability: inspectabilityScore(toolMetadata),
  };
}
