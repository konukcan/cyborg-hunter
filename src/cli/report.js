// src/cli/report.js
// CLI report pipeline orchestrator.
// Runs: config → ingest → analyze → render → output
//
// This is the main pipeline that ties all CLI modules together.
// Each stage is imported lazily where possible so partial runs
// (e.g., missing canvas) degrade gracefully.

import { join } from 'path';
import { loadConfig } from './config.js';
import { ingest } from './ingest.js';
import { computeSummary } from './analyzers/summary.js';
import { detectEdgeExits } from './analyzers/edge-exit.js';
import { rankTriage } from './analyzers/triage.js';
import { applyPhaseScope, describePhaseScope, findUnmatchedPhaseScopePhases } from './analyzers/phase-scope.js';
import { VERSION } from '../shared/constants.js';
import { checkForUpdate, formatUpdateNotice, formatCollectedVersionNotice } from './update-check.js';

export async function run(args) {
  console.log(`cyborg-hunter report v${VERSION}\n`);

  // Kick the update check off first so the registry request overlaps the
  // whole pipeline; awaited (bounded by its own short timeout) at the end.
  const updateCheck = checkForUpdate({ currentVersion: VERSION }).catch(() => null);

  // 1. Load and merge config (defaults ← file ← CLI flags)
  const config = loadConfig(args);

  // 2. Ingest participant data files
  const { participants, warnings } = await ingest(config);
  console.log(`Found ${participants.length} participants` +
    (warnings.length ? ` (${warnings.length} files had warnings)` : ''));

  if (participants.length === 0) {
    console.error(
      `[cyborg-hunter] no valid participant data found in ${config.dataDir} (pattern: ${config.filePattern}).`
    );
    console.error(`  Common causes:`);
    console.error(`    - dataDir points to the wrong directory`);
    console.error(`    - filePattern doesn't match your file extensions (try "*.csv" or "*.{json,csv}")`);
    console.error(`    - participantIdField doesn't match the actual field in your data`);
    console.error(`      (jsPsych output usually uses "subject_ID", not "participantId")`);
    if (warnings.length > 0) {
      console.error(`  Per-file warnings (${warnings.length}):`);
      for (const w of warnings.slice(0, 3)) {
        console.error(`    - ${w.file}: ${w.warnings[0]}`);
      }
      if (warnings.length > 3) console.error(`    ... and ${warnings.length - 3} more`);
    }
    process.exit(1);
  }

  // Offline staleness note: payloads stamp the library version that collected
  // them, so an experiment still serving an old bundle is visible without any
  // network. (The registry check above covers the CLI side.)
  const collectedNotice = formatCollectedVersionNotice(
    participants.map(p => p.libraryVersion), VERSION);
  if (collectedNotice) console.log(collectedNotice);

  // 3. Analyze — compute summaries, detect edge exits, rank by triage priority.
  // config.phaseScope (0.6.1) filters which trials feed the analyzers so
  // scores can honor pre-registered phase scoping; renderers below still get
  // the FULL participants, so the visual evidence is never hidden.
  const scoredParticipants = applyPhaseScope(participants, config.phaseScope);
  if (scoredParticipants !== participants) {
    console.log(`\nPhase scope active (${describePhaseScope(config.phaseScope)}):`);
    console.log(`  scores count per-trial signals inside the scope only; ambient session`);
    console.log(`  signals (sidebar, shortcuts, viewport shifts, zoom) stay session-wide.`);
    // A configured phase name that matches no trial is almost always a typo. For
    // an `include`, it silently filters every trial and reports the cohort clean.
    const unmatched = findUnmatchedPhaseScopePhases(participants, config.phaseScope);
    if (unmatched.length > 0) {
      console.warn(`[cyborg-hunter] phaseScope names match NO trial in the data: ` +
        `${unmatched.join(', ')} — likely a typo; scored trials may be wrongly emptied.`);
    }
  }
  const summaries = computeSummary(scoredParticipants, config);
  const edgeExits = detectEdgeExits(scoredParticipants, config);
  const triage = rankTriage(summaries, edgeExits, config);

  const flaggedHard = triage.filter(t => t.hardTriggered).length;
  const flaggedSoft = triage.filter(t => !t.hardTriggered && t.softFlagged).length;
  const clean = triage.length - flaggedHard - flaggedSoft;

  // Two DIFFERENT numbers live in this report and used to share the word
  // "flagged": the tier counts below come from the LIBRARY's two-tier
  // screening (hard count thresholds / soft score vs its threshold), while
  // triage.md is ORDERED by the CLI's separate composite triage score
  // (5×paste + 5×copy + 3×sidebar + 1×tab-away) within each tier. Label both
  // explicitly so the console summary can't be read as "top N of triage.md".
  console.log(`\nAnalyzing...`);
  console.log(`  Hard-flagged (hard signal crossed its count threshold): ${flaggedHard}`);
  console.log(`  Soft-flagged (library soft score >= its threshold):     ${flaggedSoft}`);
  console.log(`  Clean:                                                  ${clean}`);
  console.log(`  Triage.md orders tier-first (hard > soft > clean), then by the CLI`);
  console.log(`  triage score (5xpaste + 5xcopy + 3xsidebar + 1xtab-away) within a tier.`);

  // 4. Render outputs
  console.log(`\nRendering...`);
  const { mkdirSync } = await import('fs');
  mkdirSync(config.outputDir, { recursive: true });

  // Text-based renderers (always available, no native dependencies)
  const { renderSummaryCSV } = await import('./renderers/summary-csv.js');
  const { renderTriage } = await import('./renderers/triage-md.js');
  const { renderEventLog } = await import('./renderers/event-log.js');
  const { renderExtensions } = await import('./renderers/extensions.js');

  await renderSummaryCSV(summaries, triage, config);
  await renderTriage(triage, config);
  await renderEventLog(participants, config);
  await renderExtensions(participants, config);

  // Visual renderers require node-canvas (optional dependency).
  // If canvas is unavailable, skip with a helpful install message.
  let visualsRendered = false;
  if (!config.noVisuals) {
    let canvas;
    try {
      canvas = await import('canvas');
    } catch {
      console.log(`\n  Trajectory images require the 'canvas' package, which needs Cairo.\n`);
      console.log(`    macOS:    brew install pkg-config cairo pango libpng jpeg giflib librsvg`);
      console.log(`    Ubuntu:   sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev`);
      console.log(`    Windows:  https://github.com/nicktacik/node-canvas#compiling\n`);
      console.log(`  Then run: npm install canvas`);
      console.log(`  Continuing without visuals.\n`);
    }

    if (canvas) {
      const { renderTrajectories } = await import('./renderers/trajectories.js');
      const { renderSessionTimelines } = await import('./renderers/session-timeline.js');
      const { renderTypingProfiles } = await import('./renderers/typing-profile.js');

      // Create images/ subdirectory for visual outputs
      mkdirSync(join(config.outputDir, 'images'), { recursive: true });

      await renderTrajectories(participants, triage, config);
      await renderSessionTimelines(participants, config);
      await renderTypingProfiles(participants, config);
      visualsRendered = true;
    }
  }

  // Replay assets — per-participant JSONP models under replay/, lazy-loaded
  // by the HTML report. Size is printed because dom-tier models dominate
  // the report's disk footprint.
  const { renderReplayAssets } = await import('./renderers/replay-assets.js');
  const replayAssets = renderReplayAssets(participants, config.outputDir);
  if (replayAssets.count > 0) {
    console.log(`  replay/ — ${replayAssets.count} session replays (${(replayAssets.totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  }
  // A skipped artifact is already visible in the report (the participant's
  // replay section says why), but an analyst watching the CLI must not have
  // to open the HTML to learn a recording did not make it.
  for (const s of replayAssets.skipped) {
    console.log(`  replay/ — skipped ${s.participantId}: ${s.reason}`);
  }

  // HTML index page — references images/ folder (not base64-embedded)
  const { renderHtmlIndex } = await import('./renderers/html-index.js');
  await renderHtmlIndex(summaries, triage, participants, config, visualsRendered);

  console.log(`\nReport written to ${config.outputDir}/`);
  console.log(`  Open ${config.outputDir}/index.html to review`);

  const update = await updateCheck;
  if (update && update.updateAvailable) {
    console.log(`\n${formatUpdateNotice(VERSION, update.latest)}`);
  }
}
