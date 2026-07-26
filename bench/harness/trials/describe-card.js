// =============================================================================
// describe-card.js
//
// Native jsPsych `survey-text` trial: show a single card stimulus and ask the
// participant to describe it in free text.
//
// Renamed from `rule-naming.js` in the 2026-05-14 harness redesign. The
// original framing ("Name the rule:") implied a single canonical answer the
// participant had to discover, which doesn't match what we're measuring — we
// just want a brief free-text description as a low-friction verbal
// touchstone.
//
// The bench harness loads jsPsych plugins via <script> tags so they're
// available as globals (e.g. `jsPsychSurveyText`). We read the plugin off
// `globalThis` at call time and throw a descriptive error if it's missing —
// keeping the failure loud rather than producing a trial with `type: undefined`.
// =============================================================================

const REQUIRED_PLUGIN_GLOBALS = ['jsPsychSurveyText'];

/**
 * Build a jsPsych describe-card trial: card stimulus + single free-text response.
 *
 * @param {object} opts
 * @param {string} opts.cardImage - URL/path to the card stimulus image (used
 *   as the `<img src>` inside the trial's HTML preamble).
 * @throws Error if any required jsPsych plugin global is missing.
 * @returns {object} A jsPsych trial object suitable for inclusion in a timeline.
 */
export function buildDescribeCardTrial({ cardImage }) {
  const missing = REQUIRED_PLUGIN_GLOBALS.filter(
    name => typeof globalThis[name] === 'undefined'
  );
  if (missing.length) {
    throw new Error(
      `describe-card: missing jsPsych plugin globals: ${missing.join(', ')}. ` +
      `Load them via <script> tags in the bench harness HTML before importing ` +
      `this module.`
    );
  }

  return {
    type: globalThis.jsPsychSurveyText,
    preamble:
      `<img src="${cardImage}" alt="card stimulus" style="display:block;margin:auto;">` +
      `<p>Describe this card:</p>`,
    questions: [
      { prompt: '', rows: 3, columns: 60, required: true },
    ],
  };
}
