// Regenerates conj-disj-sample.csv using jsPsych 7's actual JSON2CSV function.
//
// The function is copied verbatim from
// https://github.com/jspsych/jsPsych/blob/main/packages/jspsych/src/modules/data/utils.ts
// (no DOM dependencies — pure string manipulation).
//
// The trial array below mirrors what `src/jspsych/extension.js` actually attaches:
//   - Per-trial scalars via jsPsych.data.addProperties()
//   - Per-trial `integrity` object via on_finish() return
//   - Session-level `integritySession` and `integrityScore` via addDataToLastTrial()
//
// Run: node tests/cli/fixtures/regenerate-conj-disj-csv.mjs
// Output overwrites conj-disj-sample.csv.

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Verbatim copy from jsPsych source (DataCollection.csv() calls this).
function JSON2CSV(objArray) {
  const array = typeof objArray != "object" ? JSON.parse(objArray) : objArray;
  let line = "";
  let result = "";
  const columns = [];

  for (const row of array) {
    for (const key in row) {
      let keyString = key + "";
      keyString = '"' + keyString.replace(/"/g, '""') + '",';
      if (!columns.includes(key)) {
        columns.push(key);
        line += keyString;
      }
    }
  }

  line = line.slice(0, -1);
  result += line + "\r\n";

  for (const row of array) {
    line = "";
    for (const col of columns) {
      let value = typeof row[col] === "undefined" ? "" : row[col];
      if (typeof value == "object") {
        value = JSON.stringify(value);
      }
      const valueString = value + "";
      line += '"' + valueString.replace(/"/g, '""') + '",';
    }

    line = line.slice(0, -1);
    result += line + "\r\n";
  }

  return result;
}

// Build the trial array exactly as the cyborg-hunter extension would.
// Two-trial session: trial 1 honest, trial 2 paste-flagged.

const trialReport1 = {
  trialId: 't1',
  libraryVersion: '0.3.0',
  participantId: 'P-CSV-1',
  startTime: 1000,
  duration_ms: 5000,
  trialSoftScore: 0,
  pasteEvents: [],
  copyEvents: [],
  dropEvents: [],
  tabAwayEvents: [],
  trialSignals: {},
};

const trialReport2 = {
  trialId: 't2',
  libraryVersion: '0.3.0',
  participantId: 'P-CSV-1',
  startTime: 6000,
  duration_ms: 4000,
  trialSoftScore: 5,
  pasteEvents: [{ t: 1500 }, { t: 2300 }],
  copyEvents: [],
  dropEvents: [],
  tabAwayEvents: [{ start: 1000, duration_ms: 200, type: 'blur' }],
  trialSignals: {},
};

const sessionReport = {
  pasteCount: 2, copyCount: 0, dropCount: 0,
  sidebarEvents: [], keyboardShortcuts: [], windowPositions: [],
  layoutShifts: [], zoomChanges: [], idleGaps: [], extensionInjections: [],
  tabAwaySums: [], charsPerSec: [], aiExtensionsFound: [],
};

const scoreReport = {
  hardScore: {
    paste: { triggered: true, count: 2 },
    copy: { triggered: false, count: 0 },
    drop: { triggered: false, count: 0 },
  },
  softScore: 5,
  anyHardTriggered: true,
  trialsCompleted: 2,
  softScoreThreshold: 10,
};

// Per-row scalars added by jsPsych itself (subjectId, trial_index) and by
// the cyborg-hunter extension's addProperties() call.
const baseScalars = (trialIndex) => ({
  subjectId: 'P-CSV-1',
  trial_index: trialIndex,
  integrityPasteCount: 2,
  integrityCopyCount: 0,
  integrityDropCount: 0,
  integrityAnyHardTriggered: true,
  integritySoftScore: 5,
  cyborgHunterVersion: '0.3.0',
});

// Per-trial `integrity` object comes from on_finish() return value.
const row1 = {
  ...baseScalars(0),
  integrity: trialReport1,
};

// Last row also gets integritySession + integrityScore via addDataToLastTrial().
const row2 = {
  ...baseScalars(1),
  integrity: trialReport2,
  integritySession: sessionReport,
  integrityScore: scoreReport,
};

const trials = [row1, row2];
const csv = JSON2CSV(trials);

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, 'conj-disj-sample.csv');
writeFileSync(outPath, csv);

console.log(`Wrote ${outPath} (${csv.length} bytes, ${trials.length} trials)`);
console.log(`First 200 chars:\n${csv.slice(0, 200)}`);
