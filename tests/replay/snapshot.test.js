// tests/replay/snapshot.test.js
// DomNode snapshot serializer (spec §4): node-tree keyframes replacing the v1
// HTML-string walker. Uses happy-dom rather than the duck-typed fixtures of
// capture-dom.test.js: this serializer's behaviour is defined against real DOM
// semantics (`matches()`, `shadowRoot`, resolved `src`, canvas width/height,
// the parser's own text/comment/iframe-fallback nodes), and a hand-rolled fake
// would be free to agree with the implementation about all of them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import { serializeTree, isExcluded } from '../../src/replay/snapshot.js';
import { createRegistry } from '../../src/replay/node-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const canonical = JSON.parse(
  readFileSync(join(HERE, 'schema-v2', 'fixtures', 'canonical-core.json'), 'utf8'));

// One-line HTML only: the parser preserves whitespace between tags as text
// nodes, and those are real nodes that get ids and appear in `children`.
function build(html, url = 'https://example.org/exp/') {
  const win = new Window({ url });
  win.document.body.innerHTML = html;
  return { win, doc: win.document, root: win.document.body.firstElementChild };
}

// Every node the serializer emitted, flattened — the counterpart to
// registry.count, which counts every node it NUMBERED.
function flatten(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const child of node.children || []) flatten(child, out);
  return out;
}

describe('serializeTree — node shapes (spec §4)', () => {
  it('reproduces the canonical-core segment-0 keyframe exactly', () => {
    // The machine check that CH's serializer speaks the contract: a DOM
    // equivalent to the hand-authored fixture must serialize to its tree,
    // ids included (1..5 pre-order).
    const { root } = build(
      '<div id="stage"><button id="go">Go</button><p id="msg">Hello</p></div>');
    const reg = createRegistry();

    const tree = serializeTree(root, reg, {});

    assert.deepStrictEqual(tree, canonical.segments[0].initial_dom);
  });

  it('reproduces the canonical-core segment-2 keyframe (empty attrs and children)', () => {
    // Pins the empty-collection encoding against the fixture: `attrs: {}` and
    // `children: []` are PRESENT-AND-EMPTY, never omitted. Also pins that a
    // password field carries no synthetic redaction marker — the fixture's
    // #secret input has its plain attributes and nothing else.
    const { root } = build(
      '<div id="stage"><form>' +
      '<input id="answer" type="text"><input id="secret" type="password">' +
      '</form></div>');
    const reg = createRegistry();

    const tree = serializeTree(root, reg, {});

    assert.deepStrictEqual(tree, canonical.segments[2].initial_dom);
    assert.deepStrictEqual(tree.children[0].attrs, {});   // <form> has no attributes
    assert.deepStrictEqual(tree.children[0].children[0].children, []);
  });

  it('emits text and comment nodes with their own ids', () => {
    const { root } = build('<div>lead<!--note--><span>inner</span></div>');
    const reg = createRegistry();

    const tree = serializeTree(root, reg, {});

    assert.deepStrictEqual(tree.children[0], { id: 2, kind: 'text', text: 'lead' });
    assert.deepStrictEqual(tree.children[1], { id: 3, kind: 'comment', text: 'note' });
    assert.strictEqual(tree.children[2].kind, 'element');
    assert.strictEqual(tree.children[2].tag, 'span');
    assert.deepStrictEqual(tree.children[2].children,
      [{ id: 5, kind: 'text', text: 'inner' }]);
  });

  it('lowercases tag names', () => {
    const { root } = build('<div><SPAN></SPAN></div>');
    const tree = serializeTree(root, createRegistry(), {});
    assert.strictEqual(tree.children[0].tag, 'span');
  });
});

describe('serializeTree — registry integration', () => {
  it('numbers in pre-order and every emitted id matches the registry', () => {
    const { root } = build(
      '<div id="stage"><button id="go">Go</button><p id="msg">Hello</p></div>');
    const reg = createRegistry();
    const live = [root, root.childNodes[0], root.childNodes[0].childNodes[0],
                  root.childNodes[1], root.childNodes[1].childNodes[0]];

    const tree = serializeTree(root, reg, {});

    assert.deepStrictEqual(live.map(n => reg.peekId(n)), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(flatten(tree).map(n => n.id), [1, 2, 3, 4, 5]);
  });

  it('does not reset the span: a second walk continues the numbering', () => {
    // resetSpan is the CALLER's call (keyframe cadence, Task 8). If
    // serializeTree reset the span itself, a mid-span dom.add subtree walk
    // would silently renumber the whole keyframe.
    const reg = createRegistry();
    const first = build('<div><span></span></div>');
    const second = build('<p></p>');

    serializeTree(first.root, reg, {});
    const added = serializeTree(second.root, reg, {});

    assert.strictEqual(added.id, 3);
    assert.strictEqual(reg.count, 3);
  });

  it('mints no ids during emission — every id comes from the numbering pass', () => {
    // The load-bearing half of the two-pass design, and what Task 8's span
    // continuity rests on: if emission could allocate, the id space would
    // depend on serialization decisions and a continuation segment's numbering
    // would drift from the keyframe's. Instrumented rather than inferred —
    // the registry is wrapped so the count at the end of assignTree is
    // captured and compared with the count after the whole walk.
    const { root } = build(
      '<section><script>x()</script><div data-record-exclude><b>hidden</b></div>' +
      '<iframe>fallback</iframe><!--c-->text<span>kept</span></section>');
    const inner = createRegistry();
    let countAfterNumbering = null;
    const spy = {
      assignTree(node) {
        const id = inner.assignTree(node);
        countAfterNumbering = inner.count;
        return id;
      },
      idFor: (n) => inner.idFor(n),
      peekId: (n) => inner.peekId(n),
      resetSpan: () => inner.resetSpan(),
      get count() { return inner.count; },
    };

    const tree = serializeTree(root, spy, {});

    assert.ok(countAfterNumbering > 0);
    assert.strictEqual(inner.count, countAfterNumbering);
    // ...on a tree that really does exercise all four never-emitted classes.
    assert.ok(flatten(tree).length < countAfterNumbering);
  });

  it('is the first allocation after resetSpan, so the keyframe root is id 1', () => {
    const reg = createRegistry();
    const a = build('<div><span></span></div>');
    serializeTree(a.root, reg, {});

    reg.resetSpan();
    const b = build('<div><span></span></div>');
    const tree = serializeTree(b.root, reg, {});

    assert.strictEqual(tree.id, 1);
    assert.strictEqual(tree.children[0].id, 2);
  });
});

describe('serializeTree — script/noscript', () => {
  it('skips script and noscript entirely — no node, no placeholder', () => {
    const { root } = build(
      '<div><script>alert(1)</script><noscript>no js</noscript><span>kept</span></div>');
    const reg = createRegistry();

    const tree = serializeTree(root, reg, {});

    assert.strictEqual(tree.children.length, 1);
    assert.strictEqual(tree.children[0].tag, 'span');
    assert.ok(!JSON.stringify(tree).includes('alert(1)'));
    assert.ok(!JSON.stringify(tree).includes('no js'));
    assert.ok(!JSON.stringify(tree).includes('script'));
  });

  it('still numbers them: the registry counts more nodes than the tree emits', () => {
    // The "numbered but never emitted" class from the registry's contract —
    // assignTree stays unconditional, the SERIALIZER decides what ships.
    const { root } = build(
      '<div><script>alert(1)</script><noscript>no js</noscript><span>kept</span></div>');
    const reg = createRegistry();

    const tree = serializeTree(root, reg, {});

    // div, script, script-text, noscript, noscript-text, span, span-text = 7
    assert.strictEqual(reg.count, 7);
    assert.strictEqual(flatten(tree).length, 3);          // div, span, "kept"
    assert.ok(reg.count > flatten(tree).length);
    assert.strictEqual(reg.peekId(root.childNodes[0]), 2); // the script IS numbered
    assert.strictEqual(tree.children[0].id, 6);            // ...and the span follows it
  });
});

describe('serializeTree — iframe', () => {
  it('emits the iframe element with its attributes and no children', () => {
    // Content is never captured (spec §13); the element itself is, so the
    // player can size and label the region (spec §12).
    const { root } = build(
      '<div><iframe src="survey.html" width="200" height="100">fallback</iframe></div>');
    const reg = createRegistry();

    const tree = serializeTree(root, reg, {});
    const frame = tree.children[0];

    assert.strictEqual(frame.kind, 'element');
    assert.strictEqual(frame.tag, 'iframe');
    assert.deepStrictEqual(frame.attrs,
      { src: 'survey.html', width: '200', height: '100' });
    assert.deepStrictEqual(frame.children, []);
    assert.ok(!JSON.stringify(tree).includes('fallback'));
  });

  it('numbers the fallback content it does not emit', () => {
    const { root } = build('<div><iframe>fallback</iframe></div>');
    const reg = createRegistry();

    serializeTree(root, reg, {});

    assert.strictEqual(reg.count, 3);                     // div, iframe, "fallback"
  });

  it('drops srcdoc, which would inline a whole document (scripts included)', () => {
    // Frame content never replays (spec §13), so srcdoc buys no replay value,
    // and carrying it would make the recording a transport for markup v1 never
    // shipped. Same principle as the on* strip.
    const { root } = build(
      '<div><iframe src="survey.html" width="200" ' +
      'srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;hi&lt;/b&gt;"></iframe></div>');

    const tree = serializeTree(root, createRegistry(), {});
    const frame = tree.children[0];

    assert.ok(!('srcdoc' in frame.attrs));
    assert.deepStrictEqual(frame.attrs, { src: 'survey.html', width: '200' });
    assert.ok(!JSON.stringify(tree).includes('alert(1)'));
  });
});

describe('serializeTree — exclusion (spec §4 placeholders)', () => {
  const cases = [
    ['data-record-exclude (primary)', '<div data-record-exclude><b>secret</b></div>'],
    ['data-ch-role (legacy)', '<div data-ch-role="honeypot"><b>secret</b></div>'],
    ['data-ch-decoy (legacy)', '<div data-ch-decoy="1"><b>secret</b></div>'],
    ['id="ch-decoy" (legacy)', '<div id="ch-decoy"><b>secret</b></div>'],
  ];

  for (const [name, inner] of cases) {
    it(`replaces a subtree marked by ${name} with a placeholder`, () => {
      const { root } = build('<section>' + inner + '<span>kept</span></section>');
      const reg = createRegistry();

      const tree = serializeTree(root, reg, {});
      const placeholder = tree.children[0];

      assert.deepStrictEqual(placeholder, { id: 2, kind: 'element', tag: 'div' });
      assert.ok(!('attrs' in placeholder));
      assert.ok(!('children' in placeholder));
      assert.ok(!JSON.stringify(tree).includes('secret'));
      assert.strictEqual(tree.children[1].tag, 'span');   // siblings unaffected
    });
  }

  it('numbers the excluded subtree so sibling ids keep their positions', () => {
    // The placeholder occupies its slot and its hidden descendants still burn
    // ids — events inside resolve to the placeholder (peekId + nearest-emitted
    // ancestor, Task 3/5).
    const { root } = build(
      '<section><div data-record-exclude><b>secret</b></div><span>kept</span></section>');
    const reg = createRegistry();

    const tree = serializeTree(root, reg, {});

    assert.strictEqual(reg.count, 6);        // section, div, b, "secret", span, "kept"
    assert.strictEqual(tree.children[0].id, 2);
    assert.strictEqual(tree.children[1].id, 5);
  });

  it('keepBait restores the legacy bait markers but never data-record-exclude', () => {
    // keepBait is the v1 debugging/analysis override for CH's own guard bait
    // (isBait, capture-dom.js). data-record-exclude is a researcher-facing
    // privacy control with no opt-out in spec §4, so it survives the override.
    const { root } = build(
      '<section>' +
      '<div data-ch-role="honeypot"><b>bait</b></div>' +
      '<div id="ch-decoy"><b>decoy</b></div>' +
      '<div data-record-exclude><b>consent</b></div>' +
      '</section>');

    const tree = serializeTree(root, createRegistry(), { keepBait: true });
    const json = JSON.stringify(tree);

    assert.ok(json.includes('bait'));
    assert.ok(json.includes('decoy'));
    assert.ok(!json.includes('consent'));
    assert.deepStrictEqual(tree.children[2], { id: 8, kind: 'element', tag: 'div' });
  });

  it('an excluded element inside a redacted subtree stays a bare placeholder', () => {
    // The two mechanisms compose in one direction here: exclusion wins on the
    // marked element (nothing below it ships at all) while its redacted
    // siblings keep their structure with content emptied.
    const { root } = build(
      '<div class="private"><div data-record-exclude><b>hidden</b></div><p>typed</p></div>');

    const tree = serializeTree(root, createRegistry(), { redactSelector: '.private' });

    assert.deepStrictEqual(tree.children[0], { id: 2, kind: 'element', tag: 'div' });
    assert.deepStrictEqual(tree.children[1].children, [{ id: 6, kind: 'text', text: '' }]);
    assert.ok(!JSON.stringify(tree).includes('hidden'));
    assert.ok(!JSON.stringify(tree).includes('typed'));
  });

  it('a redacted field inside an excluded subtree never reaches the walk', () => {
    // The other direction: exclusion short-circuits before redaction is ever
    // consulted, so a password or a selector match below a placeholder is
    // covered by the placeholder itself.
    const { root } = build(
      '<section><div data-record-exclude>' +
      '<input class="private" value="ZQX-SEL-9"><input type="password" value="ZQX-PW-9">' +
      '</div></section>');

    const tree = serializeTree(root, createRegistry(), { redactSelector: '.private' });

    assert.deepStrictEqual(tree.children[0], { id: 2, kind: 'element', tag: 'div' });
    assert.ok(!JSON.stringify(tree).includes('ZQX-SEL-9'));
    assert.ok(!JSON.stringify(tree).includes('ZQX-PW-9'));
  });

  it('isExcluded reports the same decision to the mutation mapper', () => {
    const { root } = build(
      '<section><div data-record-exclude></div><div data-ch-role="x"></div><span></span></section>');
    const [excluded, legacy, plain] = root.childNodes;

    assert.strictEqual(isExcluded(excluded, {}), true);
    assert.strictEqual(isExcluded(legacy, {}), true);
    assert.strictEqual(isExcluded(plain, {}), false);
    assert.strictEqual(isExcluded(legacy, { keepBait: true }), false);
    assert.strictEqual(isExcluded(excluded, { keepBait: true }), true);
  });
});

describe('serializeTree — redaction (spec §8)', () => {
  it('strips a password field value attribute but keeps the element', () => {
    const { root } = build(
      '<form><input id="pw" type="password" value="hunter2"></form>');

    const tree = serializeTree(root, createRegistry(), {});
    const input = tree.children[0];

    assert.deepStrictEqual(input.attrs, { id: 'pw', type: 'password' });
    assert.ok(!JSON.stringify(tree).includes('hunter2'));
  });

  it('keeps structure inside a redactSelector subtree and empties its text', () => {
    // v1 dropped a redacted element's children outright; v2 keeps the shape so
    // layout survives and only the content is withheld.
    const { root } = build(
      '<div class="private"><p><b>typed answer</b></p><input value="typed answer"></div>');

    const tree = serializeTree(root, createRegistry(), { redactSelector: '.private' });

    assert.strictEqual(tree.tag, 'div');
    assert.strictEqual(tree.children.length, 2);
    const bold = tree.children[0].children[0];
    assert.strictEqual(bold.tag, 'b');
    assert.deepStrictEqual(bold.children, [{ id: 4, kind: 'text', text: '' }]);
    assert.deepStrictEqual(tree.children[1].attrs, {});   // value attribute gone
  });

  it('redacts descendants of a redacted element, not just the element itself', () => {
    const { root } = build(
      '<section><div class="private"><span>inner secret</span></div><span>public</span></section>');

    const tree = serializeTree(root, createRegistry(), { redactSelector: '.private' });
    const json = JSON.stringify(tree);

    assert.ok(!json.includes('inner secret'));
    assert.ok(json.includes('public'));
  });

  it('leaks no sentinel anywhere in the serialized tree', () => {
    // Every channel a keyframe can carry participant-entered content through:
    // a password value, a selector-matched field's value, text, and a comment.
    const SENTINEL = 'ZQX-LEAK-SENTINEL-42';
    const { root } = build(
      '<form>' +
      `<input id="pw" type="password" value="${SENTINEL}">` +
      `<div class="private"><p>${SENTINEL}</p><!--${SENTINEL}-->` +
      `<input id="note" value="${SENTINEL}"><video src="clip.mp4"></video></div>` +
      '<p>visible</p></form>');

    const tree = serializeTree(root, createRegistry(), { redactSelector: '.private' });

    assert.ok(!JSON.stringify(tree).includes(SENTINEL));
    assert.ok(JSON.stringify(tree).includes('visible'));
  });

  it('keeps non-value attributes inside a redacted subtree (documented boundary)', () => {
    // Redaction's threat model is participant-ENTERED content: the `value`
    // attribute, text, and (in the event streams) key identities, input values,
    // clipboard payloads, anchor identity. Author-written attributes are page
    // content the recording exists to reconstruct, and stripping them all would
    // leave an unrenderable box where the field was.
    //
    // THIS TEST ASSERTS THE LEAK, not the fix: everything below is the residual
    // a page could smuggle typed content through, named here so the boundary is
    // visible rather than implied by a comment. Widening the strip is a spec
    // question (§8 says "attributes", unqualified), not a silent local change.
    //
    // The §8 FLOOR is the line that must not move, and the last two assertions
    // are where it falls: a password element's `value` goes, in both the
    // attribute and (never read here) the IDL property, while its author-written
    // attributes ride along like any other element's.
    const S = 'zqx-boundary-42';
    const { root } = build(
      '<div class="private">' +
      `<img src="diagram.png" title="a title" alt="${S}-alt" data-note="${S}" ` +
      `style="background:url(${S}.png)" ${S}="1">` +
      `<input id="pw" type="password" value="${S}-typed" title="${S}-title" ` +
      `placeholder="${S}-ph">` +
      '</div>');

    const [img, pw] = serializeTree(root, createRegistry(),
      { redactSelector: '.private' }).children;

    assert.strictEqual(img.attrs.src, 'https://example.org/exp/diagram.png');
    assert.strictEqual(img.attrs.title, 'a title');
    assert.strictEqual(img.attrs.alt, `${S}-alt`);            // author text
    assert.strictEqual(img.attrs['data-note'], S);            // data-* VALUE
    assert.ok(img.attrs.style.includes(S));                   // inline style payload
    assert.ok(S in img.attrs);                                // the attribute NAME

    assert.ok(!('value' in pw.attrs));                        // the §8 floor holds
    assert.strictEqual(pw.attrs.title, `${S}-title`);
    assert.strictEqual(pw.attrs.placeholder, `${S}-ph`);
  });
});

describe('serializeTree — annotations (spec §4)', () => {
  it('annotates canvas elements with canvas_size', () => {
    const { root } = build('<div><canvas width="120" height="80"></canvas></div>');
    const canvasNode = serializeTree(root, createRegistry(), {}).children[0];
    assert.deepStrictEqual(canvasNode.canvas_size, { w: 120, h: 80 });
  });

  it('reports the spec default bitmap size for a bare canvas', () => {
    // 300x150 is the canvas's real bitmap size, not a guess: the width/height
    // IDL properties carry it in any real DOM, so every captured canvas gets
    // the annotation. Only a duck-typed node with neither property nor
    // attribute falls through to no annotation.
    const { root } = build('<div><canvas></canvas></div>');
    const canvasNode = serializeTree(root, createRegistry(), {}).children[0];
    assert.deepStrictEqual(canvasNode.canvas_size, { w: 300, h: 150 });
  });

  it('annotates media elements with a resolved media_src', () => {
    const { root } = build('<div><video src="clip.mp4"></video><audio src="tone.ogg"></audio></div>');
    const [video, audio] = serializeTree(root, createRegistry(), {}).children;
    assert.strictEqual(video.media_src, 'https://example.org/exp/clip.mp4');
    assert.strictEqual(audio.media_src, 'https://example.org/exp/tone.ogg');
  });

  it('omits the annotations on elements that carry no such state', () => {
    const { root } = build('<div><span></span><video></video></div>');
    const [span, video] = serializeTree(root, createRegistry(), {}).children;
    assert.ok(!('canvas_size' in span));
    assert.ok(!('media_src' in span));
    assert.ok(!('media_src' in video));    // no source: nothing to point at
  });

  it('withholds media_src inside a redacted subtree', () => {
    const { root } = build('<div class="private"><video src="clip.mp4"></video></div>');
    const video = serializeTree(root, createRegistry(),
      { redactSelector: '.private' }).children[0];
    assert.ok(!('media_src' in video));
  });
});

describe('serializeTree — shadow hosts', () => {
  it('flags the host, keeps its light DOM, and drops the shadow root (spec §13)', () => {
    // The capture limit is the shadow ROOT's content, not the host's light-DOM
    // children: those are ordinary nodes the walk can see and the player can
    // rebuild. A host with no light children would pass this test either way,
    // so the fixture gives it one.
    const { root, doc } = build('<div><span id="host"><b>light child</b></span></div>');
    const host = doc.getElementById('host');
    host.attachShadow({ mode: 'open' });
    host.shadowRoot.innerHTML = '<i>ZQX-SHADOW-7</i>';

    const tree = serializeTree(root, createRegistry(), {});
    const hostNode = tree.children[0];

    assert.strictEqual(hostNode.attrs['data-ch-shadow'], '');
    assert.strictEqual(hostNode.children.length, 1);
    assert.strictEqual(hostNode.children[0].tag, 'b');
    assert.deepStrictEqual(hostNode.children[0].children,
      [{ id: 4, kind: 'text', text: 'light child' }]);
    assert.ok(!JSON.stringify(tree).includes('ZQX-SHADOW-7'));
  });

  it('does not number the shadow root either', () => {
    const { root, doc } = build('<div><span id="host"><b>light child</b></span></div>');
    doc.getElementById('host').attachShadow({ mode: 'open' });
    doc.getElementById('host').shadowRoot.innerHTML = '<i>hidden</i>';
    const reg = createRegistry();

    serializeTree(root, reg, {});

    assert.strictEqual(reg.count, 4);          // div, span, b, "light child"
  });
});

describe('serializeTree — attribute handling', () => {
  it('drops event-handler attributes (defense-in-depth beyond the player sandbox)', () => {
    const { root } = build('<div><img src="x.png" onerror="alert(1)" onload="evil()"></div>');
    const img = serializeTree(root, createRegistry(), {}).children[0];
    assert.ok(!('onerror' in img.attrs));
    assert.ok(!('onload' in img.attrs));
    assert.ok('src' in img.attrs);
  });

  it('prefers the resolved src property for images over a relative attribute', () => {
    // Reconstruction happens in a document with a different base URL, where a
    // relative stimulus path resolves to nothing (v1 behaviour, kept).
    const { root } = build('<div><img src="stim/card.png" alt="card"></div>');
    const img = serializeTree(root, createRegistry(), {}).children[0];
    assert.deepStrictEqual(img.attrs,
      { src: 'https://example.org/exp/stim/card.png', alt: 'card' });
  });
});
