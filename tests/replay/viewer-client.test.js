// tests/replay/viewer-client.test.js
// The shipped report viewer, driven headlessly over v2 models (T5 Task 4).
//
// The boot harness (`boot`, `stubCanvas`, `withProto`, the recording builders)
// moved to `tests/replay/support/viewer-harness.js` at T5.6, unchanged, so the
// alignment suite boots the same viewer the same way; its header carries the
// realm notes (assembled script, synchronous `srcdoc`, no layout engine).
//
// This file asserts STATE (reconstruction, seeds, ordering, counters, chips).
// Geometry belongs to the Playwright battery (Task 8), and the five alignment
// predicates to `alignment-viewer-model.test.js` (Task 6).

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  boot, fixture, same, withProto, baseRecording, segment, bodyKeyframe,
} from './support/viewer-harness.js';

// Composite calls, in the order they were made, from every offscreen canvas the
// client owns. An offscreen canvas is identified by having a `drawImage` at all
// — the overlay and the marker lane draw strokes and rects and never an image.
function offscreenCalls(v) {
  const out = [];
  (v.win.__canvases || []).forEach((c) => {
    if (!c.__ctx || !c.__ctx.calls.some((call) => call.name === 'drawImage')) return;
    c.__ctx.calls.forEach((call) => {
      if (call.name === 'drawImage') {
        out.push({ draw: String(call.args[0].src || ''), x: call.args[1], y: call.args[2] });
      } else if (call.name === 'clearRect') {
        out.push({ clear: true });
      }
    });
  });
  return out;
}

// ── the span restore ───────────────────────────────────────────────────────

describe('T5.4 — span restore over the committed canonical fixture', () => {
  // Session t=4100 lands in segment 2, whose origin is t_load 3510, so the
  // segment-relative seek is 590 — past the input.value at wire 4000 (tRel
  // 490). The plan states the seek in SESSION time; the viewer's playhead is
  // segment-relative, and `round1(t − origin)` is the one conversion rule
  // (viewer-model.js's forward contract), so it is applied here rather than
  // approximated.
  const REL_4100 = Math.round((4100 - 3510) * 10) / 10;

  it('seeds initial_state, then lets the stream overwrite it', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(2);

    // At the segment origin only the seed has run: form[] gave node 3 "ab".
    same(v.dbg.getNode(3), v.doc().getElementById('answer'),
      'the id map resolves node 3 to the mounted input');
    assert.equal(v.dbg.getNode(3).value, 'ab', 'seed applied at the origin');

    v.dbg.seek(REL_4100);
    assert.equal(v.dbg.getNode(3).value, 'abc', 'the input.value event overwrote the seed');

    // Backward seek restores the span and re-seeds — the parity claim: the
    // seed and the recorded stream reach their states through one code path.
    v.dbg.seek(0);
    assert.equal(v.dbg.getNode(3).value, 'ab', 'seeking back to the origin restores the seed');
  });

  it('applies the seed AFTER the mount and BEFORE the events', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(2);
    // Seed-before-mount writes into nothing — `input.value` on a node the tree
    // has not created yet is a silent no-op — and leaves "" here.
    assert.equal(v.dbg.getNode(3).value, 'ab');
    v.dbg.seek(1000);
    // Seed-after-events is only observable through a RESTORE whose target is
    // past the event: a forward walk from 0 reaches "abc" under either order.
    // So the assertion has to be made after a backward seek, which is what an
    // analyst dragging the scrub does constantly.
    v.dbg.seek(600);
    assert.equal(v.dbg.getNode(3).value, 'abc',
      'the restore replayed the seed first and the stream over it, not the reverse');
  });

  it('redacted input.value renders bullets, not the withheld length as text', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(2);
    v.dbg.seek(1000);
    assert.equal(v.dbg.getNode(4).value, '•', 'value_len 1 renders one bullet');
  });

  it('reconstructs a continuation segment from the previous keyframe', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(1);
    assert.equal(v.dbg.getSpanStart(), 0, 'segment 1 opens segment 0\'s span');
    // Mounted from segment 0's keyframe: the button and its text are there.
    assert.equal(v.dbg.getNode(2).tagName.toLowerCase(), 'button');
    // Segment 0's own dom.text at wire 460 belongs to the span walk and must
    // have been replayed on the way to segment 1.
    v.dbg.seek(500);
    assert.equal(v.dbg.getNode(5).nodeValue, 'Clicked!',
      'the earlier segment\'s patches replay before the continuation\'s');
    assert.equal(v.dbg.getNode(2).getAttribute('disabled'), '',
      'segment 1\'s own dom.attr applied');
    assert.equal(v.dbg.getCounters().patchFailures, 0);
    assert.equal(v.dbg.getCounters().skipped, 0);
  });

  it('resets window scroll to 0 for a segment with no initial_state', () => {
    const v = boot(fixture('canonical-core'));
    // Segment 1 scrolls the window to y=120 at wire 2500 (tRel 500).
    v.dbg.selectSegment(1);
    v.dbg.seek(1000);
    assert.equal(v.dbg.getCamera().y, 120, 'the scroll.window event applied');
    assert.equal(v.doc().defaultView.scrollY, 120);
    // Segment 0 has no initial_state at all. The frame survives the segment
    // change, so without the reset it would still be scrolled.
    v.dbg.selectSegment(0);
    assert.equal(v.dbg.getCamera().y, 0, 'camera reset');
    assert.equal(v.doc().defaultView.scrollY, 0, 'the live frame was scrolled back');
  });

  it('seeds window scroll from initial_state when the keyframe carries one', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(2);   // initial_state.scroll = {x:0, y:120}
    assert.equal(v.dbg.getCamera().y, 120);
    assert.equal(v.doc().defaultView.scrollY, 120);
  });
});

describe('T5.4 — forward walk vs backward restore', () => {
  it('a forward seek continues incrementally; a backward seek remounts', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(1);
    const mounts0 = v.dbg.getStats().mounts;
    v.dbg.seek(200);
    v.dbg.seek(400);
    v.dbg.seek(600);
    assert.equal(v.dbg.getStats().mounts, mounts0,
      'three forward seeks inside the applied span cost no remount');
    v.dbg.seek(100);
    assert.equal(v.dbg.getStats().mounts, mounts0 + 1, 'the backward seek restored');
  });

  it('writes the srcdoc shell ONCE and never again for a seek', () => {
    const v = boot(fixture('canonical-core'));
    const shells0 = v.dbg.getStats().shellWrites;
    assert.equal(shells0, 1, 'one shell write at boot');
    v.dbg.selectSegment(1);
    v.dbg.seek(600);
    v.dbg.seek(0);
    v.dbg.selectSegment(2);
    assert.equal(v.dbg.getStats().shellWrites, 1,
      'segment changes and backward seeks are synchronous DOM work, not srcdoc rewrites');
  });

  it('coalesces scrub seeks to at most one restore per animation frame', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(1);
    v.dbg.seek(900);
    const mounts0 = v.dbg.getStats().mounts;
    const scrub = v.mount.querySelector('.replay-scrub');
    // A drag: eight backward positions in one frame. Uncoalesced, each is a
    // restore (v1's behaviour, `input` → seek); coalesced, the frame does one.
    for (const t of [800, 700, 600, 500, 400, 300, 200, 100]) {
      scrub.value = String(t);
      scrub.dispatchEvent(new v.win.Event('input'));
    }
    assert.equal(v.dbg.getStats().mounts, mounts0, 'nothing restored before the frame ran');
    v.flushFrames();
    assert.equal(v.dbg.getStats().mounts, mounts0 + 1, 'exactly one restore');
    assert.equal(Math.round(v.dbg.getPlayhead()), 100, 'and it targets the LATEST request');
  });
});

describe('T5.4 — deep spans', () => {
  // The §5 worst case: keyframeEvery 10, so the deepest continuation sits nine
  // segments after its keyframe and a restore into it replays ten segments.
  function tenSegmentSpan() {
    const segs = [segment({
      index: 0, t_start: 0, t_end: 100,
      initial_dom: bodyKeyframe([
        { id: 2, kind: 'element', tag: 'p', attrs: { id: 'p' }, children: [{ id: 3, kind: 'text', text: 's0' }] },
      ]),
      events: [],
    })];
    for (let i = 1; i < 10; i++) {
      segs.push(segment({
        index: i, t_start: i * 100, t_end: i * 100 + 100,
        events: [
          { type: 'dom.text', t: i * 100 + 10, node: 3, text: 's' + i },
          { type: 'dom.attr', t: i * 100 + 20, node: 2, name: 'data-step', value: String(i) },
        ],
      }));
    }
    return baseRecording({ segments: segs });
  }

  it('reconstructs the 9th continuation by replaying the whole span', () => {
    const v = boot(tenSegmentSpan());
    v.dbg.selectSegment(9);
    v.dbg.seek(100);
    assert.equal(v.dbg.getSpanStart(), 0);
    assert.equal(v.dbg.getNode(3).nodeValue, 's9');
    assert.equal(v.dbg.getNode(2).getAttribute('data-step'), '9');
    assert.equal(v.dbg.getCounters().patchFailures, 0);
    assert.equal(v.dbg.getCounters().skipped, 0);
  });

  it('a mid-span segment sees only the patches up to its own playhead', () => {
    const v = boot(tenSegmentSpan());
    v.dbg.selectSegment(4);
    v.dbg.seek(15);   // past segment 4's dom.text (tRel 10), before its dom.attr (20)
    assert.equal(v.dbg.getNode(3).nodeValue, 's4');
    assert.equal(v.dbg.getNode(2).getAttribute('data-step'), '3',
      'the later patch in the same segment has not applied yet');
  });
});

describe('T5.4 — stylesheet derivation and the §7 tie precedence', () => {
  function sheetRecording() {
    return baseRecording({
      stylesheets: [{ id: 1, kind: 'inline', css: '#p{color:red}', media: null }],
      stylesheet_events: [
        { type: 'stylesheet.update', t: 50, id: 1, css: '#p{color:green}' },
        { type: 'stylesheet.add', t: 150, sheet: { id: 2, kind: 'inline', css: '#p{font-weight:bold}', media: null } },
        { type: 'stylesheet.remove', t: 250, id: 1 },
      ],
      segments: [
        segment({
          index: 0, t_start: 0, t_end: 100,
          initial_dom: bodyKeyframe([{ id: 2, kind: 'element', tag: 'p', attrs: { id: 'p' }, children: [] }]),
        }),
        segment({
          index: 1, t_start: 100, t_load: 100, t_end: 400,
          initial_dom: bodyKeyframe([{ id: 2, kind: 'element', tag: 'p', attrs: { id: 'p' }, children: [] }]),
        }),
      ],
    });
  }

  const sheets = (doc) => Array.from(doc.querySelectorAll('[data-ch-sheet]'))
    .map((n) => ({ id: n.getAttribute('data-ch-sheet'), css: n.textContent }));

  it('derives the sheet state at the keyframe origin rather than seeding it', () => {
    const v = boot(sheetRecording());
    // Segment 1's keyframe origin is 100: the t=50 update is BEFORE it and is
    // part of the derived state; the t=150 add and t=250 remove are not.
    v.dbg.selectSegment(1);
    assert.deepEqual(sheets(v.doc()), [{ id: '1', css: '#p{color:green}' }]);
  });

  it('applies the in-window sheet events through the span walk', () => {
    const v = boot(sheetRecording());
    v.dbg.selectSegment(1);
    v.dbg.seek(60);      // wire 160 — past the add, before the remove
    assert.deepEqual(sheets(v.doc()), [
      { id: '1', css: '#p{color:green}' }, { id: '2', css: '#p{font-weight:bold}' },
    ]);
    v.dbg.seek(200);     // wire 300 — past the remove
    assert.deepEqual(sheets(v.doc()), [{ id: '2', css: '#p{font-weight:bold}' }]);
  });

  it('rebuilds sheet state from the session baseline on every restore', () => {
    const v = boot(sheetRecording());
    v.dbg.selectSegment(1);
    v.dbg.seek(200);                            // sheet 1 removed
    v.dbg.seek(0);                              // backward: restore
    assert.deepEqual(sheets(v.doc()), [{ id: '1', css: '#p{color:green}' }],
      'the removed sheet came back — derivation, not a running mutation');
  });

  it('orders equal-t entries stylesheet → viewport → segment event (§7)', () => {
    const rec = baseRecording({
      stylesheet_events: [
        { type: 'stylesheet.add', t: 100, sheet: { id: 9, kind: 'inline', css: '#p{color:blue}', media: null } },
      ],
      viewport_changes: [{ t: 100, w: 640, h: 480, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 }],
      segments: [segment({
        index: 0, t_start: 0, t_end: 300,
        initial_dom: bodyKeyframe([{ id: 2, kind: 'element', tag: 'p', attrs: { id: 'p' }, children: [] }]),
        events: [{ type: 'dom.attr', t: 100, node: 2, name: 'data-x', value: 'set' }],
      })],
    });
    const v = boot(rec);
    v.dbg.seek(200);
    // All three landed…
    assert.equal(v.doc().querySelector('[data-ch-sheet="9"]').textContent, '#p{color:blue}');
    assert.equal(v.dbg.getCamera().w, 640);
    assert.equal(v.dbg.getNode(2).getAttribute('data-x'), 'set');
    // …in the order §7 fixes for a tie. `rank` IS the precedence the merge
    // sorts on, so asserting the merged list is asserting the rule the walk
    // consumes.
    const tied = v.dbg.getWalk().filter((w) => w.t === 100);
    assert.deepEqual(tied.map((w) => w.stream), ['stylesheet', 'viewport', 'event']);
  });
});

describe('T5.4 — the data-ch-* family is viewer-owned, both verbs', () => {
  const iframeKeyframe = () => bodyKeyframe([
    { id: 2, kind: 'element', tag: 'iframe', attrs: { src: 'https://evil.test/x', id: 'f' }, children: [] },
    { id: 3, kind: 'element', tag: 'div', attrs: { id: 'host', 'data-ch-shadow': '' }, children: [] },
    { id: 4, kind: 'element', tag: 'div', attrs: { id: 'plain' }, children: [] },
  ]);

  it('fires the iframe and shadow chips on a v2 reconstruction', () => {
    const v = boot(baseRecording({
      segments: [segment({ initial_dom: iframeKeyframe() })],
    }));
    assert.notEqual(v.chip('data-ch-iframe-warn').style.display, 'none',
      'a real childless <iframe> is what v2 capture emits — the chip must see it');
    assert.notEqual(v.chip('data-ch-shadow-warn').style.display, 'none');
    assert.equal(v.dbg.getNode(2).getAttribute('data-ch-placeholder'), 'iframe');
    assert.equal(v.dbg.getNode(2).hasAttribute('src'), false, 'no src to fetch');
  });

  it('the shell stylesheet outlines the placeholder region', () => {
    const v = boot(baseRecording({ segments: [segment({ initial_dom: iframeKeyframe() })] }));
    const shellCss = Array.from(v.doc().querySelectorAll('style'))
      .map((s) => s.textContent).join('\n');
    assert.match(shellCss, /\[data-ch-placeholder\]/,
      'the stamped element gets a rule so the region reads as "something was here"');
    assert.match(shellCss, /dashed/);
  });

  it('a recording cannot FORGE a viewer-owned stamp from a keyframe', () => {
    const v = boot(baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([
          { id: 2, kind: 'element', tag: 'div', attrs: { id: 'liar', 'data-ch-placeholder': 'iframe' }, children: [] },
        ]),
      })],
    }));
    assert.equal(v.dbg.getNode(2).hasAttribute('data-ch-placeholder'), false);
    assert.equal(v.chip('data-ch-iframe-warn').style.display, 'none',
      'no iframe in this reconstruction, so no chip');
  });

  it('a recording cannot FORGE a viewer-owned stamp by dom.attr', () => {
    const v = boot(baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([{ id: 2, kind: 'element', tag: 'div', attrs: { id: 'd' }, children: [] }]),
        events: [
          { type: 'dom.attr', t: 10, node: 2, name: 'data-ch-placeholder', value: 'iframe' },
          { type: 'dom.attr', t: 20, node: 2, name: 'data-ch-shadow', value: '' },
        ],
      })],
    }));
    v.dbg.seek(100);
    assert.equal(v.dbg.getNode(2).hasAttribute('data-ch-placeholder'), false);
    assert.equal(v.dbg.getNode(2).hasAttribute('data-ch-shadow'), false);
    assert.equal(v.chip('data-ch-shadow-warn').style.display, 'none');
  });

  it('a recording cannot STRIP a viewer-owned stamp', () => {
    // `dom.attr` with value null reaches removeAttribute, which validates
    // nothing in any realm — so a detector hardened only against forgery is
    // still hideable. Hiding the shadow chip is a §13 absence-of-evidence
    // signal going dark, which is why the strip half matters more than the
    // forge half.
    const v = boot(baseRecording({
      segments: [segment({
        initial_dom: iframeKeyframe(),
        events: [
          { type: 'dom.attr', t: 10, node: 3, name: 'data-ch-shadow', value: null },
          { type: 'dom.attr', t: 20, node: 2, name: 'data-ch-placeholder', value: null },
        ],
      })],
    }));
    v.dbg.seek(100);
    assert.equal(v.dbg.getNode(3).getAttribute('data-ch-shadow'), '',
      'the shadow flag survives a removal patch');
    assert.equal(v.dbg.getNode(2).getAttribute('data-ch-placeholder'), 'iframe');
    assert.notEqual(v.chip('data-ch-shadow-warn').style.display, 'none');
    assert.notEqual(v.chip('data-ch-iframe-warn').style.display, 'none');
  });

  // `data-ch-sheet` is the THIRD name the viewer stamps onto live nodes, and
  // the first Task-4 draft missed it: the scoping argument counted the names
  // the viewer stamps as two. The set that needs protecting is the names the
  // viewer stamps AND READS BACK, and the read-backs were document-wide.
  // Recorded content mounts into <body> and sheets live in <head>, so scoping
  // the four sheet queries to the head closes it without deleting an attribute
  // the page really had.
  it('does not delete a keyframe element that carries data-ch-sheet', () => {
    const v = boot(baseRecording({
      stylesheets: [{ id: 1, kind: 'inline', css: '#p{color:red}', media: null }],
      segments: [segment({
        initial_dom: bodyKeyframe([
          {
            id: 2, kind: 'element', tag: 'div', attrs: { id: 'keepme', 'data-ch-sheet': '7' },
            children: [{ id: 3, kind: 'text', text: 'PAGE CONTENT' }],
          },
        ]),
      })],
    }));
    // The sheet-reset loop runs on every restore; a document-wide query took
    // this element with it, with BOTH counters at 0 — a silent divergence,
    // which is the failure the counters exist to prevent.
    assert.equal(v.doc().body.textContent, 'PAGE CONTENT');
    assert.ok(v.doc().contains(v.dbg.getNode(2)), 'the element is still in the document');
    assert.equal(v.dbg.getNode(2).getAttribute('data-ch-sheet'), '7',
      'and keeps the attribute the page really had');
    assert.deepEqual(v.dbg.getCounters(),
      { patchFailures: 0, skipped: 0, unknownTypes: [] });
  });

  it('a stylesheet.update cannot hijack a page-authored data-ch-sheet node', () => {
    const v = boot(baseRecording({
      stylesheets: [],
      stylesheet_events: [{ type: 'stylesheet.update', t: 50, id: 7, css: 'HIJACKED' }],
      segments: [segment({
        t_end: 300,
        initial_dom: bodyKeyframe([
          {
            id: 2, kind: 'element', tag: 'style', attrs: { 'data-ch-sheet': '7' },
            children: [{ id: 3, kind: 'text', text: 'PAGE CSS' }],
          },
        ]),
      })],
    }));
    v.dbg.seek(200);
    assert.equal(v.dbg.getNode(2).textContent, 'PAGE CSS', 'the page\'s own style survived');
    const headSheet = v.doc().head.querySelector('[data-ch-sheet="7"]');
    assert.ok(headSheet && headSheet.textContent === 'HIJACKED',
      'the update created its own sheet in the head instead');
  });

  it('inserts sheets against the head anchor, not a page-authored one', () => {
    // A page-authored <style data-ch-shell-rules> in the BODY became
    // insertSheet's anchor, and `head.insertBefore(node, bodyChild)` raises
    // NotFoundError in a browser — an uncaught throw inside restore().
    const v = boot(baseRecording({
      stylesheets: [{ id: 1, kind: 'inline', css: '#p{color:red}', media: null }],
      segments: [segment({
        initial_dom: bodyKeyframe([
          { id: 2, kind: 'element', tag: 'style', attrs: { 'data-ch-shell-rules': '' }, children: [] },
        ]),
      })],
    }));
    const anchor = v.doc().head.querySelector('style[data-ch-shell-rules]');
    const sheet = v.doc().head.querySelector('[data-ch-sheet="1"]');
    assert.ok(anchor && sheet, 'both the viewer rules and the recorded sheet are in the head');
    assert.ok(sheet.compareDocumentPosition(anchor) & 4,
      'the recorded sheet precedes the viewer rules, so page CSS cannot override them');
  });

  it('leaves page-authored data-ch-* attributes alone', () => {
    // `data-ch-redact` is the RESEARCHER's marker on their own page and is
    // serialised into the keyframe (capture-e2e pins that). The predicate is
    // over the names the VIEWER stamps, not over the whole namespace, so page
    // CSS keyed on it still matches.
    const v = boot(baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([
          { id: 2, kind: 'element', tag: 'div', attrs: { 'data-ch-redact': '' }, children: [] },
        ]),
      })],
    }));
    assert.equal(v.dbg.getNode(2).getAttribute('data-ch-redact'), '');
  });
});

describe('T5.4 — counters, chips and defects', () => {
  it('folds skipped and patchFailures into one chip with two counters', () => {
    const v = boot(baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([
          { id: 2, kind: 'element', tag: 'div', attrs: { '@click': 'x' }, children: [] },
        ]),
        events: [{ type: 'dom.text', t: 10, node: 999, text: 'nowhere' }],
      })],
    }));
    v.dbg.seek(100);
    const c = v.dbg.getCounters();
    assert.equal(c.skipped, 1, 'the file said something no DOM here could hold');
    assert.equal(c.patchFailures, 1, 'a reference the span could not honour');
    const chip = v.chip('data-ch-apply-failures');
    assert.notEqual(chip.style.display, 'none');
    assert.match(chip.textContent, /2 recorded change/);
  });

  it('refuses to play a continuation-before-keyframe segment, visibly', () => {
    const v = boot(baseRecording({
      segments: [
        segment({ index: 0, t_start: 0, t_end: 100, events: [{ type: 'dom.attr', t: 10, node: 1, name: 'x', value: 'y' }] }),
        segment({ index: 1, t_start: 100, t_end: 200, initial_dom: bodyKeyframe([]) }),
      ],
    }));
    assert.equal(v.model.segments[0].defect, 'continuation-before-keyframe');
    const chip = v.chip('data-ch-defect');
    assert.notEqual(chip.style.display, 'none');
    assert.match(chip.textContent, /cannot be reconstructed/i);
    // …and the defect does not poison the rest of the recording.
    v.dbg.selectSegment(1);
    assert.equal(v.chip('data-ch-defect').style.display, 'none');
  });

  it('renders a trace-tier recording without an iframe and still folds the camera', () => {
    const v = boot(baseRecording({
      extensions: { 'cyborg-hunter': { tier: 'trace' } },
      viewport_changes: [{ t: 50, w: 800, h: 600, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 }],
      segments: [segment({
        t_end: 300,
        events: [{ type: 'scroll.window', t: 100, x: 0, y: 40 }],
      })],
    }));
    assert.equal(v.doc(), null, 'no reconstruction at trace tier');
    v.dbg.seek(200);
    assert.equal(v.dbg.getCamera().y, 40);
    assert.equal(v.dbg.getCamera().w, 800);
  });
});

describe('T5.4 — the alignment check is wired to §6, not dead', () => {
  // TASK 6 owns the five predicates, the client-box chain and the three
  // anchor outcomes. What this pins is only that the re-point is LIVE: the
  // walk still offers anchored events to the check, the check still resolves
  // `anchor.node` through the span id map, and an event carrying no §6 blocks
  // still produces no check at all. Without it the whole surface could go
  // quiet between here and Task 6 and nothing would notice.
  it('checks an anchored event and skips an unanchored one', () => {
    const v = boot(fixture('canonical-core'));
    v.dbg.seek(1000);
    const checks = v.dbg.getChecks();
    assert.equal(checks.length, 1, 'one anchored event in segment 0');
    assert.equal(checks[0].type, 'mouse.click');
    // happy-dom has no layout, so every rect is 0×0 and the recorded
    // 310×205 anchor cannot match — the check FIRING is the assertion, and
    // failing loudly on a divergence is what it is for.
    assert.equal(checks[0].status, 'uncertain');
    assert.ok(checks[0].reasons.length > 0);
    // The two key events in the same segment carry neither camera nor anchor
    // (§6 MAY-omit): absence is not failure.
    assert.equal(checks.filter((c) => c.type.indexOf('key.') === 0).length, 0);
  });

  it('buckets an event-level redacted event as redacted, not as uncertain', () => {
    // Design §8: the `redacted` bucket narrows to events carrying
    // `redacted: true` at the EVENT level. canonical-core segment 2 holds a
    // redacted key.down, which under §5.2 carries no other fields at all, so
    // there is nothing to verify and nothing to report as misaligned. It must
    // stay distinguishable from `no-anchor`, which means something else: an
    // event that HAD a target and reported none applicable.
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(2);
    v.dbg.seek(1000);
    const checks = v.dbg.getChecks();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].type, 'key.down');
    assert.equal(checks[0].status, 'redacted');
    // T5.6 gave the chip a fourth bucket to name, so the wording counts the
    // redacted interactions instead of gesturing at them; the property this
    // pins — an event-level redacted event reads as UNVERIFIED, never as
    // verified and never as a warning — is unchanged.
    assert.equal(v.chip('data-ch-align').textContent,
      'alignment unverified (1 redacted)');
  });

  it('clears the alignment chip class when a segment has nothing to warn about', () => {
    // The chip keeps `replay-warn` from the previous segment otherwise, so a
    // clean segment renders an empty chip that is still styled as a warning.
    const v = boot(fixture('canonical-core'));
    v.dbg.seek(1000);                       // segment 0: one uncertain check
    assert.match(v.chip('data-ch-align').className, /replay-warn/);
    v.dbg.selectSegment(1);                 // no anchored events at all
    assert.equal(v.chip('data-ch-align').textContent, '');
    assert.equal(v.chip('data-ch-align').className, 'replay-note');
  });

  it('recomputes memoised checks across the WHOLE span on a restore', () => {
    // `evaluateCheck` memoises on the event object. `loadSegment` clears only
    // the current segment's caches, so an earlier segment of the same span
    // kept checks computed under a different stage transform and a restore
    // replayed them unexamined. The clear belongs to the restore, which is
    // what rebuilds the state the checks are about.
    const v = boot(fixture('canonical-core'));
    v.dbg.selectSegment(1);                 // span 0: replays segment 0's click
    const click = v.model.segments[0].events[1];
    assert.ok(click.__chk, 'the earlier segment\'s check was computed by the span walk');
    click.__chk.reasons.push('STALE-MARKER');
    v.dbg.seek(900);
    v.dbg.seek(100);                        // backward: restore
    assert.ok(click.__chk, 'and recomputed');
    assert.equal(click.__chk.reasons.indexOf('STALE-MARKER'), -1,
      'the memo did not survive the restore');
  });

  it('counts the defect path\'s mount, so getStats stays honest', () => {
    const v = boot(baseRecording({
      segments: [
        segment({ index: 0, t_start: 0, t_end: 100, events: [{ type: 'dom.attr', t: 10, node: 1, name: 'x', value: 'y' }] }),
        segment({ index: 1, t_start: 100, t_end: 200, initial_dom: bodyKeyframe([]) }),
      ],
    }));
    // The defect path clears the body through mountTree, which is a real
    // remount; a counter that skips it under-reports. Asserted as a DELTA,
    // because the absolute number differs by one between realms: happy-dom's
    // synchronous srcdoc parse lets the boot restore run before
    // `selectSegment(0)` does its own, where a browser defers the first one to
    // `onload`. Task 8 should read deltas for the same reason.
    const before = v.dbg.getStats().mounts;
    v.dbg.selectSegment(0);
    assert.equal(v.dbg.getStats().mounts, before + 1);
  });

  it('resolves the anchor through the span id map, not a marker or a path', () => {
    const rec = fixture('canonical-core');
    // Point the anchor at an id the span cannot hold. v1 would have fallen
    // back to a child-index path or getElementById; v2 must fail loudly.
    rec.segments[0].events[1].anchor.node = 4242;
    const v = boot(rec);
    v.dbg.seek(1000);
    assert.match(v.dbg.getChecks()[0].reasons.join(' '), /4242 not held by this span/);
  });
});

describe('T5.4 — the foreign fixture plays', () => {
  it('mounts every jspsych-full segment and applies its patches', () => {
    const v = boot(fixture('jspsych-full'));
    assert.equal(v.model.foreign, true);
    for (const seg of v.model.segments) {
      v.dbg.selectSegment(seg.index);
      v.dbg.seek(seg.durMs);
      assert.ok(v.doc().body.childNodes.length > 0 || seg.initialDom == null,
        'segment ' + seg.index + ' mounted something');
    }
    const c = v.dbg.getCounters();
    // Segment 10 carries jsPsych 8.2.3's free-sort node with an attribute
    // literally named `<` — the one skip the corpus holds (Task 2's pin).
    assert.equal(c.patchFailures, 0, 'no reference the span could not honour');
    assert.equal(c.skipped, 0, 'segment 13 holds no malformed name');
  });

  it('counts the corpus\'s one malformed attribute name on segment 10', () => {
    const v = boot(fixture('jspsych-full'));
    v.dbg.selectSegment(10);
    assert.equal(v.dbg.getCounters().skipped, 1);
  });
});

// ── T5.5: the adopted vocabulary ───────────────────────────────────────────

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const canvasKeyframe = (id, w, h, attrs) => bodyKeyframe([{
  id, kind: 'element', tag: 'canvas', attrs: attrs || {}, children: [], canvas_size: { w, h },
}]);

// The helper's own contract, pinned: a patch must survive an `await` inside the
// body. Without this, `withProto` is a trap handed to three later tasks. It
// lives in the shared harness now (T5.6) and this is still its only pin.
describe('T5.5 — the prototype-patch helper', () => {
  it('keeps the patch installed across an await inside the body', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window({ url: 'https://report.test/' });
    const seen = [];
    await withProto(win, 'HTMLImageElement', 'decode', { value: () => 'STUB' }, async () => {
      seen.push(win.document.createElement('img').decode());
      await new Promise((r) => setTimeout(r, 0));
      seen.push(win.document.createElement('img').decode());
    });
    assert.equal(seen[0], 'STUB');
    assert.equal(seen[1], 'STUB', 'the stub survived the await, not just the call before it');
    assert.notEqual(win.document.createElement('img').decode(), 'STUB', 'and is gone afterwards');
  });
});

// jspsych-full's canvas segments both TEAR DOWN inside their own span: segment
// 8 removes the canvas's parent at 263.4 and segment 9 removes the canvas
// itself at 1505.1. These are the last playhead positions at which each canvas
// is still mounted, and they are read off the fixture rather than guessed.
const SEG8_LIVE = 100;      // after the baseline at 3.9, before the removes
const SEG9_LIVE = 1000;     // after the 9th snapshot at 936, before the removes

describe('T5.5 — canvas.snapshot composites in the parent, presented through a head rule', () => {
  it('presents the segment-8 full baseline through a viewer-owned shell-head rule', async () => {
    const v = boot(fixture('jspsych-full'));
    v.dbg.selectSegment(8);
    v.dbg.seek(SEG8_LIVE);
    await v.dbg.canvasSettled();

    const canvas = v.dbg.getNode(3);
    assert.equal(canvas.tagName.toLowerCase(), 'canvas');
    assert.equal(canvas.getAttribute('data-ch-canvas'), '3',
      'the composited canvas carries the viewer\'s own stamp');

    const rule = v.doc().head.querySelector('style[data-ch-canvas-rule="3"]');
    assert.ok(rule, 'the presentation rule lives in the shell HEAD, not in the inline style');
    assert.match(rule.textContent, /\[data-ch-canvas="3"\]/);
    assert.match(rule.textContent, /background-image:url\("data:image\/png;base64,[^"]*"\) !important/);
    assert.match(rule.textContent, /background-size:100% 100% !important/);

    // The full baseline clears the offscreen bitmap before drawing at (0,0):
    // a region patch preserves surrounding pixels, a baseline must not.
    const calls = offscreenCalls(v);
    assert.deepEqual(calls.map((c) => (c.clear ? 'clear' : c.x + ',' + c.y)), ['clear', '0,0']);
  });

  it('composites segment 9\'s region patches at their recorded offsets, in event order', async () => {
    const rec = fixture('jspsych-full');
    const snaps = rec.segments[9].events
      .filter((e) => e.type === 'canvas.snapshot' && e.t - rec.segments[9].t_start <= SEG9_LIVE);
    const v = boot(rec);
    v.dbg.selectSegment(9);
    v.dbg.seek(SEG9_LIVE);
    await v.dbg.canvasSettled();

    const calls = offscreenCalls(v);
    // 1 baseline (clear + draw at 0,0) then the regions at their own offsets.
    assert.deepEqual(calls[0], { clear: true });
    const drawn = calls.filter((c) => !c.clear);
    assert.equal(drawn.length, 9, 'nine snapshots up to this playhead, nine composites');
    assert.deepEqual(drawn.map((c) => c.x + ',' + c.y),
      snaps.map((e) => (e.region ? e.region.x + ',' + e.region.y : '0,0')));
    // Event order, verified through the payloads rather than only the offsets:
    // several regions share an origin, so offsets alone would not distinguish
    // a reordering.
    assert.deepEqual(drawn.map((c) => c.draw), snaps.map((e) => e.data_url));
    assert.equal(calls.filter((c) => c.clear).length, 1,
      'only the baseline clears; a region patch preserves the surrounding pixels');
  });

  it('an out-of-order decode cannot reorder composites', async () => {
    const rec = fixture('jspsych-full');
    const snaps = rec.segments[9].events
      .filter((e) => e.type === 'canvas.snapshot' && e.t - rec.segments[9].t_start <= SEG9_LIVE);
    const v = boot(rec);
    // Fault injection: hold every decode open, then resolve them BACKWARDS,
    // WITH A REAL GAP BETWEEN EACH. The fork's bare `img.onload` handlers have
    // no ordering guarantee and would composite in decode order (design §3.1).
    //
    // The gap is the injection. A first version resolved all nine synchronously
    // and passed against a mutant with the chain deleted, because no microtask
    // had run yet when the last `resolve()` was called: every decode was
    // already settled by the time the first continuation fired, so the draws
    // came out in event order for a reason that had nothing to do with the
    // chain. Yielding between resolutions is what makes decode order real.
    const pending = [];
    await withProto(v.win, 'HTMLImageElement', 'decode',
      { value: function () { return new Promise((resolve) => { pending.push(resolve); }); } },
      async () => {
        v.dbg.selectSegment(9);
        v.dbg.seek(SEG9_LIVE);
        assert.ok(pending.length >= 2,
          'decoding STARTS for every snapshot in the batch — the draws are what is serialised');
        const settled = v.dbg.canvasSettled();
        for (let i = pending.length - 1; i >= 0; i--) {
          pending[i]();
          await new Promise((r) => setTimeout(r, 0));
        }
        await settled;
      });

    const drawn = offscreenCalls(v).filter((c) => !c.clear);
    assert.deepEqual(drawn.map((c) => c.draw), snaps.map((e) => e.data_url),
      'composites landed in EVENT order even though the decodes resolved backwards');
  });

  it('presents once per applied batch and skips the re-encode for an untouched canvas', async () => {
    const v = boot(fixture('jspsych-full'));
    v.dbg.selectSegment(9);
    v.win.__encodes = 0;
    v.dbg.seek(SEG9_LIVE);
    await v.dbg.canvasSettled();
    assert.equal(v.win.__encodes, 1,
      'nine composites, ONE presentation — the re-encode is the cost (Task 0)');

    // A further forward seek touches no canvas, so nothing is re-encoded: the
    // cheap follow-on Task 0's measurement points at.
    v.dbg.seek(SEG9_LIVE + 100);
    await v.dbg.canvasSettled();
    assert.equal(v.win.__encodes, 1, 'no snapshot in this batch ⇒ no re-encode');
  });

  it('counts the corpus\'s own snapshot-after-remove instead of resurrecting the node', async () => {
    // A real property of the committed fixture, not a constructed case: at
    // t=1505.1 segment 9 removes node 8 and THEN carries one more
    // `canvas.snapshot` for it (array order decides at equal `t`, §7). The
    // honest answer is a counted failure and no rule — the alternative would be
    // a composite presented on a node the reconstruction no longer has.
    const v = boot(fixture('jspsych-full'));
    v.dbg.selectSegment(9);
    v.dbg.seek(v.model.segments[9].durMs);
    await v.dbg.canvasSettled();
    assert.equal(v.dbg.getNode(8), undefined, 'the canvas really was removed');
    assert.ok(v.dbg.getCounters().patchFailures >= 1,
      'the trailing snapshot is a reference the span could not honour');
    assert.equal(v.doc().head.querySelectorAll('[data-ch-canvas-rule]').length, 0,
      'no rule survives a canvas that left the reconstruction');
  });

  it('presentation survives a dom.attr on style, and its removal', async () => {
    const clobber = baseRecording({
      segments: [segment({
        initial_dom: canvasKeyframe(2, 40, 20, { style: 'display: block;' }),
        events: [
          { type: 'canvas.snapshot', t: 10, node: 2, data_url: PNG_1PX },
          { type: 'dom.attr', t: 20, node: 2, name: 'style', value: 'display: block; outline: 1px solid red;' },
          { type: 'dom.attr', t: 30, node: 2, name: 'style', value: null },
        ],
      })],
    });
    const v = boot(clobber);
    v.dbg.seek(15);
    await v.dbg.canvasSettled();
    const presented = v.doc().head.querySelector('style[data-ch-canvas-rule="2"]').textContent;
    assert.match(presented, /background-image:url/);

    // Per CSSOM a `style` write replaces the whole inline declaration block, so
    // a viewer presenting INTO that block loses the composite. The invariant is
    // asserted, not the route (design §3.1's Task-0 amendment).
    v.dbg.seek(25);
    await v.dbg.canvasSettled();
    assert.equal(v.dbg.getNode(2).getAttribute('data-ch-canvas'), '2', 'the stamp survived the style write');
    assert.equal(v.doc().head.querySelector('style[data-ch-canvas-rule="2"]').textContent, presented,
      'the presentation is untouched by a dom.attr on style');

    v.dbg.seek(35);
    await v.dbg.canvasSettled();
    assert.equal(v.dbg.getNode(2).getAttribute('data-ch-canvas'), '2', 'the stamp survived the style REMOVAL');
    assert.equal(v.doc().head.querySelector('style[data-ch-canvas-rule="2"]').textContent, presented,
      'value: null clobbers by the same route and must not reach the presentation either');
  });

  it('pins a collapsed canvas from canvas_size and leaves a laid-out one alone', async () => {
    const rec = baseRecording({
      segments: [segment({
        initial_dom: canvasKeyframe(2, 40, 20, {}),
        events: [{ type: 'canvas.snapshot', t: 10, node: 2, data_url: PNG_1PX }],
      })],
    });
    // happy-dom has no layout: every rect is 0x0, which is exactly the
    // sandbox-specific collapse design §3.3 repairs.
    const v = boot(rec);
    v.dbg.seek(15);
    await v.dbg.canvasSettled();
    const rule = v.doc().head.querySelector('style[data-ch-canvas-rule="2"]').textContent;
    assert.match(rule, /width:40px;height:20px/, 'the used-size-0 repair pinned the bitmap size');
    assert.match(rule, /display:inline-block/);
    assert.ok(!/width:40px !important/.test(rule),
      'the size carries NO !important — page CSS stays authoritative (§3.3)');

    // A canvas the page really did lay out keeps its own box. The repair reads
    // the CONTENT box (`clientWidth`/`clientHeight`), because a bordered canvas
    // whose content collapsed still reports a non-zero border box — the
    // corpus's own sketchpad, measured at 4×28 with a 0×0 content box. The
    // patch has to be in place before the BOOT, because §3.3 measures once per
    // mount: a repair re-derived on every batch would re-measure a box it had
    // itself pinned.
    const rule2 = await withProto(v.win, 'HTMLElement', 'clientWidth', { get: () => 123, configurable: true },
      () => withProto(v.win, 'HTMLElement', 'clientHeight', { get: () => 45, configurable: true },
        async () => {
          const v2 = boot(rec);
          v2.dbg.seek(15);
          await v2.dbg.canvasSettled();
          return v2.doc().head.querySelector('style[data-ch-canvas-rule="2"]').textContent;
        }));
    assert.ok(!/width:40px/.test(rule2), 'a laid-out canvas is not re-sized by the viewer');
    assert.match(rule2, /background-image:url/, 'it is still presented');
  });

  it('rebuilds canvas rules on a restore rather than accumulating them', async () => {
    const v = boot(fixture('jspsych-full'));
    v.dbg.selectSegment(9);
    v.dbg.seek(SEG9_LIVE);
    await v.dbg.canvasSettled();
    assert.equal(v.doc().head.querySelectorAll('[data-ch-canvas-rule]').length, 1);
    v.dbg.seek(0);                       // backward ⇒ restore
    v.dbg.seek(SEG9_LIVE);
    await v.dbg.canvasSettled();
    assert.equal(v.doc().head.querySelectorAll('[data-ch-canvas-rule]').length, 1,
      'one rule per canvas, not one per restore');
  });

  it('re-derives the composite on a restore instead of carrying it across spans', async () => {
    // Node ids are per-recording and every keyframe re-uses the low ones —
    // `jspsych-full` has a canvas at id 8 in segment 9 and a TEXT node at id 8
    // in segment 8. So a composite kept across a restore is not a stale
    // picture of the same canvas; it is another segment's pixels on this one.
    //
    // The stub's data URL counts the draws behind it, which is what makes the
    // claim observable in a realm with no painting: a segment whose only
    // snapshot is a REGION patch must present ONE composite, not that one on
    // top of the previous segment's baseline.
    const rec = baseRecording({
      segments: [
        segment({
          index: 0, t_start: 0, t_end: 1000,
          initial_dom: canvasKeyframe(2, 40, 20, {}),
          events: [{ type: 'canvas.snapshot', t: 10, node: 2, data_url: PNG_1PX }],
        }),
        segment({
          index: 1, t_start: 1000, t_end: 2000,
          initial_dom: canvasKeyframe(2, 40, 20, {}),
          events: [{ type: 'canvas.snapshot', t: 10, node: 2, data_url: PNG_1PX, region: { x: 1, y: 1, w: 1, h: 1 } }],
        }),
      ],
    });
    const v = boot(rec);
    v.dbg.selectSegment(0);
    v.dbg.seek(20);
    await v.dbg.canvasSettled();
    const first = v.doc().head.querySelector('style[data-ch-canvas-rule="2"]').textContent;
    assert.match(first, /base64,QQQQ1"\)/, 'one composite behind segment 0\'s presentation');

    v.dbg.selectSegment(1);
    v.dbg.seek(20);
    await v.dbg.canvasSettled();
    const second = v.doc().head.querySelector('style[data-ch-canvas-rule="2"]').textContent;
    assert.match(second, /base64,QQQQ1"\)/,
      'segment 1 presents its OWN single region patch, not that patch over segment 0\'s baseline');
  });

  it('composites a canvas added mid-span and drops its rule when it is removed', async () => {
    const rec = baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([]),
        events: [
          { type: 'dom.add', t: 10, parent: 1, before: null,
            node: { id: 7, kind: 'element', tag: 'canvas', attrs: {}, children: [], canvas_size: { w: 8, h: 4 } } },
          { type: 'canvas.snapshot', t: 20, node: 7, data_url: PNG_1PX },
          { type: 'dom.remove', t: 30, node: 7 },
        ],
      })],
    });
    const v = boot(rec);
    v.dbg.seek(25);
    await v.dbg.canvasSettled();
    assert.ok(v.doc().head.querySelector('style[data-ch-canvas-rule="7"]'),
      'a canvas that arrived by dom.add composites and presents identically');
    v.dbg.seek(35);
    await v.dbg.canvasSettled();
    assert.equal(v.doc().head.querySelector('style[data-ch-canvas-rule="7"]'), null,
      'the rule leaves with the node — a composite for a node nothing resolves is a ghost');
  });

  it('will not let a recording strip or forge the presentation key', async () => {
    const rec = baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([
          // FORGE: a keyframe claiming the stamp on an ordinary element would
          // paint it with whatever composite that id later holds.
          { id: 5, kind: 'element', tag: 'div', attrs: { 'data-ch-canvas': '2' }, children: [] },
          { id: 2, kind: 'element', tag: 'canvas', attrs: {}, children: [], canvas_size: { w: 8, h: 4 } },
        ]),
        events: [
          { type: 'canvas.snapshot', t: 10, node: 2, data_url: PNG_1PX },
          // STRIP: `value: null` reaches removeAttribute, which validates
          // nothing in any realm — the half a forge-only guard misses.
          { type: 'dom.attr', t: 20, node: 2, name: 'data-ch-canvas', value: null },
          { type: 'dom.attr', t: 30, node: 5, name: 'data-ch-canvas', value: '2' },
        ],
      })],
    });
    const v = boot(rec);
    v.dbg.seek(40);
    await v.dbg.canvasSettled();
    assert.equal(v.dbg.getNode(2).getAttribute('data-ch-canvas'), '2',
      'the recording cannot strip the selector its own composite is presented through');
    assert.equal(v.dbg.getNode(5).getAttribute('data-ch-canvas'), null,
      'and cannot point that selector at an element of its choosing, from either verb');
  });

  it('a throwing presentation does not poison the canvas chain', async () => {
    // A rejected chain is permanent: every later composite for that canvas is
    // skipped and `canvasSettled()` — the one call Task 7's executor awaits —
    // rejects. So both links have to end resolved whatever they throw.
    const rec = baseRecording({
      segments: [segment({
        initial_dom: canvasKeyframe(2, 8, 4, {}),
        events: [
          { type: 'canvas.snapshot', t: 10, node: 2, data_url: PNG_1PX },
          { type: 'canvas.snapshot', t: 30, node: 2, data_url: PNG_1PX, region: { x: 1, y: 1, w: 1, h: 1 } },
        ],
      })],
    });
    const v = boot(rec);
    let thrown = 0;
    await withProto(v.win, 'HTMLCanvasElement', 'toDataURL',
      { value: function () { thrown++; throw new Error('encoder gone'); } },
      async () => {
        v.dbg.seek(20);
        await v.dbg.canvasSettled();      // must RESOLVE, not reject
      });
    assert.ok(thrown > 0, 'the presentation really did throw');
    assert.ok(v.dbg.getCounters().patchFailures >= 1, 'and the analyst is told');

    // The canvas keeps working afterwards.
    v.dbg.seek(40);
    await v.dbg.canvasSettled();
    const rule = v.doc().head.querySelector('style[data-ch-canvas-rule="2"]');
    assert.match(rule.textContent, /background-image:url/,
      'the composite after the failure still lands');
  });

  it('counts a canvas.snapshot the span cannot honour instead of throwing', async () => {
    const rec = baseRecording({
      segments: [segment({
        initial_dom: canvasKeyframe(2, 8, 4, {}),
        events: [
          { type: 'canvas.snapshot', t: 10, node: 4242, data_url: PNG_1PX },
          { type: 'canvas.snapshot', t: 20, node: 1, data_url: PNG_1PX },
        ],
      })],
    });
    const v = boot(rec);
    v.dbg.seek(30);
    await v.dbg.canvasSettled();
    assert.equal(v.dbg.getCounters().patchFailures, 2,
      'an unheld id and a non-canvas target are both references the span could not honour');
    assert.equal(v.doc().head.querySelector('[data-ch-canvas-rule="4242"]'), null);
    assert.equal(v.doc().head.querySelector('[data-ch-canvas-rule="1"]'), null);
    // Node 2 IS a canvas and never received a usable snapshot, so its rule
    // carries the §3.3 size repair and no background at all.
    const only = v.doc().head.querySelector('[data-ch-canvas-rule="2"]').textContent;
    assert.match(only, /width:8px;height:4px/);
    assert.ok(!/background-image/.test(only));
  });
});

describe('T5.5 — media is state, never playback', () => {
  const mediaRecording = (events, initialState) => baseRecording({
    segments: [segment({
      initial_dom: bodyKeyframe([
        { id: 2, kind: 'element', tag: 'video', attrs: { id: 'clip' }, children: [] },
      ]),
      initial_state: initialState || null,
      events,
    })],
  });

  it('renders a state badge and a lane marker without ever playing the element', () => {
    const v = boot(mediaRecording([
      { type: 'media.play', t: 100, node: 2, current_time: 0 },
      { type: 'media.time', t: 300, node: 2, current_time: 2.5 },
      { type: 'media.pause', t: 500, node: 2, current_time: 4 },
    ]));
    const el = v.dbg.getNode(2);
    let played = 0;
    el.play = () => { played++; };

    v.dbg.seek(400);
    const badges = v.mount.querySelectorAll('.replay-media-badge');
    assert.equal(badges.length, 1, 'one badge per media element with recorded state');
    assert.match(badges[0].textContent, /playing/);
    assert.match(badges[0].textContent, /2\.5/, 'the badge reports the recorded position');

    v.dbg.seek(600);
    assert.match(v.mount.querySelector('.replay-media-badge').textContent, /paused/);
    assert.equal(played, 0, 'design §7: badges and lane markers, no playback');
    assert.equal(el.currentTime || 0, 0, 'the element is never seeked either');
    assert.ok(v.chip('data-ch-media-note').textContent.length > 0,
      'the declared limitation is stated in the viewer\'s own advisory chip');
  });

  it('seeds initial_state.media through the same handler as the stream', () => {
    const v = boot(mediaRecording([], {
      scroll: null, element_scroll: [], form: [],
      media: [{ node: 2, current_time: 7.25 }],
    }));
    assert.match(v.mount.querySelector('.replay-media-badge').textContent, /7\.25/,
      'design §6 maps initial_state.media to media.time, and §7 renders it as state');
  });

  it('shows no media chip for a recording with no media at all', () => {
    const v = boot(fixture('canonical-core'));
    assert.equal(v.chip('data-ch-media-note').style.display, 'none');
    assert.equal(v.mount.querySelectorAll('.replay-media-badge').length, 0);
  });
});

describe('T5.5 — clipboard renders in both producer modes and redacted', () => {
  const clip = (over) => baseRecording({
    segments: [segment({
      initial_dom: bodyKeyframe([]),
      events: [Object.assign({ type: 'clipboard.paste', t: 100, target: null }, over)],
    })],
  });

  it('renders content mode, length-only mode and the redacted variant differently', () => {
    const content = boot(clip({ text: 'hello world', html: null, len: null }));
    content.dbg.seek(200);
    assert.match(content.mount.querySelector('.replay-ticker').textContent, /clipboard\.paste/);
    assert.match(content.mount.querySelector('.replay-ticker').textContent, /hello world/,
      'content mode (jsPsych) shows what was pasted');

    const lenOnly = boot(clip({ text: null, html: null, len: 42 }));
    lenOnly.dbg.seek(200);
    const lenText = lenOnly.mount.querySelector('.replay-ticker').textContent;
    assert.match(lenText, /42 ch/, 'length-only mode (CH) shows the length it does carry');

    const redacted = boot(clip({ redacted: true, text: null, html: null, len: null }));
    redacted.dbg.seek(200);
    const redText = redacted.mount.querySelector('.replay-ticker').textContent;
    assert.match(redText, /redacted/);
    assert.ok(!/ch\)/.test(redText), 'a redacted clipboard event shows neither content nor a length');
  });

  it('marks every clipboard event in the lane', () => {
    const v = boot(clip({ text: 'x', html: null, len: null }));
    v.dbg.seek(200);
    const lane = v.mount.querySelector('.replay-lane');
    const painted = lane.__ctx.calls.filter((c) => c.name === 'fillRect');
    assert.ok(painted.length >= 2, 'the lane background plus at least one marker');
  });
});

describe('T5.5 — fullscreen, focus and visibility are lane events', () => {
  it('marks fullscreen.enter/exit in the lane and names them in the ticker', () => {
    const v = boot(fixture('jspsych-full'));
    v.dbg.selectSegment(1);            // carries fullscreen.enter
    v.dbg.seek(v.model.segments[1].durMs);
    assert.match(v.mount.querySelector('.replay-ticker').textContent, /fullscreen\.enter/);

    v.dbg.selectSegment(13);           // carries fullscreen.exit
    v.dbg.seek(v.model.segments[13].durMs);
    assert.match(v.mount.querySelector('.replay-ticker').textContent, /fullscreen\.exit/);
    assert.equal(v.dbg.getCounters().unknownTypes.length, 0,
      'the §5 vocabulary is recognised, so nothing here counts as unknown');
  });
});

describe('T5.5 — §5.8 unknown event types', () => {
  it('skips an unrecognised type, counts it once, warns once, and keeps walking', () => {
    const rec = baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([
          { id: 2, kind: 'element', tag: 'p', attrs: {}, children: [{ id: 3, kind: 'text', text: 'a' }] },
        ]),
        events: [
          { type: 'vendor.telemetry', t: 100, payload: 1 },
          { type: 'vendor.telemetry', t: 150, payload: 2 },
          { type: 'gesture.pinch', t: 200 },
          { type: 'dom.text', t: 300, node: 3, text: 'b' },
        ],
      })],
    });
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warned.push(args.join(' ')); };
    let v;
    try {
      v = boot(rec);
      v.dbg.seek(400);
    } finally { console.warn = realWarn; }

    assert.equal(v.dbg.getNode(3).nodeValue, 'b', 'the walk continued past the unknown types');
    assert.deepEqual(v.dbg.getCounters().unknownTypes.slice().sort(),
      ['gesture.pinch', 'vendor.telemetry'], 'counted once per TYPE, not per occurrence');
    assert.equal(warned.length, 2, 'one warning per type, not per event');
    assert.match(v.chip('data-ch-unknown-types').textContent, /gesture\.pinch/);
    assert.equal(v.dbg.getCounters().patchFailures, 0,
      'an unknown type is a vocabulary gap, not a reference the span could not honour');
  });

  it('reports the file\'s unknown types BEFORE the analyst scrubs into the segment carrying them', () => {
    // The chip's wording is a claim about the RECORDING, so it cannot be
    // computed from wherever the playhead happens to have been. Computed
    // during the walk it stayed empty until someone visited segment 1 — the
    // "never fail silently" rule failing silently. `findCaptureStop` already
    // makes the identical argument for the §5.7 banner one screen earlier.
    const rec = baseRecording({
      segments: [
        segment({ index: 0, t_start: 0, t_end: 1000, initial_dom: bodyKeyframe([]), events: [] }),
        segment({
          index: 1, t_start: 1000, t_end: 2000, initial_dom: bodyKeyframe([]),
          events: [
            { type: 'vendor.telemetry', t: 10 },
            { type: 'vendor.telemetry', t: 20 },
          ],
        }),
      ],
    });
    const realWarn = console.warn;
    const warned = [];
    console.warn = (...args) => { warned.push(args.join(' ')); };
    let v;
    try { v = boot(rec); } finally { console.warn = realWarn; }

    const chip = v.chip('data-ch-unknown-types');
    assert.equal(chip.style.display, '', 'shown at boot, on segment 0, with nothing scrubbed');
    assert.match(chip.textContent, /vendor\.telemetry/);
    assert.match(chip.textContent, /2 event\(s\)/, 'the scan counts occurrences file-wide');
    assert.deepEqual(v.dbg.getCounters().unknownTypes, ['vendor.telemetry']);
    assert.equal(warned.length, 1, 'one console warning per type, at the scan');

    // Restore-stable by construction: the count comes from the file, not from
    // how many times the walk replayed it.
    v.dbg.selectSegment(1);
    v.dbg.seek(100);
    v.dbg.seek(0);
    v.dbg.seek(100);
    assert.match(v.chip('data-ch-unknown-types').textContent, /2 event\(s\)/);
    assert.deepEqual(v.dbg.getCounters().unknownTypes, ['vendor.telemetry']);
  });

  it('does not re-warn for the same type after a restore', () => {
    const rec = baseRecording({
      segments: [segment({
        initial_dom: bodyKeyframe([]),
        events: [{ type: 'vendor.telemetry', t: 100 }],
      })],
    });
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warned.push(args.join(' ')); };
    let v;
    try {
      v = boot(rec);
      v.dbg.seek(200);
      v.dbg.seek(0);       // restore replays the same event
      v.dbg.seek(200);
    } finally { console.warn = realWarn; }
    assert.equal(warned.length, 1);
    assert.deepEqual(v.dbg.getCounters().unknownTypes, ['vendor.telemetry']);
  });
});

describe('T5.5 — §5.7 truncation and the capture-failure surface', () => {
  const stopped = (stopEvent, over) => baseRecording(Object.assign({
    truncated: true,
    segments: [segment({
      initial_dom: bodyKeyframe([]),
      events: stopEvent ? [stopEvent] : [],
    })],
  }, over));

  it('names the reason and quotes the recording\'s OWN configured limit', () => {
    const v = boot(stopped({
      type: 'recording.capture_stopped', t: 900, reason: 'buffer_limit',
      extensions: { 'cyborg-hunter': { limit_events: 1234 } },
    }));
    const note = v.chip('data-ch-cap-note');
    assert.notEqual(note, null, 'truncated: true shows the banner');
    assert.match(note.querySelector('summary').textContent, /buffer limit/);
    assert.match(note.textContent, /1,234 events/,
      'the configured cap rides in the event\'s vendor namespace and is REAL, not a default');
    assert.ok(!/library defaults/.test(note.textContent),
      'no default-quoting when the recording states its own limit');
  });

  it('quotes the character cap when that is the limit the recording crossed', () => {
    const v = boot(stopped({
      type: 'recording.capture_stopped', t: 900, reason: 'buffer_limit',
      extensions: { 'cyborg-hunter': { limit_chars: 8000000 } },
    }));
    assert.match(v.chip('data-ch-cap-note').textContent, /8,000,000 characters/);
  });

  it('offers NO buffer-cap explanation for a stop the recording attributes to an error', () => {
    // The banner used to name "capture error" in the summary and then explain
    // it as a buffer cap in the body, quoting two numbers with nothing to do
    // with what happened. §5.7 asks players to surface truncation; surfacing it
    // with a cause the recording denies is worse than saying less.
    const v = boot(stopped({ type: 'recording.capture_stopped', t: 900, reason: 'error' }));
    const note = v.chip('data-ch-cap-note');
    assert.match(note.querySelector('summary').textContent, /capture error/);
    assert.match(note.textContent, /capture error/, 'the body names what the recording says');
    assert.ok(!/usual cause is a buffer cap/.test(note.textContent),
      'and never ASSERTS the cause the recording denies (naming it to rule it out is fine)');
    assert.ok(!/library defaults/.test(note.textContent));
    assert.ok(!/50,000/.test(note.textContent) && !/8,000,000/.test(note.textContent),
      'no cap numbers at all for a stop that was not a cap');
  });

  it('falls back to the library defaults, and says so, for a CH file that hit a cap it did not state', () => {
    const v = boot(stopped({ type: 'recording.capture_stopped', t: 900, reason: 'buffer_limit' }));
    const note = v.chip('data-ch-cap-note');
    assert.match(note.querySelector('summary').textContent, /buffer limit/);
    assert.match(note.textContent, /library defaults/);
    assert.match(note.textContent, /50,000 events/);
  });

  it('never quotes CH\'s defaults for a producer that is not CH', () => {
    // `model.foreign` keys on producer identity and exists for exactly this
    // (viewer-model.js's own comment). Quoting CH's REPLAY_DEFAULTS in the
    // sentence that explains a jsPsych recording's stop describes a recorder
    // that did not make the file — in a viewer whose premise (§7) is that it
    // plays foreign conforming files.
    const foreign = stopped(
      { type: 'recording.capture_stopped', t: 900, reason: 'buffer_limit' },
      { recorder: { name: 'jspsych', version: '8.2.3' } });
    const note = boot(foreign).chip('data-ch-cap-note');
    assert.match(note.textContent, /does not state/);
    assert.ok(!/library defaults/.test(note.textContent));
    assert.ok(!/50,000/.test(note.textContent) && !/8,000,000/.test(note.textContent),
      'CH\'s numbers never describe another producer\'s recorder');

    // The READ is not gated on `foreign`: a foreign file that DOES carry the
    // namespace still gets its own number quoted (§9 is where vendor data
    // lives, and declining to read one the viewer understands helps nobody).
    const foreignWithLimit = stopped(
      { type: 'recording.capture_stopped', t: 900, reason: 'buffer_limit',
        extensions: { 'cyborg-hunter': { limit_events: 777 } } },
      { recorder: { name: 'jspsych', version: '8.2.3' } });
    assert.match(boot(foreignWithLimit).chip('data-ch-cap-note').textContent, /777 events/);
  });

  it('shows the banner for a truncated recording that carries no stop event at all', () => {
    const v = boot(stopped(null));
    assert.notEqual(v.chip('data-ch-cap-note'), null);
    assert.match(v.chip('data-ch-cap-note').textContent, /Absence of evidence/);
  });

  it('shows no banner for a complete recording', () => {
    const v = boot(fixture('canonical-core'));
    assert.equal(v.chip('data-ch-cap-note'), null);
  });

  it('names the channels a capture failure took dark (§13)', () => {
    const rec = stopped(null, {
      truncated: false,
      extensions: {
        'cyborg-hunter': {
          tier: 'dom',
          capture_failures: [
            { channel: 'mutations', message: 'boom', t: 10 },
            { channel: 'paste', message: 'boom', t: 20 },
          ],
        },
      },
    });
    const v = boot(rec);
    const chip = v.chip('data-ch-capture-failures');
    assert.equal(chip.style.display, '', 'the chip is shown');
    assert.match(chip.textContent, /mutations/);
    assert.match(chip.textContent, /paste/);
    assert.equal(boot(fixture('canonical-core')).chip('data-ch-capture-failures').style.display, 'none');
  });
});

// ── the participant's own view state (T5.8) ────────────────────────────────
// `dpr`, `vv_scale` and `vv_offset_*` are three §6 camera fields that had NO
// reader anywhere: `foldEventCamera` read six of ten and stopped, and the DPR
// advisory read the SEGMENT SEED, so an interaction recorded mid-pinch or
// mid-zoom replayed at 1× with nothing said. They are deliberately NOT
// alignment inputs — pinch zoom moves neither client coordinates nor
// `getBoundingClientRect` — so what they buy is an advisory, and it has to be
// playhead-scoped because a zoom is a moment inside a segment, not a property
// of one. Geometry across a real pinch is the Playwright battery's
// (`cursor-alignment.battery.mjs`, B-pinch); this file pins the state machine.
describe('T5.8 — per-event dpr / vv_scale / vv_offset_* drive a playhead-scoped advisory', () => {
  const camera = (over) => Object.assign({
    scroll_x: 0, scroll_y: 0, viewport_w: 1000, viewport_h: 800,
    client_w: 1000, client_h: 800, dpr: 1, vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0,
  }, over);

  const pinchRecording = () => baseRecording({
    segments: [segment({
      t_end: 1000,
      initial_dom: bodyKeyframe([
        { id: 2, kind: 'element', tag: 'button', attrs: { id: 'b' }, children: [] },
      ]),
      events: [
        { type: 'mouse.click', t: 100, x: 5, y: 5, button: 0, target: 2, camera: camera() },
        { type: 'mouse.click', t: 300, x: 5, y: 5, button: 0, target: 2,
          camera: camera({ dpr: 3, vv_scale: 2.5, vv_offset_x: 120, vv_offset_y: 64 }) },
        { type: 'mouse.click', t: 500, x: 5, y: 5, button: 0, target: 2, camera: camera() },
      ],
    })],
  });

  it('names the pinch state at the interaction and clears it afterwards', () => {
    const v = boot(pinchRecording());
    const zoom = () => v.chip('data-ch-zoom-note');
    v.dbg.seek(150);
    assert.equal(zoom().style.display, 'none', 'silent before the pinch');
    v.dbg.seek(350);
    assert.equal(zoom().style.display, '', 'shown at the pinched interaction');
    assert.match(zoom().textContent, /2\.5×/);
    assert.match(zoom().textContent, /120,64/);
    v.dbg.seek(550);
    assert.equal(zoom().style.display, 'none', 'quiet again once the pinch ends');
  });

  it('reads the DPR advisory off the PLAYHEAD, not the segment seed', () => {
    const v = boot(pinchRecording());
    const dpr = () => v.chip('data-ch-dpr-note');
    // The seed says DPR 1 and so does the viewer's own window, so a
    // seed-scoped advisory is silent for the whole segment — which is the
    // defect: the middle interaction was recorded at DPR 3.
    v.dbg.seek(150);
    assert.equal(dpr().style.display, 'none');
    v.dbg.seek(350);
    assert.equal(dpr().style.display, '', 'the mid-segment DPR change is reported where it happens');
    assert.match(dpr().textContent, /Recorded at DPR 3/);
    v.dbg.seek(550);
    assert.equal(dpr().style.display, 'none');
  });

  it('rebuilds the view state on a restore rather than carrying it', () => {
    // A backward seek is a restore, and a restore to a position BEFORE any
    // camera block has no view state at all. Carrying the last one would tell
    // the analyst the recording was pinched at a moment it was not.
    const v = boot(pinchRecording());
    v.dbg.seek(350);
    assert.equal(v.chip('data-ch-zoom-note').style.display, '');
    v.dbg.seek(0);
    assert.equal(v.chip('data-ch-zoom-note').style.display, 'none');
    assert.equal(v.chip('data-ch-dpr-note').style.display, 'none');
  });

  it('falls back to the segment seed before the first camera block', () => {
    // A recording whose SESSION viewport states DPR 2 and whose events say
    // nothing: the advisory still fires, from the seed, exactly as it did
    // before this change.
    const rec = pinchRecording();
    rec.viewport.dpr = 2;
    rec.segments[0].events = [];
    const v = boot(rec);
    assert.equal(v.chip('data-ch-dpr-note').style.display, '');
    assert.match(v.chip('data-ch-dpr-note').textContent, /Recorded at DPR 2/);
  });
});

// ── the §13 placeholder latch cannot depend on sample timing (T5.8) ────────
describe('T5.8 — a placeholder removed at tRel 0 still latches its chip', () => {
  it('latches from the span keyframe, before the walk applies anything', () => {
    // FOUND BY THE PLAYWRIGHT BATTERY, on WebKit: its timer granularity is
    // 1 ms, so a removal in the same millisecond as the segment origin rounds
    // to tRel 0 and is applied inside the FIRST `applyUpTo` — before a latch
    // that only samples at batch boundaries has looked. The chip's contract is
    // "existed at ANY point in this span", and "any point" has to include the
    // keyframe itself.
    const rec = baseRecording({
      segments: [segment({
        t_end: 1000,
        initial_dom: bodyKeyframe([
          { id: 2, kind: 'element', tag: 'iframe', attrs: { id: 'f' }, children: [] },
        ]),
        events: [{ type: 'dom.remove', t: 0, node: 2 }],
      })],
    });
    const v = boot(rec);
    assert.equal(v.doc().querySelector('iframe, [data-ch-placeholder="iframe"]'), null,
      'the placeholder really is gone from the reconstruction');
    assert.notEqual(v.chip('data-ch-iframe-warn').style.display, 'none',
      'and the warning is still there — the interactions inside it are still invisible');
  });
});

// ── the view-state fallback is symmetric (T5.8 fix, review M-3) ────────────
describe('T5.8 fix — a partial camera block cannot cancel half the view state', () => {
  it('inherits vv_scale the same way it inherits dpr', () => {
    // §6 says complete blocks or none, so this is a FOREIGN-file shape — and
    // the viewer plays foreign files by design. With an asymmetric fallback
    // (dpr inheriting, scale hard-resetting to 1) the second event below ends
    // the pinch note while keeping the DPR one, i.e. invents an end to a state
    // the recording never said had ended.
    const cam = (over) => Object.assign({
      scroll_x: 0, scroll_y: 0, viewport_w: 1000, viewport_h: 800,
      client_w: 1000, client_h: 800, dpr: 1, vv_scale: 1, vv_offset_x: 0, vv_offset_y: 0,
    }, over);
    const rec = baseRecording({
      recorder: { name: 'some-other-recorder', version: '1.0.0' },
      segments: [segment({
        t_end: 1000,
        initial_dom: bodyKeyframe([
          { id: 2, kind: 'element', tag: 'button', attrs: { id: 'b' }, children: [] },
        ]),
        events: [
          { type: 'mouse.click', t: 100, x: 5, y: 5, button: 0, target: 2,
            camera: cam({ dpr: 3, vv_scale: 2.5, vv_offset_x: 120, vv_offset_y: 64 }) },
          // Partial: states dpr, says nothing about the visual viewport.
          { type: 'mouse.click', t: 300, x: 5, y: 5, button: 0, target: 2,
            camera: { scroll_x: 0, scroll_y: 0, dpr: 3 } },
        ],
      })],
    });
    const v = boot(rec);
    v.dbg.seek(150);
    assert.equal(v.chip('data-ch-zoom-note').style.display, '');
    v.dbg.seek(350);
    assert.equal(v.chip('data-ch-zoom-note').style.display, '',
      'the pinch note survives a block that says nothing about the visual viewport');
    assert.match(v.chip('data-ch-zoom-note').textContent, /2\.5×/);
    assert.match(v.chip('data-ch-zoom-note').textContent, /120,64/);
    assert.equal(v.chip('data-ch-dpr-note').style.display, '');
  });
});
