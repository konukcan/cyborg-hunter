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
    // Strictly more drawing than the 218-call baseline, plus one signature
    // call per newly-covered lane (each color is unique to its subroutine).
    assert.ok(log.length > 218, `enriched log has ${log.length} calls (baseline: 218)`);
    assert.ok(log.some(c => c[0] === 'set:fillStyle' && c[1] === '#8e24aa'), 'sidebar span drawn');
    assert.ok(log.some(c => c[0] === 'set:strokeStyle' && c[1] === '#00897b'), 'viewport shift ticks drawn');
    assert.ok(log.some(c => c[0] === 'set:fillStyle' && c[1] === '#c62828'), 'guard-friction groups drawn');
  });
