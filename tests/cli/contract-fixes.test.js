import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderExtensions } from '../../src/cli/renderers/extensions.js';
import { deriveSessionOffset, collectEvents } from '../../src/cli/renderers/session-timeline.js';

// Round 1 fix: extensions.csv read a dead per-trial `sidebarGapPx`; the current
// library records sidebars session-scoped in session.sidebarEvents.
describe('extensions.csv sidebar source', () => {
  let outDir;
  before(() => { outDir = mkdtempSync(join(tmpdir(), 'ch-ext-')); });
  after(() => { rmSync(outDir, { recursive: true, force: true }); });

  it('derives sidebar rows from session.sidebarEvents (current library shape)', async () => {
    const participants = [{
      participantId: 'P1',
      trials: [{ trialId: 'r1' }],  // no per-trial sidebarGapPx (current shape)
      session: {
        aiExtensionsFound: [],
        sidebarEvents: [
          { type: 'opened', method: 'innerWidth_delta', t: 100 },
          { type: 'closed', method: 'innerWidth_delta', t: 5000 },
          { type: 'opened', method: 'layout_compression', t: 9000 },
        ],
      },
    }];
    await renderExtensions(participants, { outputDir: outDir });
    const csv = readFileSync(join(outDir, 'extensions.csv'), 'utf8');
    assert.match(csv, /P1,sidebar,browser_sidebar,2 open events/,
      'counts the two "opened" events, not the paired close');
  });

  it('falls back to legacy per-trial sidebarGapPx when no session events exist', async () => {
    const participants = [{
      participantId: 'P2',
      trials: [{ trialId: 'r1', sidebarGapPx: 312 }],
    }];
    await renderExtensions(participants, { outputDir: outDir });
    const csv = readFileSync(join(outDir, 'extensions.csv'), 'utf8');
    assert.match(csv, /P2,sidebar,browser_sidebar,312px gap/);
  });
});

// Round 1 fix: deriveSessionOffset Strategy 2 read the nested
// integrityTrial.tabAwayEvents path, which is gone after Shape-1 ingest spreads
// it to the top level — dropping legacy participants to the offset-0 fallback.
describe('session-timeline deriveSessionOffset', () => {
  it('Strategy 2 estimates offset from top-level tabAwayEvents (post-ingest shape)', () => {
    const p = {
      participantId: 'P1',
      metadata: { startTime: '2026-04-14T12:00:00.000Z' },
      trials: [{
        // No trialStart_perfNow → Strategy 1 skipped. Tab-away lives at the
        // top level (post-ingest), not under integrityTrial.
        timestamp: '2026-04-14T12:00:10.000Z',  // trial end 10s after session start
        rt: 5000,                                // → trial start at +5000ms
        tabAwayEvents: [{ start: 28000, duration_ms: 500, type: 'blur' }],
      }],
    };
    // candidate = firstTabPerfNow - trialStartRel - rt/2 = 28000 - 5000 - 2500
    const offset = deriveSessionOffset(p, collectEvents(p));
    assert.equal(offset, 20500, 'Strategy 2 fired on the top-level path');
  });

  it('returns 0 only when neither anchor nor per-trial tab-aways are available', () => {
    const p = {
      participantId: 'P2',
      metadata: { startTime: '2026-04-14T12:00:00.000Z' },
      trials: [{ timestamp: '2026-04-14T12:00:10.000Z', rt: 5000, tabAwayEvents: [] }],
    };
    assert.equal(deriveSessionOffset(p, collectEvents(p)), 0);
  });

  // Round 2 fix: legacy Shape-2 trials carry `responseTime_ms`, not `rt`
  // (ingest's LEGACY_FIELD_MAP only renames mouseTrack). Strategy 2 read `t.rt`
  // directly, so every legacy/SE participant skipped the candidate loop and fell
  // through to the offset-0 fallback — drifting the timeline.
  it('Strategy 2 falls back to responseTime_ms when legacy trials lack rt (Shape-2)', () => {
    const p = {
      participantId: 'P3',
      metadata: { startTime: '2026-04-14T12:00:00.000Z' },
      trials: [{
        timestamp: '2026-04-14T12:00:10.000Z',  // trial end 10s after session start
        responseTime_ms: 5000,                   // legacy field name — no `rt`
        tabAwayEvents: [{ start: 28000, duration_ms: 500, type: 'blur' }],
      }],
    };
    // Same numbers as the rt test above → same 20500 offset, proving the
    // responseTime_ms fallback fires instead of dropping to 0.
    assert.equal(deriveSessionOffset(p, collectEvents(p)), 20500,
      'reads responseTime_ms instead of dropping to the offset-0 fallback');
  });
});

describe('session-timeline collectEvents', () => {
  it('pairs sidebar open/close into spans and reads guard-friction violations', () => {
    const p = {
      participantId: 'P1',
      session: {
        sidebarEvents: [{ type: 'opened', t: 100 }, { type: 'closed', t: 5000 }],
        layoutShifts: [{ t: 200, delta: 30 }],
        tabAwaySums: [4000, 1000],
      },
      trials: [{ tabAwayEvents: [{ start: 1000, duration_ms: 4000, type: 'blur' }] }],
      guardFriction: { violations: [{ t: 300, reason: 'sidebar_open', phase: 'gallery' }] },
    };
    const ev = collectEvents(p);
    assert.equal(ev.sidebarSpans.length, 1, 'one open+close => one span');
    assert.equal(ev.sidebarSpans[0].start_perfNow_ms, 100);
    assert.equal(ev.sidebarSpans[0].end_perfNow_ms, 5000);
    assert.equal(ev.layoutShifts.length, 1);
    assert.equal(ev.guardViolations.length, 1);
    assert.equal(ev.guardViolations[0].reason, 'sidebar_open');
    assert.equal(ev.tabAways.length, 1);
    assert.equal(ev.tabFlickerCutoffMs, 3000, 'defaults to 3s when no saved config');
  });

  it('uses the participant saved tab-away cutoff for the timeline bins', () => {
    const strict = { participantId: 'P1', session: { config: { thresholds: { tabAwayDurationMs: 5000 } } } };
    assert.equal(collectEvents(strict).tabFlickerCutoffMs, 5000, 'strict participant => 5s cutoff');
    const plain = { participantId: 'P2', session: {} };
    assert.equal(collectEvents(plain).tabFlickerCutoffMs, 3000);
  });

  // Round 2 fix: the cutoff used a two-tier (saved ?? default) precedence while
  // summary.js / typing-profile.js use three tiers (saved ?? CLI ?? default), so
  // a legacy cohort re-screened with a CLI override binned at 3s on the timeline
  // but at the override value in summary.csv.
  it('applies the CLI tab-away cutoff when the participant has no saved threshold', () => {
    const legacy = { participantId: 'P3', session: {} };  // predates persisted thresholds
    assert.equal(
      collectEvents(legacy, { thresholds: { tabAwayDurationMs: 5000 } }).tabFlickerCutoffMs, 5000,
      'CLI override applies when no saved threshold exists');
    // The participant's own saved threshold still wins over a CLI override.
    const strict = { participantId: 'P4', session: { config: { thresholds: { tabAwayDurationMs: 8000 } } } };
    assert.equal(
      collectEvents(strict, { thresholds: { tabAwayDurationMs: 5000 } }).tabFlickerCutoffMs, 8000,
      'saved threshold takes precedence over the CLI override');
  });

  // Round 2 fix: two independent runtime detectors (innerWidth_delta +
  // layout_compression) can each emit "opened" on different poll ticks before
  // any close. pairSidebarEvents overwrote openT on every open, starting the
  // drawn span at the later detector and disagreeing with countSidebarOpenings.
  it('anchors a sidebar span to the first open across cross-tick double-detection', () => {
    const p = {
      participantId: 'P1',
      session: {
        sidebarEvents: [
          { type: 'opened', method: 'innerWidth_delta', t: 1000 },
          { type: 'opened', method: 'layout_compression', t: 3000 },
          { type: 'closed', method: 'innerWidth_delta', t: 10000 },
        ],
      },
    };
    const ev = collectEvents(p);
    assert.equal(ev.sidebarSpans.length, 1, 'collapses the double-detection into one span');
    assert.equal(ev.sidebarSpans[0].start_perfNow_ms, 1000, 'span starts at the FIRST open');
  });

  // Round 2 fix: the layoutShifts/guardViolations filters dereferenced e.t
  // without a null guard, so a single null entry threw and the outer try/catch
  // dropped the whole participant's PNG — violating the "malformed → skipped,
  // render continues" contract documented in the file header.
  it('tolerates null entries in layoutShifts and guard violations without throwing', () => {
    const p = {
      participantId: 'P1',
      session: { layoutShifts: [null, { t: 10, delta: 7 }] },
      guardFriction: { violations: [null, { t: 300, reason: 'sidebar_open' }] },
    };
    const ev = collectEvents(p);  // must not throw on null.t
    assert.equal(ev.layoutShifts.length, 1, 'drops the null layout shift, keeps the valid one');
    assert.equal(ev.guardViolations.length, 1, 'drops the null violation, keeps the valid one');
  });

  it('tolerates malformed / empty events without throwing', () => {
    const p = {
      participantId: 'P1',
      session: {
        // junk entries: missing type, non-object, missing timestamps
        sidebarEvents: [null, { type: 'opened' }, 'x', { type: 'closed', t: 9 }],
        layoutShifts: [{ delta: 5 } /* no t */, { t: 10, delta: 7 }],
      },
      trials: [{ tabAwayEvents: [{ /* no start */ duration_ms: 100 }, null] }],
      guardFriction: { violations: [{ reason: 'x' /* no t */ }] },
    };
    const ev = collectEvents(p);
    assert.ok(Array.isArray(ev.sidebarSpans));
    assert.equal(ev.layoutShifts.length, 1, 'drops the layout shift with no timestamp');
    assert.equal(ev.tabAways.length, 0, 'drops the tab-away with no start');
    assert.equal(ev.guardViolations.length, 0, 'drops the violation with no timestamp');
  });
});

// 0.6.1 — retro item 1 (CLI side): libraries now save session-level
// tabAwayEvents with full timing. The timeline prefers those, so off-trial
// tab-aways (consent, tutorial, comprehension) plot instead of being counted
// as "timing not preserved". Pre-0.6.1 payloads keep the per-trial path.
describe('collectEvents — session-level tabAwayEvents (0.6.1)', () => {
  it('prefers session.tabAwayEvents and plots off-trial events', () => {
    const p = {
      participantId: 'P-SESS-TABS',
      trials: [{
        trialId: 't1',
        tabAwayEvents: [{ start: 5000, duration_ms: 4000, type: 'tabHidden' }],
      }],
      session: {
        // Three events: the on-trial one above plus two off-trial ones
        // (e.g. during consent and the gallery phase).
        tabAwayEvents: [
          { start: 1000, duration_ms: 12000, type: 'windowBlur', timestamp: '2026-05-31T21:00:01.000Z' },
          { start: 5000, duration_ms: 4000, type: 'tabHidden', timestamp: '2026-05-31T21:00:05.000Z' },
          { start: 90000, duration_ms: 700, type: 'windowBlur', timestamp: '2026-05-31T21:01:30.000Z' },
        ],
        tabAwaySums: [12000, 4000, 700],
      },
    };
    const events = collectEvents(p, {});
    assert.equal(events.tabAwaySource, 'session');
    assert.equal(events.tabAways.length, 3, 'ALL session tab-aways plot, incl. off-trial');
    assert.deepEqual(events.tabAways.map(e => e.t_perfNow_ms), [1000, 5000, 90000]);
  });

  it('falls back to per-trial events for pre-0.6.1 payloads', () => {
    const p = {
      participantId: 'P-LEGACY-TABS',
      trials: [{
        trialId: 't1',
        tabAwayEvents: [{ start: 5000, duration_ms: 4000, type: 'tabHidden' }],
      }],
      session: { tabAwaySums: [4000, 9000] },  // second event was off-trial: unplaceable
    };
    const events = collectEvents(p, {});
    assert.equal(events.tabAwaySource, 'per-trial');
    assert.equal(events.tabAways.length, 1);
    assert.equal(events.offTrialTabAwayCount, 1, 'off-trial event counted as unplaceable');
  });

  it('reads viewportWidthShifts with fallback to the deprecated layoutShifts key', () => {
    const shifts = [{ t: 1000, delta: -320 }];
    const newPayload = collectEvents({ trials: [], session: { viewportWidthShifts: shifts } }, {});
    assert.equal(newPayload.layoutShifts.length, 1);
    const oldPayload = collectEvents({ trials: [], session: { layoutShifts: shifts } }, {});
    assert.equal(oldPayload.layoutShifts.length, 1);
  });
});
