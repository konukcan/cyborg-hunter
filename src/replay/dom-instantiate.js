// src/replay/dom-instantiate.js
// SessionRecording v2 keyframe (a DomNode tree, spec §4) → real DOM inside the
// reconstruction frame, plus the `Map<number, Node>` every `dom.*` patch
// (§5.1), every event `target`, and every `anchor.node` (§6) resolves through —
// and, since T5 Task 3, the application of those four patches through that map.
//
// Instantiation and patching live together because they are ONE READING OF §4.
// `dom.add` instantiates a subtree into the same id map, reverse index and
// canvas map a keyframe fills, and its namespace, its §12 filters and its
// tolerance for malformed nodes are the keyframe walk's, not a second set that
// happens to agree today. Splitting them would create the drift this migration
// exists to remove. (The concatenation contract below is a second, weaker
// reason: a separate module would have to import this one, and while an
// assembler that strips one export line could strip two, the reading argument
// stands on its own.)
//
// THIS IS WHERE THE HTML-STRING ERA ENDS, and that is a security result rather
// than a refactor. v1 built the reconstruction by interpolating a captured HTML
// string into the frame's `srcdoc` and applied child-list patches with
// `innerHTML`. Nothing here parses markup: every node is created by name and
// every attribute set by `setAttribute`, so `</script>` breakouts,
// attribute-escaping bugs and parser-normalisation drift (nested forms, table
// fostering, duplicate ids — the reason v1's reference resolution needed a
// tag-validated path fallback) stop being defended against and start being
// impossible. The claim the dogfood suite used to make — "injected markup
// arrives defanged" — becomes the stronger "injected markup is never parsed".
//
// Recording content is UNTRUSTED (spec §12): attacker-controlled DOM, CSS and
// URLs. CH's own capture already withholds `on*` handlers and iframe `srcdoc`,
// but a conforming file from a foreign producer is not bound by CH's capture
// rules, so the filters below are a PLAYER duty and are applied to every file.
//
// PURE and BROWSER-SAFE: no Node APIs, no imports, and — see the export block
// at the bottom — exactly one line of ESM syntax. The report's viewer client
// (`src/cli/renderers/replay-viewer.client.js`) is a plain IIFE inlined
// verbatim into the report and cannot `import`, so the build CONCATENATES this
// module ahead of it with that one line stripped (T5 Task 2's recorded
// decision; `tests/replay/dom-instantiate.test.js` machine-checks that the
// source stays concatenable and strict-safe). The alternative — the client
// carrying its own copy — would put two readings of §4 in the repo, which is
// the failure this whole migration exists to remove. Style follows the client
// and `snapshot.js` (`var`, `function`) for the same reason.

// Spec §4's exclusion placeholder is `{id, kind, tag}` with the `attrs` and
// `children` keys ABSENT, so `attrs || {}` and `children || []` below ARE the
// placeholder handling: a bare, empty element of that tag, holding its id and
// its sibling position. It is written as a fallback rather than a branch
// because that is exactly what it is, and because the fork crashed on the
// shape when it read the keys as required.

// Executable content never enters the reconstruction as itself. A foreign
// producer may serialise `script`/`noscript` (CH's own capture skips them
// outright); they are instantiated as inert `<template>`s, which the UA never
// renders and never runs, so ids and sibling positions stay coherent instead
// of the tree developing a hole a later patch would miss. Their children are
// instantiated too — the source text keeps its id, so a later `dom.text` still
// lands. WHERE those children sit is realm-dependent and deliberately not
// relied on: happy-dom routes `appendChild` on a template into `content`,
// browsers keep it in `childNodes`, and neither is rendered or executed.
var INERT_TAGS = { script: true, noscript: true };

// Attributes whose value is a URL the browser will follow. Everything else is
// page content: a `title` that reads like a `javascript:` URL is text.
var URL_ATTRS = {
  href: true, src: true, action: true, formaction: true, 'xlink:href': true,
};

// The XML `Name` production, ASCII subset — the same predicate capture uses in
// `isSerializableAttr` (`snapshot.js`), duplicated rather than imported because
// this file must survive concatenation as a plain script (header). It gates
// both attribute names and element tags.
//
// WHY IT IS HERE, corrected in fix round 1 after measurement. The first version
// of this comment said a real browser's `setAttribute` throws
// `InvalidCharacterError` on a name outside this production. It does not:
// chromium, firefox and webkit all accept `setAttribute('<', 'v')`, and all
// three mount `jspsych-full`'s malformed free-sort node unfiltered. happy-dom
// 20.9.0 is the realm that throws on it. Three reasons survive, and they are
// the reasons the filter stays:
//   1. REALM DETERMINISM. The reconstruction runs in happy-dom under `npm
//      test`, in three browser engines under the Task-8 battery, and in the
//      analyst's browser in production. A viewer whose tree depends on which
//      one is executing cannot be a conformance player. Filtering by a fixed
//      predicate gives one answer everywhere; deferring to the host gives
//      three.
//   2. PARITY WITH CAPTURE. CH's own recorder refuses the same names, so a CH
//      file can never carry one. Sharing the predicate is what makes the
//      corpus pin (`['<']`, exactly one attribute) mean something.
//   3. SOME NAMES REALLY DO ABORT. Every engine measured, happy-dom included,
//      throws on a whitespace-bearing name such as `a b`. A player with no
//      name filter loses the whole mount on a hostile file. Same for tags:
//      `createElement('')`, `('<div')`, `('a b')` and `('1abc')` all throw in
//      browsers, and happy-dom throws on `''` alone — the divergence reason 1
//      exists for.
// The cost is real and is recorded rather than hidden: the engines accept
// `@click`, `[ngModel]`, `(click)`, `*ngIf`, `1x` and `café`, and this drops
// them all. CH files never carry them; foreign producers might.
var NAME_TOKEN_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

// Tags only, on top of the Name production: the XML namespace prefixes are
// RESERVED, and `createElementNS` enforces that where `createElement` does not.
// Measured tri-engine (playwright-core 1.62.1): `createElementNS(<any ns>,
// 'xml:foo' | 'xmlns:foo' | 'xmlns')` throws `NamespaceError` on chromium,
// firefox and webkit, while happy-dom 20.9.0 accepts all three — so without
// this line a foreign `svg` subtree carrying one aborts the whole mount in the
// analyst's browser and passes every node test. `a:b` and a bare `xml` are
// legal everywhere and stay legal. Case is not part of the rule but is not a
// gap either: the walk lowercases a tag before creating it, so `XML:Foo`
// reaches `createElementNS` as `xml:foo` and is caught here.
//
// It gates TAGS ONLY, deliberately. `setAttribute` does no namespace
// validation, so `xmlns:xlink="…"` — which real SVG markup carries — sets
// fine and is kept.
var RESERVED_TAG_PREFIX_RE = /^(?:xml|xmlns):|^xmlns$/;

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;

// Foreign content (spec-r3 gap, recorded). Spec §4's DomNode carries no
// namespace, so a player has to infer one, and `createElement` alone cannot
// reconstruct SVG at all: an `svg > circle` built that way lands in the XHTML
// namespace and lays out at 0×0, where the same markup PARSED lands in the SVG
// namespace and lays out at its viewport. v1 built the reconstruction from an
// HTML string and got the parser's foreign-content rules for free; this module
// has to state them. The rule below is the parser's, reduced to what a keyframe
// can express: an `svg` or `math` element opens its namespace, descendants
// inherit it, and the SVG HTML-integration points hand their children back to
// XHTML.
//
// Known incompleteness, both of them format-level rather than player-level:
// capture lowercases every tag (`snapshot.js`), so camelCase SVG children
// (`linearGradient`, `clipPath`) and `foreignObject` itself arrive folded and
// cannot be re-cased from the file; and MathML's own integration points
// (`annotation-xml`, `mi`/`mo`/`mn`/`ms`/`mtext`) are not modelled. Both belong
// in the spec-r3 conversation, not in a workaround here.
var XHTML_NS = 'http://www.w3.org/1999/xhtml';
var SVG_NS = 'http://www.w3.org/2000/svg';
var MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
var FOREIGN_ROOTS = { svg: SVG_NS, math: MATHML_NS };
var SVG_HTML_INTEGRATION = { foreignobject: true, desc: true, title: true };

// Stamped on elements the format cannot carry the content of (spec §12/§13),
// so the shell stylesheet can outline the region and the header chip can count
// it. Only iframes need it today: their content is a separate browsing context
// no recorder observes.
var PLACEHOLDER_ATTR = 'data-ch-placeholder';

// Capture's own flag for a shadow host (`snapshot.js`, spec §13): the light-DOM
// children are ordinary capturable nodes, the shadow ROOT's content is not.
var SHADOW_ATTR = 'data-ch-shadow';

// The canvas-presentation key (design §3.1, route 2). A script-less sandboxed
// frame holds canvas pixels it never paints, so `canvas.snapshot` composites in
// a parent-owned offscreen canvas and is PRESENTED as a background image. The
// viewer stamps this name on the canvas it composites into and matches it from
// a rule in the shell head; `CANVAS_RULE_ATTR` marks the rule element itself.
// Presenting through the head instead of the element's inline `style` is what
// makes the presentation survive a recorded `dom.attr` naming `style` — per
// CSSOM that write replaces the whole inline declaration block.
var CANVAS_ATTR = 'data-ch-canvas';
var CANVAS_RULE_ATTR = 'data-ch-canvas-rule';

// VIEWER-OWNED ATTRIBUTES. These names are not page content: they are what
// the reconstruction says about ITSELF, and the viewer's chips read them back
// out of the live DOM — the iframe/placeholder chip through
// `iframe, [data-ch-placeholder="iframe"]`, the shadow chip through
// `[data-ch-shadow]`. So a recording that could write them would be choosing
// what the viewer reports about the reconstruction, and the failure runs in
// BOTH directions:
//
//   FORGE — stamping `data-ch-placeholder` on any element fakes a "content was
//     here" outline and chip over a region that was fully captured. Both names
//     pass the Name-production filter, so nothing else stops it.
//   STRIP — `dom.attr` with `value: null` reaches `removeAttribute`, which
//     validates nothing in any realm (that is why the removal path carries no
//     name filter), so a recording can delete a flag the viewer itself applied.
//     This is the worse half: hiding the shadow chip turns spec §13's "absence
//     of evidence is not evidence of absence" into silence, and an analyst
//     reads an empty region as an empty region.
//
// ONE predicate therefore gates BOTH verbs on BOTH paths — the keyframe walk
// and `dom.attr` — and the viewer re-stamps the flags itself from the DomNode
// data (below). A recording can still CLAIM a shadow host in a keyframe, which
// is exactly what capture's own flag is; what it cannot do is move, invent or
// erase the claim afterwards.
//
// Scoped to the names the viewer stamps, NOT to the whole `data-ch-*`
// namespace: `data-ch-redact` is the researcher's own marker on their own page
// and is serialised into keyframes, and the honeypot's `data-ch-role` /
// `data-ch-decoy` are page-authored too. Dropping those would delete
// attributes the page really had and silently break any CSS keyed on them.
//
// The canvas pair joined the set in T5.5 for a reason with more teeth than the
// chips': `data-ch-canvas` is the SELECTOR the presented composite is keyed on,
// so a recording that could strip it would blank a canvas the analyst is
// looking at, and one that could forge it would paint another element with a
// canvas's pixels.
var VIEWER_OWNED_ATTRS = {};
VIEWER_OWNED_ATTRS[PLACEHOLDER_ATTR] = true;
VIEWER_OWNED_ATTRS[SHADOW_ATTR] = true;
VIEWER_OWNED_ATTRS[CANVAS_ATTR] = true;
VIEWER_OWNED_ATTRS[CANVAS_RULE_ATTR] = true;

function isViewerOwnedAttr(name) {
  return VIEWER_OWNED_ATTRS[String(name).toLowerCase()] === true;
}

function isNameToken(name) {
  return NAME_TOKEN_RE.test(name);
}

// The tag guard, applied at the instantiation boundary for keyframes and for
// every `dom.add` subtree alike.
function isUsableTag(tag) {
  return isNameToken(tag) && !RESERVED_TAG_PREFIX_RE.test(tag);
}

// The namespace an element is created in, given its parent's.
function namespaceFor(tag, parentNs) {
  if (FOREIGN_ROOTS[tag]) return FOREIGN_ROOTS[tag];
  return parentNs || XHTML_NS;
}

// The namespace this element's CHILDREN are created in. Inside SVG, the HTML
// integration points hold ordinary HTML.
function childNamespaceOf(tag, ns) {
  if (ns === SVG_NS && SVG_HTML_INTEGRATION[tag] === true) return XHTML_NS;
  return ns;
}

/**
 * Would this attribute value navigate to script?
 *
 * ASCII whitespace and C0 controls are stripped from ANYWHERE in the value
 * before the scheme is tested, because the HTML and URL parsers remove tabs
 * and newlines from URLs and trim leading controls — so `java\tscript:alert(1)`
 * navigates, and a scheme test that trims only the ends is bypassed by one
 * tab. Stripping cannot create a false positive: it can only remove characters
 * from a scheme that was already there.
 */
function isSafeUrl(value) {
  var probe = String(value).replace(/[\x00-\x20]/g, '').toLowerCase();
  return probe.indexOf('javascript:') !== 0 && probe.indexOf('vbscript:') !== 0;
}

/**
 * Set one attribute through the §12 filters. Refused attributes are DROPPED,
 * not neutralised: a `javascript:` href rewritten to `#` would claim the page
 * had a link it did not have.
 *
 * TWO refusal classes, counted differently (fix round 1, review I-4 — the first
 * version of this counted neither, on an argument that only holds for one of
 * them):
 *
 *   - **security** — an `on*` handler, or a `javascript:`/`vbscript:` value in
 *     a URL attribute. Dropping these is the point, and the reconstruction is
 *     visually right without them, so nothing is counted. Counting would light
 *     the analyst's "recorded change(s) could not be reapplied" chip every time
 *     a filter worked.
 *   - **name token** — a name outside the XML `Name` production. Those are page
 *     state that is LOST: chromium, firefox and webkit all accept `@click`,
 *     `[ngModel]`, `(click)`, `*ngIf`, `1x`, `café` and `<` (Task 2's
 *     tri-engine table), and this module drops them anyway, for the
 *     realm-determinism reasons in the header. That loss gets a surface —
 *     `skipped`, the counter for "the file said something no DOM here could
 *     hold" — rather than only a comment.
 */
function setFilteredAttr(el, name, value, ctx) {
  if (!isNameToken(name)) {
    if (ctx) ctx.skipped++;
    return;
  }
  if (/^on/i.test(name)) return;
  // Viewer-owned (see VIEWER_OWNED_ATTRS): refused on the SET path so a
  // recording cannot forge a placeholder outline or a shadow chip. Uncounted,
  // like the other integrity refusals — the reconstruction is visually right
  // without it, and counting would light the analyst's "could not be
  // reapplied" chip every time a filter worked. The viewer re-stamps the flags
  // it recognises itself, in `instantiateElement`.
  if (isViewerOwnedAttr(name)) return;
  var text = value == null ? '' : String(value);
  if (URL_ATTRS[name.toLowerCase()] === true && !isSafeUrl(text)) return;
  el.setAttribute(name, text);
}

function applyAttrs(el, attrs, skip, ctx) {
  for (var name in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    if (skip && skip[name.toLowerCase()] === true) continue;
    setFilteredAttr(el, name, attrs[name], ctx);
  }
}

// Frames are recorded as the element only (spec §13) and must stay that way in
// the reconstruction: no `src` to fetch, no `srcdoc` to parse. §12's network
// policy is then satisfied structurally — there is nothing to request — with
// the viewer's `frame-src 'none'` CSP as the belt to that brace.
var IFRAME_SKIP = { src: true, srcdoc: true };

// Design §7 renders media as a state badge and a lane marker, with no playback,
// and honours `media_src` only so the element has its shape. `autoplay` is the
// one recorded attribute that would start playback with nobody asking, and the
// shell CSP allows `media-src *`, so it is dropped where it lands.
var MEDIA_TAGS = { video: true, audio: true };
var MEDIA_SKIP = { autoplay: true };

// Which recorded attributes this tag never receives.
function skipSetFor(tag) {
  if (tag === 'iframe') return IFRAME_SKIP;
  if (MEDIA_TAGS[tag] === true) return MEDIA_SKIP;
  return null;
}

function instantiateNode(domNode, ctx, parentNs) {
  // Tolerant posture (design §4): an unusable node is skipped and counted, not
  // thrown on. `instantiateTree` has no try/catch by design — one guard at the
  // boundary, one predicate, the same answer in every realm — so this is the
  // line that stops a hand-edited or foreign file from aborting a whole
  // keyframe mount. The §11 tolerant loader admits all of these shapes into
  // the model, so the viewer is where they arrive.
  if (!domNode || typeof domNode !== 'object') {
    ctx.skipped++;
    return null;
  }
  var doc = ctx.doc;
  var node;
  if (domNode.kind === 'text') {
    node = doc.createTextNode(domNode.text == null ? '' : String(domNode.text));
  } else if (domNode.kind === 'comment') {
    node = doc.createComment(domNode.text == null ? '' : String(domNode.text));
  } else {
    var tag = String(domNode.tag == null ? '' : domNode.tag).toLowerCase();
    if (!isUsableTag(tag)) {
      ctx.skipped++;
      return null;
    }
    node = instantiateElement(domNode, ctx, tag, parentNs);
  }
  if (!bind(ctx, domNode.id, node)) {
    // The id belongs to the reconstruction root and `bind` refused to move it
    // (see there). Refusing the binding means refusing the NODE: the walk
    // already bound its children as it descended, and a node in the tree that
    // no id resolves to breaks every reader that walks from the root —
    // including `readTree`, the shared one — which is the same failure the
    // refusal exists to prevent.
    purgeSubtree(ctx, node);
    ctx.patchFailures++;
    return null;
  }
  return node;
}

function instantiateElement(domNode, ctx, tag, parentNs) {
  var inert = INERT_TAGS[tag] === true;
  var isFrame = tag === 'iframe';
  var ns = namespaceFor(tag, parentNs);
  // The FRAME's document, never the report's: a node created in the report's
  // realm and adopted into the frame is a cross-realm object, and the whole
  // point of the sandbox is that the reconstruction is made of the frame's own
  // nodes. A `<template>` standing in for a script is an HTML element wherever
  // the script sat, so the substitution lands in the XHTML namespace.
  var created = inert ? 'template' : tag;
  var createdNs = inert ? XHTML_NS : ns;
  var el = createdNs === XHTML_NS
    ? ctx.doc.createElement(created)
    : ctx.doc.createElementNS(createdNs, created);

  var skip = skipSetFor(tag);
  applyAttrs(el, domNode.attrs || {}, skip, ctx);
  // §4's `media_src` is the RESOLVED url the element actually loaded
  // (`currentSrc`), where the recorded `src` attribute is whatever the page
  // author wrote — routinely a relative path, which resolves to nothing in a
  // `srcdoc` frame with no base URL. The resolved one wins, which is the same
  // rule capture applies to `<img>` (snapshot.js `emittedAttrValue`). Media is
  // rendered as badges and lane markers rather than played (design §7); this
  // is only so the element has its shape.
  //
  // It obeys the SAME skip set as the recorded attributes (fix round 1). Until
  // it did, a `media_src` on an iframe node reached the live DOM as `src` and
  // chromium issued the request whenever the shell CSP was absent — measured.
  // §12's network policy is supposed to hold STRUCTURALLY here, with nothing to
  // request; `frame-src 'none'` is the belt, it lives in a file this module
  // does not ship with, and three consumers build their own frames.
  if (!(skip && skip.src === true)
      && typeof domNode.media_src === 'string' && domNode.media_src) {
    setFilteredAttr(el, 'src', domNode.media_src, ctx);
  }
  if (isFrame) el.setAttribute(PLACEHOLDER_ATTR, 'iframe');
  // The shadow flag is re-stamped BY THE VIEWER from the recorded claim rather
  // than passed through `applyAttrs`, which now refuses the name. Same DOM as
  // before; the difference is that the flag in the reconstruction is one the
  // viewer put there and no later patch can move or delete (see
  // VIEWER_OWNED_ATTRS). The value is normalised to the empty string capture
  // writes, so the chip's selector cannot be dodged by a value.
  var recorded = domNode.attrs;
  if (recorded && Object.prototype.hasOwnProperty.call(recorded, SHADOW_ATTR)) {
    el.setAttribute(SHADOW_ATTR, '');
  }

  // §4's `canvas_size` is the BITMAP size, which is not an attribute and must
  // not become one — it is what sizes the parent-owned offscreen canvas the
  // snapshots composite into (design §3.1) and what the used-size-0 sizing
  // repair pins from (design §3.3). Both live in the viewer client; recording it
  // is this walk's, because this walk is the only place the annotation is in
  // hand.
  //
  // The delete is not redundant with the set. `dom.add` OVERWRITES an id
  // binding, because a remove+add pair carrying one id is a MOVE (pin M5), and
  // this map is keyed by the same ids — so an id re-bound to a node with NO
  // `canvas_size` would keep the previous node's bitmap size, and the viewer
  // would size an offscreen canvas for an element that is not a canvas.
  ctx.canvases.delete(domNode.id);
  var size = domNode.canvas_size;
  if (size && typeof size === 'object'
      && typeof size.w === 'number' && typeof size.h === 'number') {
    ctx.canvases.set(domNode.id, { w: size.w, h: size.h });
  }

  var childNs = childNamespaceOf(tag, createdNs);
  var kids = domNode.children || [];
  for (var i = 0; i < kids.length; i++) {
    var child = instantiateNode(kids[i], ctx, childNs);
    if (child) el.appendChild(child);
  }
  return el;
}

// The span-scoped state. One of these per keyframe span (design §4): the id map
// is rebuilt from scratch at every span restore, and everything a patch needs
// to resolve travels with it.
//
// `idOf` is the reverse index, and it ships rather than being rebuilt on demand
// because `dom.remove` has to purge the removed node AND its whole subtree from
// the map — matching `dom-player.js` and the fork's `removeFromMap`, so a later
// patch naming a purged descendant is caught rather than resolved against a
// detached node. Rebuilding it per removal is O(span) per patch; keeping it
// alongside costs one `Map` and is maintained in exactly one place (`bind`).
function newContext(doc) {
  return {
    doc: doc, root: null,
    idMap: new Map(), idOf: new Map(), canvases: new Map(),
    skipped: 0, patchFailures: 0,
  };
}

function result(ctx, root) {
  ctx.root = root;
  return ctx;
}

/**
 * Bind an id to a node, overwriting whatever either side held.
 *
 * The overwrite IS the contract (design §4, T3 Task 3 pin M5): a `dom.remove` +
 * `dom.add` pair carrying the same id is a MOVE, and treating the second
 * binding as a duplicate loses the node. Both directions are cleared first, so
 * the two maps stay exact inverses of each other — the property the subtree
 * purge depends on and a test pins over both fixtures. Note the guarantee is
 * about the MAP: a bare re-add with no preceding remove leaves the old subtree
 * in the document, still resolvable through its own ids, because nothing asked
 * for it to be detached and inventing a detach would be the viewer editing the
 * reconstruction.
 *
 * ONE EXCEPTION, added in fix round 1 (review I-1): the id the mount bound to
 * the reconstruction ROOT is not movable. A `dom.add` carrying it — at the
 * subtree's own root or buried in its children — otherwise pointed the root id
 * at an attacker-chosen element with nothing counted, which decides what Task
 * 7's `exists`/`attr:<name>` read, what an `anchor.node` naming the root
 * resolves to, and what the §8 camera chain measures; and it dropped
 * `mount.root` out of `idOf`, so every reader that walks from the root threw
 * one layer up. Unreachable from CH capture, reachable from any foreign file.
 *
 * @returns {boolean} whether the binding was made
 */
function bind(ctx, id, node) {
  var prev = ctx.idMap.get(id);
  if (prev !== undefined && prev !== node) {
    if (prev === ctx.root) return false;
    ctx.idOf.delete(prev);
  }
  var prevId = ctx.idOf.get(node);
  if (prevId !== undefined && prevId !== id) ctx.idMap.delete(prevId);
  ctx.idMap.set(id, node);
  ctx.idOf.set(node, id);
  return true;
}

// Drop a node and every descendant from both maps.
//
// `template.content` is walked as well as `childNodes` for the realm reason
// `INERT_TAGS` records: happy-dom routes `appendChild` on a template into
// `content`, browsers keep it in `childNodes`. Walking both leaves the same map
// in every realm, which is the same determinism argument the name filters rest
// on. Deleting an id twice is a no-op, so the overlap costs nothing.
function purgeSubtree(ctx, node) {
  var id = ctx.idOf.get(node);
  if (id !== undefined) {
    ctx.idOf.delete(node);
    // Delete only the binding this node actually OWNS. Given the inversion
    // `bind` maintains, `idMap.get(id) === node` always holds — so the test is
    // dead weight on a healthy map and the whole point on a broken one: without
    // it, a node whose reverse entry disagrees takes an innocent node's binding
    // down with it, turning a loud inconsistency into a quiet one. Pinned by
    // injection rather than left as a defensive line (review I-2, H3).
    if (ctx.idMap.get(id) === node) {
      ctx.idMap.delete(id);
      ctx.canvases.delete(id);
    }
  }
  var kids = node.childNodes || [];
  for (var i = 0; i < kids.length; i++) purgeSubtree(ctx, kids[i]);
  var content = node.content;
  if (content && content.childNodes) {
    var inner = content.childNodes;
    for (var j = 0; j < inner.length; j++) purgeSubtree(ctx, inner[j]);
  }
}

/**
 * Instantiate a DomNode tree as a DETACHED subtree of `doc`.
 *
 * @param {object} domNode  a spec §4 DomNode tree
 * @param {Document} doc    the frame's document — every node is created in it
 * @returns {{root: Node|null, doc: Document, idMap: Map<number, Node>,
 *            idOf: Map<Node, number>, canvases: Map<number, {w, h}>,
 *            skipped: number, patchFailures: number}}
 *   the span state `applyPatch` extends. `canvases` is the §4 `canvas_size`
 *   annotation, which no DOM read can recover, keyed by the same ids as
 *   `idMap`.
 *
 *   The two counters answer different questions and both belong in the
 *   `counters.patchFailures` surface that already drives the "recorded
 *   change(s) could not be reapplied" chip: `skipped` is *the file said
 *   something no DOM here could hold* (a tag or attribute name outside the
 *   Name production, a null child), `patchFailures` is *a reference the span
 *   could not honour* (an id the map does not hold, a `before` that is not a
 *   child, a target of the wrong kind, a refused re-bind of the root).
 *
 *   THE RETURNED OBJECT IS THE LIVE STATE, not a snapshot: `applyPatch` keeps
 *   incrementing these counters on the same object, so read them as properties
 *   (`mount.skipped`) at the moment you need them. Destructuring at mount time
 *   captures the numbers as they were before any patch applied.
 */
function instantiateTree(domNode, doc) {
  var ctx = newContext(doc);
  return result(ctx, instantiateNode(domNode, ctx, null));
}

/**
 * Mount a keyframe into the frame's body, with the body-root split.
 *
 * A root whose tag is `body` — CH's ordinary case, since the observed root
 * defaults to `document.body`, and jsPsych's too — has its ATTRIBUTES applied
 * to the frame's own `<body>` and its children instantiated inside it, with
 * the root id bound to that body. Instantiating a second `<body>` inside the
 * first would break the `height: 100%` chain a wiped display element depends
 * on and would put the recorded body's styles on a node the page's CSS does
 * not match. Any other root is instantiated as a child of the cleared body.
 *
 * This is also the rebuild: the body's previous children and attributes are
 * removed first, so a span restore is `mountTree(...)` and nothing else. The
 * frame itself survives — `srcdoc` is written once per mount (design §4), so
 * no `onload` round trip stands between a backward seek and a readable DOM.
 *
 * CARRY FOR TASK 3: on the body-root path the root id is bound to the frame's
 * OWN `<body>`. A `dom.remove` naming that id must skip and count rather than
 * call `.remove()`, which would detach the element every later mount and patch
 * depends on and leave the reconstruction nowhere to go.
 *
 * @param {object|null} domNode  the span keyframe's `initial_dom`; null clears
 *   the body and mounts nothing, which is the trace-tier and the
 *   nothing-to-restore case
 * @param {Element} body  the frame's `<body>`
 * @param {Document} doc  the frame's document
 * @returns {object}  the span state, as `instantiateTree` documents it
 */
function mountTree(domNode, body, doc) {
  while (body.firstChild) body.removeChild(body.firstChild);
  var live = body.attributes;
  for (var i = live.length - 1; i >= 0; i--) body.removeAttribute(live[i].name);

  var ctx = newContext(doc);
  // A null keyframe is the LEGITIMATE case — trace tier, or a restore with
  // nothing to mount — so it clears and reports no skip. Anything else that is
  // not an object is a malformed keyframe and is counted.
  if (domNode == null) return result(ctx, null);
  if (typeof domNode !== 'object') {
    ctx.skipped++;
    return result(ctx, null);
  }

  var tag = domNode.kind === 'element' || domNode.kind == null
    ? String(domNode.tag == null ? '' : domNode.tag).toLowerCase() : null;
  if (tag !== 'body') {
    var root = instantiateNode(domNode, ctx, null);
    if (root) body.appendChild(root);
    return result(ctx, root);
  }

  applyAttrs(body, domNode.attrs || {}, null, ctx);
  bind(ctx, domNode.id, body);
  // Recorded BEFORE the children walk, not just by `result()` at the end, so a
  // keyframe whose descendant repeats the root's id cannot re-bind it away from
  // the frame's own body mid-mount — the mount-time half of `bind`'s exception.
  ctx.root = body;
  var kids = domNode.children || [];
  for (var j = 0; j < kids.length; j++) {
    var child = instantiateNode(kids[j], ctx, null);
    if (child) body.appendChild(child);
  }
  return result(ctx, body);
}

// ── spec §5.1 patch application ────────────────────────────────────────────
//
// TOLERANT, COUNTED, SURFACED (design §4). A patch naming an id the map does
// not hold is skipped and counted into `patchFailures`, never thrown on. This
// is a DELIBERATE divergence from `tests/replay/support/dom-player.js`, which
// throws on the same input: the test player's job is to catch mapper bugs, the
// viewer's job is to show an analyst as much of an unrepeatable session as
// survives. The consequence is recorded and routed — a tolerant viewer cannot
// detect a producer emitting dangling references, which is why T7 owes a
// dangling-reference negative fixture (design §14 risk 2).
//
// What is NOT counted: an attribute refused by the §12 filters. Instantiation
// drops the same names silently, so counting them here would light up the
// "recorded change(s) could not be reapplied" chip for a filter working exactly
// as designed. A dropped `on*` handler leaves the visual reconstruction right;
// an unresolvable id means it is wrong.

// Every caller tests the result for falsiness, so an id the map does not hold
// arrives as `undefined` and reads the same as a missing node.
function resolve(mount, id) {
  return mount.idMap.get(id);
}

function tagNameOf(node) {
  return node && node.tagName ? String(node.tagName).toLowerCase() : '';
}

function applyAdd(patch, mount) {
  var parent = resolve(mount, patch.parent);
  if (!parent || parent.nodeType !== ELEMENT_NODE) {
    mount.patchFailures++;
    return;
  }
  // The inserted subtree inherits the LIVE parent's namespace, so a `dom.add`
  // into an SVG subtree does not silently produce XHTML children that lay out
  // at 0×0 — and an add into an SVG HTML-integration point produces HTML
  // again. `dom-player.js` carries the same rule; re-sync both when either
  // moves.
  var childNs = childNamespaceOf(tagNameOf(parent), parent.namespaceURI);
  var node = instantiateNode(patch.node, mount, childNs);
  if (!node) return;              // already counted into `skipped`

  var ref = null;
  if (patch.before !== null && patch.before !== undefined) {
    var anchor = mount.idMap.get(patch.before);
    // A `before` the map does not hold, or one that is not a child of this
    // parent, cannot be honoured: the node is appended instead. Counted,
    // because the recorded POSITION was lost even though the node survived —
    // the reconstruction is knowingly approximate at that point.
    if (anchor !== undefined && anchor.parentNode === parent) ref = anchor;
    else mount.patchFailures++;
  }

  try {
    parent.insertBefore(node, ref);
  } catch (err) {
    // A hierarchy the DOM refuses. The subtree is unbound again rather than
    // left in the map, where a later patch would resolve it against a node
    // nothing can see.
    mount.patchFailures++;
    purgeSubtree(mount, node);
  }
}

function applyRemove(patch, mount) {
  var node = resolve(mount, patch.node);
  if (!node) {
    mount.patchFailures++;
    return;
  }
  // The reconstruction root is not removable, under either root shape — the
  // other half of the invariant `bind` protects. On the body-root path (design
  // §4's split) the root IS the frame's own `<body>`, so a blind `.remove()`
  // detaches the element every later mount and patch depends on; on any other
  // path it is the node every reader walks from. One predicate for both, so
  // there is no disjunct a test cannot reach.
  if (node === mount.root) {
    mount.patchFailures++;
    return;
  }
  purgeSubtree(mount, node);
  if (node.parentNode) node.parentNode.removeChild(node);
}

function applyAttr(patch, mount) {
  var el = resolve(mount, patch.node);
  if (!el || el.nodeType !== ELEMENT_NODE) {
    mount.patchFailures++;
    return;
  }
  var name = String(patch.name == null ? '' : patch.name);
  if (patch.value === null || patch.value === undefined) {
    // ONE name check on the removal path, and it is the same predicate the set
    // path uses. `removeAttribute` validates nothing — browsers by spec,
    // happy-dom measured — so removing a name this module would never have SET
    // is a harmless no-op and needs no guard; what DOES need one is the
    // viewer's own flags, which a recording can strip as well as forge. Task 3
    // left this line to Task 4 because the detector that reads the flags back
    // lands there.
    if (isViewerOwnedAttr(name)) return;
    el.removeAttribute(name);
    return;
  }
  // ONE §12 gate on the set path, and it is the gate instantiation uses, so a
  // keyframe and a patch can never disagree about what an element may carry.
  setFilteredAttr(el, name, patch.value, mount);
}

function applyText(patch, mount) {
  var node = resolve(mount, patch.node);
  if (!node) {
    mount.patchFailures++;
    return;
  }
  // §5.1's `dom.text` addresses a text or comment node. An element has no
  // character data, and assigning to `nodeValue` on one is a silent no-op —
  // counting is the honest answer, and it is where the two players differ
  // hardest: the strict one writes `.data` on whatever it resolved.
  if (node.nodeType !== TEXT_NODE && node.nodeType !== COMMENT_NODE) {
    mount.patchFailures++;
    return;
  }
  node.nodeValue = patch.text == null ? '' : String(patch.text);
}

/**
 * Apply one spec §5.1 patch to a mounted span.
 *
 * @param {object} patch  a `dom.add` / `dom.remove` / `dom.attr` / `dom.text`
 *   event; anything else is left alone
 * @param {object} mount  the state `mountTree`/`instantiateTree` returned
 * @returns {boolean} whether this event was a DOM patch — so a caller's
 *   vocabulary dispatch (§5.2-§5.8, in the viewer client) can fall through on
 *   `false`
 *   without needing its own list of the four types
 */
function applyPatch(patch, mount) {
  if (!patch) return false;
  var type = patch.type;
  if (type === 'dom.add') applyAdd(patch, mount);
  else if (type === 'dom.remove') applyRemove(patch, mount);
  else if (type === 'dom.attr') applyAttr(patch, mount);
  else if (type === 'dom.text') applyText(patch, mount);
  else return false;
  return true;
}

/**
 * Apply a time-ordered slice of a segment's events, in order, skipping the
 * ones that are not DOM patches.
 *
 * @param {object[]} patches
 * @param {object} mount
 * @returns {object} the same mount state, for chaining
 */
function applyPatches(patches, mount) {
  var list = patches || [];
  for (var i = 0; i < list.length; i++) applyPatch(list[i], mount);
  return mount;
}

// ONE line of ESM syntax, last, so the build can strip it with a single
// replace and concatenate the rest into the report's viewer script. Keep it
// that way — the header explains why, and the test suite fails if it drifts.
export { instantiateTree, mountTree, applyPatch, applyPatches };
