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
// **A seed may only name nodes the file contains, and never a placeholder.**
// Every entry is a node id, and an id the player never received is worse than a
// missing seed: it either does nothing or lands on the wrong node. The span's
// delivery model (delivery.js) is the file's own record of what went into it,
// so it answers this directly — no re-derivation from a live DOM that may have
// moved since the keyframe walk. Re-deriving was the first version of this
// rule ("is the nearest emitted ancestor this node"), and it broke twice: it
// admitted a node whose exclusion attribute came off after the walk but before
// the observer flush, and it admitted the EXCLUSION PLACEHOLDER ITSELF, whose
// state is precisely what spec §4 withholds. Hence two conditions, delivered
// and not excluded, and `registry.peekId` only for the id.
//
// Redaction (spec §8) subtracts from all four fields rather than emitting
// redacted variants: §3's interface has no room for a redacted entry, and the
// entries are pure identity plus state. A skipped control is also marked in
// the taint set, so a field that spent this keyframe inside a redacted
// container stays withheld after it is moved out.

import {
  isInRedactedSubtree, isRedactionTainted, markRedacted,
} from './redaction.js';
import { isExcluded } from './snapshot.js';

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

function attrOf(el, name) {
  if (typeof el.getAttribute === 'function') return el.getAttribute(name);
  var attrs = el.attributes || [];
  for (var i = 0; i < attrs.length; i++) if (attrs[i].name === name) return attrs[i].value;
  return null;
}

function hasAttr(el, name) { return attrOf(el, name) !== null; }

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

// The id to seed this node under, or null when the seed may not name it.
//
// `holds` is what the file contains, from the file's own record: it rejects
// nodes outside the observed root, scripts, iframe and shadow content,
// everything behind a placeholder, and anything numbered but never emitted —
// all in one lookup, and without asking the live DOM, which can have moved
// since the walk that produced the file.
//
// `isExcluded` is the second condition rather than a consequence of the first,
// because a placeholder IS delivered: spec §4 puts its `id`, `kind` and `tag`
// in the tree and withholds everything else. Its scroll offsets, media
// position and IDL value are that everything else. CH ships this exact shape
// (extension-guard-honeypot.js stamps the marker on the bait INPUT), and
// `keepBait` still turns the legacy markers off here, as everywhere.
function seedableId(node, span, opts) {
  if (!span.delivery.holds(node)) return null;
  if (isExcluded(node, opts)) return null;
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
    // No connectedness check: what belongs in the seed is what the FILE holds,
    // which `seedableId` reads off the span's own record. A node the keyframe
    // emitted stays addressable in the player after the page drops it, and the
    // removal reaches the player as the `dom.remove` the observer is about to
    // emit. Keeping the Set from growing is the tracker's job
    // (capture-trace.js), and its prune of detached elements is why one rarely
    // reaches this loop at all.
    if (!el) return;
    if (isWithheld(el, opts)) return;
    var id = seedableId(el, span, opts);
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
    var id = seedableId(el, span, opts);
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

// Display size, which decides whether the browser auto-selects anything: HTML's
// "ask for a reset" algorithm picks the first non-disabled option only for a
// single-select showing one row. Browsers return the attribute value from
// `el.size`, or 0 when the attribute is absent; happy-dom leaves it undefined
// even with the attribute present, hence the attribute fallback.
function displaySize(el) {
  if (typeof el.size === 'number' && el.size > 0) return el.size;
  var parsed = parseInt(attrOf(el, 'size'), 10);
  return parsed > 0 ? parsed : 1;
}

// Selected option values, and the selection the reconstruction would show on
// its own: options carrying the `selected` ATTRIBUTE, or, for a one-row
// single-select where none does, the first non-disabled option. A list box
// (`size` above 1) and a `multiple` select both start with nothing selected, so
// inventing a default for them would report divergence on an untouched page —
// and one junk entry defeats the whole-object omission.
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
  if (!el.multiple && displaySize(el) === 1 && dflt.length === 0 && firstEnabled) {
    dflt.push(optionValue(firstEnabled));
  }
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
    var id = seedableId(el, span, opts);
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
 * contains. Taken before the walk it returns null, enforced below rather than
 * left to the docblock: without the guard the window scroll still reads, so a
 * wiring slip produces a plausible-looking seed carrying no state at all.
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
  // Numbered nothing means walked nothing: there are no ids to name, so there
  // is no seed to give. (A walked span always numbers at least the root.)
  if (span.registry.count === 0) return null;
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
