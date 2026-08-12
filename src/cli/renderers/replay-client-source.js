// src/cli/renderers/replay-client-source.js
// The report's viewer script, ASSEMBLED — the one place that knows the viewer
// client is a concatenation rather than a file.
//
// T5 Task 2 recorded the decision this module executes: `replay-viewer.client.js`
// calls `mountTree`/`applyPatch`/`applyPatches` out of `src/replay/dom-instantiate.js`,
// and the client is a plain IIFE inlined verbatim into an HTML report — it
// cannot `import`. The two ways to give it those functions are (a) the client
// carries its own copy, which would put two readings of spec §4 in the repo,
// which is the failure this migration exists to remove, or (b) the build
// concatenates the module ahead of the client with its single `export` line
// stripped. (b) is the decision, and `tests/replay/dom-instantiate.test.js`
// machine-checks that the module stays concatenable — no imports, exactly one
// strippable ESM statement, strict-safe.
//
// The concatenation is wrapped in ONE `'use strict'` IIFE so the module's ~35
// top-level `var`s and helper functions (`bind`, `resolve`, `result`, …) never
// reach the report page's global scope, where they would collide with the
// report's own scripts. The client's own IIFE nests inside it and closes over
// them; `window.initChReplayViewer` is still assigned, which is the whole
// public surface.
//
// FIVE consumers were surveyed at Task 2 and are routed as follows:
//   html-index.js                      → this module (the shipped report)
//   tools/assemble-demo-site.mjs       → this module (writes the ASSEMBLED file,
//                                        which demo/results.js fetches by name)
//   cursor-alignment.battery.mjs       → this module (Task 8's harness)
//   tools/investigate/probe-support.mjs → NOT a consumer of the assembly: it
//                                        extracts the literal `srcdocCsp()` out
//                                        of the client source and needs the raw
//                                        file, not the bundle.
//   tools/investigate/cursor-alignment-probe.mjs → superseded (Task 1).

import { readFileSync } from 'fs';

import { inlineSrcHazards } from '../../shared/inline-safe.js';

// The one ESM statement `dom-instantiate.js` is allowed to carry. The same
// literal appears in that module's own concatenability test; if it drifts, this
// throws rather than shipping a report whose viewer has a stray `export`.
const EXPORT_BLOCK = /^export \{[^}]*\};$/m;

const MODULE_URL = new URL('../../replay/dom-instantiate.js', import.meta.url);
const CLIENT_URL = new URL('./replay-viewer.client.js', import.meta.url);

/**
 * The assembly itself, over sources rather than paths, so every contract the
 * assembled script has to satisfy can be exercised with a constructed
 * violation instead of by editing shipped files.
 *
 * @param {string} mod     src/replay/dom-instantiate.js
 * @param {string} client  src/cli/renderers/replay-viewer.client.js
 * @returns {string} the two inside one strict IIFE
 * @throws {Error} on any of the three contract violations below
 */
export function assembleReplayClientSrc(mod, client) {
  if (!EXPORT_BLOCK.test(mod)) {
    throw new Error(
      'replay-client-source: dom-instantiate.js no longer ends in a single strippable ' +
      '`export { … };` line — the concatenation contract (T5 Task 2) is broken. ' +
      'Fix the module, not this assembler.');
  }
  if (/^\s*import\b/m.test(mod)) {
    throw new Error(
      'replay-client-source: dom-instantiate.js grew an import; a plain script ' +
      'concatenation cannot resolve it.');
  }
  const out = "(function () {\n'use strict';\n" +
    mod.replace(EXPORT_BLOCK, '') + '\n' +
    client + '\n})();\n';
  // Third contract, and the reason it is HERE (T5 Task 10 fix round 3, review
  // I-1): every consumer of this function inlines the result into an HTML
  // `<script>`, and `inlineSafeSrc` — the rule they all apply — neutralises
  // `</script` and cannot neutralise the script-data-ESCAPED breakout. An
  // unpaired `<!--` followed by a `<script`, in a comment or a string, makes
  // the parser swallow the page's own closing tag: the viewer never boots and
  // NOTHING is logged. That is strictly worse than the truncation Task 10
  // fixed, which at least raised a SyntaxError. The escape cannot be widened
  // safely (see inline-safe.js), so the precondition is asserted instead —
  // loudly, at build time, on the day a comment mentioning HTML lands.
  const hazards = inlineSrcHazards(out);
  if (hazards.length) {
    throw new Error(
      'replay-client-source: the assembled viewer cannot be safely inlined into a ' +
      '<script> element — it ' + hazards.join('; and it ') + '. Such a sequence puts ' +
      'the HTML parser into script-data-escaped state, where the report\'s own ' +
      '</script> no longer closes the element and the viewer silently never boots. ' +
      'Reword the source (a comment mentioning HTML is the usual cause); do NOT ' +
      'widen the escape, which would change the meaning of regex literals.');
  }
  return out;
}

/**
 * @returns {string} the viewer script as the report inlines it: the §4
 *   instantiation/patch module and the viewer client inside one strict IIFE.
 */
export function readReplayClientSrc() {
  return assembleReplayClientSrc(
    readFileSync(MODULE_URL, 'utf8'),
    readFileSync(CLIENT_URL, 'utf8'));
}
