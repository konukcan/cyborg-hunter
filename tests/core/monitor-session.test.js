// Node-side lifecycle tests for the core monitor (0.6.1 additions).
// Uses happy-dom to provide window/document; ResizeObserver is stubbed so the
// viewport-shift debounce can be driven deterministically.
//
// Covers the three 0.6.1 library changes:
//   1. endTrial() stamps a wall-clock ISO `timestamp` on the trial report
//      (retro item 2 — Date.parse(undefined)=NaN corrupted per-rule anchors).
//   2. Session-level tabAwayEvents[] records timestamped events for tab-aways
//      that happen OUTSIDE any trial (retro item 1 — consent/tutorial/
//      comprehension events landed in tabAwaySums durations-only).
//   3. layoutShifts → viewportWidthShifts rename (deprecated alias kept) with
//      one-gesture-one-event debouncing (upstream-feedback item).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Window } from 'happy-dom';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Captures ResizeObserver instances so tests can fire entries by hand.
const observers = [];
class StubResizeObserver {
  constructor(cb) { this.cb = cb; observers.push(this); }
  observe() {}
  disconnect() {}
  fire(width) { this.cb([{ contentRect: { width } }]); }
}

let win, monitor, init;

beforeEach(async () => {
  win = new Window();
  global.window = win;
  global.document = win.document;
  global.Node = win.Node;
  global.MutationObserver = win.MutationObserver;
  global.ResizeObserver = StubResizeObserver;
  observers.length = 0;
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

describe('endTrial() wall-clock timestamp (item 2)', () => {
  it('stamps an ISO timestamp on the trial report', () => {
    monitor = init({ participantId: 'T1' });
    monitor.startSession();
    monitor.startTrial({ trialId: 't1' });
    const before = Date.now();
    const report = monitor.endTrial();
    const after = Date.now();

    assert.equal(typeof report.timestamp, 'string');
    const parsed = Date.parse(report.timestamp);
    assert.ok(Number.isFinite(parsed), 'timestamp must be Date.parse-able');
    assert.ok(parsed >= before - 1 && parsed <= after + 1,
      'timestamp must be the trial-end wall-clock');
  });
});

describe('session-level tabAwayEvents (item 1)', () => {
  it('records a timestamped event for a tab-away OUTSIDE any trial', async () => {
    monitor = init({ participantId: 'T2' });
    monitor.startSession();

    // No trial active — this is the consent/tutorial/comprehension case.
    win.dispatchEvent(new win.Event('blur'));
    await sleep(25);
    win.dispatchEvent(new win.Event('focus'));

    const report = monitor.getSessionReport();
    assert.equal(report.tabAwayEvents.length, 1);
    const ev = report.tabAwayEvents[0];
    assert.equal(ev.type, 'windowBlur');
    assert.equal(typeof ev.start, 'number');
    assert.ok(ev.duration_ms >= 20, `duration_ms=${ev.duration_ms} should cover the blur period`);
    assert.ok(Number.isFinite(Date.parse(ev.timestamp)), 'event carries a wall-clock ISO timestamp');
    // tabAwaySums stays in lockstep (backward compatibility).
    assert.equal(report.tabAwaySums.length, 1);
    assert.equal(report.tabAwaySums[0], ev.duration_ms);
  });

  it('records the event on BOTH the trial report and the session when a trial is active', async () => {
    monitor = init({ participantId: 'T3' });
    monitor.startSession();
    monitor.startTrial({ trialId: 't1' });

    win.dispatchEvent(new win.Event('blur'));
    await sleep(15);
    win.dispatchEvent(new win.Event('focus'));

    const trialReport = monitor.endTrial();
    const sessionReport = monitor.getSessionReport();
    assert.equal(trialReport.tabAwayEvents.length, 1);
    assert.equal(sessionReport.tabAwayEvents.length, 1);
    assert.equal(trialReport.tabAwayEvents[0].start, sessionReport.tabAwayEvents[0].start);
  });
});

describe('viewportWidthShifts rename + debounce (upstream feedback)', () => {
  it('exposes viewportWidthShifts with layoutShifts as a deprecated alias', () => {
    monitor = init({ participantId: 'T4' });
    monitor.startSession();
    const report = monitor.getSessionReport();
    assert.ok(Array.isArray(report.viewportWidthShifts), 'canonical key present');
    assert.ok(Array.isArray(report.layoutShifts), 'deprecated alias present');
    assert.deepStrictEqual(report.layoutShifts, report.viewportWidthShifts);
  });

  it('collapses a multi-fire resize gesture into ONE event with the net delta', async () => {
    monitor = init({
      participantId: 'T5',
      thresholds: { viewportShiftDebounceMs: 30 },
    });
    monitor.startSession();
    const resizeObs = observers[0];
    assert.ok(resizeObs, 'monitor must observe documentElement resize');

    const baseline = win.document.documentElement.clientWidth;
    // Simulate a drag: five observer fires in quick succession.
    for (const w of [baseline - 80, baseline - 160, baseline - 240, baseline - 300, baseline - 320]) {
      resizeObs.fire(w);
      await sleep(5);
    }
    await sleep(80); // let the debounce settle

    const report = monitor.getSessionReport();
    assert.equal(report.viewportWidthShifts.length, 1,
      `one gesture must log one event, got ${report.viewportWidthShifts.length}`);
    const ev = report.viewportWidthShifts[0];
    assert.equal(ev.delta, 320, 'event carries the NET width change of the gesture');
    assert.equal(ev.oldWidth, Math.round(baseline));
    assert.equal(ev.newWidth, Math.round(baseline - 320));
    // Alias sees the same event.
    assert.deepStrictEqual(report.layoutShifts, report.viewportWidthShifts);
  });

  it('ignores a transient shift that settles back under the threshold', async () => {
    monitor = init({
      participantId: 'T6',
      thresholds: { viewportShiftDebounceMs: 30 },
    });
    monitor.startSession();
    const resizeObs = observers[0];
    const baseline = win.document.documentElement.clientWidth;

    resizeObs.fire(baseline - 300);   // transient
    await sleep(5);
    resizeObs.fire(baseline - 4);     // settles within layoutCompressionPx
    await sleep(80);

    const report = monitor.getSessionReport();
    assert.equal(report.viewportWidthShifts.length, 0,
      'a shift that settles back must not be logged');
  });
});
