// src/replay/snapshot.js
// DomNode snapshot serializer for the v2 recording format (spec §4).
//
// Replaces the v1 HTML-string walker (capture-dom.js `serializeDom`) as the
// keyframe producer: a keyframe is now a tree of `{id, kind, ...}` objects,
// and every node carries the integer id that later `dom.*` patches address it
// by. The string walker stays live until Tasks 3/5 retire its remaining
// callers; nothing here imports it.
//
// Three families of node never reach the file, and all three are deliberate:
//   - script/noscript: skipped outright, no node and no placeholder. The
//     player must never see executable content, and an empty <script> element
//     in the tree would be a lie about the page's shape without being useful.
//   - excluded subtrees (spec §4): reduced to a placeholder `{id, kind, tag}`,
//     which keeps sibling positions and event targets coherent.
//   - iframe children (spec §13): frames are recorded as the element only.
// In every case the registry still NUMBERS what is not emitted (assignTree is
// unconditional), so ids stay stable and a later lookup of a hidden node
// resolves — see node-registry.js on "numbered but never emitted".
//
// Which is why the emission rules are not private to the walk: `emitNode`
// branches on `isEmittableNode` / `carriesChildren`, and both — plus
// `nearestEmittedAncestor`, which composes them — are exported for the
// mutation mapper and, later, event-target resolution. One predicate, three
// callers; a second opinion about what reaches the file is how a `dom.remove`
// ends up naming a node the player never received.

import {
  isRedacted, isInRedactedSubtree, markRedacted, isRedactionTainted,
} from './redaction.js';

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;

// Executable or replay-irrelevant: never serialized, in any form.
var SKIP_TAGS = { SCRIPT: true, NOSCRIPT: true };

// HTMLMediaElement tags — the elements spec §5.4's media.* events address and
// the ones §4's `media_src` annotation describes.
var MEDIA_TAGS = { VIDEO: true, AUDIO: true };

// Spec §4's exclusion attribute. Its presence is enough; the value is free.
var EXCLUDE_ATTR = 'data-record-exclude';

// CH-v1's guard-bait markers, still stamped by the honeypot extension
// (extension-guard-honeypot.js). They keep working as exclusion markers, but
// under v2 semantics: a placeholder, not the v1 full drop.
var LEGACY_EXCLUDE_ATTRS = { 'data-ch-role': true, 'data-ch-decoy': true };
var LEGACY_EXCLUDE_ID = 'ch-decoy';

// Shadow hosts keep their LIGHT-DOM children, which are ordinary capturable
// nodes; what the format cannot carry is the shadow ROOT's content (spec §13).
// The flag marks that gap so a player can label it rather than present a
// partial reconstruction as complete. Caveat a player should know: children
// that the shadow tree slots elsewhere are recorded in their light-DOM
// position, because the slot assignment lives in the tree we cannot see.
var SHADOW_FLAG_ATTR = 'data-ch-shadow';

// Valid attribute-name token; also refuses event-handler attributes (on*).
// The player is required not to execute recording content (spec §12), but the
// artifact should not carry handlers at all — a recording gets opened by other
// tools too.
var ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
function isSerializableAttr(name) {
  return ATTR_NAME_RE.test(name) && !/^on/i.test(name);
}

function attrValue(node, name) {
  var attrs = node.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].name === name) return attrs[i].value;
  }
  return null;
}

/**
 * True when this element's contents must not enter the recording.
 *
 * `data-record-exclude` (spec §4) is the primary, researcher-facing control
 * and has no opt-out: it guards consent text and sensitive UI, so a debugging
 * flag must not be able to switch it off. The legacy CH markers are guard bait,
 * and `keepBait` — the v1 analysis override (capture-dom.js `isBait`) — keeps
 * turning exactly those off, unchanged.
 *
 * Exported because the mutation mapper (Task 3) must reach the same verdict:
 * a patch that leaks the contents of a subtree the snapshot placeheld would
 * defeat the exclusion one mutation later.
 */
export function isExcluded(node, opts) {
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  var attrs = node.attributes || [];
  var legacy = false;
  for (var i = 0; i < attrs.length; i++) {
    var name = attrs[i].name;
    if (name === EXCLUDE_ATTR) return true;
    if (LEGACY_EXCLUDE_ATTRS[name]) legacy = true;
  }
  if (opts && opts.keepBait) return false;
  return legacy || node.id === LEGACY_EXCLUDE_ID;
}

// Canvas bitmap size (spec §4). The width/height IDL properties are the
// browser's authoritative numbers and are always present there — a bare
// <canvas> reports the spec default 300x150, which is its real bitmap size, so
// every canvas in a real capture carries the annotation. The attribute
// fallback and the null return exist for duck-typed fixture nodes, where
// guessing 300x150 would claim a size nobody measured.
function canvasSize(node) {
  var w = intOr(node.width, attrValue(node, 'width'));
  var h = intOr(node.height, attrValue(node, 'height'));
  if (w === null || h === null) return null;
  return { w: w, h: h };
}

function intOr(prop, attr) {
  if (typeof prop === 'number' && isFinite(prop)) return prop;
  var parsed = parseInt(attr, 10);
  return isFinite(parsed) ? parsed : null;
}

// Resolved media URL (spec §4). `currentSrc` is what the element actually
// loaded — it resolves <source> children and relative paths, which is what a
// player needs; `src` is the fallback when nothing has loaded yet.
function mediaSrc(node) {
  var src = node.currentSrc || node.src || attrValue(node, 'src');
  return typeof src === 'string' && src ? src : null;
}

// Does a snapshot of this element carry this attribute at all? Split out of
// buildAttrs so the mutation mapper (Task 3) reaches the same verdict for a
// `dom.attr` patch: a patch carrying what the keyframe refuses would leak the
// same content one mutation later.
function isEmittedAttr(tagName, name, redacted) {
  if (!isSerializableAttr(name)) return false;
  // `srcdoc` is a whole HTML document inlined in an attribute, scripts
  // included. Frame content never replays (spec §13), so it buys nothing,
  // and carrying it would make the recording a transport for markup v1 never
  // shipped (v1 swapped the iframe for a bare styled span). Same principle
  // as the on* strip above: a recording gets opened by other tools too.
  if (name === 'srcdoc' && tagName === 'IFRAME') return false;
  // `value` is the one attribute that routinely carries participant-ENTERED
  // content, which is what spec §8 redacts; the rest are author-written page
  // content the recording exists to reconstruct, and stripping them all
  // would leave an unrenderable box where the field was. Known residual
  // (test-pinned in snapshot.test.js and mutations.test.js): a page that
  // mirrors typed content into some other attribute — a data-* attribute,
  // title, aria-label — leaks it here. Widening the strip is a spec question,
  // not a silent fix.
  if (name === 'value' && redacted) return false;
  return true;
}

// The value a snapshot carries for an attribute it does emit. Images prefer
// the resolved `src` PROPERTY: reconstruction happens in a document with a
// different base URL, where the relative stimulus path a page author wrote
// resolves to nothing.
function emittedAttrValue(node, tagName, name, raw) {
  if (name === 'src' && tagName === 'IMG' &&
      typeof node.src === 'string' && node.src) return node.src;
  return String(raw);
}

function buildAttrs(node, tagName, redacted) {
  var out = {};
  var wroteSrc = false;

  var attrs = node.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    var name = attrs[i].name;
    if (!isEmittedAttr(tagName, name, redacted)) continue;
    out[name] = emittedAttrValue(node, tagName, name, attrs[i].value);
    if (name === 'src') wroteSrc = true;
  }
  if (!wroteSrc && tagName === 'IMG' && typeof node.src === 'string' && node.src) {
    out.src = node.src;
  }
  if (node.shadowRoot) out[SHADOW_FLAG_ATTR] = '';
  return out;
}

/**
 * Sentinel: this attribute never reaches the file, so there is no patch to
 * emit for it — distinct from a `null` VALUE, which is spec §5.1's encoding
 * for "the attribute was removed".
 */
export var ATTR_WITHHELD = { withheld: true };

/**
 * The `value` a `dom.attr` patch should carry for this attribute right now,
 * or ATTR_WITHHELD when a snapshot would not carry the attribute at all.
 *
 * @param {object} node      the mutated element
 * @param {string} name      the mutated attribute
 * @param {boolean} redacted whether the element sits in a redacted subtree
 */
export function attrPatchValue(node, name, redacted) {
  var tagName = node.tagName || '';
  if (!isEmittedAttr(tagName, name, redacted)) return ATTR_WITHHELD;
  var raw = attrValue(node, name);
  if (raw === null) return null;               // removed (spec §5.1)
  return emittedAttrValue(node, tagName, name, raw);
}

/**
 * Every attribute a snapshot of this element would carry, with its values —
 * the set an exclusion transition has to clear or restore wholesale.
 */
export function emittedAttrs(node, redacted) {
  return buildAttrs(node, node.tagName || '', redacted);
}

/**
 * Can this node appear in the file at all, wherever it sits? Elements the
 * serializer skips outright (script/noscript) and node kinds spec §4 gives no
 * `kind` to (doctype, processing instruction, fragment) cannot.
 *
 * Half of the emission rule; `carriesChildren` is the other half. Both are
 * exported and both are what `emitNode` itself branches on, so "would this
 * node be in the file" has exactly one answer in this codebase.
 */
export function isEmittableNode(node) {
  if (!node) return false;
  var type = node.nodeType;
  if (type === TEXT_NODE || type === COMMENT_NODE) return true;
  if (type !== ELEMENT_NODE) return false;
  return !SKIP_TAGS[node.tagName || ''];
}

/**
 * Does an emitted element carry its children into the file? Exclusion
 * placeholders and iframes do not.
 *
 * `excluded` is a PARAMETER rather than a lookup because the mutation mapper
 * has to ask about the state one mutation ago: when `data-record-exclude`
 * lands on a live element, the DOM already reads "placeholder" while the file
 * still holds the children the mapper must now remove.
 */
export function carriesChildren(el, excluded) {
  if (!el || el.nodeType !== ELEMENT_NODE) return false;
  if (excluded) return false;
  // Frames are the element only (spec §13): the child document is a separate
  // browsing context this recorder never observes, and any parser fallback
  // content inside the element was never rendered.
  return (el.tagName || '') !== 'IFRAME';
}

/**
 * The nearest ancestor-or-self of `node` that the file actually contains, or
 * null when nothing on the path to `root` does (including `node` being outside
 * the observed root entirely).
 *
 * Two callers, two readings of the same answer:
 *   - event targets and anchors (Task 5) take the returned node as their
 *     reference — a target inside an excluded subtree resolves to the
 *     placeholder, exactly as spec §7 requires;
 *   - `dom.remove` (mutations.js) emits only when the answer IS the node,
 *     because removing something the player never received is at best a
 *     no-op and at worst (resolved to a placeholder) deletes the wrong node.
 *
 * `registry.peekId` answers "was it numbered", which is not the same question:
 * assignTree numbers unconditionally, so scripts and hidden subtrees peek
 * non-null. This function is the missing half, and it is built from the same
 * predicates `emitNode` branches on rather than re-deriving them.
 *
 * @param {object} node
 * @param {object} root             the observed root
 * @param {object} [opts]           {keepBait} — exclusion depends on it
 * @param {object} [detachedParent] the parent a just-REMOVED node had, since
 *                                  its own `parentNode` is already null
 */
export function nearestEmittedAncestor(node, root, opts, detachedParent) {
  if (!node || !root) return null;
  opts = opts || {};
  var chain = [];
  var cur = node;
  while (cur && cur !== root) {
    chain.push(cur);
    var parent = cur.parentNode;
    if (!parent && chain.length === 1 && detachedParent) parent = detachedParent;
    cur = parent;
  }
  if (cur !== root || !isEmittableNode(root)) return null;

  var emitted = root;
  for (var i = chain.length - 1; i >= 0; i--) {
    if (!carriesChildren(emitted, isExcluded(emitted, opts))) return emitted;
    if (!isEmittableNode(chain[i])) return emitted;
    emitted = chain[i];
  }
  return emitted;
}

function emitNode(node, registry, opts, inheritedRedaction) {
  if (!isEmittableNode(node)) return null;
  var type = node.nodeType;
  // Redaction travels WITH the node, not with its current position: a node
  // this recording once stripped stays stripped even after it is moved out of
  // the redacted subtree (redaction.js on the taint set). Every node emitted
  // under redaction joins the set here, which is the one place that knows.
  if (!inheritedRedaction && isRedactionTainted(node, opts.taint)) inheritedRedaction = true;

  if (type === TEXT_NODE || type === COMMENT_NODE) {
    // Structure survives redaction, content does not: the node keeps its id
    // and position with an empty string, so patches addressing it still land
    // and the reconstruction keeps the same shape. `text` stays present —
    // spec §4 types it as a required string.
    if (inheritedRedaction) markRedacted(node, opts.taint);
    return {
      id: registry.idFor(node),
      kind: type === TEXT_NODE ? 'text' : 'comment',
      text: inheritedRedaction ? '' : String(node.textContent || ''),
    };
  }
  var tagName = node.tagName || '';
  var id = registry.idFor(node);
  if (isExcluded(node, opts)) return { id: id, kind: 'element', tag: tagName.toLowerCase() };

  var redacted = inheritedRedaction || isRedacted(node, opts.redactSelector);
  if (redacted) markRedacted(node, opts.taint);
  var out = {
    id: id,
    kind: 'element',
    tag: tagName.toLowerCase(),
    attrs: buildAttrs(node, tagName, redacted),
    children: [],
  };

  var size = tagName === 'CANVAS' ? canvasSize(node) : null;
  if (size) out.canvas_size = size;
  // Withheld inside a redacted subtree: `currentSrc` is a RESOLVED url that no
  // attribute need contain — a blob/object URL for participant-supplied media
  // is the case that matters — so this annotation can expose what buildAttrs
  // does not. (The plain `src` attribute is still emitted; see there.)
  var src = MEDIA_TAGS[tagName] && !redacted ? mediaSrc(node) : null;
  if (src) out.media_src = src;

  // Not excluded here (that returned above), so this is the iframe rule.
  if (!carriesChildren(node, false)) return out;

  var kids = node.childNodes || [];
  for (var i = 0; i < kids.length; i++) {
    var child = emitNode(kids[i], registry, opts, redacted);
    if (child) out.children.push(child);
  }
  return out;
}

/**
 * Serialize a subtree into the DomNode tree of a keyframe (spec §4).
 *
 * @param {object} root      the observed root (or, mid-span, an inserted subtree)
 * @param {object} registry  a node-registry (node-registry.js) — supplies the ids
 * @param {object} [opts]    {keepBait, redactSelector}
 * @returns {object|null}    the root DomNode; null if the root itself is unserializable
 *
 * Registry contract: the whole tree is numbered FIRST, in one unconditional
 * pre-order pass, and only then walked for emission. That ordering is what
 * makes ids independent of serialization decisions — a node hidden behind an
 * exclusion placeholder or skipped as a script still holds its number, so
 * removing an exclusion attribute later does not renumber its siblings.
 *
 * `resetSpan` is the CALLER's call (keyframe cadence, Task 8): this function
 * only ever adds to the current span. Calling it at a keyframe means calling
 * `registry.resetSpan()` first, so that this walk is the span's first
 * allocation and the tree numbers 1..N (the precondition node-registry.js
 * documents).
 */
export function serializeTree(root, registry, opts) {
  opts = opts || {};
  if (!root) return null;
  registry.assignTree(root);
  // Ancestors above the root count: a redaction selector matching a wrapper
  // outside the observed root still redacts everything inside it.
  return emitNode(root, registry, opts, isInRedactedSubtree(root, opts.redactSelector));
}
