import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderEventLog } from '../../src/cli/renderers/event-log.js';

describe('event-log renderer', () => {
  let outDir;
  before(() => { outDir = mkdtempSync(join(tmpdir(), 'ch-evlog-')); });
  after(() => { rmSync(outDir, { recursive: true, force: true }); });

  it('emits one row per copy/paste/drop event (existing behavior)', async () => {
    const participants = [{
      participantId: 'P1',
      trials: [{
        trialId: 'r1',
        copyEvents: [{ t: 1000 }, { t: 2000 }],
        pasteEvents: [{ t: 3000, text: 'pasted' }],
        dropEvents: [{ t: 4000, text: 'dropped' }],
      }],
    }];
    await renderEventLog(participants, { outputDir: outDir });
    const csv = readFileSync(join(outDir, 'event-log.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    // header + 4 events
    assert.equal(lines.length, 5);
    assert.match(csv, /P1,r1,copy,1000/);
    assert.match(csv, /P1,r1,copy,2000/);
    assert.match(csv, /P1,r1,paste,3000/);
    assert.match(csv, /P1,r1,drop,4000/);
  });

  // Regression for the bug found in quillien-2a verification (April 2026):
  // event-log.csv contained zero tab-away rows even though the participant
  // had 5 tab-aways in raw data — the renderer simply wasn't iterating
  // tabAwayEvents. Fix: emit one row per tab-away with type windowBlur/etc.
  // in the text column and the duration in a new duration_ms column.
  it('emits one row per tab-away event with duration_ms populated', async () => {
    const participants = [{
      participantId: 'P1',
      trials: [{
        trialId: 'r1',
        tabAwayEvents: [
          { start: 5000, duration_ms: 2767, type: 'windowBlur' },
          { start: 9000, duration_ms: 548, type: 'visibilityChange' },
        ],
      }],
    }];
    await renderEventLog(participants, { outputDir: outDir });
    const csv = readFileSync(join(outDir, 'event-log.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    // header + 2 tab-aways
    assert.equal(lines.length, 3);
    // Tab-aways should be on the session-absolute clock (e.start), matching
    // the convention used by copy/paste/drop (e.t is also session-absolute
    // performance.now() in the integrity monitor).
    assert.match(csv, /P1,r1,tabAway,5000,2767,windowBlur/);
    assert.match(csv, /P1,r1,tabAway,9000,548,visibilityChange/);
  });

  it('header includes duration_ms column for tab-away support', async () => {
    await renderEventLog([], { outputDir: outDir });
    const csv = readFileSync(join(outDir, 'event-log.csv'), 'utf8');
    assert.equal(csv.trim().split('\n')[0], 'participantId,trialId,eventType,timestamp,duration_ms,text');
  });

  // Round 1 fix: the renderer appended rows in loop/category order (all pastes,
  // then all copies, …) despite advertising "chronological". Events of mixed
  // types must interleave by timestamp within each participant.
  it('orders events chronologically within a participant across types', async () => {
    const participants = [{
      participantId: 'P1',
      trials: [{
        trialId: 'r1',
        // Deliberately out of order across categories: a tab-away at t=1500
        // must sort between the two pastes, and the copy at t=500 must lead.
        pasteEvents: [{ t: 1000, text: 'a' }, { t: 3000, text: 'b' }],
        copyEvents: [{ t: 500 }],
        tabAwayEvents: [{ start: 1500, duration_ms: 200, type: 'blur' }],
      }],
    }];
    await renderEventLog(participants, { outputDir: outDir });
    const csv = readFileSync(join(outDir, 'event-log.csv'), 'utf8');
    const timestamps = csv.trim().split('\n').slice(1).map(l => Number(l.split(',')[3]));
    assert.deepEqual(timestamps, [500, 1000, 1500, 3000], 'rows sorted by timestamp');
  });
});
