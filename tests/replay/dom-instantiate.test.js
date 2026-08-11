// tests/replay/dom-instantiate.test.js
// T5 Task 2 — DomNode tree (spec §4) → real DOM, plus the integer-ID map every
// `dom.*` patch (Task 3) and every `anchor.node` (Task 6) resolves through.
//
// The oracle for the shape claims is `tests/replay/support/dom-player.js` — the
// deliberately strict §5.1 player the capture-side suites judge the mutation
// mapper against. Reusing its reader rather than mirroring it is the point:
// the viewer and the test player must hold ONE reading of what a DomNode tree
// becomes, or a capture-side suite and a viewer-side suite can both be green
// about incompatible trees. `asPlayerTree` is the same file's statement of what
// a reconstruction can show (an exclusion placeholder has no attributes and no
// children), so the fixture side of every comparison comes from there too.
//
// happy-dom stands in for the frame realm. The one thing it cannot test is the
// thing §12 is really about — that nothing executes — because nothing executes
// in happy-dom either. What is testable here is that the executable content
// never reaches the tree in the first place: no `on*` attribute is set, no
// `javascript:` URL is set, and a `<script>` is not a `<script>`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { Window } from 'happy-dom';

import { instantiateTree, mountTree } from '../../src/replay/dom-instantiate.js';
import { readTree, asPlayerTree } from './support/dom-player.js';

const FIXTURES = new URL('./schema-v2/fixtures/', import.meta.url);
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'));

function freshDoc() {
  return new Window({ url: 'https://example.org/exp/' }).document;
}

// Node IDENTITY is asserted through `assert.ok(a === b)` rather than
// `assert.equal`, everywhere in this file. Not style: when `assert.equal`
// fails it renders both operands with `util.inspect`, and inspecting a
// happy-dom node walks `ownerDocument → defaultView → …` until the runner is
// SIGKILLed for memory. A reviewer investigating a real failure would get a
// dead process instead of a diff. (Found the hard way while writing this file.)
function same(actual, expectedNode, what) {
  assert.ok(actual === expectedNode, what);
}

// The reader wants node → id; the viewer's map is id → node, because that is
// the direction every patch resolves in. Inverting it here also pins that no
// two ids share a node, which is what makes the inversion lossless.
function invert(idMap) {
  const idOf = new Map();
  for (const [id, node] of idMap) idOf.set(node, id);
  assert.equal(idOf.size, idMap.size, 'two ids bound to the same node');
  return idOf;
}

function roundTrip(dom) {
  const doc = freshDoc();
  const { root, idMap } = instantiateTree(dom, doc);
  return readTree(root, invert(idMap));
}

// `canvas_size` and `media_src` are spec §4 ANNOTATIONS, not DOM. They travel
// out of band — into the `canvases` map and into the resolved `src` — and no
// live DOM read can produce them, so a structural round-trip has to drop them
// from the expected side. Both are asserted directly further down.
function withoutAnnotations(node) {
  if (!node || node.kind !== 'element') return node;
  return {
    id: node.id, kind: 'element', tag: node.tag,
    attrs: node.attrs, children: node.children.map(withoutAnnotations),
  };
}

const expected = (dom) => withoutAnnotations(asPlayerTree(dom));

// The one place the viewer and the strict test player legitimately disagree.
// happy-dom sets any attribute name it is given; a real browser's
// `setAttribute` throws `InvalidCharacterError` on a name outside the XML Name
// production, so the player holds an attribute the reconstruction CANNOT. The
// corpus has exactly one (named below), and the loop that forgives it counts
// what it forgave — otherwise this helper would quietly bless a filter that had
// started eating ordinary attributes.
function dropUnnameable(node, tally) {
  if (!node || node.kind !== 'element') return node;
  const attrs = {};
  for (const [name, value] of Object.entries(node.attrs)) {
    if (/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(name) && !/^on/i.test(name)) attrs[name] = value;
    else tally.push(name);
  }
  return {
    id: node.id, kind: 'element', tag: node.tag, attrs,
    children: node.children.map((c) => dropUnnameable(c, tally)),
  };
}

describe('instantiateTree — tree shapes round-trip', () => {
  it('canonical-core segment 0 instantiates to the tree the strict player reads', () => {
    const dom = fixture('canonical-core').segments[0].initial_dom;
    assert.deepEqual(roundTrip(dom), expected(dom));
  });

  it('jspsych-full segment 0 — a real jsPsych 8.2.3 body tree — round-trips', () => {
    const dom = fixture('jspsych-full').segments[0].initial_dom;
    assert.equal(dom.tag, 'body');
    assert.deepEqual(roundTrip(dom), expected(dom));
  });

  it('every committed keyframe in both fixtures round-trips', () => {
    let checked = 0;
    const forgiven = [];
    for (const name of ['canonical-core', 'jspsych-full']) {
      for (const seg of fixture(name).segments) {
        if (!seg.initial_dom) continue;
        assert.deepEqual(roundTrip(seg.initial_dom),
          dropUnnameable(expected(seg.initial_dom), forgiven),
          name + ' segment ' + seg.index);
        checked++;
      }
    }
    // 2 canonical keyframes + jspsych-full's 14. A silent zero here would make
    // the loop a green test over nothing.
    assert.equal(checked, 16);
    // And exactly one attribute forgiven, corpus-wide — see the test below.
    assert.deepEqual(forgiven, ['<']);
  });

  it("jspsych-full's free-sort arena carries an attribute setAttribute refuses", () => {
    // A REAL-CORPUS instance of the §12 name filter, not a constructed one:
    // jsPsych 8.2.3's free-sort plugin builds its arena from an HTML string the
    // parser reads as carrying attributes named `<` and `div`. `div` is a legal
    // name and survives; `<` is outside the XML Name production, so a real
    // browser's `setAttribute` throws `InvalidCharacterError` on it — one
    // malformed attribute in one plugin would abort the whole reconstruction.
    // The strict test player sets it happily, which is why the round-trip loop
    // above has to forgive exactly this one attribute.
    const arena = fixture('jspsych-full').segments[10].initial_dom;
    let node = null;
    (function walk(n) {
      if (n.attrs && Object.prototype.hasOwnProperty.call(n.attrs, '<')) node = n;
      (n.children || []).forEach(walk);
    })(arena);
    assert.ok(node, 'the fixture no longer carries the malformed attribute');
    assert.equal(node.id, 10);
    assert.equal(node.attrs['<'], '');

    const { idMap } = instantiateTree(arena, freshDoc());
    const el = idMap.get(10);
    assert.equal(el.getAttribute('<'), null);
    assert.equal(el.getAttribute('div'), '');
    assert.equal(el.getAttribute('id'), 'jspsych-free-sort-arena');
  });

  it('maps every node in the tree, ids included', () => {
    const dom = fixture('jspsych-full').segments[0].initial_dom;
    const { idMap } = instantiateTree(dom, freshDoc());
    let count = 0;
    (function walk(n) { count++; (n.children || []).forEach(walk); })(dom);
    assert.equal(idMap.size, count);
    assert.equal(idMap.size, 22);
    assert.equal(idMap.get(dom.id).tagName.toLowerCase(), 'body');
  });
});

describe('mountTree — the body-root split (design §4)', () => {
  it('a body root applies its attributes to the frame body and maps its id to it', () => {
    const dom = fixture('jspsych-full').segments[0].initial_dom;
    const doc = freshDoc();
    const { root, idMap } = mountTree(dom, doc.body, doc);

    same(root, doc.body, 'the returned root IS the frame body');
    same(idMap.get(dom.id), doc.body, 'the root id binds to the frame body');
    for (const [name, value] of Object.entries(dom.attrs)) {
      assert.equal(doc.body.getAttribute(name), value, name);
    }
    assert.equal(doc.body.childNodes.length, dom.children.length);
    // The children land INSIDE the frame's own body, not inside a nested one:
    // the `height:100%` chain a wiped jsPsych display depends on runs through
    // the real body element (design §4).
    assert.equal(doc.body.querySelectorAll('body').length, 0);
    assert.deepEqual(readTree(doc.body, invert(idMap)), expected(dom));
  });

  it('a non-body root is instantiated as a child of a cleared body', () => {
    const dom = fixture('canonical-core').segments[0].initial_dom;
    const doc = freshDoc();
    const { root, idMap } = mountTree(dom, doc.body, doc);

    same(root.parentNode, doc.body, 'the root is a child of the frame body');
    assert.equal(doc.body.childNodes.length, 1);
    same(idMap.get(dom.id), root, 'the root id binds to the instantiated root');
    assert.equal(root.tagName.toLowerCase(), 'div');
  });

  it('mounting clears the previous mount — children and body attributes both', () => {
    const doc = freshDoc();
    doc.body.setAttribute('class', 'from-the-previous-segment');
    doc.body.appendChild(doc.createElement('section'));

    const dom = fixture('canonical-core').segments[0].initial_dom;
    mountTree(dom, doc.body, doc);

    assert.equal(doc.body.getAttribute('class'), null);
    assert.equal(doc.body.attributes.length, 0);
    assert.equal(doc.body.childNodes.length, 1);
    assert.equal(doc.body.querySelectorAll('section').length, 0);
  });

  it('a null keyframe clears the body and mounts nothing', () => {
    const doc = freshDoc();
    doc.body.appendChild(doc.createElement('section'));
    const { root, idMap } = mountTree(null, doc.body, doc);
    same(root, null, 'a null keyframe mounts no root');
    assert.equal(idMap.size, 0);
    assert.equal(doc.body.childNodes.length, 0);
  });
});

describe('spec §12 player filters', () => {
  // One node carrying every shape the filters exist for. Recording content is
  // attacker-controlled (§12) and a foreign producer is not bound by CH's own
  // capture-side strip, so this is a player duty, not a belt on a brace.
  const hostile = {
    id: 1,
    kind: 'element',
    tag: 'div',
    attrs: {
      id: 'kept',
      title: 'javascript:this is not a URL attribute',
      'data-note': 'onclick',
      onclick: 'alert(1)',
      ONMOUSEOVER: 'alert(2)',
      onFocus: 'alert(3)',
      href: 'javascript:alert(4)',
      src: '  JaVaScRiPt:alert(5)',
      action: 'vbscript:msgbox(6)',
      // The HTML/URL parsers strip tabs and newlines out of URLs, so a scheme
      // test that does not strip them first is bypassed by one \t.
      formaction: 'java\tscr\nipt:alert(7)',
      'xlink:href': 'JAVASCRIPT:alert(8)',
      'not a name': 'setAttribute would throw on this',
    },
    children: [],
  };

  it('drops on* handlers, javascript:/vbscript: URLs, and unnameable attributes', () => {
    const { root } = instantiateTree(hostile, freshDoc());
    const names = Array.from(root.attributes).map((a) => a.name);
    assert.deepEqual(names.slice().sort(), ['data-note', 'id', 'title']);
    for (const dropped of ['onclick', 'ONMOUSEOVER', 'onFocus', 'onmouseover', 'onfocus',
      'href', 'src', 'action', 'formaction', 'xlink:href', 'not a name']) {
      assert.equal(root.getAttribute(dropped), null, dropped);
    }
    // Kept, and kept VERBATIM: `title` is not a URL attribute, so a value that
    // merely reads like one is page content, not a vector.
    assert.equal(root.getAttribute('title'), hostile.attrs.title);
    assert.equal(root.getAttribute('data-note'), 'onclick');
  });

  it('keeps ordinary URLs in the same attributes it filters', () => {
    const { root } = instantiateTree({
      id: 1, kind: 'element', tag: 'a',
      attrs: {
        href: 'https://example.org/next',
        src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        'xlink:href': '#local',
      },
      children: [],
    }, freshDoc());
    assert.equal(root.getAttribute('href'), 'https://example.org/next');
    assert.equal(root.getAttribute('src'), 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');
    assert.equal(root.getAttribute('xlink:href'), '#local');
  });

  it('script and noscript become inert <template>s and keep their ids', () => {
    const dom = {
      id: 1, kind: 'element', tag: 'div', attrs: {}, children: [
        { id: 2, kind: 'element', tag: 'script', attrs: { type: 'text/javascript' },
          children: [{ id: 3, kind: 'text', text: 'alert(1)' }] },
        { id: 4, kind: 'element', tag: 'noscript', attrs: {}, children: [] },
      ],
    };
    const { root, idMap } = instantiateTree(dom, freshDoc());
    assert.equal(idMap.get(2).tagName.toLowerCase(), 'template');
    assert.equal(idMap.get(4).tagName.toLowerCase(), 'template');
    assert.equal(root.querySelectorAll('script').length, 0);
    assert.equal(root.querySelectorAll('noscript').length, 0);
    // Sibling positions and the id bindings survive, which is why a template is
    // used rather than a drop: a later patch addressing node 2, 3 or 4 lands.
    assert.equal(root.childNodes.length, 2);
    same(root.childNodes[0], idMap.get(2), 'the script keeps its position');
    same(root.childNodes[1], idMap.get(4), 'the noscript keeps its position');
    assert.equal(idMap.size, 4);
    // The source survives as inert TEXT, addressable by its own id. WHERE it
    // sits inside the template is realm-dependent and deliberately unasserted:
    // happy-dom routes `appendChild` into `template.content`, a real browser
    // keeps it in `childNodes`, and a template renders neither.
    assert.equal(idMap.get(3).nodeType, 3);
    assert.equal(idMap.get(3).data, 'alert(1)');
  });

  it('an iframe is instantiated without src/srcdoc and stamped as a placeholder', () => {
    const { root, idMap } = instantiateTree({
      id: 1, kind: 'element', tag: 'iframe',
      attrs: {
        src: 'https://survey.example.com/s/1',
        srcdoc: '<script>alert(1)</script>',
        width: '400', height: '300', title: 'embedded survey',
      },
      children: [],
    }, freshDoc());
    assert.equal(root.getAttribute('src'), null);
    assert.equal(root.getAttribute('srcdoc'), null);
    assert.equal(root.getAttribute('data-ch-placeholder'), 'iframe');
    // Everything else survives, so the region keeps its shape and the existing
    // header chip has something to detect (design §4).
    assert.equal(root.getAttribute('width'), '400');
    assert.equal(root.getAttribute('title'), 'embedded survey');
    same(idMap.get(1), root, 'the iframe keeps its id');
  });
});

describe('spec §4 annotations', () => {
  it('an exclusion placeholder instantiates as a bare empty element', () => {
    // §4: the placeholder carries `id`, `kind` and `tag`; its attributes and
    // children keys are ABSENT, which is the whole encoding.
    const dom = {
      id: 1, kind: 'element', tag: 'div', attrs: {}, children: [
        { id: 2, kind: 'element', tag: 'p' },
        { id: 3, kind: 'text', text: 'after' },
      ],
    };
    const { root, idMap } = instantiateTree(dom, freshDoc());
    const placeholder = idMap.get(2);
    assert.equal(placeholder.tagName.toLowerCase(), 'p');
    assert.equal(placeholder.attributes.length, 0);
    assert.equal(placeholder.childNodes.length, 0);
    // Sibling positions stay coherent — the reason §4 keeps the node at all.
    assert.equal(root.childNodes.length, 2);
    same(root.childNodes[1], idMap.get(3), 'the placeholder holds its position');
    assert.deepEqual(readTree(root, invert(idMap)), asPlayerTree(dom));
  });

  it('canvas_size is recorded for the sizing repair and the offscreen composite', () => {
    const jspsych = fixture('jspsych-full');
    const sketchpad = jspsych.segments[9].initial_dom;
    const { idMap, canvases } = instantiateTree(sketchpad, freshDoc());

    assert.deepEqual(canvases.get(8), { w: 400, h: 300 });
    assert.equal(canvases.size, 1);
    assert.equal(idMap.get(8).tagName.toLowerCase(), 'canvas');
    // The annotation is NOT smuggled into the reconstruction as an attribute:
    // the round-trip above would have caught it, and the composite reads the
    // map instead (design §3.1, §3.3).
    assert.equal(idMap.get(8).getAttribute('canvas_size'), null);

    const baseline = instantiateTree(jspsych.segments[8].initial_dom, freshDoc());
    assert.deepEqual(baseline.canvases.get(3), { w: 400, h: 300 });
  });

  it('media_src is applied as the resolved src', () => {
    const { root } = instantiateTree({
      id: 1, kind: 'element', tag: 'video',
      attrs: { src: 'stimuli/clip.mp4', controls: '' },
      media_src: 'https://example.org/exp/stimuli/clip.mp4',
      children: [],
    }, freshDoc());
    // The recorded attribute is a page-relative path that resolves to nothing
    // in a srcdoc frame; `media_src` is what the element actually loaded, so it
    // wins — the same rule capture applies to <img> (snapshot.js).
    assert.equal(root.getAttribute('src'), 'https://example.org/exp/stimuli/clip.mp4');
    assert.equal(root.getAttribute('controls'), '');
  });

  it('a hostile media_src is filtered like any other URL attribute', () => {
    const { root } = instantiateTree({
      id: 1, kind: 'element', tag: 'video', attrs: {},
      media_src: 'javascript:alert(1)', children: [],
    }, freshDoc());
    assert.equal(root.getAttribute('src'), null);
  });
});

describe('the module is concatenable into the report viewer as a plain script', () => {
  // The viewer client is an IIFE inlined verbatim into the report by
  // html-index.js; it cannot `import`. The recorded decision (Task 2) is that
  // the BUILD concatenates this module's source ahead of the client rather than
  // the client carrying a second copy of it — so the module has to stay plain
  // script text with exactly one strippable ESM statement. These two tests are
  // what stop that decision from silently expiring.
  const SRC = readFileSync(
    new URL('../../src/replay/dom-instantiate.js', import.meta.url), 'utf8');
  const EXPORT_BLOCK = /^export \{[^}]*\};$/m;

  it('carries no imports and exactly one trailing export block', () => {
    const statements = SRC.match(/^\s*(?:import|export)\b.*$/gm) || [];
    assert.equal(statements.length, 1, 'expected one ESM statement, got: ' + statements);
    assert.match(statements[0], EXPORT_BLOCK);
    assert.match(SRC.trimEnd(), /export \{[^}]*\};$/);
  });

  it('evaluates as a strict-mode script and yields a working instantiateTree', () => {
    const script = SRC.replace(EXPORT_BLOCK, '');
    // Strict mode because the assembler wraps the concatenation in the same
    // `'use strict'` IIFE the client uses; ESM is strict by default, so a
    // sloppy-only construct would pass the module tests and break in the report.
    const api = new Function("'use strict';" + script +
      '\nreturn { instantiateTree: instantiateTree, mountTree: mountTree };')();
    const dom = fixture('canonical-core').segments[0].initial_dom;
    const doc = freshDoc();
    const { root, idMap } = api.instantiateTree(dom, doc);
    assert.deepEqual(readTree(root, invert(idMap)), expected(dom));
    same(api.mountTree(dom, doc.body, doc).root.parentNode, doc.body,
      'the concatenated mountTree still mounts into the body');
  });
});
