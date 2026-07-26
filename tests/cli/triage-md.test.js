// 0.6.1 — retro item 4: the console summary counts "flagged" by the LIBRARY's
// two-tier screening while triage.md is ordered by the CLI's composite score.
// triage.md now carries an explicit Tier column (HARD / soft / clean) plus a
// header note distinguishing the two numbers, so the ranked list and the
// console counts can no longer be conflated.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderTriage } from '../../src/cli/renderers/triage-md.js';

describe('triage.md renderer', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ch-triage-'));
  after(() => rmSync(outputDir, { recursive: true, force: true }));

  it('renders a Tier column with HARD / soft / clean per participant', async () => {
    const triage = [
      { participantId: 'P-HARD', score: 20, reason: '4 paste events', hardTriggered: true, softFlagged: true },
      { participantId: 'P-SOFT', score: 9, reason: '3 sidebar events', hardTriggered: false, softFlagged: true },
      { participantId: 'P-CLEAN', score: 0, reason: 'clean', hardTriggered: false, softFlagged: false },
    ];
    await renderTriage(triage, { outputDir });
    const md = readFileSync(join(outputDir, 'triage.md'), 'utf8');

    assert.ok(md.includes('| Rank | Participant | Tier | Score | Reason |'), 'table header carries Tier');
    assert.match(md, /\| 1 \| P-HARD \| \*\*HARD\*\* \| 20 \|/);
    assert.match(md, /\| 2 \| P-SOFT \| soft \| 9 \|/);
    assert.match(md, /\| 3 \| P-CLEAN \| clean \| 0 \|/);
    // The header note must spell out that Score is the CLI heuristic, not the
    // library soft score.
    assert.ok(md.includes('not the library soft score'), 'score/soft-score distinction documented in the header');
  });
});
