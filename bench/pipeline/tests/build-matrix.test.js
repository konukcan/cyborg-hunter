// build-matrix.test.js
//
// Tests for bench/pipeline/build-matrix.js — the 3-D coverage matrix builder
// that joins (runs × scenarios × guards) against the behavior taxonomy and
// emits a structured matrix + markdown renderer.
//
// Run: node --test bench/pipeline/tests/build-matrix.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildMatrix,
  renderMatrixMarkdown,
  SCENARIOS,
  GUARD_CONFIGS,
} from '../build-matrix.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TAXONOMY_PATH = join(REPO_ROOT, 'bench', 'pipeline', 'taxonomy.json');
const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));
const ALL_BEHAVIORS = taxonomy.behaviors.map((b) => b.id);

// Helper: build a CommonEvent-ish object for tests.
function ev(type, { source = 'ch', payload = {}, t_ms = 0 } = {}) {
  return { t_ms, type, source, trialId: null, payload };
}

// ---------- Test 1: empty input ----------
test('buildMatrix: empty runs array → 29 rows, all cells empty', () => {
  const matrix = buildMatrix([]);
  assert.deepEqual(matrix.scenarios, SCENARIOS);
  assert.deepEqual(matrix.guardConfigs, GUARD_CONFIGS);
  assert.equal(matrix.rows.length, ALL_BEHAVIORS.length, 'one row per taxonomy behavior');
  assert.equal(matrix.rows.length, 29, '29 behaviors expected');

  for (const row of matrix.rows) {
    const cellKeys = Object.keys(row.cells);
    assert.equal(cellKeys.length, SCENARIOS.length * GUARD_CONFIGS.length, '15 cells per row');
    for (const cell of Object.values(row.cells)) {
      assert.equal(cell.ch, false);
      assert.equal(cell.rt, false);
      assert.equal(cell.intended, null);
      assert.equal(cell.runs, 0);
    }
  }
});

// ---------- Test 2: single run with paste in (bot-playwright, none) ----------
test('buildMatrix: single paste in (bot-playwright, none) → only that cell flips ch=true', () => {
  const runs = [
    {
      runId: 'r1',
      scenario: 'bot-playwright',
      guards: 'none',
      events: [ev('paste', { source: 'ch' })],
    },
  ];
  const matrix = buildMatrix(runs);
  const pasteRow = matrix.rows.find((r) => r.behavior === 'paste');
  assert.ok(pasteRow, 'paste row exists');

  const targetCell = pasteRow.cells['bot-playwright|none'];
  assert.equal(targetCell.ch, true);
  assert.equal(targetCell.rt, false);
  assert.equal(targetCell.runs, 1);

  // every other cell in the paste row must be empty
  for (const [key, cell] of Object.entries(pasteRow.cells)) {
    if (key === 'bot-playwright|none') continue;
    assert.equal(cell.ch, false, `cell ${key} should be ch=false`);
    assert.equal(cell.rt, false, `cell ${key} should be rt=false`);
    assert.equal(cell.runs, 0, `cell ${key} should have 0 runs`);
  }

  // every non-paste row must be entirely empty
  for (const row of matrix.rows) {
    if (row.behavior === 'paste') continue;
    for (const cell of Object.values(row.cells)) {
      assert.equal(cell.ch, false);
      assert.equal(cell.rt, false);
    }
  }
});

// ---------- Test 3: two runs same cell, mixed sources ----------
test('buildMatrix: two runs in same cell with CH + RT pastes → ch=true, rt=true, runs=2', () => {
  const runs = [
    {
      runId: 'r1',
      scenario: 'cyborg-paste',
      guards: 'friction',
      events: [ev('paste', { source: 'ch' })],
    },
    {
      runId: 'r2',
      scenario: 'cyborg-paste',
      guards: 'friction',
      events: [ev('paste', { source: 'roundtable' })],
    },
  ];
  const matrix = buildMatrix(runs);
  const cell = matrix.rows.find((r) => r.behavior === 'paste').cells['cyborg-paste|friction'];
  assert.equal(cell.ch, true);
  assert.equal(cell.rt, true);
  assert.equal(cell.runs, 2);
});

// ---------- Test 4: behavior with no matching events ----------
test('buildMatrix: behavior not detected by any event → all cells stay false', () => {
  const runs = [
    {
      runId: 'r1',
      scenario: 'clean-human',
      guards: 'full',
      events: [ev('paste', { source: 'ch' }), ev('click', { source: 'ch' })],
    },
  ];
  const matrix = buildMatrix(runs);
  const copyRow = matrix.rows.find((r) => r.behavior === 'copy');
  for (const cell of Object.values(copyRow.cells)) {
    assert.equal(cell.ch, false);
    assert.equal(cell.rt, false);
  }
  // but the cell still counts the run
  assert.equal(copyRow.cells['clean-human|full'].runs, 1);
});

// ---------- Test 5: markdown renderer ----------
test('renderMatrixMarkdown: contains header, all 29 behaviors, all 15 columns, cell pattern', () => {
  const matrix = buildMatrix([
    {
      runId: 'r1',
      scenario: 'bot-playwright',
      guards: 'friction',
      events: [ev('paste', { source: 'ch' })],
    },
  ]);
  const md = renderMatrixMarkdown(matrix);

  assert.ok(md.includes('Behavior'), 'header has "Behavior" label');

  // every behavior id appears as a row
  for (const bid of ALL_BEHAVIORS) {
    assert.ok(md.includes(bid), `markdown should contain behavior id "${bid}"`);
  }

  // every column header (scenario | guard) appears — pipes are escaped in
  // markdown table cells, so the literal substring is "<s> \| <g>".
  for (const s of SCENARIOS) {
    for (const g of GUARD_CONFIGS) {
      assert.ok(
        md.includes(`${s} \\| ${g}`),
        `column header "${s} \\| ${g}" missing`,
      );
    }
  }

  // cell format: filled cell uses CH ✓/✗ / RT ✓/✗ (N runs)
  assert.match(md, /CH ✓ \/ RT ✗ \(1 runs\)/, 'should render a filled paste cell with CH ✓');
  // empty cell pattern
  assert.match(md, /— \(0 runs\)/, 'should render empty cells as em-dash');
});

// ---------- Test 6: custom matcher for derived behavior ----------
test('buildMatrix: custom matcher fires on tab_away + payload.duration_ms < 10000 → tab_away_short cell flips', () => {
  const matcher = (behaviorId, event) => {
    if (behaviorId === 'tab_away_short') {
      return event.type === 'tab_away' && (event.payload?.duration_ms ?? Infinity) < 10000;
    }
    if (behaviorId === 'tab_away_long') {
      return event.type === 'tab_away' && (event.payload?.duration_ms ?? 0) >= 10000;
    }
    return event.type === behaviorId;
  };

  const runs = [
    {
      runId: 'r1',
      scenario: 'cyborg-no-paste',
      guards: 'none',
      events: [ev('tab_away', { source: 'ch', payload: { duration_ms: 4200 } })],
    },
  ];
  const matrix = buildMatrix(runs, matcher);

  const shortCell = matrix.rows
    .find((r) => r.behavior === 'tab_away_short')
    .cells['cyborg-no-paste|none'];
  assert.equal(shortCell.ch, true, 'tab_away_short should fire on duration_ms=4200');
  assert.equal(shortCell.rt, false);
  assert.equal(shortCell.runs, 1);

  // tab_away_long should NOT fire for this run
  const longCell = matrix.rows
    .find((r) => r.behavior === 'tab_away_long')
    .cells['cyborg-no-paste|none'];
  assert.equal(longCell.ch, false);
  assert.equal(longCell.rt, false);
});

// ---------- Bonus: purity check ----------
test('buildMatrix: does not mutate input runs', () => {
  const runs = [
    {
      runId: 'r1',
      scenario: 'bot-playwright',
      guards: 'none',
      events: [ev('paste', { source: 'ch' })],
    },
  ];
  const snapshot = JSON.parse(JSON.stringify(runs));
  buildMatrix(runs);
  assert.deepEqual(runs, snapshot, 'input runs should be untouched');
});
