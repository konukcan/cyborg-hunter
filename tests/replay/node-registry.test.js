// tests/replay/node-registry.test.js
// Node-ID registry: keyframe-span-scoped integer ids, first-seen pre-order
// assignment (spec §4). Fake-DOM fixtures duck-typed to `childNodes`, the
// same style as capture-dom.test.js — the registry never touches DOM APIs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../src/replay/node-registry.js';

// ── Fake DOM builders (only childNodes matters to the registry) ──
const ELEMENT = 1, TEXT = 3, COMMENT = 8;

function el(tagName, children) {
  return { nodeType: ELEMENT, tagName: tagName.toUpperCase(), childNodes: children || [] };
}
function text(s) { return { nodeType: TEXT, textContent: s, childNodes: [] }; }
function comment(s) { return { nodeType: COMMENT, textContent: s, childNodes: [] }; }

// The canonical-core segment-0 keyframe tree (fixtures/canonical-core.json):
// div#stage > (button#go > "Go", p#msg > "Hello") numbered 1..5 pre-order.
function canonicalTree() {
  const goText = text('Go');
  const msgText = text('Hello');
  const button = el('button', [goText]);
  const p = el('p', [msgText]);
  const div = el('div', [button, p]);
  return { div, button, goText, p, msgText };
}

describe('createRegistry — pre-order assignment', () => {
  it('numbers the canonical-core segment-0 tree 1..5 in pre-order', () => {
    const reg = createRegistry();
    const { div, button, goText, p, msgText } = canonicalTree();

    const rootId = reg.assignTree(div);

    assert.strictEqual(rootId, 1);
    assert.deepStrictEqual(
      [reg.peekId(div), reg.peekId(button), reg.peekId(goText), reg.peekId(p), reg.peekId(msgText)],
      [1, 2, 3, 4, 5]);
    assert.strictEqual(reg.count, 5);
  });

  it('is idempotent: re-assigning an already-numbered tree keeps the ids', () => {
    const reg = createRegistry();
    const { div, msgText } = canonicalTree();
    reg.assignTree(div);
    reg.assignTree(div);
    assert.strictEqual(reg.peekId(msgText), 5);
    assert.strictEqual(reg.count, 5);
  });
});

describe('createRegistry — span scoping', () => {
  it('resetSpan clears assignments and restarts the counter at 1', () => {
    const reg = createRegistry();
    const first = canonicalTree();
    reg.assignTree(first.div);
    assert.strictEqual(reg.count, 5);

    reg.resetSpan();
    assert.strictEqual(reg.count, 0);
    assert.strictEqual(reg.peekId(first.div), null);   // old span forgotten

    const second = canonicalTree();
    assert.strictEqual(reg.assignTree(second.div), 1);
    assert.strictEqual(reg.peekId(second.msgText), 5);
    assert.strictEqual(reg.count, 5);
  });

  it('mid-span assignTree continues numbering (dom.add allocates 6,7 after a 5-node keyframe)', () => {
    // Pins the canonical fixture's segment-1 dom.add:
    // {node: {id: 6, tag: "span", children: [{id: 7, kind: "text"}]}}
    const reg = createRegistry();
    reg.assignTree(canonicalTree().div);

    const noteText = text('saved');
    const span = el('span', [noteText]);
    const addedId = reg.assignTree(span);

    assert.strictEqual(addedId, 6);
    assert.strictEqual(reg.peekId(noteText), 7);
    assert.strictEqual(reg.count, 7);
  });
});

describe('createRegistry — lookup semantics', () => {
  it('peekId returns null for unknown nodes and never allocates', () => {
    const reg = createRegistry();
    reg.assignTree(canonicalTree().div);
    const stranger = el('section', []);

    assert.strictEqual(reg.peekId(stranger), null);
    assert.strictEqual(reg.peekId(stranger), null);
    assert.strictEqual(reg.count, 5);                  // peeking allocated nothing

    assert.strictEqual(reg.idFor(stranger), 6);        // next id was still free
    assert.strictEqual(reg.peekId(stranger), 6);
  });

  it('idFor assigns the next id to an unknown node and is stable on repeat calls', () => {
    const reg = createRegistry();
    const orphan = el('div', [el('span', [])]);        // children NOT walked by idFor

    assert.strictEqual(reg.idFor(orphan), 1);
    assert.strictEqual(reg.idFor(orphan), 1);
    assert.strictEqual(reg.count, 1);

    assert.strictEqual(reg.idFor(el('p', [])), 2);
    assert.strictEqual(reg.count, 2);
  });
});

describe('createRegistry — node kinds', () => {
  it('assigns ids to text and comment nodes as well as elements', () => {
    const reg = createRegistry();
    const lead = text('before');
    const note = comment('hidden note');
    const inner = text('inside');
    const span = el('span', [inner]);
    const root = el('div', [lead, note, span]);

    reg.assignTree(root);

    assert.deepStrictEqual(
      [reg.peekId(root), reg.peekId(lead), reg.peekId(note), reg.peekId(span), reg.peekId(inner)],
      [1, 2, 3, 4, 5]);
    assert.strictEqual(reg.count, 5);
  });

  it('numbers excluded/bait-looking subtrees too — filtering is the serializer\'s job', () => {
    // The registry numbers whatever tree it is given; exclusion and redaction
    // decisions belong to the snapshot serializer (Task 2).
    const reg = createRegistry();
    const baitText = text('bait');
    const bait = el('div', [baitText]);
    const root = el('body', [bait]);

    reg.assignTree(root);

    assert.deepStrictEqual([reg.peekId(root), reg.peekId(bait), reg.peekId(baitText)], [1, 2, 3]);
    assert.strictEqual(reg.count, 3);
  });
});

describe('createRegistry — count accuracy', () => {
  it('tracks the number of assigned ids across walks, fallbacks, and resets', () => {
    const reg = createRegistry();
    assert.strictEqual(reg.count, 0);

    reg.assignTree(canonicalTree().div);
    assert.strictEqual(reg.count, 5);

    reg.assignTree(el('span', [text('saved')]));       // mid-span add: 6,7
    assert.strictEqual(reg.count, 7);

    reg.idFor(el('em', []));                           // fallback single assign: 8
    assert.strictEqual(reg.count, 8);

    reg.peekId(el('i', []));                           // peek: no allocation
    assert.strictEqual(reg.count, 8);

    reg.resetSpan();
    assert.strictEqual(reg.count, 0);
  });

  it('registries are independent (separate spans do not share a counter)', () => {
    const a = createRegistry();
    const b = createRegistry();
    const shared = el('div', [text('x')]);

    a.assignTree(shared);
    assert.strictEqual(b.peekId(shared), null);
    assert.strictEqual(b.assignTree(shared), 1);
    assert.strictEqual(a.count, 2);
    assert.strictEqual(b.count, 2);
  });
});
