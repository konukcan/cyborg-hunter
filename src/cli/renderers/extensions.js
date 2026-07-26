// src/cli/renderers/extensions.js
// Writes extensions.csv — lists which AI extensions/tools were detected
// for which participants. One row per participant × extension.
// Also includes sidebar detection as a separate row.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { countSidebarOpenings } from '../analyzers/summary.js';

export async function renderExtensions(participants, config) {
  const header = 'participantId,detectionType,name,details';
  const rows = [];

  for (const p of participants) {
    const pid = p.participantId;

    // Extensions detected (from browser scan)
    const extensions = p.session?.aiExtensionsFound || p.trials[0]?.extensionsDetected || [];
    for (const ext of extensions) {
      const name = typeof ext === 'string' ? ext : ext.name || 'unknown';
      rows.push(`${pid},extension,${escapeCSV(name)},`);
    }

    // Sidebar detection. Prefer the current library's session-level
    // sidebarEvents (the monitor records sidebars session-scoped, not per-trial);
    // fall back to the legacy per-trial sidebarGapPx only when no session events
    // exist (pre-session / Shape-2 legacy data). countSidebarOpenings() counts
    // distinct openings (collapsing the paired open/close records and the
    // innerWidth_delta + layout_compression double-detection), matching the
    // summary/triage count.
    const sidebarOpens = countSidebarOpenings(p.session?.sidebarEvents);
    if (sidebarOpens > 0) {
      rows.push(`${pid},sidebar,browser_sidebar,${sidebarOpens} open event${sidebarOpens === 1 ? '' : 's'}`);
    } else if (p.trials.some(t => (t.sidebarGapPx || 0) > 0)) {
      const maxGap = Math.max(...p.trials.map(t => t.sidebarGapPx || 0));
      rows.push(`${pid},sidebar,browser_sidebar,${maxGap}px gap`);
    }
  }

  const csv = [header, ...rows].join('\n') + '\n';
  const outPath = join(config.outputDir, 'extensions.csv');
  writeFileSync(outPath, csv);
  console.log(`  extensions.csv — ${rows.length} detections`);
}

function escapeCSV(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
