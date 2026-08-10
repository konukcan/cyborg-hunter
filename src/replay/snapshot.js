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

import { isRedacted, isInRedactedSubtree } from './redaction.js';

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

function buildAttrs(node, tagName, redacted) {
  var out = {};
  // Images: prefer the resolved `src` property. Reconstruction happens in a
  // document with a different base URL, where the relative stimulus path a
  // page author wrote resolves to nothing.
  var srcOverride = (tagName === 'IMG' && typeof node.src === 'string' && node.src)
    ? node.src : null;
  var wroteSrc = false;

  var attrs = node.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    var name = attrs[i].name;
    var value = attrs[i].value;
    if (!isSerializableAttr(name)) continue;
    // `srcdoc` is a whole HTML document inlined in an attribute, scripts
    // included. Frame content never replays (spec §13), so it buys nothing,
    // and carrying it would make the recording a transport for markup v1 never
    // shipped (v1 swapped the iframe for a bare styled span). Same principle
    // as the on* strip above: a recording gets opened by other tools too.
    if (name === 'srcdoc' && tagName === 'IFRAME') continue;
    // `value` is the one attribute that routinely carries participant-ENTERED
    // content, which is what spec §8 redacts; the rest are author-written page
    // content the recording exists to reconstruct, and stripping them all
    // would leave an unrenderable box where the field was. Known residual
    // (test-pinned in snapshot.test.js): a page that mirrors typed content
    // into some other attribute — a data-* attribute, title, aria-label —
    // leaks it here. Widening the strip is a spec question, not a silent fix.
    if (name === 'value' && redacted) continue;
    if (name === 'src' && srcOverride) { value = srcOverride; wroteSrc = true; }
    out[name] = String(value);
  }
  if (srcOverride && !wroteSrc) out.src = srcOverride;
  if (node.shadowRoot) out[SHADOW_FLAG_ATTR] = '';
  return out;
}

function emitNode(node, registry, opts, inheritedRedaction) {
  if (!node) return null;
  var type = node.nodeType;

  if (type === TEXT_NODE || type === COMMENT_NODE) {
    // Structure survives redaction, content does not: the node keeps its id
    // and position with an empty string, so patches addressing it still land
    // and the reconstruction keeps the same shape. `text` stays present —
    // spec §4 types it as a required string.
    return {
      id: registry.idFor(node),
      kind: type === TEXT_NODE ? 'text' : 'comment',
      text: inheritedRedaction ? '' : String(node.textContent || ''),
    };
  }
  if (type !== ELEMENT_NODE) return null;   // doctype, PI, fragment: no §4 kind

  var tagName = node.tagName || '';
  if (SKIP_TAGS[tagName]) return null;

  var id = registry.idFor(node);
  if (isExcluded(node, opts)) return { id: id, kind: 'element', tag: tagName.toLowerCase() };

  var redacted = inheritedRedaction || isRedacted(node, opts.redactSelector);
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

  // Frames are the element only (spec §13): the child document is a separate
  // browsing context this recorder never observes, and any parser fallback
  // content inside the element was never rendered.
  if (tagName === 'IFRAME') return out;

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
