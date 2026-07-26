// src/replay/capture-dom.js
// Tier-2 ("dom") capture: initial-DOM serialization, MutationObserver →
// patch log, initial stylesheet capture, guard-friction pre-scramble hook.
//
// The serializer is a hand-rolled tree walker (clean-room; no dependency on
// outerHTML) so it can (a) strip/redact during the walk and (b) run against
// duck-typed fixture trees in node tests.
//
// Node addressing: a path is the list of childNodes indices from the capture
// root down to the node ([1,1] = root.childNodes[1].childNodes[1]). The
// viewer resolves paths against its reconstructed tree; paths are relative
// to the SNAPSHOT state at each point in the patch sequence, which holds as
// long as patches are applied in order from the initial DOM.

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;

// Elements never serialized: executable or replay-irrelevant. IFRAME is NOT
// here — frames serialize as inert size-preserving placeholders (see
// serializeNode) so the surrounding layout doesn't collapse in the viewer.
var SKIP_TAGS = { SCRIPT: true, NOSCRIPT: true };

/**
 * Serialization-stable node references. Child-index paths are not stable
 * across HTML reparsing (the parser drops comments, merges text nodes, and
 * inserts elements like <tbody>), so every serialized ELEMENT is stamped
 * with a marker attribute instead. The attribute name embeds a per-recording
 * nonce so page CSS written before the recording existed cannot target it
 * ([data-chn-*]{display:none} attacks) and pre-existing page attributes
 * cannot collide. Ids live in a WeakMap keyed by the LIVE node — the live
 * DOM is never mutated (stamping real attributes would echo through the
 * MutationObserver and interfere with the host page). The viewer harvests
 * markers into an out-of-band map and strips them before any measured layout.
 */
export function createMarkerRegistry(nonce) {
  var ids = new WeakMap();
  var next = 1;
  return {
    attr: 'data-chn-' + nonce,
    refFor: function (node) {
      var n = ids.get(node);
      if (n == null) { n = next++; ids.set(node, n); }
      return n;
    }
  };
}

// Void elements per the HTML spec — serialized without a closing tag.
var VOID_TAGS = {
  AREA: true, BASE: true, BR: true, COL: true, EMBED: true, HR: true,
  IMG: true, INPUT: true, LINK: true, META: true, SOURCE: true,
  TRACK: true, WBR: true
};

// Valid attribute-name token; also refuses event-handler attributes
// (on*) as defense-in-depth — the viewer sandbox+CSP already block inline
// handlers, but the serialized artifact should not carry them at all.
var ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
function isSerializableAttr(name) {
  return ATTR_NAME_RE.test(name) && !/^on/i.test(name);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isBait(node, opts) {
  if (opts && opts.keepBait) return false;
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  if (node.id === 'ch-decoy') return true;
  var attrs = node.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].name === 'data-ch-role') return true;
    if (attrs[i].name === 'data-ch-decoy') return true;
  }
  return false;
}

function isPassword(node) {
  return node.tagName === 'INPUT' &&
    (node.type === 'password' || hasAttr(node, 'type', 'password'));
}

// True when the node should be redacted in the DOM capture: a password field
// (always) or anything matching the configured redactSelector. Without this the
// DOM path (initial snapshot, value attributes, characterData/childList patches)
// leaked the content of fields the researcher explicitly marked for redaction,
// silently defeating redactSelector for everything except the RAF-coalesced
// input-value events.
function isRedacted(node, opts) {
  if (!node) return false;
  if (isPassword(node)) return true;
  var sel = opts && opts.redactSelector;
  if (!sel || typeof node.matches !== 'function') return false;
  try { return node.matches(sel); } catch (e) { return false; }
}

// True when the node is inside (or is) a redacted element. Walks ancestors so
// that mutation targets which are TEXT NODES (characterData records, added text
// nodes) — which have no matches() of their own — are correctly redacted when
// their containing element is. Without the walk, characterData on a redacted
// contenteditable would leak the typed text through mutation patches.
function isInRedactedSubtree(node, opts) {
  var cur = node;
  while (cur) {
    if (cur.nodeType === ELEMENT_NODE && isRedacted(cur, opts)) return true;
    cur = cur.parentNode;
  }
  return false;
}

function hasAttr(node, name, value) {
  var attrs = node.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].name === name) return value == null || attrs[i].value === value;
  }
  return false;
}

/**
 * Serializes a DOM subtree to an HTML string.
 * - strips scripts/iframes and (by default) honeypot/decoy nodes
 * - prefers the `src` PROPERTY for images (always absolute) over the
 *   attribute (may be relative and unresolvable inside the viewer's srcdoc)
 * - redacts password input values (marker attribute, no content)
 */
export function serializeDom(root, opts) {
  opts = opts || {};
  var out = [];
  serializeNode(root, opts, out);
  return out.join('');
}

// Iframe → inert placeholder. Child documents are never captured (their
// events don't bubble to this document and the srcdoc CSP blocks frames
// anyway), but dropping the element entirely would collapse the surrounding
// layout and silently shift every element below it. The placeholder keeps
// the recorded footprint; the viewer shows a per-trial "iframe content not
// captured" warning when one is present.
// Current footprint of an iframe, for the placeholder and for footprint
// re-sync patches when the iframe's attributes later mutate.
function iframeFootprint(node) {
  var w = null, h = null;
  try {
    if (typeof node.getBoundingClientRect === 'function') {
      var r = node.getBoundingClientRect();
      // A 0×0 rect is a VALID footprint (hidden iframe) — the placeholder
      // must reproduce it, not invent a default-size box that shifts layout.
      if (r) { w = Math.round(r.width || 0); h = Math.round(r.height || 0); }
    }
  } catch (e) { /* fall through to attributes */ }
  if (w == null) {
    w = parseInt(hasAttr(node, 'width') ? getAttrValue(node, 'width') : '', 10);
    h = parseInt(hasAttr(node, 'height') ? getAttrValue(node, 'height') : '', 10);
    if (!(w > 0)) w = 300;   // spec default iframe size
    if (!(h > 0)) h = 150;
  }
  return { w: w, h: h };
}

// Layout-affecting computed properties copied onto the placeholder so an
// absolutely-positioned / block / floated / margined iframe doesn't collapse
// into a plain in-flow inline box and shift everything around it.
var IFRAME_LAYOUT_PROPS = ['position', 'top', 'right', 'bottom', 'left',
  'margin', 'float', 'vertical-align', 'z-index'];

function iframeFootprintStyle(node) {
  var f = iframeFootprint(node);
  var css = '';
  var display = 'inline-block';
  try {
    var view = node.ownerDocument && node.ownerDocument.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      var cs = view.getComputedStyle(node);
      // display: keep the computed value except 'inline' — a span needs
      // inline-block (or stronger) to honor explicit width/height.
      if (cs.display && cs.display !== 'inline') display = cs.display;
      for (var i = 0; i < IFRAME_LAYOUT_PROPS.length; i++) {
        var prop = IFRAME_LAYOUT_PROPS[i];
        var v = cs.getPropertyValue(prop);
        if (v && v !== 'auto' && v !== 'none' && v !== 'normal' &&
            v !== 'baseline' && v !== '0px') {
          css += prop + ':' + v + ';';
        }
      }
    }
  } catch (e) { /* fall back to the plain inline-block footprint */ }
  return 'display:' + display + ';' + css +
    'width:' + f.w + 'px;height:' + f.h + 'px';
}

function serializeIframePlaceholder(node, opts, out) {
  // <span>, not <div>: iframes are phrasing content, so the placeholder must
  // be too — a div inside <p> would trigger parser reparenting (implicit </p>)
  // and shift the reconstructed layout the placeholder exists to preserve.
  out.push('<span data-ch-iframe=""');
  if (opts.markers) {
    out.push(' ' + opts.markers.attr + '="' + opts.markers.refFor(node) + '"');
  }
  out.push(' style="' + iframeFootprintStyle(node) + '"></span>');
}

function getAttrValue(node, name) {
  var attrs = node.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].name === name) return attrs[i].value;
  }
  return '';
}

function serializeNode(node, opts, out) {
  if (!node) return;
  if (node.nodeType === TEXT_NODE) {
    out.push(escapeHtml(node.textContent || ''));
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;   // comments, PIs: irrelevant
  var tag = node.tagName;
  if (SKIP_TAGS[tag]) return;
  if (isBait(node, opts)) return;
  if (tag === 'IFRAME') { serializeIframePlaceholder(node, opts, out); return; }

  var lower = tag.toLowerCase();
  out.push('<' + lower);
  if (opts.markers) {
    out.push(' ' + opts.markers.attr + '="' + opts.markers.refFor(node) + '"');
  }
  // Shadow roots are not serializable from the outside: the host's box
  // survives but its rendered content does not. Mark it so the viewer can
  // refuse to "verify" interactions against a hollow reconstruction.
  if (node.shadowRoot) out.push(' data-ch-shadow=""');

  var redactValue = isRedacted(node, opts);
  var srcOverride = (tag === 'IMG' && node.src) ? node.src : null;
  var wroteSrc = false;

  var attrs = node.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    var name = attrs[i].name;
    var value = attrs[i].value;
    if (!isSerializableAttr(name)) continue;
    if (name === 'value' && redactValue) continue;
    if (name === 'src' && srcOverride) { value = srcOverride; wroteSrc = true; }
    out.push(' ' + name + '="' + escapeHtml(value) + '"');
  }
  if (srcOverride && !wroteSrc) out.push(' src="' + escapeHtml(srcOverride) + '"');
  if (redactValue) out.push(' data-ch-redacted="true"');
  out.push('>');

  if (!VOID_TAGS[tag]) {
    // A redacted element's text children (e.g. contenteditable content) are
    // withheld too — otherwise typed text under a redactSelector match would
    // leak straight into the snapshot despite the marker on the element.
    if (!redactValue) {
      var kids = node.childNodes || [];
      for (var k = 0; k < kids.length; k++) serializeNode(kids[k], opts, out);
    }
    out.push('</' + lower + '>');
  }
}

/**
 * Child-index path from root to node; [] for the root itself; null if the
 * node is not under the root (e.g. extension-injected DOM outside the
 * experiment container).
 */
export function nodePath(node, root) {
  var path = [];
  var cur = node;
  while (cur && cur !== root) {
    var parent = cur.parentNode;
    if (!parent) return null;
    var idx = indexOfChild(parent, cur);
    if (idx === -1) return null;
    path.unshift(idx);
    cur = parent;
  }
  return cur === root ? path : null;
}

function indexOfChild(parent, child) {
  var kids = parent.childNodes || [];
  for (var i = 0; i < kids.length; i++) if (kids[i] === child) return i;
  return -1;
}

/**
 * Translates one MutationRecord into a JSON patch entry, or null when the
 * mutation should not be recorded (bait subtree, node outside root).
 */
export function mutationToPatch(record, root, opts) {
  var target = record.target;
  // Walk up: mutations inside bait subtrees are never recorded.
  var cur = target;
  while (cur) {
    if (isBait(cur, opts)) return null;
    cur = cur.parentNode;
  }
  // With a marker registry, characterData mutations are recorded as the
  // PARENT's resulting-children snapshot: text nodes are not parser-stable
  // references (adjacent text nodes merge on reparse; empty ones vanish), so
  // a text-node address can resolve to the wrong node in the reconstruction.
  // The parent element IS stable via its marker, and a children snapshot is
  // idempotent like every other childList patch.
  if (record.type === 'characterData' && opts.markers) {
    var parent = target.parentNode;
    if (!parent || nodePath(parent, root) === null) return null;
    record = { type: 'childList', target: parent };
    target = parent;
  }

  var path = nodePath(target, root);
  if (path === null) return null;

  // Marker reference: the parser-stable address the viewer resolves first;
  // the child-index path stays as a diagnostic fallback. `tag` is the tag
  // EXPECTED IN THE RECONSTRUCTION (that's what resolution validates) — for
  // iframes that is the placeholder span, not the source tag.
  var ref = opts.markers && target.nodeType === ELEMENT_NODE
    ? { n: opts.markers.refFor(target),
        tag: target.tagName === 'IFRAME' ? 'span' : target.tagName.toLowerCase() }
    : null;

  if (record.type === 'childList') {
    // State-snapshot patch: removed nodes are already detached (they have
    // no address), so a faithful add/remove log is impossible. Serializing
    // the target's RESULTING children makes application an idempotent
    // innerHTML assignment — and backward seeks just rebuild from the
    // initial DOM and re-apply patches in order.
    //
    // A childList mutation on (or inside) a redacted element emits empty
    // children: serializeChildren walks the target's children directly, so it
    // would otherwise leak text/inputs that serializeNode hides when it reaches
    // the redacted element itself.
    return Object.assign({
      op: 'childList',
      path: path,
      html: isInRedactedSubtree(target, opts) ? '' : serializeChildren(target, opts)
    }, ref || {});
  }
  if (record.type === 'attributes') {
    // The reconstruction holds a placeholder SPAN where the iframe was, and
    // width/height ATTRIBUTES don't size a span — so any attribute change on
    // an iframe is translated into a fresh footprint style patch instead of
    // forwarding an attribute the placeholder can't honor.
    if (target.tagName === 'IFRAME') {
      return Object.assign(
        { op: 'attributes', path: path, name: 'style', value: iframeFootprintStyle(target) },
        ref || {});
    }
    var name = record.attributeName;
    if (!isSerializableAttr(name)) return null;
    var value = typeof target.getAttribute === 'function'
      ? target.getAttribute(name) : null;
    // Never leak the value attribute of a redacted field (password or
    // redactSelector match, including via a redacted ancestor).
    if (name === 'value' && isInRedactedSubtree(target, opts)) value = null;
    return Object.assign({ op: 'attributes', path: path, name: name, value: value }, ref || {});
  }
  if (record.type === 'characterData') {
    // characterData targets are TEXT NODES, so redaction must consult the
    // containing element(s): typing into a redacted contenteditable must not
    // carry the typed text through the patch.
    var text = isInRedactedSubtree(target, opts) ? '' : (target.textContent || '');
    return { op: 'characterData', path: path, value: text };
  }
  return null;
}

// Serializes only the CHILDREN of a node (innerHTML semantics) — used by
// the childList state-snapshot patch.
function serializeChildren(node, opts) {
  var out = [];
  var kids = node.childNodes || [];
  for (var i = 0; i < kids.length; i++) serializeNode(kids[i], opts, out);
  return out.join('');
}

/**
 * Initial stylesheet capture: css text where readable, href fallback for
 * cross-origin sheets (viewer inlines css; hrefs render as absolute links).
 */
export function captureStylesheets(doc) {
  var out = [];
  var sheets = (doc && doc.styleSheets) || [];
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    try {
      var rules = sheet.cssRules;
      var css = [];
      for (var r = 0; r < rules.length; r++) css.push(rules[r].cssText);
      out.push({ css: css.join('\n') });
    } catch (e) {
      // Cross-origin sheet: record the (absolute) href so the viewer can
      // at least link it; content is unreadable from this origin.
      out.push({ href: sheet.href || null });
    }
  }
  return out;
}

/**
 * Attaches tier-2 capture to a recorder:
 *  - snapshots initial DOM + stylesheets at session start and at each
 *    startTrial (recorder calls snapshotTrial via the returned hooks)
 *  - MutationObserver → 'mutation' events
 *  - guard-friction cooperation: onViolation('start') fires synchronously
 *    BEFORE obfuscateContent() (pinned by contract test), so the clean-DOM
 *    snapshot taken inside the callback is genuinely pre-scramble.
 */
export function attachDomCapture(rec, env) {
  env = env || {};
  var doc = env.doc || document;
  var win = env.win || window;
  var now = env.now || function () { return performance.now(); };
  var MutationObserverImpl = env.MutationObserver ||
    (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
  // Per-recording marker nonce (see createMarkerRegistry). Registered on the
  // recorder so capture-trace can reference the same registry for interaction
  // anchors and the serializer can emit the attribute name on the wire.
  var markers = createMarkerRegistry(
    (Math.random().toString(16).slice(2, 10) || 'fallback0'));
  if (typeof rec.setMarkers === 'function') {
    rec.setMarkers(markers);
    rec.setMarkerAttr(markers.attr);
  }
  var opts = { keepBait: rec.config.keepBait, redactSelector: rec.config.redactSelector,
               markers: markers };

  function resolveRoot() {
    var r = rec.config.root;
    if (typeof r === 'string') {
      try { return doc.querySelector(r) || doc.body; } catch (e) { return doc.body; }
    }
    return r || doc.body;
  }

  try {
    rec.setStylesheets(captureStylesheets(doc));
  } catch (e) { rec.captureFailure('stylesheets', e); }

  // Snapshot the initial DOM at the start of every trial (explicit or
  // implicit) — this is the frame the viewer reconstructs and patches.
  //
  // The initial snapshot is the single largest capture source and is stored on
  // the trial (not pushed as an event), so the recorder's per-event size cap
  // can't see it. Enforce the cap HERE at assignment: a snapshot longer than
  // maxCharsPerTrial is dropped (with a captureFailure) rather than retained,
  // so a giant DOM can't bypass the resource/payload limit. A dropped snapshot
  // makes that trial's replay show "no DOM captured" rather than blowing up.
  rec.onTrialStart(function (trial) {
    try {
      var html = serializeDom(resolveRoot(), opts);
      var cap = rec.config.maxCharsPerTrial;
      if (cap != null && html.length > cap) {
        rec.captureFailure('dom_snapshot', new Error(
          'initial DOM snapshot length ' + html.length + ' exceeds maxCharsPerTrial ' +
          cap + '; dropped to bound payload size'));
        trial.initialDom = '';
      } else {
        trial.initialDom = html;
      }
    } catch (e) {
      rec.captureFailure('dom_snapshot', e);
      trial.initialDom = '';
    }
  });

  if (MutationObserverImpl) {
    var observer = new MutationObserverImpl(function (records) {
      try {
        var root = resolveRoot();
        // Intra-batch dedup: ONE childList patch per TARGET NODE, emitted at
        // the target's FIRST record position. A single task appending N
        // children to one container delivers N childList records, and each
        // patch serializes the target's FULL resulting children — O(N²)
        // work on the participant's machine without dedup. Serialization
        // happens at callback time (final state), so every record for a
        // target would carry identical html — only ORDER matters, and
        // first-occurrence order guarantees a node created in-batch has its
        // ancestor's creating patch emitted BEFORE any patch targeting the
        // new node (observer records are chronological). Keyed by node
        // IDENTITY, not path (path-keyed dedup was refuted: same-batch
        // index aliasing). attributes/characterData records never skipped.
        // Dedup key = the EFFECTIVE childList target: in marker mode,
        // characterData records become parent-level childList snapshots
        // inside mutationToPatch, so N text rewrites on one node are the
        // same O(N²) storm as N appends and must dedup on the PARENT.
        var seenChildListTargets = new Set();
        var effectiveChildListTarget = function (record) {
          if (record.type === 'childList') return record.target;
          if (record.type === 'characterData' && opts.markers &&
              record.target && record.target.parentNode) {
            return record.target.parentNode;
          }
          return null;
        };
        for (var i = 0; i < records.length; i++) {
          var key = effectiveChildListTarget(records[i]);
          if (key) {
            if (seenChildListTargets.has(key)) continue;
            seenChildListTargets.add(key);
          }
          var patch = mutationToPatch(records[i], root, opts);
          if (patch) rec.pushEvent('mutation', patch, now());
        }
      } catch (e) { rec.captureFailure('mutations', e); }
    });
    try {
      observer.observe(resolveRoot(), {
        childList: true, attributes: true, characterData: true, subtree: true
      });
      // Registered through the listener registry with the observer marker so
      // recorder.destroy() disconnects it (same convention as core monitor).
      rec.addListener(
        { addEventListener: function () {}, removeEventListener: function () {} },
        '_mutation_observer', observer, { _isObserver: true });
    } catch (e) { rec.captureFailure('mutations', e); }
  }

  // Guard-friction cooperation: snapshot the clean DOM synchronously when a
  // violation starts (before friction scrambles content), so the analyst can
  // see exactly what the participant saw at the moment of violation.
  if (win.GuardFriction && typeof win.GuardFriction.onViolation === 'function') {
    try {
      // Late-subscription hardening: if a violation is ALREADY in progress
      // when replay attaches (friction started first — e.g. standalone
      // wiring order, or a participant who was out of fullscreen from the
      // very beginning), its phase:'start' emission is long gone. Synthesize
      // it from friction's current state so the recording never silently
      // misses an ongoing violation.
      // Local invariant guard: assembly (index.js) only attaches captures
      // after startSession(), but make that self-evident here — synthesize
      // only when the recorder is actually recording, so no wiring change
      // can ever route this through a pre-session pushEvent.
      var recState = rec.getState().state;
      if ((recState === 'session' || recState === 'trial') &&
          typeof win.GuardFriction.getCurrentState === 'function') {
        var gs = win.GuardFriction.getCurrentState();
        if (gs && gs.in_violation) {
          rec.pushEvent('ch:guard_violation', {
            reason: gs.current_reason || 'unknown',
            phase: 'start',
            synthesized_at_subscribe: true,
            // NOT pre_scramble_dom: in enforcement mode the page may already
            // be scrambled by the time we subscribe — this snapshot is
            // whatever the DOM looks like right now, and its name must not
            // overclaim (an analyst could otherwise read scrambled content
            // as what the participant "really saw" pre-violation).
            dom_at_subscribe: serializeDom(resolveRoot(), opts)
          }, now());
        }
      }
      win.GuardFriction.onViolation(function (violation) {
        try {
          if (violation && violation.phase === 'start') {
            rec.pushEvent('ch:guard_violation', {
              reason: violation.reason,
              phase: 'start',
              pre_scramble_dom: serializeDom(resolveRoot(), opts)
            }, now());
          } else if (violation && violation.phase) {
            rec.pushEvent('ch:guard_violation', {
              reason: violation.reason, phase: violation.phase,
              duration_ms: violation.duration != null ? violation.duration : null
            }, now());
          }
        } catch (e) { rec.captureFailure('guard_violation', e); }
      });
    } catch (e) { rec.captureFailure('guard_violation', e); }
  }

  // (No return value: all wiring goes through recorder hooks.)
}
