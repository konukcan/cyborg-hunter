// generate-fixture.mjs — writes the synthetic-pilot example dataset.
//
// EVERYTHING HERE IS SYNTHETIC. No participant, real or anonymized, is behind
// any of these numbers; the three "participants" are hand-authored to
// illustrate the three triage tiers (clean / soft / HARD) with realistic
// v0.6.1-shaped data.
//
// The rows mirror what the cyborg-hunter jsPsych extension actually saves:
//   - per-row scalars added via jsPsych.data.addProperties() at finalize()
//   - a per-trial `integrity` object returned by endTrial()
//   - `integritySession` + `integrityScore` on the last row, added via
//     addDataToLastTrial() at finalize()
// The CSV serialization uses jsPsych 7's own JSON2CSV function (copied
// verbatim from jspsych/src/modules/data/utils.ts — pure string code).
//
// Regenerate with:  node generate-fixture.mjs        (from this directory)
// Output:           data/sim-SYN-*.csv  (overwritten)

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── jsPsych 7's CSV serializer, verbatim ────────────────────────────────────
function JSON2CSV(objArray) {
  const array = typeof objArray != "object" ? JSON.parse(objArray) : objArray;
  let line = "";
  let result = "";
  const columns = [];
  for (const row of array) {
    for (const key in row) {
      let keyString = key + "";
      keyString = '"' + keyString.replace(/"/g, '""') + '",';
      if (!columns.includes(key)) { columns.push(key); line += keyString; }
    }
  }
  line = line.slice(0, -1);
  result += line + "\r\n";
  for (const row of array) {
    line = "";
    for (const col of columns) {
      let value = typeof row[col] === "undefined" ? "" : row[col];
      if (typeof value == "object") { value = JSON.stringify(value); }
      const valueString = value + "";
      line += '"' + valueString.replace(/"/g, '""') + '",';
    }
    line = line.slice(0, -1);
    result += line + "\r\n";
  }
  return result;
}

// ── Shared constants (standard preset, v0.6.1) ──────────────────────────────
const VERSION = '0.6.1';
const PRESET = 'standard';
const SOFT_THRESHOLD = 6;          // standard softScoreThreshold
const TAB_CUTOFF_MS = 3000;        // standard tabAwayDurationMs
const TYPING_CPS = 10;             // standard typingSpeedCps
// All wall-clock stamps hang off one synthetic session start.
const SESSION_EPOCH = Date.parse('2026-07-01T12:00:00.000Z');

const iso = (perfMs) => new Date(SESSION_EPOCH + perfMs).toISOString();

// A deterministic little mouse path so trajectory plots have something to draw.
function mousePath(startT) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    pts.push({
      x: 200 + i * 90 + (i % 3) * 25,
      y: 300 + Math.round(60 * Math.sin(i * 1.1)),
      t: startT + 400 + i * 350,
      type: i === 7 ? 'down' : 'move'
    });
  }
  return pts;
}

// Builds one trial's `integrity` object the way endTrial() shapes it.
// `sig` carries this trial's raw events; session totals accumulate outside.
function buildTrial(pid, idx, sig, session) {
  const startTime = 20000 + idx * 30000;
  const duration = 9000 + (idx * 1700) % 8000;

  session.pasteCount += sig.pasteEvents.length;
  session.copyCount += sig.copyEvents.length;

  // The runtime pushes the SAME tab-away event object to the active trial AND
  // to the session record (focus.js), stamping an ISO timestamp on it. Every
  // tab-away therefore appears in sessionData.tabAwayEvents/tabAwaySums too.
  sig.tabAwayEvents = sig.tabAwayEvents.map(e => ({ ...e, timestamp: iso(e.start + e.duration_ms) }));
  for (const e of sig.tabAwayEvents) {
    session.tabAwayEvents.push(e);
    session.tabAwaySums.push(e.duration_ms);
  }

  const softCopyCapped = Math.min(sig.copyEvents.length, 2);
  const copyScore = softCopyCapped * 2;
  const longTabs = sig.tabAwayEvents.filter(e => (e.duration_ms || 0) > TAB_CUTOFF_MS).length;
  const tabCapped = Math.min(longTabs, 2);
  const tabScore = tabCapped * 1;
  const fastHit = sig.charsPerSec != null && sig.charsPerSec > TYPING_CPS ? 1 : 0;
  const typingScore = fastHit * 2;
  const sidebarScore = sig.sidebarHits ? 3 : 0;
  const trialSoftScore = copyScore + tabScore + typingScore + sidebarScore;
  session.softScore += trialSoftScore;
  if (sig.charsPerSec != null) session.charsPerSec.push(sig.charsPerSec);

  const trialSignals = {
    hard: {
      paste: { trialHits: sig.pasteEvents.length, sessionTotal: session.pasteCount, countThreshold: 2 },
      drop: { trialHits: 0, sessionTotal: 0, countThreshold: 2 }
    },
    soft: {
      copy: { hits: sig.copyEvents.length, capped: softCopyCapped, score: copyScore },
      tabAway: { hits: longTabs, capped: tabCapped, score: tabScore }
    }
  };
  if (sig.charsPerSec != null) {
    trialSignals.soft.typingSpeed = { charsPerSec: sig.charsPerSec, threshold: TYPING_CPS, hit: fastHit, score: typingScore };
  }
  if (sig.sidebarHits) {
    trialSignals.soft.sidebarEvent = { hits: sig.sidebarHits, score: sidebarScore };
  }

  const integrity = {
    trialId: 't' + (idx + 1),
    phase: 'test',
    participantId: pid,
    libraryVersion: VERSION,
    startTime,
    duration_ms: duration,
    timestamp: iso(startTime + duration),           // 0.6.1: wall-clock stamp
    trialStart_perfNow: startTime,
    pasteEvents: sig.pasteEvents,
    copyEvents: sig.copyEvents,
    dropEvents: [],
    tabAwayEvents: sig.tabAwayEvents,
    mouseEvents: mousePath(startTime),
    editTimestamps: [],                              // keystrokeDynamics off (standard default)
    foreignInputEvents: [],
    syntheticInsertions: [],
    trialSoftScore,
    trialSignals
  };
  if (sig.charsPerSec != null) integrity.charsPerSec = sig.charsPerSec;
  return integrity;
}

// Assembles one participant's CSV rows from trial definitions + session extras.
function buildParticipant(pid, trialDefs, sessionExtras) {
  const session = { pasteCount: 0, copyCount: 0, softScore: 0, charsPerSec: [], tabAwayEvents: [], tabAwaySums: [] };
  // Off-trial tab-aways (consent, tutorial, ...) land ONLY in the session
  // record — that is the 0.6.1 session-level tabAwayEvents feature.
  for (const e of (sessionExtras.offTrialTabAways || [])) {
    const stamped = { ...e, timestamp: iso(e.start + e.duration_ms) };
    session.tabAwayEvents.push(stamped);
    session.tabAwaySums.push(stamped.duration_ms);
  }
  const trials = trialDefs.map((sig, i) => buildTrial(pid, i, sig, session));
  session.tabAwayEvents.sort((a, b) => a.start - b.start);

  const anyHard = session.pasteCount >= 2;
  const hardScore = {
    paste: { count: session.pasteCount, threshold: 2, triggered: session.pasteCount >= 2 },
    drop: { count: 0, threshold: 2, triggered: false }
  };

  // getSessionReport() shape, v0.6.1 (viewportWidthShifts + deprecated alias).
  const shifts = sessionExtras.viewportWidthShifts || [];
  const integritySession = {
    pasteCount: session.pasteCount,
    copyCount: session.copyCount,
    dropCount: 0,
    tabAwaySums: session.tabAwaySums,
    tabAwayEvents: session.tabAwayEvents,   // 0.6.1: every tab-away, timestamped and placeable
    charsPerSec: session.charsPerSec,
    sidebarEvents: sessionExtras.sidebarEvents || [],
    devToolsEvents: [],
    aiExtensionsFound: sessionExtras.aiExtensionsFound || [],
    keyboardShortcuts: [],
    windowPositions: [],
    idleGaps: [],
    extensionInjections: [],
    viewportWidthShifts: shifts,
    layoutShifts: shifts,                               // deprecated alias, same content
    zoomChanges: [],
    hardScore,
    softScore: session.softScore,
    softScoreThreshold: SOFT_THRESHOLD,
    anyHardTriggered: anyHard,
    trialsCompleted: trials.length,
    config: {
      preset: PRESET,
      participantId: pid,
      thresholds: { tabAwayDurationMs: TAB_CUTOFF_MS, typingSpeedCps: TYPING_CPS }
    },
    libraryVersion: VERSION
  };

  const integrityScore = {
    hardScore,
    softScore: session.softScore,
    softScoreThreshold: SOFT_THRESHOLD,
    anyHardTriggered: anyHard,
    trialsCompleted: trials.length
  };

  // Per-row scalars: addProperties() runs at finalize(), so every row carries
  // the final session totals (that is how real saved data looks too).
  const scalars = (i) => ({
    subject_ID: pid,
    trial_index: i,
    trial_type: 'survey-text',
    rt: 4000 + i * 800,
    integrityPasteCount: session.pasteCount,
    integrityCopyCount: session.copyCount,
    integrityDropCount: 0,
    integrityAnyHardTriggered: anyHard,
    integritySoftScore: session.softScore,
    cyborgHunterVersion: VERSION
  });

  const rows = trials.map((integrity, i) => ({ ...scalars(i), integrity }));
  rows[rows.length - 1] = { ...rows[rows.length - 1], integritySession, integrityScore };
  return rows;
}

// ── The three synthetic participants ────────────────────────────────────────

// SYN-CLEAN-01: nothing to see. One sub-threshold flicker, ordinary typing,
// one benign window resize (viewport-width shift) mid-session.
const clean = buildParticipant('SYN-CLEAN-01', [
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: 3.1 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [{ start: 52000, duration_ms: 800, type: 'windowBlur' }], charsPerSec: 4.4 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: 3.8 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: null },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: 4.9 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: 3.5 }
], {
  viewportWidthShifts: [{ oldWidth: 1440, newWidth: 1280, delta: -160, t: 95000 }]
});

// SYN-SOFT-02: no hard signal, but the pattern accumulates — copies, long
// tab-aways, a sidebar opening, and one off-trial tab-away during the
// consent page (session-level tabAwayEvents, new in 0.6.1).
const soft = buildParticipant('SYN-SOFT-02', [
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: 4.2 },
  { pasteEvents: [], copyEvents: [{ t: 54000, text: 'if the hand has two hearts and a face card' }], tabAwayEvents: [], charsPerSec: 5.0 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [{ start: 84000, duration_ms: 12000, type: 'tabHidden' }], charsPerSec: null },
  { pasteEvents: [], copyEvents: [{ t: 112000, text: 'two hearts and a face card' }, { t: 115000, text: 'a face card but no spades' }], tabAwayEvents: [], charsPerSec: 6.1, sidebarHits: 1 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [{ start: 145000, duration_ms: 8000, type: 'tabHidden' }], charsPerSec: 5.4 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: 4.7 }
], {
  offTrialTabAways: [{ start: 4200, duration_ms: 6400, type: 'tabHidden' }],
  sidebarEvents: [
    { type: 'opened', method: 'innerWidth_delta', deltaIW: 340, innerWidth: 1100, baselineIW: 1440, t: 110500 },
    { type: 'closed', method: 'innerWidth_delta', deltaIW: 340, duration_ms: 9200, t: 119700 }
  ]
});

// SYN-HARD-03: two pastes → the standard preset's paste countThreshold (2)
// fires. The pasted text is the kind of fluent, over-complete answer that a
// chat assistant produces; read it in event-log.csv, that is the point.
const hard = buildParticipant('SYN-HARD-03', [
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [{ start: 22000, duration_ms: 900, type: 'windowBlur' }], charsPerSec: 4.0 },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [{ start: 56000, duration_ms: 25000, type: 'tabHidden' }], charsPerSec: null },
  {
    pasteEvents: [{ t: 86500, text: 'The rule appears to be: the hand wins whenever it contains at least two cards of the same suit and no card lower than a five. Both examples shown satisfy this condition.' }],
    copyEvents: [{ t: 82000, text: 'wins when the hand contains' }],
    tabAwayEvents: [{ start: 81000, duration_ms: 15000, type: 'tabHidden' }],
    charsPerSec: 14.2
  },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [{ start: 118000, duration_ms: 1500, type: 'windowBlur' }], charsPerSec: 4.6 },
  {
    pasteEvents: [{ t: 148000, text: 'Yes — this hand also fits the rule, since the two clubs count as a same-suit pair and every card is five or higher.' }],
    copyEvents: [],
    tabAwayEvents: [{ start: 143000, duration_ms: 11000, type: 'tabHidden' }],
    charsPerSec: null
  },
  { pasteEvents: [], copyEvents: [], tabAwayEvents: [], charsPerSec: 4.1 }
], {});

// ── Write the files ──────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

for (const [name, rows] of [
  ['sim-SYN-CLEAN-01.csv', clean],
  ['sim-SYN-SOFT-02.csv', soft],
  ['sim-SYN-HARD-03.csv', hard]
]) {
  const csv = JSON2CSV(rows);
  writeFileSync(join(dataDir, name), csv);
  console.log(`Wrote data/${name} (${csv.length} bytes, ${rows.length} rows)`);
}
