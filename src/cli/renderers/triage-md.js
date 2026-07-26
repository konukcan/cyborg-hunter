// src/cli/renderers/triage-md.js
// Writes triage.md — a ranked markdown table of participants by suspiciousness.
// This is the "start here" document for manual review.

import { writeFileSync } from 'fs';
import { join } from 'path';

export async function renderTriage(triage, config) {
  const lines = [
    '# Participant Triage — Ranked by Suspiciousness',
    '',
    `_${triage.length} participants analyzed_`,
    '',
    '**Tier** is the library\'s two-tier screening verdict: `HARD` = a hard signal',
    '(paste/drop/copy) crossed its count threshold; `soft` = library soft score ≥',
    'its threshold; `clean` = neither. **Score** is the CLI\'s separate ranking',
    'heuristic (5×paste + 5×copy + 3×sidebar + 1×tab-away) — it orders rows',
    '*within* a tier and is not the library soft score.',
    '',
    '| Rank | Participant | Tier | Score | Reason |',
    '|------|-------------|------|-------|--------|',
  ];

  triage.forEach((t, i) => {
    const tier = t.hardTriggered ? '**HARD**' : t.softFlagged ? 'soft' : 'clean';
    // Escape pipe characters in reason text to avoid breaking the table
    const reason = t.reason.replace(/\|/g, '\\|');
    lines.push(`| ${i + 1} | ${t.participantId} | ${tier} | ${t.score} | ${reason} |`);
  });

  lines.push('');
  const outPath = join(config.outputDir, 'triage.md');
  writeFileSync(outPath, lines.join('\n'));
  console.log(`  triage.md — ranked list`);
}
