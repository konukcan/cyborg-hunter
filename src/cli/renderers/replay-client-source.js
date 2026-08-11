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

// The one ESM statement `dom-instantiate.js` is allowed to carry. The same
// literal appears in that module's own concatenability test; if it drifts, this
// throws rather than shipping a report whose viewer has a stray `export`.
const EXPORT_BLOCK = /^export \{[^}]*\};$/m;

const MODULE_URL = new URL('../../replay/dom-instantiate.js', import.meta.url);
const CLIENT_URL = new URL('./replay-viewer.client.js', import.meta.url);

/**
 * @returns {string} the viewer script as the report inlines it: the §4
 *   instantiation/patch module and the viewer client inside one strict IIFE.
 */
export function readReplayClientSrc() {
  const mod = readFileSync(MODULE_URL, 'utf8');
  const client = readFileSync(CLIENT_URL, 'utf8');
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
  return "(function () {\n'use strict';\n" +
    mod.replace(EXPORT_BLOCK, '') + '\n' +
    client + '\n})();\n';
}
