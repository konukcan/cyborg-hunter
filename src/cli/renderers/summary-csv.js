// src/cli/renderers/summary-csv.js
// Writes summary.csv — one row per participant with columns for every
// signal aggregate and the triage score/reason.

import { writeFileSync } from 'fs';
import { join } from 'path';

// CSV columns in output order. Each entry: [header, accessor function].
const COLUMNS = [
  ['participantId', (s, t) => s.participantId],
  ['trialCount', (s, t) => s.trialCount],
  ['triageScore', (s, t) => t.score],
  ['hardTriggered', (s, t) => t.hardTriggered ? 'YES' : 'no'],
  ['triageReason', (s, t) => t.reason],
  ['totalPasteEvents', (s, t) => s.totalPasteEvents],
  ['totalCopyEvents', (s, t) => s.totalCopyEvents],
  ['totalDropEvents', (s, t) => s.totalDropEvents],
  ['totalTabAways', (s, t) => s.totalTabAways],
  ['tabAwayLongCount', (s, t) => s.tabAwayLongCount ?? 0],       // ≥10s
  ['tabAwayMediumCount', (s, t) => s.tabAwayMediumCount ?? 0],   // 3–10s
  ['tabAwayFlickerCount', (s, t) => s.tabAwayFlickerCount ?? 0], // <3s
  ['totalTabAwayDuration_ms', (s, t) => s.totalTabAwayDuration_ms],
  ['trialsWithTabAway', (s, t) => s.trialsWithTabAway],
  ['meanTypingSpeed', (s, t) => s.meanTypingSpeed.toFixed(2)],
  ['trialsWithFastTyping', (s, t) => s.trialsWithFastTyping],
  ['meanMouseEvents', (s, t) => s.meanMouseEvents.toFixed(1)],
  ['meanPathEfficiency', (s, t) => s.meanPathEfficiency.toFixed(3)],
  ['totalIdleGaps', (s, t) => s.totalIdleGaps],
  ['totalSyntheticInsertions', (s, t) => s.totalSyntheticInsertions],
  ['totalForeignInputEvents', (s, t) => s.totalForeignInputEvents],
  ['totalSoftScore', (s, t) => s.totalSoftScore],
  ['edgeExitCount', (s, t) => t.edgeExitCount],
  // Session-level signals (Task 4) — drop legacy sidebarDetected/extensionsDetected
  // columns in favour of richer session-authoritative counts.
  ['sidebar_event_count', (s, t) => s.sidebarEventCount ?? 0],
  ['ai_extensions', (s, t) => {
    const ext = s.aiExtensionsFound || [];
    return ext.map(e => typeof e === 'string' ? e : (e.name || 'unknown')).join('; ');
  }],
  ['keyboard_shortcut_count', (s, t) => s.keyboardShortcutCount || 0],
  ['layout_shift_count', (s, t) => s.layoutShiftCount || 0],
  ['zoom_change_count', (s, t) => s.zoomChangeCount || 0],
  ['dev_tools_event_count', (s, t) => s.devToolsEventCount || 0],
  ['authoritative_soft_score', (s, t) => s.authoritativeSoftScore ?? ''],
  // Guard-honeypot self-disclosure. Three states: 'YES' = box ticked,
  // 'no' = honeypot present but unticked (negative evidence), '' = honeypot
  // extension not used for this participant (honeypotAiUse is null).
  ['honeypot_ai_use', (s, t) => s.honeypotAiUse == null ? '' : (s.honeypotAiUse ? 'YES' : 'no')],
  ['honeypot_ai_report', (s, t) => s.honeypotAiReport || ''],
];

export async function renderSummaryCSV(summaries, triage, config) {
  // Build a lookup from participantId → triage entry
  const triageMap = new Map(triage.map(t => [t.participantId, t]));

  const header = COLUMNS.map(c => c[0]).join(',');
  const rows = summaries.map(s => {
    const t = triageMap.get(s.participantId) || {};
    return COLUMNS.map(c => escapeCSV(c[1](s, t))).join(',');
  });

  const csv = [header, ...rows].join('\n') + '\n';
  const outPath = join(config.outputDir, 'summary.csv');
  writeFileSync(outPath, csv);
  console.log(`  summary.csv — ${summaries.length} participants`);
}

// Escapes a CSV value: wraps in quotes if it contains commas, quotes, or newlines
function escapeCSV(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
