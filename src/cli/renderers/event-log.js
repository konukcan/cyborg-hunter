// src/cli/renderers/event-log.js
// Writes event-log.csv — chronological clipboard/paste events across all participants.
// Each row is one event with participant, trial, type, timestamp, and text (if paste).

import { writeFileSync } from 'fs';
import { join } from 'path';

export async function renderEventLog(participants, config) {
  // duration_ms column is populated for tab-aways (which have intrinsic
  // duration); empty for instantaneous events (copy, paste, drop, synthetic).
  const header = 'participantId,trialId,eventType,timestamp,duration_ms,text';
  const rows = [];

  for (const p of participants) {
    // Collect this participant's events with their session-absolute timestamp,
    // then sort chronologically before serializing. All event timestamps are on
    // the same performance.now() clock (copy/paste/drop/synthetic use `e.t`,
    // tab-aways use `e.start`), so a single numeric sort interleaves them
    // correctly. Without this the rows came out in loop/category order
    // (all pastes, then all copies, …), contradicting the "chronological" docs.
    const pEvents = [];
    for (const trial of p.trials) {
      const trialId = trial.trialId || trial.ruleId || '?';

      for (const e of (trial.pasteEvents || [])) {
        pEvents.push({ ts: e.t, row: formatRow(p.participantId, trialId, 'paste', e.t, '', e.text) });
      }
      for (const e of (trial.copyEvents || [])) {
        pEvents.push({ ts: e.t, row: formatRow(p.participantId, trialId, 'copy', e.t, '', '') });
      }
      for (const e of (trial.dropEvents || [])) {
        pEvents.push({ ts: e.t, row: formatRow(p.participantId, trialId, 'drop', e.t, '', e.text) });
      }
      for (const e of (trial.syntheticInsertions || [])) {
        pEvents.push({ ts: e.t, row: formatRow(p.participantId, trialId, 'synthetic', e.t, '', e.text) });
      }
      // Tab-away timestamp uses the session-absolute `start` (the `text` column
      // carries the trigger type — windowBlur / visibilityChange / etc. — so
      // analysts can filter by trigger).
      for (const e of (trial.tabAwayEvents || [])) {
        pEvents.push({ ts: e.start, row: formatRow(p.participantId, trialId, 'tabAway', e.start, e.duration_ms, e.type || '') });
      }
    }
    // Stable chronological sort; events with no usable timestamp sort last.
    pEvents.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
    for (const e of pEvents) rows.push(e.row);
  }

  const csv = [header, ...rows].join('\n') + '\n';
  const outPath = join(config.outputDir, 'event-log.csv');
  writeFileSync(outPath, csv);
  console.log(`  event-log.csv — ${rows.length} events`);
}

function formatRow(pid, trialId, type, timestamp, duration, text) {
  return [pid, trialId, type, timestamp ?? '', duration ?? '', escapeCSV(text ?? '')].join(',');
}

function escapeCSV(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
