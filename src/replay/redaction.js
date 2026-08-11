// src/replay/redaction.js
// Redaction predicates, shared by every capture path.
//
// Spec §8 makes redaction a property of the FILE, not of one capture channel:
// a redacted subtree's content must not appear in `initial_dom`, in
// `initial_state.form`, in `dom.text`/`dom.attr`, in key identities, in
// clipboard payloads, or in anchor identity. A single predicate is what makes
// that claim checkable — v1 had two implementations (capture-trace's
// `inRedactedSubtree`, capture-dom's `isInRedactedSubtree`) with different
// signatures and quietly different password detection, so "is this node
// redacted" could be answered two ways in one recording.
//
// The unified definition takes the SELECTOR (the actual configuration datum),
// not an options bag, so both capture modules call it the same way:
//   capture-trace: isInRedactedSubtree(el, config.redactSelector)
//   snapshot/dom:  isInRedactedSubtree(node, opts.redactSelector)
//
// Adoption: complete. Every capture path — the snapshot walk, the mutation
// mapper, the keyframe seed and event capture — asks this module, and the v1
// duplicates it replaced are gone. The password check is the union of what the
// two of them used to do separately (property OR attribute), which is why the
// predicate is broader than either was.

var ELEMENT_NODE = 1;

// Nodes whose content this recording has ever withheld. Redaction is a
// property of the FILE (spec §8), and the DOM only knows the present: a node
// that spent the trial inside a redacted container and is then moved OUT of
// it would serialize its accumulated content into the very next `dom.add`,
// putting in the file exactly the text the keyframe refused. Membership is
// therefore permanent for the life of the page, not scoped to a keyframe
// span: a whole-file leak scan reads every segment.
//
// A module-level WeakSet, so the protection is on by default and no wiring
// step can forget it. It holds no node alive, and it is keyed by node
// IDENTITY, so two recorders on one page (or two tests in one process) can
// only ever over-redact each other's nodes, never under-redact. Callers that
// want their own scope may pass one in.
var defaultTaint = new WeakSet();

// How many nodes the SHARED set has ever withheld. A WeakSet has no `size`, so
// a counter is the only way to answer the one question a later recording needs
// to ask: did this page withhold anything before I started? Its answer travels
// as `extensions["cyborg-hunter"].inherited_redaction_taint`, because an empty
// field in a second recording otherwise means two things the file cannot
// distinguish — the participant typed nothing, or an earlier recording on this
// page withheld it.
//
// Monotonic on purpose. GC can drop entries from the WeakSet, but a node that
// became unreachable can never be encountered again, so "has ever withheld" is
// the question with a stable answer.
var defaultTaintMarks = 0;

function taintSet(taint) {
  return taint && typeof taint.has === 'function' ? taint : defaultTaint;
}

/**
 * Record that this node's content was withheld, so every later channel keeps
 * withholding it. Called wherever the withholding happens: the snapshot walk
 * stripping a subtree, a suppressed `dom.text`, a withheld `value` patch.
 */
export function markRedacted(node, taint) {
  if (node) {
    var set = taintSet(taint);
    if (set === defaultTaint) defaultTaintMarks++;
    set.add(node);
  }
  return node;
}

/**
 * True when the page's shared taint set has withheld something already. Read
 * once, at `startSession`, so a recording can state whether it inherited
 * withholding from an earlier one on the same page (see the counter above).
 */
export function hasInheritedRedactionTaint() {
  return defaultTaintMarks > 0;
}

/** True when this node's content has ever been withheld (see markRedacted). */
export function isRedactionTainted(node, taint) {
  return !!node && taintSet(taint).has(node);
}

function hasTypePasswordAttr(el) {
  var attrs = el.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].name === 'type') return attrs[i].value === 'password';
  }
  return false;
}

/**
 * The spec §8 floor: `<input type="password">` values are never recorded, in
 * any channel, and no configuration can turn that off.
 *
 * Property OR attribute: the `type` IDL property is the browser's answer, but
 * it is absent on duck-typed fixture nodes and reads "text" for an unknown
 * type — so a field the page author wrote as `type="password"` must be caught
 * by the attribute too. Detection stays declarative (spec §8): a name or
 * placeholder that merely looks password-ish is not a password field.
 */
export function isPasswordField(el) {
  if (!el || el.tagName !== 'INPUT') return false;
  return el.type === 'password' || hasTypePasswordAttr(el);
}

/**
 * True when this element is itself redacted: a password field (always) or a
 * match for the researcher-configured redaction selector.
 *
 * A selector that throws (invalid syntax) redacts nothing rather than
 * everything — the alternative is a typo silently emptying a whole recording.
 */
export function isRedacted(el, selector) {
  if (isPasswordField(el)) return true;
  if (!selector || !el || typeof el.matches !== 'function') return false;
  try { return el.matches(selector); } catch (e) { return false; }
}

/**
 * True when the node is a redacted element or lives inside one.
 *
 * The ancestor walk is what makes redaction a subtree property: text nodes and
 * comments have no `matches()` of their own, so typed content under a redacted
 * container (a contenteditable, a wrapper div matched by the selector) is only
 * caught by asking about its ancestors. Elements above the observed root count
 * too — the walk follows `parentNode` as far as it goes.
 */
export function isInRedactedSubtree(node, selector) {
  var cur = node;
  while (cur) {
    if (cur.nodeType === ELEMENT_NODE && isRedacted(cur, selector)) return true;
    cur = cur.parentNode;
  }
  return false;
}
