// tests/replay/support/viewer-harness.js
// Booting the SHIPPED report viewer headlessly over a v2 model.
//
// Extracted from `viewer-client.test.js` at T5.6, unchanged in behaviour, so
// the alignment suite and the vocabulary suite boot the viewer the same way.
// Two copies of a boot harness are two readings of what "the viewer" is, and
// this migration exists to remove exactly that class of duplication (Task 2's
// `readTree` extraction set the precedent).
//
// It runs the ASSEMBLED script — `dom-instantiate.js` concatenated ahead of the
// client, exactly what `html-index.js` inlines into a report — because the
// client calls `mountTree`/`applyPatch` out of that concatenation and a test
// that evaluated the client alone would prove nothing about what ships.
//
// happy-dom is a real enough DOM for the span walk: it parses `srcdoc`
// SYNCHRONOUSLY (so a boot needs no await here), keeps one `contentDocument`
// identity across the session, and implements `value`/`checked`/`scrollTop`
// and window scroll. What it does NOT implement is LAYOUT — every
// `getBoundingClientRect()` is 0×0, `documentElement.clientWidth` is 0,
// `elementFromPoint` returns null and `getContext('2d')` returns null. Suites
// that need geometry either model it explicitly (see
// `alignment-viewer-model.test.js`) or belong in a Playwright battery.

import assert from 'node:assert';
import { readFileSync } from 'fs';
import { Window } from 'happy-dom';

import { readReplayClientSrc } from '../../../src/cli/renderers/replay-client-source.js';
import { buildViewerModel } from '../../../src/replay/viewer-model.js';

export const CLIENT_SRC = readReplayClientSrc();

export const fixture = (name) => JSON.parse(readFileSync(
  new URL(`../schema-v2/fixtures/${name}.json`, import.meta.url), 'utf8'));

// Node identity assertions go through this: a failing `assert.equal` on two
// happy-dom nodes renders both with `util.inspect`, which walks
// ownerDocument → defaultView → … until the runner is OOM-killed with no
// per-test output (Task 2's SIGKILL finding).
export const same = (a, b, msg) => assert.ok(a === b, msg);

// ── prototype patching ─────────────────────────────────────────────────────
// happy-dom shares element classes across `Window` instances
// (`a.HTMLImageElement === b.HTMLImageElement`), so a prototype patch leaks
// into every later test in the file — a stubbed `decode` that never resolves
// turns the next five into 15-second timeouts. Patches go through this.
//
// ALWAYS `await withProto(...)`, and note that the helper AWAITS `body()`
// rather than returning its promise. A synchronous `try { return body(); }
// finally {…}` runs the `finally` the moment an async body returns its
// promise — that is, at its first `await` — so the stub silently uninstalls
// itself mid-test and everything after the first `await` runs against the real
// prototype. That version was green only because both call sites happened to
// depend on the stub before their first suspension. The contract is: the patch
// is installed for the WHOLE body, sync or async.
export async function withProto(win, ctor, name, descriptor, body) {
  const proto = win[ctor].prototype;
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, Object.assign({ configurable: true }, descriptor));
  try { return await body(); } finally {
    if (original) Object.defineProperty(proto, name, original); else delete proto[name];
  }
}

// ── canvas ─────────────────────────────────────────────────────────────────
// happy-dom has no 2D context; the viewer draws the cursor overlay, the marker
// lane AND (from T5.5) the offscreen canvas composites through one. A recorder
// stands in so drawing is exercised (a throw here would be a real defect)
// without asserting pixels.
//
// `toDataURL` returns '' in happy-dom, which is not a data URL and which the
// client's own presentation guard refuses; the stub returns a well-formed one
// whose payload counts the draws behind it, so a test can tell one composite
// from another and can count RE-ENCODES (the cost design §3.1 defers to once
// per batch). Presented PIXELS are the Playwright battery's business — this
// realm has no painting at all, which is exactly the trap the plan forbids
// asserting into (`viewer-canvas.battery.mjs`).
export function stubCanvas(win) {
  win.__canvases = [];
  win.HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__ctx) {
      const calls = [];
      const rec = (name) => (...args) => { calls.push({ name, args }); };
      // The offscreen composite canvas is DETACHED by design — it belongs to
      // the report document but is never mounted — so a querySelectorAll would
      // not find it. Every canvas that ever asks for a context registers here.
      win.__canvases.push(this);
      this.__ctx = {
        calls,
        clearRect: rec('clearRect'), fillRect: rec('fillRect'),
        beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
        stroke: rec('stroke'), fill: rec('fill'), arc: rec('arc'),
        drawImage: rec('drawImage'),
        setLineDash: rec('setLineDash'),
        fillStyle: '', strokeStyle: '', lineWidth: 1,
      };
    }
    return this.__ctx;
  };
  win.__encodes = 0;
  win.HTMLCanvasElement.prototype.toDataURL = function () {
    win.__encodes++;
    const draws = this.__ctx ? this.__ctx.calls.filter((c) => c.name === 'drawImage').length : 0;
    return 'data:image/png;base64,' + 'Q'.repeat(4) + draws;
  };
}

// ── boot ───────────────────────────────────────────────────────────────────

export function boot(recording, opts) {
  const model = buildViewerModel(recording);
  // No network in this realm: happy-dom would otherwise try to fetch every
  // <link rel=stylesheet> the viewer links and fire `error` on it, which the
  // client counts as a failed sheet. Disabled loads count as success here;
  // the real error path is exercised in the browser battery, not this realm.
  const win = new Window({ url: 'https://report.test/', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } });
  stubCanvas(win);
  const frames = [];
  win.document.body.innerHTML = '<div id="mount"></div>';
  const mount = win.document.getElementById('mount');
  // The four globals the client reads. ResizeObserver is deliberately
  // undefined — the client is `typeof`-guarded and an analyst-side resize is
  // not what these files test.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'requestAnimationFrame', 'ResizeObserver', CLIENT_SRC)(
    win, win.document, (fn) => { frames.push(fn); return frames.length; }, undefined);
  win.initChReplayViewer(mount, model, opts);
  const dbg = mount._chReplayDebug;
  return {
    win, mount, model, dbg,
    frames,
    flushFrames: () => { const q = frames.splice(0); q.forEach((f) => f(0)); return q.length; },
    doc: () => {
      const f = mount.querySelector('.replay-frame');
      return f ? f.contentDocument : null;
    },
    frame: () => mount.querySelector('.replay-frame'),
    chip: (attr) => mount.querySelector('[' + attr + ']'),
  };
}

// ── constructed recordings ─────────────────────────────────────────────────

export function baseRecording(over) {
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

export const bodyKeyframe = (children, attrs) => ({
  id: 1, kind: 'element', tag: 'body', attrs: attrs || {}, children,
});

export function segment(over) {
  return Object.assign({
    index: 0, label: null, plugin: null,
    t_start: 0, t_dom_ready: null, t_load: null, t_end: 1000,
    initial_dom: null, initial_state: null, events: [],
    host_data: null, extensions: null,
  }, over);
}
