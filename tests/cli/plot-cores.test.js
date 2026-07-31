// tests/cli/plot-cores.test.js
// Draw-call-log snapshots for the extracted plot cores. Platform-independent
// (unlike PNG pixel hashes): a fake canvas records every 2d-context method
// call + property set; the log is snapshotted. A verbatim-move regression or
// accidental drawing change shows up as a log diff.
// Regenerate deliberately: SNAPSHOT_UPDATE=1 node --test tests/cli/plot-cores.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXT = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'demo', 'DEMO-FIXT.json'), 'utf8'));

// Fake createCanvas: records method calls and property assignments on the 2d
// context. Methods that must return values get minimal stubs.
export function makeRecordingCanvasFactory(log) {
  return function createCanvas(w, h) {
    log.push(['createCanvas', w, h]);
    const ctx = new Proxy({}, {
      get(_, prop) {
        if (prop === 'measureText') return (s) => { log.push(['measureText', s]); return { width: String(s).length * 6 }; };
        if (prop === 'createLinearGradient') return (...a) => { log.push(['createLinearGradient', ...a]); return { addColorStop: (o, c) => log.push(['addColorStop', o, c]) }; };
        return (...args) => { log.push([prop, ...args.map(a => (typeof a === 'number' ? Math.round(a * 100) / 100 : a))]); };
      },
      set(_, prop, value) { log.push(['set:' + String(prop), value]); return true; },
    });
    return { width: w, height: h, getContext: () => ctx };
  };
}

function snapshotTest(name, file, render, extraChecks) {
  test(name, async () => {
    const log = [];
    const canvas = await render(makeRecordingCanvasFactory(log));
    assert.ok(canvas, 'core returned a canvas');
    // Lane-coverage assertions run on BOTH paths (regenerate + verify) so a
    // fixture regenerated from a broken render can't silently pass.
    if (extraChecks) extraChecks(log);
    const snapPath = join(here, '..', 'fixtures', 'cli', file);
    const out = JSON.stringify({ calls: log.length, log }, null, 1);
    if (process.env.SNAPSHOT_UPDATE === '1' || !existsSync(snapPath)) { writeFileSync(snapPath, out); return; }
    assert.equal(out, readFileSync(snapPath, 'utf8'));
  });
}

// Participant in extracted shape — same pipeline the CLI runs.
import { extractIntegrityData } from '../../src/cli/extract-core.js';
const P = extractIntegrityData(FIXT, { outputDir: '.', participantIdField: 'participantId' });

import { drawSessionTimeline } from '../../src/cli/renderers/session-timeline-core.js';
snapshotTest('session-timeline core draw log', 'drawlog-session-timeline.json',
  (cc) => drawSessionTimeline(P, { outputDir: '.' }, cc));

// Enriched variant: DEMO-FIXT records no sidebar / viewport-shift / guard
// events, so the baseline snapshot never enters those lanes' draw loops.
// Inject plain-data events (the exact field shapes collectEvents reads) into
// a deep copy so drawSidebars / drawLayoutShifts / drawGuardViolations draw
// for real. metadata.startTime is absent from the fixture → deriveSessionOffset
// returns 0, so every injected perfNow `t` plots directly at t/1000 seconds
// (x-domain ≈ 17.2s, set by the fixture's own 11.2s tab-away).
//
// NOT injected: a second gallery for drawPhaseGuides' multi-gallery branch.
// DEMO-FIXT trials all carry phase:"default", which derivePhases excludes from
// rule grouping (it groups only 'classification'/unphased trials), and
// metadata lacks startTime/endTime — two galleries would mean overwriting real
// fixture fields rather than adding absent events. That branch waits for a
// fixture with genuine phase data.
const P_ENRICHED = structuredClone(P);
P_ENRICHED.session.sidebarEvents = [
  { type: 'opened', t: 2000 },   // span 2s → 5s, closed (solid bar, no dash)
  { type: 'closed', t: 5000 },
  { type: 'opened', t: 15000 },  // trailing open, never closed → dashed-border
                                 // branch. Its end extends to sessionDurSec,
                                 // which is 0 here (fixture has no session
                                 // duration metadata), so it draws as the
                                 // 3px min-width stub at 15s — the dash still
                                 // executes.
];
P_ENRICHED.session.viewportWidthShifts = [
  { t: 3000, delta: -350 },      // tick at 3s
  { t: 9000, delta: 350 },       // tick at 9s
];
P_ENRICHED.guardFriction = { violations: [
  { t: 10000, reason: 'sidebar_open', phase: 'gallery' },  // ┐ 400ms apart →
  { t: 10400, reason: 'sidebar_open', phase: 'gallery' },  // ┘ one clustered tick
  { t: 12000, reason: 'devtools', phase: 'typing' },       // 1.6s later → second group
] };

snapshotTest('session-timeline core draw log (enriched)', 'drawlog-session-timeline-enriched.json',
  (cc) => drawSessionTimeline(P_ENRICHED, { outputDir: '.' }, cc),
  (log) => {
    // Strictly more drawing than the 218-call baseline. The per-lane checks
    // are count/shape-based, NOT bare `some(color)`: the legend swatches
    // (drawLegendRow) set every lane color once even when a lane drew
    // nothing, and drawLayoutShifts sets its strokeStyle before an empty
    // loop — so mere presence would pass on the un-enriched baseline too.
    assert.ok(log.length > 218, `enriched log has ${log.length} calls (baseline: 218)`);
    const fills = (color) => log.filter(c => c[0] === 'set:fillStyle' && c[1] === color).length;
    // 2 sidebar spans (closed pair + trailing unclosed stub) + 1 legend swatch
    assert.ok(fills('#8e24aa') >= 3, `sidebar fillStyle ×${fills('#8e24aa')}, want ≥3 (2 spans + legend)`);
    // 2 violation groups (clustered 400ms pair, 12s singleton) + 1 legend swatch
    assert.ok(fills('#c62828') >= 3, `guard fillStyle ×${fills('#c62828')}, want ≥3 (2 groups + legend)`);
    // Shifts: the strokeStyle count doesn't move with events (it's set before
    // the loop even when empty), so count the tick draws (moveTo) between the
    // lane's strokeStyle set and the next lane's first fillStyle set instead.
    const lsStart = log.findIndex(c => c[0] === 'set:strokeStyle' && c[1] === '#00897b');
    const lsEnd = log.findIndex((c, i) => i > lsStart && c[0] === 'set:fillStyle');
    assert.equal(log.slice(lsStart, lsEnd).filter(c => c[0] === 'moveTo').length, 2,
      'two viewport-shift ticks drawn');
    // Unclosed trailing sidebar → dashed-border branch. Nothing else in this
    // render calls setLineDash (phase guides skip: < 2 galleries), and the
    // baseline log has zero setLineDash calls.
    assert.ok(log.some(c => c[0] === 'setLineDash'), 'unclosed sidebar dashed border drawn');
  });

// ── Trajectories core ────────────────────────────────────────────────────
import { drawTrajectoryGrid } from '../../src/cli/renderers/trajectories-core.js';

snapshotTest('trajectories core draw log', 'drawlog-trajectories.json',
  (cc) => drawTrajectoryGrid(P, /* triageEntry */ { hardTriggered: false }, { outputDir: '.' }, cc),
  (log) => {
    // Non-tautological checks (per the A3-review template warning): several
    // fillStyle/strokeStyle assignments in trajectories-core.js fire
    // UNCONDITIONALLY once per data-bearing trial panel (mousedown color,
    // mouseup color, panel border, window-rect color) regardless of whether
    // any markers actually get drawn — so a bare `some(color)` check would
    // pass even on a render with zero markers. These assertions instead use
    // occurrence counts (checked against real per-trial counts derived from
    // DEMO-FIXT's own data) or window-bound the log between a style-set and
    // the next one to count the draw calls that landed inside it.
    const fillSets = (color) => log.filter(c => c[0] === 'set:fillStyle' && c[1] === color);
    const strokeSets = (color) => log.filter(c => c[0] === 'set:strokeStyle' && c[1] === color);

    // Red hard-signal panel border: of DEMO-FIXT's 6 trials, only act1-paste
    // (2 pasteEvents === countThreshold) has trialSignals.hard.*.trialHits > 0.
    assert.equal(strokeSets('#ff0000').length, 1,
      'exactly one hard-signal (red) panel border — act1-paste');

    // Tab-away leave/return diamonds: act1-tabaway has exactly one >3s gap
    // (5105ms→11427ms) and it overlaps that trial's one tabAwayEvent — the
    // only such overlap in the fixture, so exactly one diamond pair.
    assert.equal(fillSets('#ffff00').length, 1, 'one tab-away LEAVE diamond drawn');
    assert.equal(fillSets('#00ffff').length, 1, 'one tab-away RETURN diamond drawn');

    // Plain grey pause circle (a >3s gap with NO overlapping tab-away):
    // DEMO-FIXT's only qualifying gap is claimed by the diamond branch above,
    // so the plain-pause branch never fires here. Asserted at zero so the
    // enriched test below (which adds a non-overlapping gap) actually proves
    // the branch fires rather than coincidentally matching a snapshot.
    assert.equal(fillSets('#ccc').length, 0,
      'baseline has no bare pause circle — its only 3s+ gap overlaps a tab-away');

    // Window/screen outline: every windowPositions sample in DEMO-FIXT has
    // y(61) + h(906) = 967 > sh(900) — a genuine window/screen paradox in
    // the recorded data — so chooseScreenFrame's legacy branch always
    // resolves drawOuter=false. The window rect (dashed purple) still draws
    // for each of the 5 trials that reach geometry resolution (moves.length
    // > 0); the screen rect (teal) never does. The enriched test below fixes
    // the paradox to exercise drawOuter=true.
    assert.equal(strokeSets('#7e57c2').length, 5, 'window outline drawn for all 5 data-bearing trials');
    assert.equal(strokeSets('#26a69a').length, 0, 'screen outline suppressed — window/screen paradox in fixture data');

    // Mousedown/mouseup markers: window-bounded fill() counts, not mere
    // color presence (the mousedown/mouseup fillStyle is set once per
    // data-bearing trial regardless of how many down/up events exist).
    // act1-paste is the 2nd data-bearing trial and has exactly 2 down and
    // 2 up events.
    const downIdxs = log.reduce((acc, c, i) => { if (c[0] === 'set:fillStyle' && c[1] === '#00cc00') acc.push(i); return acc; }, []);
    const upIdxs = log.reduce((acc, c, i) => { if (c[0] === 'set:fillStyle' && c[1] === '#ff00ff') acc.push(i); return acc; }, []);
    assert.equal(downIdxs.length, 5, '5 data-bearing trials reach the mousedown style-set');
    assert.equal(upIdxs.length, 5, '5 data-bearing trials reach the mouseup style-set');
    const pasteDownStart = downIdxs[1];
    const pasteUpStart = upIdxs[1];
    const nextBorder = log.findIndex((c, i) => i > pasteUpStart && c[0] === 'set:strokeStyle');
    assert.equal(log.slice(pasteDownStart, pasteUpStart).filter(c => c[0] === 'fill').length, 2,
      'act1-paste draws exactly 2 mousedown triangles');
    assert.equal(log.slice(pasteUpStart, nextBorder).filter(c => c[0] === 'fill').length, 2,
      'act1-paste draws exactly 2 mouseup triangles');
  });

// Enriched variant: DEMO-FIXT's only 3s+ gap overlaps a tab-away (drawn as a
// diamond pair above), so the plain grey pause-circle branch never fires;
// and every windowPositions sample carries a window/screen paradox
// (y + h > sh), so the drawOuter=true (screen outline) branch never fires
// either. Both fixed here, on a structuredClone so the baseline P above is
// untouched:
//   - act2-fullscreen-entry (previously a single click with no move event —
//     the "No mouse data" panel) gets two move events 4.1s apart with no
//     tabAwayEvents, landing in the plain-pause-circle branch.
//   - session.windowPositions[*].h drops from 906 to 800 (same field the
//     library actually polls; DEMO-FIXT's own value happens to be
//     internally inconsistent) so winY+winH fits inside the recorded screen
//     height and drawOuter=true for every trial that resolves geometry.
const P_TRAJ_ENRICHED = structuredClone(P);
for (const wp of P_TRAJ_ENRICHED.session.windowPositions) wp.h = 800;
const fsIdx = P_TRAJ_ENRICHED.trials.findIndex(t => t.trialId === 'act2-fullscreen-entry');
P_TRAJ_ENRICHED.trials[fsIdx].duration_ms = 4300;
P_TRAJ_ENRICHED.trials[fsIdx].mouseEvents = [
  { x: 265, y: 504, t: 1, type: 'click' },
  { x: 265, y: 504, t: 100, type: 'move' },
  { x: 270, y: 510, t: 4200, type: 'move' },  // gap 4100ms > 3000, tabAwayEvents stays []
];

snapshotTest('trajectories core draw log (enriched)', 'drawlog-trajectories-enriched.json',
  (cc) => drawTrajectoryGrid(P_TRAJ_ENRICHED, /* triageEntry */ { hardTriggered: false }, { outputDir: '.' }, cc),
  (log) => {
    const fillSets = (color) => log.filter(c => c[0] === 'set:fillStyle' && c[1] === color);
    const strokeSets = (color) => log.filter(c => c[0] === 'set:strokeStyle' && c[1] === color);
    assert.ok(log.length > 283, `enriched log has ${log.length} calls (baseline: 283)`);
    assert.equal(fillSets('#ccc').length, 1, 'the injected non-overlapping gap draws exactly one bare pause circle');
    assert.equal(strokeSets('#26a69a').length, 6,
      'screen outline now drawn for all 6 trials once the window/screen paradox is fixed');
  });
