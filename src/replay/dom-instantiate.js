// src/replay/dom-instantiate.js
// SessionRecording v2 keyframe (a DomNode tree, spec §4) → real DOM inside the
// reconstruction frame, plus the `Map<number, Node>` every `dom.*` patch
// (§5.1), every event `target`, and every `anchor.node` (§6) resolves through.
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

function isNameToken(name) {
  return NAME_TOKEN_RE.test(name);
}

function isSafeAttrName(name) {
  return isNameToken(name) && !/^on/i.test(name);
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

// Set one attribute through the §12 filters. Refused attributes are DROPPED,
// not neutralised: a `javascript:` href rewritten to `#` would claim the page
// had a link it did not have.
function setFilteredAttr(el, name, value) {
  if (!isSafeAttrName(name)) return;
  var text = value == null ? '' : String(value);
  if (URL_ATTRS[name.toLowerCase()] === true && !isSafeUrl(text)) return;
  el.setAttribute(name, text);
}

function applyAttrs(el, attrs, skip) {
  for (var name in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    if (skip && skip[name.toLowerCase()] === true) continue;
    setFilteredAttr(el, name, attrs[name]);
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
    if (!isNameToken(tag)) {
      ctx.skipped++;
      return null;
    }
    node = instantiateElement(domNode, ctx, tag, parentNs);
  }
  ctx.idMap.set(domNode.id, node);
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
  applyAttrs(el, domNode.attrs || {}, skip);
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
    setFilteredAttr(el, 'src', domNode.media_src);
  }
  if (isFrame) el.setAttribute(PLACEHOLDER_ATTR, 'iframe');

  // §4's `canvas_size` is the BITMAP size, which is not an attribute and must
  // not become one — it is what sizes the parent-owned offscreen canvas the
  // snapshots composite into (design §3.1) and what the used-size-0 sizing
  // repair pins from (design §3.3). Both are Task 5's; recording it is this
  // walk's, because this walk is the only place the annotation is in hand.
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

function newContext(doc) {
  return { doc: doc, idMap: new Map(), canvases: new Map(), skipped: 0 };
}

function result(ctx, root) {
  return {
    root: root, idMap: ctx.idMap, canvases: ctx.canvases, skipped: ctx.skipped,
  };
}

/**
 * Instantiate a DomNode tree as a DETACHED subtree of `doc`.
 *
 * @param {object} domNode  a spec §4 DomNode tree
 * @param {Document} doc    the frame's document — every node is created in it
 * @returns {{root: Node|null, idMap: Map<number, Node>,
 *            canvases: Map<number, {w, h}>, skipped: number}}
 *   `canvases` is the §4 `canvas_size` annotation, which no DOM read can
 *   recover, keyed by the same ids as `idMap`. `skipped` counts the nodes no
 *   DOM could hold; it belongs in the `counters.patchFailures` surface that
 *   already drives the "recorded change(s) could not be reapplied" chip.
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
 * @returns {{root: Node|null, idMap: Map<number, Node>,
 *            canvases: Map<number, {w, h}>, skipped: number}}
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

  applyAttrs(body, domNode.attrs || {}, null);
  ctx.idMap.set(domNode.id, body);
  var kids = domNode.children || [];
  for (var j = 0; j < kids.length; j++) {
    var child = instantiateNode(kids[j], ctx, null);
    if (child) body.appendChild(child);
  }
  return result(ctx, body);
}

// ONE line of ESM syntax, last, so the build can strip it with a single
// replace and concatenate the rest into the report's viewer script. Keep it
// that way — the header explains why, and the test suite fails if it drifts.
export { instantiateTree, mountTree };
