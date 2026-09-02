// tests/core/mouse-track-passthrough.test.js
// A8: raw mouseTrack passthrough, end to end.
//
// Step-1 findings (this task; see monitor.js/extract-core.js comments added
// alongside this test for the fix itself):
//   1. collectForPostHoc.rawMouseTrack (monitor.js:67) was declared in the
//      default config object but never READ anywhere — `grep -rn
//      "rawMouseTrack"` across monitor.js/constants.js/extension-cyborg-
//      hunter.js turned up exactly the one declaration line. Unlike the
//      keystroke-timing toggle it was modeled on (fullKeystrokeTimestamps,
//      gated at monitor.js ~360-369), NOTHING in endTrial() emptied
//      report.mouseEvents when it was off. Because endTrial() builds the
//      report via `deepCopy(trialData)`, and trialData.mouseEvents is always
//      populated whenever mouse tracking is on (the default), every trial
//      report leaked the full raw {x,y,t,type} trace regardless of the
//      documented off-by-default privacy toggle. Declared, not implemented.
//   2. extract-core.js's LEGACY_FIELD_MAP (mouseTrack → mouseEvents) and the
//      mouseDataAvailable flag it derives were wired ONLY into the Shape-2
//      legacy branch (raw.responses, via mapLegacyFields) — never applied to
//      Shape-1 (`{ trials: [{ integrity }] }`, the jsPsych-extension shape
//      demo/payload.js and CyborgHunter.endTrial() actually produce) or
//      Shape-3. A Shape-1 payload that DID have raw mouse data never got
//      mouseDataAvailable computed at all.
//
// Fix (this task):
//   - monitor.js endTrial() now gates the raw track the same way the
//     keystroke-timing toggle is gated: persisted under `mouseTrack` (the
//     name extract-core's field map already expects) ONLY when
//     collectForPostHoc.rawMouseTrack is true; report.mouseEvents (the
//     internal collection-buffer name) is never left on the report.
//   - extract-core.js now applies the mouseTrack → mouseEvents rename +
//     mouseDataAvailable derivation once, after all three shapes are
//     resolved, so it covers Shape-1/2/3 uniformly instead of Shape-2 only.
//
// Harness pattern copied from tests/core/monitor-session.test.js (happy-dom
// window/document + ResizeObserver stub).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';
import { buildPayload } from '../../demo/payload.js';
import { extractIntegrityData } from '../../src/cli/extract-core.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class StubResizeObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
}

let win, monitor, init;

beforeEach(async () => {
  win = new Window();
  global.window = win;
  global.document = win.document;
  global.Node = win.Node;
  global.MutationObserver = win.MutationObserver;
  global.ResizeObserver = StubResizeObserver;
  ({ init } = await import('../../src/core/monitor.js'));
});

afterEach(() => {
  if (monitor) { try { monitor.destroy(); } catch { /* already destroyed */ } }
  monitor = null;
  win.close();
  delete global.window;
  delete global.document;
  delete global.Node;
  delete global.MutationObserver;
  delete global.ResizeObserver;
});

// Dispatches a synthetic mousemove at (x, y). happy-dom's MouseEvent
// constructor does not derive pageX/pageY from clientX/clientY (both come
// back 0), so they're forced via defineProperty — the same technique
// attachMouseSignals' `e.pageX`/`e.pageY` reads rely on.
function dispatchMove(x, y) {
  const ev = new win.MouseEvent('mousemove');
  Object.defineProperty(ev, 'pageX', { value: x, configurable: true });
  Object.defineProperty(ev, 'pageY', { value: y, configurable: true });
  win.document.dispatchEvent(ev);
}

describe('rawMouseTrack privacy gate (A8)', () => {
  it('default config: trial report carries the raw mouse track under `mouseTrack` (on by default since 2026-09-02)', () => {
    monitor = init({ participantId: 'P1', thresholds: { mouseThrottleMs: 0 } });
    monitor.startSession();
    monitor.startTrial({ trialId: 't1' });
    dispatchMove(10, 10);
    dispatchMove(20, 30);
    dispatchMove(15, 25);
    const report = monitor.endTrial();

    assert.ok(Array.isArray(report.mouseTrack), 'mouseTrack must be present by default');
    assert.equal(report.mouseEvents, undefined, 'mouseEvents must be absent by default');
    // The derived signal still works — only the raw trace is gated.
    assert.ok(report.mouseMetrics, 'mouseMetrics (derived) must still be computed');
  });

  it('collectForPostHoc.rawMouseTrack: false drops the raw track and keeps the derived metrics', () => {
    monitor = init({ participantId: 'P1', thresholds: { mouseThrottleMs: 0 },
      collectForPostHoc: { rawMouseTrack: false } });
    monitor.startSession();
    monitor.startTrial({ trialId: 't1' });
    dispatchMove(10, 10);
    dispatchMove(20, 20);
    dispatchMove(30, 30);
    const report = monitor.endTrial();
    assert.equal(report.mouseTrack, undefined, 'explicit opt-out: no raw track');
    assert.equal(report.mouseEvents, undefined, 'raw field never leaks under its internal name');
    assert.ok(report.mouseMetrics, 'derived metrics still computed');
  });

  it('collectForPostHoc.rawMouseTrack: true persists the raw track under `mouseTrack`', () => {
    monitor = init({
      participantId: 'P2',
      collectForPostHoc: { rawMouseTrack: true },
      thresholds: { mouseThrottleMs: 0 },
    });
    monitor.startSession();
    monitor.startTrial({ trialId: 't1' });
    dispatchMove(10, 10);
    dispatchMove(20, 30);
    dispatchMove(15, 25);
    const report = monitor.endTrial();

    assert.equal(report.mouseEvents, undefined,
      'the internal buffer name must not leak onto the report');
    assert.ok(Array.isArray(report.mouseTrack), 'raw track persisted under mouseTrack');
    assert.equal(report.mouseTrack.length, 3);
    // Shape trajectories-core.js actually reads: {t, x, y, type}, filtering
    // on type === 'move' (src/cli/renderers/trajectories-core.js:496).
    for (const sample of report.mouseTrack) {
      assert.equal(typeof sample.x, 'number');
      assert.equal(typeof sample.y, 'number');
      assert.equal(typeof sample.t, 'number');
      assert.equal(sample.type, 'move');
    }
  });
});

describe('Shape-1 round-trip through extractIntegrityData (A8)', () => {
  it('mouseTrack survives buildPayload → extractIntegrityData as mouseEvents/mouseDataAvailable, and session.windowPositions survives alongside it', async () => {
    monitor = init({
      participantId: 'P3',
      collectForPostHoc: { rawMouseTrack: true },
      thresholds: { mouseThrottleMs: 0, windowPositionPollMs: 5 },
    });
    monitor.startSession();
    // Let the window-position poller (2ms interval override) fire at least
    // once before any trial starts, so sessionReport.windowPositions is
    // non-empty — proving the passthrough, not just its absence.
    await sleep(20);

    monitor.startTrial({ trialId: 't1' });
    dispatchMove(10, 10);
    dispatchMove(20, 30);
    dispatchMove(15, 25);
    const trialReport = monitor.endTrial();
    const sessionReport = monitor.getSessionReport();

    assert.ok(sessionReport.windowPositions.length > 0,
      'test setup: expected the window-position poller to have fired');

    const payload = buildPayload({
      pid: 'P3',
      trials: [{ trialId: 't1', integrity: trialReport }],
      sessionReport,
      violations: [],
    });

    const result = extractIntegrityData(payload, { participantIdField: 'participantId' });

    const trial = result.trials[0];
    assert.ok(trial.mouseEvents.length > 0, 'raw track survives as trial.mouseEvents');
    assert.equal(trial.mouseDataAvailable, true);
    // extract-core's windowPositions fallback (findSessionData) reads
    // raw.metadata.integritySession, which buildPayload sets directly to
    // sessionReport — so result.session IS sessionReport, and its
    // windowPositions must be the exact array getSessionReport() produced.
    assert.deepStrictEqual(result.session.windowPositions, sessionReport.windowPositions);
  });
});
