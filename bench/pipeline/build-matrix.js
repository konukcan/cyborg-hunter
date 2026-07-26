// build-matrix.js
//
// Builds the signal-coverage matrix for the cyborg-hunter bench:
//
//     scenario × guards × behavior → { ch_detected, rt_detected, runs, intended }
//
// The matrix is the reporting artifact for the bench: it shows, for every
// (synthetic scenario × guard configuration × taxonomy behavior) triple,
// whether the cyborg-hunter (CH) library and/or the roundtable (RT) analysis
// flagged that behavior in any run we collected.
//
// Two pure functions:
//   - buildMatrix(runs, behaviorMatcher?) → matrix object
//   - renderMatrixMarkdown(matrix)        → markdown table string
//
// No I/O; no mutation of input. Tests live in tests/build-matrix.test.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load taxonomy from disk. Node 20 / 22 still ships JSON import attributes as
// experimental, and the rest of bench/pipeline/ uses readFileSync, so we
// follow that convention for consistency and to avoid the warning.
const TAXONOMY_PATH = join(__dirname, 'taxonomy.json');
const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));

export const SCENARIOS = [
  'bot-playwright',
  'bot-browser-use',
  'cyborg-paste',
  'cyborg-no-paste',
  'clean-human',
];

export const GUARD_CONFIGS = ['none', 'friction', 'full'];

/**
 * Default behavior matcher: an event represents behavior B iff event.type === B.
 * Callers can pass a richer matcher for derived behaviors (e.g. tab_away_short
 * from tab_away + duration_ms < 10000).
 */
function defaultMatcher(behaviorId, event) {
  return event.type === behaviorId;
}

/**
 * Build the 3-D coverage matrix.
 *
 * @param {Array<{ runId: string, scenario: string, guards: string, events: Array }>} runs
 * @param {(behaviorId: string, event: object) => boolean} [behaviorMatcher]
 * @returns {{ scenarios: string[], guardConfigs: string[], rows: Array }}
 */
export function buildMatrix(runs, behaviorMatcher = defaultMatcher) {
  // Group runs by cell key for O(1) cell lookup later.
  // Map<"scenario|guards", Array<run>>
  const runsByCell = new Map();
  for (const s of SCENARIOS) {
    for (const g of GUARD_CONFIGS) {
      runsByCell.set(cellKey(s, g), []);
    }
  }
  for (const run of runs) {
    const key = cellKey(run.scenario, run.guards);
    // Silently drop runs whose (scenario, guards) is not in the known grid;
    // they cannot be rendered. Caller is expected to validate upstream.
    if (!runsByCell.has(key)) continue;
    runsByCell.get(key).push(run);
  }

  const rows = taxonomy.behaviors.map((b) => {
    const cells = {};
    for (const s of SCENARIOS) {
      for (const g of GUARD_CONFIGS) {
        const key = cellKey(s, g);
        const cellRuns = runsByCell.get(key);
        let ch = false;
        let rt = false;
        for (const run of cellRuns) {
          for (const event of run.events) {
            if (!behaviorMatcher(b.id, event)) continue;
            if (event.source === 'ch') ch = true;
            else if (event.source === 'roundtable') rt = true;
            // Short-circuit when both flipped — nothing more to learn.
            if (ch && rt) break;
          }
          if (ch && rt) break;
        }
        cells[key] = {
          ch,
          rt,
          intended: null, // future: operator-asserted ground truth from manifest
          runs: cellRuns.length,
        };
      }
    }
    return {
      behavior: b.id,
      description: b.description,
      cells,
    };
  });

  return {
    scenarios: SCENARIOS,
    guardConfigs: GUARD_CONFIGS,
    rows,
  };
}

function cellKey(scenario, guards) {
  return `${scenario}|${guards}`;
}

/**
 * Render the matrix as a GitHub-flavored markdown table.
 *
 * Columns: one per (scenario, guards) pair, 15 in total.
 * Cell:    "CH ✓/✗ / RT ✓/✗ (N runs)", or "— (0 runs)" when sparse.
 */
export function renderMatrixMarkdown(matrix) {
  const headers = ['Behavior'];
  for (const s of matrix.scenarios) {
    for (const g of matrix.guardConfigs) {
      headers.push(`${s} | ${g}`);
    }
  }

  const escapePipe = (s) => String(s).replace(/\|/g, '\\|');
  const headerRow = `| ${headers.map(escapePipe).join(' | ')} |`;
  const sepRow = `|${headers.map(() => '---').join('|')}|`;

  const bodyRows = matrix.rows.map((row) => {
    const cells = [row.behavior];
    for (const s of matrix.scenarios) {
      for (const g of matrix.guardConfigs) {
        const c = row.cells[cellKey(s, g)];
        cells.push(formatCell(c));
      }
    }
    return `| ${cells.map(escapePipe).join(' | ')} |`;
  });

  return [headerRow, sepRow, ...bodyRows].join('\n');
}

function formatCell(cell) {
  if (cell.runs === 0) return `— (0 runs)`;
  const ch = cell.ch ? '✓' : '✗';
  const rt = cell.rt ? '✓' : '✗';
  return `CH ${ch} / RT ${rt} (${cell.runs} runs)`;
}
