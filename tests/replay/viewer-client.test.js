// tests/replay/viewer-client.test.js
// The shipped report viewer, driven headlessly over v2 models (T5 Task 4).
//
// It runs the ASSEMBLED script — `dom-instantiate.js` concatenated ahead of the
// client, exactly what `html-index.js` inlines into a report — because the
// client calls `mountTree`/`applyPatch` out of that concatenation and a test
// that evaluated the client alone would prove nothing about what ships.
//
// happy-dom is a real enough DOM for the span walk: it parses `srcdoc`
// SYNCHRONOUSLY (so a boot needs no await here), keeps one `contentDocument`
// identity across the session, and implements `value`/`checked`/`scrollTop`
// and window scroll. What it does NOT implement is layout — every
// `getBoundingClientRect()` is 0×0 and `getContext('2d')` returns null — so
// this file asserts STATE (reconstruction, seeds, ordering, counters, chips)
// and leaves geometry to the Playwright battery (Task 8) and the five
// alignment predicates to Task 6.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { Window } from 'happy-dom';

import { readReplayClientSrc } from '../../src/cli/renderers/replay-client-source.js';
import { buildViewerModel } from '../../src/replay/viewer-model.js';

const CLIENT_SRC = readReplayClientSrc();

const fixture = (name) => JSON.parse(readFileSync(
  new URL(`./schema-v2/fixtures/${name}.json`, import.meta.url), 'utf8'));

// Node identity assertions go through this: a failing `assert.equal` on two
// happy-dom nodes renders both with `util.inspect`, which walks
// ownerDocument → defaultView → … until the runner is OOM-killed with no
// per-test output (Task 2's SIGKILL finding).
const same = (a, b, msg) => assert.ok(a === b, msg);

// ── harness ────────────────────────────────────────────────────────────────

// happy-dom has no 2D context; the viewer draws the cursor overlay and the
// marker lane through one. A recorder stands in so drawing is exercised (a
// throw here would be a real defect) without asserting pixels.
function stubCanvas(win) {
  win.HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__ctx) {
      const calls = [];
      const rec = (name) => (...args) => { calls.push({ name, args }); };
      this.__ctx = {
        calls,
        clearRect: rec('clearRect'), fillRect: rec('fillRect'),
        beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
        stroke: rec('stroke'), fill: rec('fill'), arc: rec('arc'),
        setLineDash: rec('setLineDash'),
        fillStyle: '', strokeStyle: '', lineWidth: 1,
      };
    }
    return this.__ctx;
  };
}

function boot(recording) {
  const model = buildViewerModel(recording);
  const win = new Window({ url: 'https://report.test/' });
  stubCanvas(win);
  const frames = [];
  win.document.body.innerHTML = '<div id="mount"></div>';
  const mount = win.document.getElementById('mount');
  // The four globals the client reads. ResizeObserver is deliberately
  // undefined — the client is `typeof`-guarded and an analyst-side resize is
  // not what this file tests.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'requestAnimationFrame', 'ResizeObserver', CLIENT_SRC)(
    win, win.document, (fn) => { frames.push(fn); return frames.length; }, undefined);
  win.initChReplayViewer(mount, model);
  const dbg = mount._chReplayDebug;
  return {
    win, mount, model, dbg,
    frames,
    flushFrames: () => { const q = frames.splice(0); q.forEach((f) => f(0)); return q.length; },
    doc: () => {
      const f = mount.querySelector('.replay-frame');
      return f ? f.contentDocument : null;
    },
    chip: (attr) => mount.querySelector('[' + attr + ']'),
  };
}

// ── constructed recordings ─────────────────────────────────────────────────

function baseRecording(over) {
  return Object.assign({
    schema_version: 2,
    recorder: { name: 'cyborg-hunter-replay', version: '0.7.5' },
    participant_id: 'P1',
    recording_started_at: '2026-08-11T00:00:00.000Z',
    recording_started_at_perf: 0,
    user_agent: 'test',
    viewport: { w: 1000, h: 800, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
    stylesheets: [],
    stylesheet_events: [],
    viewport_changes: [],
    ended_at_perf: 10000,
    end_reason: 'finished',
    truncated: false,
    extensions: { 'cyborg-hunter': { tier: 'dom' } },
    segments: [],
  }, over);
}

const bodyKeyframe = (children) => ({
  id: 1, kind: 'element', tag: 'body', attrs: {}, children,
});

function segment(over) {
  return Object.assign({
    index: 0, label: null, plugin: null,
    t_start: 0, t_dom_ready: null, t_load: null, t_end: 1000,
    initial_dom: null, initial_state: null, events: [],
    host_data: null, extensions: null,
  }, over);
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
