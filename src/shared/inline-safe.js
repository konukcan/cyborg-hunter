// src/shared/inline-safe.js
// Putting text inside an HTML `<script>` element safely. TWO rules, because
// there are two kinds of text and one rule for both is wrong in each
// direction. Pure and dependency-free: the CLI renderers, the Playwright
// batteries and the investigation probes all import it.
//
// WHY THIS MODULE EXISTS. Before T5 Task 10 this duty was hand-rolled in nine
// places, and the copy that mattered — the shipped report's — had drifted to
// zero, so every report generated between Task 4 and Task 10 inlined a viewer
// the HTML parser truncated at the first `</script` inside a source COMMENT
// and booted with a SyntaxError and no player. Nine correct copies and one
// missing copy is the same failure the tier read had (fixed by exporting
// `inferTier`), so it gets the same answer.
//
// ── Rule 1, inlineSafeJson: for DATA (a model, a payload) ──────────────────
// Escape EVERY `<` to the six-character JS unicode escape `<`. Inside a
// JSON string literal that is the same character to the JS parser, so the
// value round-trips exactly, and no `<` survives for the HTML tokenizer to
// react to — which covers `</script`, `<!--` and `<script` in one move. This
// is the rule to use whenever the text is untrusted (participant-typed or
// visitor-pasted content reaches the viewer model as DomNode text).
//
// ── Rule 2, inlineSafeSrc: for JS SOURCE ───────────────────────────────────
// Rule 1 cannot be used here: source is not a string literal, so rewriting
// `a < b` to `a < b` is a syntax error. What is safe is neutralising the
// one sequence that can close a `<script>` element — `</script`,
// case-insensitively. `<\/script` is an identity escape inside a string, a
// `\/` inside a regex literal, and raw text inside a comment, so no code
// changes meaning. Nothing wider is safe: `<\script` alters a regex literal
// (`\s` is a character class) and `<\!--` is a SyntaxError under `/u`.
//
// ── The precondition Rule 2 carries, and why the guard below exists ────────
// Rule 2 is complete for the END-TAG class only. An unpaired `<!--` puts the
// tokenizer into script-data-escaped state, and a following `<script` takes it
// to script-data-DOUBLE-escaped state, where the page's own `</script>` no
// longer closes the element — the viewer never boots and, unlike the
// truncation above, NOTHING IS LOGGED. That failure needs no `</script` at
// all. So a consumer that inlines source must also assert the precondition,
// which is what `inlineSrcHazards` is for. Data has no such precondition:
// Rule 1 escapes those sequences too.

/**
 * Inline a value as JSON inside a `<script>`. Use for all DATA.
 * @param {*} value  anything JSON-serialisable
 * @returns {string} the JSON text, with every `<` escaped to `<`
 */
export function inlineSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Inline JavaScript SOURCE inside a `<script>`. Use for source only; pair it
 * with `inlineSrcHazards` (or a caller that has already asserted the
 * precondition — see `readReplayClientSrc`).
 * @param {string} src
 * @returns {string} the source with every `</script` neutralised
 */
export function inlineSafeSrc(src) {
  return String(src ?? '').replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * The sequences `inlineSafeSrc` cannot neutralise. Non-empty means the source
 * must not be inlined as-is: it can silently swallow its own closing tag.
 * @param {string} src
 * @returns {string[]} human-readable reasons, empty when the source is safe
 */
export function inlineSrcHazards(src) {
  const s = String(src ?? '');
  const reasons = [];
  // `<!--` opens script-data-escaped state. A matching `-->` would close it,
  // but "matching" is a tokenizer state question, not a text question, so the
  // safe rule is: no `<!--` in inlined source at all.
  if (/<!--/.test(s)) reasons.push('contains `<!--`, which opens script-data-escaped state');
  // `<script` + whitespace/`/`/`>` is the second half of the double-escape.
  // Harmless on its own, refused anyway: the pair is what bites, and either
  // half arriving alone is one edit away from the other.
  if (/<script[\s/>]/i.test(s)) reasons.push('contains `<script`, the second half of the double-escape');
  return reasons;
}
