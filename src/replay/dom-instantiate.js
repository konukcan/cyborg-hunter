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

// Deliberately the same predicate as capture's `isSerializableAttr`
// (`snapshot.js`): a valid attribute-name token, and never an event handler.
// It is duplicated rather than imported because this file must survive
// concatenation as a plain script (header), and because the two are answering
// the question for different reasons — capture refuses to WRITE handlers,
// the player refuses to INSTANTIATE them. The name test is not cosmetic:
// `setAttribute` throws `InvalidCharacterError` on a malformed name, and one
// hand-edited attribute must not abort an analyst's whole reconstruction.
var ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

// Stamped on elements the format cannot carry the content of (spec §12/§13),
// so the shell stylesheet can outline the region and the header chip can count
// it. Only iframes need it today: their content is a separate browsing context
// no recorder observes.
var PLACEHOLDER_ATTR = 'data-ch-placeholder';

function isSafeAttrName(name) {
  return ATTR_NAME_RE.test(name) && !/^on/i.test(name);
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

function instantiateNode(domNode, ctx) {
  var doc = ctx.doc;
  var node;
  if (domNode.kind === 'text') {
    node = doc.createTextNode(domNode.text == null ? '' : String(domNode.text));
  } else if (domNode.kind === 'comment') {
    node = doc.createComment(domNode.text == null ? '' : String(domNode.text));
  } else {
    node = instantiateElement(domNode, ctx);
  }
  ctx.idMap.set(domNode.id, node);
  return node;
}

function instantiateElement(domNode, ctx) {
  var tag = String(domNode.tag == null ? '' : domNode.tag).toLowerCase();
  var inert = INERT_TAGS[tag] === true;
  var isFrame = tag === 'iframe';
  // The FRAME's document, never the report's: a node created in the report's
  // realm and adopted into the frame is a cross-realm object, and the whole
  // point of the sandbox is that the reconstruction is made of the frame's own
  // nodes.
  var el = ctx.doc.createElement(inert ? 'template' : tag);

  applyAttrs(el, domNode.attrs || {}, isFrame ? IFRAME_SKIP : null);
  // §4's `media_src` is the RESOLVED url the element actually loaded
  // (`currentSrc`), where the recorded `src` attribute is whatever the page
  // author wrote — routinely a relative path, which resolves to nothing in a
  // `srcdoc` frame with no base URL. The resolved one wins, which is the same
  // rule capture applies to `<img>` (snapshot.js `emittedAttrValue`). Media is
  // rendered as badges and lane markers rather than played (design §7); this
  // is only so the element has its shape.
  if (typeof domNode.media_src === 'string' && domNode.media_src) {
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

  var kids = domNode.children || [];
  for (var i = 0; i < kids.length; i++) {
    el.appendChild(instantiateNode(kids[i], ctx));
  }
  return el;
}

function newContext(doc) {
  return { doc: doc, idMap: new Map(), canvases: new Map() };
}

function result(ctx, root) {
  return { root: root, idMap: ctx.idMap, canvases: ctx.canvases };
}

/**
 * Instantiate a DomNode tree as a DETACHED subtree of `doc`.
 *
 * @param {object} domNode  a spec §4 DomNode tree
 * @param {Document} doc    the frame's document — every node is created in it
 * @returns {{root: Node, idMap: Map<number, Node>, canvases: Map<number, {w, h}>}}
 *   `canvases` is the §4 `canvas_size` annotation, which no DOM read can
 *   recover, keyed by the same ids as `idMap`.
 */
function instantiateTree(domNode, doc) {
  var ctx = newContext(doc);
  return result(ctx, instantiateNode(domNode, ctx));
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
 * @param {object|null} domNode  the span keyframe's `initial_dom`; null clears
 *   the body and mounts nothing, which is the trace-tier and the
 *   nothing-to-restore case
 * @param {Element} body  the frame's `<body>`
 * @param {Document} doc  the frame's document
 * @returns {{root: Node|null, idMap: Map<number, Node>, canvases: Map<number, {w, h}>}}
 */
function mountTree(domNode, body, doc) {
  while (body.firstChild) body.removeChild(body.firstChild);
  var live = body.attributes;
  for (var i = live.length - 1; i >= 0; i--) body.removeAttribute(live[i].name);

  var ctx = newContext(doc);
  if (!domNode || typeof domNode !== 'object') return result(ctx, null);

  var tag = domNode.kind === 'element' || domNode.kind == null
    ? String(domNode.tag == null ? '' : domNode.tag).toLowerCase() : null;
  if (tag !== 'body') {
    var root = instantiateNode(domNode, ctx);
    body.appendChild(root);
    return result(ctx, root);
  }

  applyAttrs(body, domNode.attrs || {}, null);
  ctx.idMap.set(domNode.id, body);
  var kids = domNode.children || [];
  for (var j = 0; j < kids.length; j++) {
    body.appendChild(instantiateNode(kids[j], ctx));
  }
  return result(ctx, body);
}

// ONE line of ESM syntax, last, so the build can strip it with a single
// replace and concatenate the rest into the report's viewer script. Keep it
// that way — the header explains why, and the test suite fails if it drifts.
export { instantiateTree, mountTree };
