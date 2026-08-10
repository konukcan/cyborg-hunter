// src/replay/initial-state.js
// Keyframe replay-state seeds (spec §3 `initial_state`).
//
// A DomNode tree is not a replay checkpoint on its own. It carries the page's
// STRUCTURE, and structure is where the participant's state mostly is not:
// how far a scroll container was scrolled, where a video sits, what is typed
// into a field the page author never wrote a `value` attribute for. All of
// that was established BEFORE the keyframe, so no mutation in the segment will
// ever restore it — a player seeking to the keyframe would show a page the
// participant never saw. `initial_state` is the missing half.
//
// Two properties shape everything here.
//
// **Only divergence is worth seeding.** The keyframe tree already carries the
// `value`, `checked` and `selected` ATTRIBUTES, so a control still at its
// default is restored for free by the reconstruction. What the tree cannot
// carry is the IDL state that diverged from those attributes, which is exactly
// the participant's contribution. The same reasoning gives the spec's
// omit-when-all-default rule its meaning (§3: keyframes MUST carry the seed
// "whenever any of that state is non-default"): default is the state a player
// reaches by rebuilding the tree and touching nothing.
//
// **A seed may only name nodes the file contains.** Every entry is a node id,
// and an id the player never received is worse than a missing seed — it either
// does nothing or lands on the wrong node. Membership is decided by
// `nearestEmittedAncestor` (snapshot.js), the same predicate the snapshot walk
// and the mutation mapper branch on, rather than by a second opinion: a node
// is seedable when the nearest ancestor the file holds IS the node itself.
// `registry.peekId` answers a different question ("was it numbered"), and
// numbered-but-never-emitted is a whole population here — scrollers behind an
// exclusion placeholder, controls inside an iframe, anything outside the
// observed root.
//
// Redaction (spec §8) subtracts from all four fields rather than emitting
// redacted variants: §3's interface has no room for a redacted entry, and the
// entries are pure identity plus state. A skipped control is also marked in
// the taint set, so a field that spent this keyframe inside a redacted
// container stays withheld after it is moved out.

import {
  isInRedactedSubtree, isRedactionTainted, markRedacted,
} from './redaction.js';
import { nearestEmittedAncestor } from './snapshot.js';

var MEDIA_SELECTOR = 'video, audio';
var FORM_SELECTOR = 'input, textarea, select';

// Never seeded, whatever their state: password values are the spec §8 floor
// (already caught by the redaction predicate — this is where the READER looks
// for it), and file inputs are spec §13's "never recorded", where browsers
// hand out a fake path rather than an empty string.
var SKIP_INPUT_TYPES = { password: true, file: true };

function round(v) { return Math.round(v); }
// Media positions are seconds; three decimals is millisecond resolution, and
// keeps a 17-digit float out of the wire.
function r3(v) { return Math.round(v * 1000) / 1000; }

function hasAttr(el, name) {
  if (typeof el.hasAttribute === 'function') return el.hasAttribute(name);
  var attrs = el.attributes || [];
  for (var i = 0; i < attrs.length; i++) if (attrs[i].name === name) return true;
  return false;
}

// Elements of interest under the observed root, in document order. The root
// itself counts: a recording whose observed root IS the scrollable pane or the
// media element is legal.
function collect(root, selector) {
  var out = [];
  if (typeof root.matches === 'function') {
    try { if (root.matches(selector)) out.push(root); } catch (e) { /* not a real element */ }
  }
  if (typeof root.querySelectorAll !== 'function') return out;
  var found = root.querySelectorAll(selector);
  for (var i = 0; i < found.length; i++) out.push(found[i]);
  return out;
}

// The id to seed this node under, or null when the file does not contain it.
// Both halves are load-bearing: nearestEmittedAncestor rejects nodes the
// serializer skipped or placeheld, peekId rejects nodes never numbered at all
// (and is the id itself).
function seedableId(node, root, span, opts) {
  if (nearestEmittedAncestor(node, root, opts) !== node) return null;
  return span.registry.peekId(node);
}

// Redacted for seeding purposes: inside a redacted subtree right now, or
// content this recording has already withheld (the taint set). Marking on the
// way out is what keeps the second case true later.
function isWithheld(el, opts) {
  if (isInRedactedSubtree(el, opts.redactSelector) || isRedactionTainted(el, opts.taint)) {
    markRedacted(el, opts.taint);
    return true;
  }
  return false;
}

// ── per-field builders ─────────────────────────────────────────────────────

// Tracked scrollers, in the order they first scrolled. Entries at the origin
// are skipped for the same reason the whole object is omitted when everything
// is default: a freshly rebuilt DOM is already at 0/0.
function elementScroll(root, span, opts) {
  var out = [];
  var scrolled = opts.scrolled;
  if (!scrolled || typeof scrolled.forEach !== 'function') return out;
  scrolled.forEach(function (el) {
    // No connectedness check: an element removed from the document is no
    // longer a descendant of the observed root, so the seedable-ness rule
    // below already drops it — and asking twice would ALSO drop the case where
    // the observed root itself is detached, whose tree the keyframe did
    // serialize and whose scroll offsets therefore do belong in the seed.
    // Keeping the Set from growing is the tracker's job (capture-trace.js).
    if (!el) return;
    if (isWithheld(el, opts)) return;
    var id = seedableId(el, root, span, opts);
    if (id === null) return;
    var x = round(el.scrollLeft || 0);
    var y = round(el.scrollTop || 0);
    if (x === 0 && y === 0) return;
    out.push({ node: id, x: x, y: y });
  });
  return out;
}

function media(root, span, opts) {
  var out = [];
  var els = collect(root, MEDIA_SELECTOR);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (isWithheld(el, opts)) continue;
    var id = seedableId(el, root, span, opts);
    if (id === null) continue;
    var time = typeof el.currentTime === 'number' && isFinite(el.currentTime)
      ? r3(el.currentTime) : 0;
    // Absent `paused` reads as paused: that is the default for a media element
    // nothing has played, and the direction that seeds nothing.
    var paused = el.paused !== false;
    if (time === 0 && paused) continue;
    out.push({ node: id, current_time: time, paused: paused });
  }
  return out;
}

// The value a rebuilt DOM would show for this control. A missing IDL default
// (duck-typed node) reads as empty, so anything the element actually holds
// counts as divergence rather than being silently dropped.
function defaultValueOf(el) {
  return typeof el.defaultValue === 'string' ? el.defaultValue : '';
}

function optionValue(option) {
  if (typeof option.value === 'string') return option.value;
  return String(option.textContent || '');
}

// Selected option values, and the selection the reconstruction would show on
// its own: options carrying the `selected` ATTRIBUTE, or — for a single-select
// where none does — the first non-disabled option, which is what the browser
// selects for an untouched dropdown.
function selectDivergence(el) {
  var options = el.options ? Array.prototype.slice.call(el.options) : [];
  var current = [];
  var dflt = [];
  var firstEnabled = null;
  for (var i = 0; i < options.length; i++) {
    var option = options[i];
    if (option.selected) current.push(optionValue(option));
    if (hasAttr(option, 'selected')) dflt.push(optionValue(option));
    if (firstEnabled === null && !option.disabled) firstEnabled = option;
  }
  if (!el.multiple && dflt.length === 0 && firstEnabled) dflt.push(optionValue(firstEnabled));
  if (current.length === dflt.length && current.every(function (v, i2) { return v === dflt[i2]; })) {
    return null;
  }
  return { selected: current };
}

// The state of one control, or null when it matches what the tree restores.
function formDivergence(el) {
  var tag = el.tagName;
  if (tag === 'SELECT') return selectDivergence(el);
  if (tag === 'INPUT') {
    var type = String(el.type || 'text').toLowerCase();
    if (SKIP_INPUT_TYPES[type]) return null;
    if (type === 'checkbox' || type === 'radio') {
      // `checked` is the whole state of a box; its `value` is the author's
      // submit token, which the tree already carries as an attribute.
      return !!el.checked === !!el.defaultChecked ? null : { checked: !!el.checked };
    }
  }
  var value = typeof el.value === 'string' ? el.value : String(el.value == null ? '' : el.value);
  return value === defaultValueOf(el) ? null : { value: value };
}

function form(root, span, opts) {
  var out = [];
  var els = collect(root, FORM_SELECTOR);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    // The spec §8 floor lives in redaction.js's isPasswordField, which this
    // walk reaches through isInRedactedSubtree(el) — the element itself is the
    // first link of that ancestor chain.
    if (isWithheld(el, opts)) continue;
    var id = seedableId(el, root, span, opts);
    if (id === null) continue;
    var state = formDivergence(el);
    if (!state) continue;
    // `node` first on the wire, matching the fixture's reading order.
    out.push(Object.assign({ node: id }, state));
  }
  return out;
}

/**
 * Build the `initial_state` seed for a keyframe segment (spec §3).
 *
 * CALL ORDER: after the keyframe's `serializeTree` on the SAME span. The seed
 * names nodes by the ids that walk assigned, and asks the span what the file
 * contains; taken before the walk it would seed nothing at all.
 *
 * @param {object} root   the observed root, as serialized
 * @param {object} span   the capture span (span.js) the keyframe was taken on
 * @param {object} [opts]
 *   `win`            window-ish {scrollX, scrollY}; defaults to the real
 *                    window, and a missing one reads as the scroll origin
 *   `scrolled`       the tracker's Set of elements that have scrolled
 *                    (capture-trace.js `getScrolledElements()`); iterated in
 *                    first-scroll order, never mutated here
 *   `keepBait`       exclusion override, as everywhere else
 *   `redactSelector` §8 redaction selector
 *   `taint`          §8 taint set (redaction.js); shared with the snapshot
 * @returns {object|null} the InitialState, or null when every field is at its
 *   default — the spec's omit rule, and the jsPsych-adapter case in general
 *   (a wiped display starts every segment at defaults, so that path simply
 *   never calls this).
 */
export function buildInitialState(root, span, opts) {
  opts = opts || {};
  if (!root || !span) return null;
  var win = opts.win !== undefined
    ? opts.win : (typeof window !== 'undefined' ? window : null);
  var scroll = {
    x: win ? round(win.scrollX || 0) : 0,
    y: win ? round(win.scrollY || 0) : 0,
  };
  var state = {
    scroll: scroll,
    element_scroll: elementScroll(root, span, opts),
    media: media(root, span, opts),
    form: form(root, span, opts),
  };
  if (scroll.x === 0 && scroll.y === 0 && !state.element_scroll.length &&
      !state.media.length && !state.form.length) {
    return null;
  }
  return state;
}
