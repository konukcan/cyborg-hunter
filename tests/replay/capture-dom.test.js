// tests/replay/capture-dom.test.js
// Tier-2 DOM capture: serializer (fixture fake-DOM trees), node paths,
// mutation-record → patch translation, stylesheet capture.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  serializeDom, nodePath, mutationToPatch, captureStylesheets,
} from '../../src/replay/capture-dom.js';

// ── Fake DOM builders (duck-typed to what the serializer walks) ──
const ELEMENT = 1, TEXT = 3;

function el(tagName, attrs, children) {
  const node = {
    nodeType: ELEMENT,
    tagName: tagName.toUpperCase(),
    attributes: Object.entries(attrs || {}).map(([name, value]) => ({ name, value })),
    childNodes: children || [],
  };
  (children || []).forEach(c => { c.parentNode = node; });
  // Mirror common properties the serializer prefers over attributes
  (node.attributes).forEach(({ name, value }) => {
    if (name === 'id') node.id = value;
    if (name === 'type') node.type = value;
    if (name === 'value') node.value = value;
  });
  return node;
}
function text(s) { return { nodeType: TEXT, textContent: s, childNodes: [] }; }

describe('serializeDom', () => {
  it('serializes elements, attributes, and text', () => {
    const root = el('div', { class: 'stim' }, [
      el('p', {}, [text('Which card wins?')]),
      el('img', { alt: 'card' }, []),
    ]);
    const html = serializeDom(root, {});
    assert.match(html, /<div class="stim"><p>Which card wins\?<\/p><img alt="card"><\/div>/);
  });

  it('escapes text and attribute values', () => {
    const root = el('div', { title: 'a"b<c' }, [text('1 < 2 & 3')]);
    const html = serializeDom(root, {});
    assert.match(html, /title="a&quot;b&lt;c"/);
    assert.match(html, />1 &lt; 2 &amp; 3</);
  });

  it('strips script elements', () => {
    const root = el('div', {}, [
      el('script', {}, [text('alert(1)')]),
      el('span', {}, [text('kept')]),
    ]);
    const html = serializeDom(root, {});
    assert.ok(!html.includes('script'));
    assert.ok(html.includes('kept'));
  });

  it('strips honeypot/decoy nodes by default, keeps them with keepBait', () => {
    const root = el('body', {}, [
      el('div', { 'data-ch-role': 'honeypot', id: 'fg-honeypot' }, [text('bait')]),
      el('div', { id: 'ch-decoy' }, [text('decoy answer')]),
      el('div', { id: 'real' }, [text('stimulus')]),
    ]);
    const stripped = serializeDom(root, {});
    assert.ok(!stripped.includes('bait'));
    assert.ok(!stripped.includes('decoy answer'));
    assert.ok(stripped.includes('stimulus'));
    const kept = serializeDom(root, { keepBait: true });
    assert.ok(kept.includes('bait'));
    assert.ok(kept.includes('decoy answer'));
  });

  it('serializes img src from the property (absolute URL), not the attribute', () => {
    const img = el('img', { src: 'stim/card.png' }, []);
    img.src = 'https://example.org/stim/card.png';   // property is absolute
    const html = serializeDom(el('div', {}, [img]), {});
    assert.match(html, /src="https:\/\/example\.org\/stim\/card\.png"/);
  });

  it('redacts password input values', () => {
    const pw = el('input', { type: 'password', value: 'hunter2', id: 'pw' }, []);
    const html = serializeDom(el('form', {}, [pw]), {});
    assert.ok(!html.includes('hunter2'));
    assert.match(html, /data-ch-redacted="true"/);
  });
});

describe('serializeDom hardening', () => {
  it('strips event-handler attributes (defense-in-depth beyond the sandbox)', () => {
    const img = el('img', { src: 'x.png', onerror: 'alert(1)', onload: 'evil()' }, []);
    const html = serializeDom(el('div', {}, [img]), {});
    assert.ok(!/onerror|onload|alert|evil/.test(html));
    assert.match(html, /src="x.png"/);
  });

  it('drops attribute names that are not valid tokens', () => {
    const node = el('div', {}, []);
    node.attributes = [{ name: 'data-ok', value: '1' }, { name: 'bad name="x', value: 'y' }];
    const html = serializeDom(node, {});
    assert.match(html, /data-ok="1"/);
    assert.ok(!html.includes('bad name'));
  });
});

describe('nodePath', () => {
  it('computes child-index paths relative to the root', () => {
    const target = el('span', {}, []);
    const root = el('div', {}, [
      el('p', {}, []),
      el('section', {}, [el('a', {}, []), target]),
    ]);
    assert.deepStrictEqual(nodePath(target, root), [1, 1]);
    assert.deepStrictEqual(nodePath(root, root), []);
  });

  it('returns null for a node outside the root', () => {
    const stranger = el('div', {}, []);
    const root = el('div', {}, []);
    assert.strictEqual(nodePath(stranger, root), null);
  });
});

describe('mutationToPatch', () => {
  it('translates childList mutations into state-snapshot patches (resulting children HTML)', () => {
    // Removed nodes are detached by the time the observer fires, so a
    // faithful add/remove log is impossible — instead the patch carries the
    // target's RESULTING children serialization. Applying it is idempotent
    // (innerHTML assignment), which makes backward seeks trivially correct.
    const root = el('div', {}, []);
    const added = el('div', { class: 'feedback' }, [text('Correct!')]);
    const container = el('main', {}, [added]);
    root.childNodes.push(container);
    container.parentNode = root;
    const record = {
      type: 'childList', target: container,
      addedNodes: [added], removedNodes: [],
    };
    const patch = mutationToPatch(record, root, {});
    assert.strictEqual(patch.op, 'childList');
    assert.deepStrictEqual(patch.path, [0]);
    assert.match(patch.html, /Correct!/);
    assert.match(patch.html, /class="feedback"/);
  });

  it('childList snapshots exclude bait nodes among the children', () => {
    const bait = el('div', { 'data-ch-role': 'honeypot' }, [text('bait')]);
    const keep = el('span', {}, [text('kept')]);
    const container = el('main', {}, [bait, keep]);
    const root = el('div', {}, [container]);
    const record = { type: 'childList', target: container, addedNodes: [bait], removedNodes: [] };
    const patch = mutationToPatch(record, root, {});
    assert.ok(!patch.html.includes('bait'));
    assert.ok(patch.html.includes('kept'));
  });

  it('translates attribute changes', () => {
    const target = el('button', { disabled: 'true' }, []);
    const root = el('div', {}, [target]);
    target.getAttribute = (n) => (n === 'disabled' ? 'true' : null);
    const record = { type: 'attributes', target, attributeName: 'disabled' };
    const patch = mutationToPatch(record, root, {});
    assert.deepStrictEqual(
      { op: patch.op, path: patch.path, name: patch.name, value: patch.value },
      { op: 'attributes', path: [0], name: 'disabled', value: 'true' });
  });

  it('translates characterData changes', () => {
    const t = text('updated text');
    const root = el('div', {}, [el('p', {}, [t])]);
    const record = { type: 'characterData', target: t };
    const patch = mutationToPatch(record, root, {});
    assert.deepStrictEqual(
      { op: patch.op, path: patch.path, value: patch.value },
      { op: 'characterData', path: [0, 0], value: 'updated text' });
  });

  it('skips mutations on honeypot subtrees (returns null)', () => {
    const bait = el('div', { 'data-ch-role': 'honeypot' }, []);
    const root = el('body', {}, [bait]);
    const record = { type: 'attributes', target: bait, attributeName: 'style' };
    assert.strictEqual(mutationToPatch(record, root, {}), null);
  });
});

describe('captureStylesheets', () => {
  it('captures css text and falls back to href on cross-origin throw', () => {
    const fakeDoc = {
      styleSheets: [
        { href: null, cssRules: [{ cssText: '.a{color:red}' }, { cssText: '.b{margin:0}' }] },
        { href: 'https://cdn.example/jspsych.css',
          get cssRules() { throw new DOMException('cross-origin'); } },
      ],
    };
    const sheets = captureStylesheets(fakeDoc);
    assert.strictEqual(sheets.length, 2);
    assert.strictEqual(sheets[0].css, '.a{color:red}\n.b{margin:0}');
    assert.strictEqual(sheets[1].href, 'https://cdn.example/jspsych.css');
    assert.strictEqual(sheets[1].css, undefined);
  });
});
