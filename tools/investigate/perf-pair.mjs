#!/usr/bin/env node
// tools/investigate/perf-pair.mjs
//
// Paired control-vs-treatment driver around capture-perf-baseline.mjs (T3 Task 9b).
//
// WHY THIS EXISTS. Task 0 recorded ABSOLUTE budgets. Task 4 then showed they do
// not transfer across sessions: the same v1 code measured 0.066 ms/keystroke
// against a 0.059 budget recorded hours earlier, on a machine whose load had
// moved. So the T3 gate is a comparison, not a constant:
//
//   * CONTROL   = a dist built from a pinned PRE-REWRITE ref, on its own copy
//                 of the page.
//   * TREATMENT = the current dist, on a byte-identical copy of the same page.
//   * INTERLEAVED, one run each, alternating — Task 4's A/B was block-ordered
//                 and a monotone load trend inside each block was visible in
//                 the numbers.
//   * Gate on the MEDIAN of the per-run values, not the worst run: the
//     worst-run statistic is unstable WITHIN a single session (Task 4 review).
//
// The budget multiple stays Task 0's 1.25x, applied to the control median
// measured in THIS session.
//
// USAGE
//   node tools/investigate/perf-pair.mjs \
//     --control=scratch/t9/pair/control/demo-standalone.html \
//     --treatment=scratch/t9/pair/treatment/demo-standalone.html \
//     --pairs=5 --out-dir=scratch/t9/artifacts -- --inflated-typing --runs=1
//
// Everything after `--` is passed through to the harness verbatim.
// Exit code: 0 when every gated scenario is within budget, 1 otherwise (or on
// a harness failure). A harness SKIP (no browser) propagates as a skip.

import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const HARNESS = join(here, 'capture-perf-baseline.mjs');

const argv = process.argv.slice(2);
const passThroughAt = argv.indexOf('--');
const own = passThroughAt === -1 ? argv : argv.slice(0, passThroughAt);
const passThrough = passThroughAt === -1 ? [] : argv.slice(passThroughAt + 1);
function opt(name, dflt) {
  const hit = own.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  if (hit === '--' + name) return true;
  const raw = hit.slice(name.length + 3);
  return typeof dflt === 'number' ? Number(raw) : raw;
}
const CFG = {
  control: String(opt('control', '')),
  treatment: String(opt('treatment', '')),
  pairs: Number(opt('pairs', 5)),
  outDir: String(opt('out-dir', 'scratch/perf-pair')),
  budgetMultiple: Number(opt('budget', 1.25)),
};
if (!CFG.control || !CFG.treatment) {
  console.error('usage: perf-pair.mjs --control=<page> --treatment=<page> [--pairs=N] [--out-dir=D] [-- <harness args>]');
  process.exit(2);
}

const outDir = resolve(repoRoot, CFG.outDir);
await mkdir(outDir, { recursive: true });

function runHarness(page, outPath) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath,
      [HARNESS, '--page=' + page, '--out=' + outPath, ...passThrough],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.on('close', (code) => {
      if (code !== 0) return rej(new Error('harness exited ' + code + ' for ' + page + '\n' + stdout));
      if (/^SKIP:/m.test(stdout)) return rej(new Error('SKIP'));
      res(stdout);
    });
    child.on('error', rej);
  });
}

const artifacts = { control: [], treatment: [] };
for (let i = 0; i < CFG.pairs; i++) {
  for (const arm of ['control', 'treatment']) {
    const outPath = join(outDir, arm + '-' + String(i + 1).padStart(2, '0') + '.json');
    process.stdout.write('▶ pair ' + (i + 1) + '/' + CFG.pairs + ' ' + arm.padEnd(9) + ' … ');
    try {
      await runHarness(CFG[arm], outPath);
    } catch (e) {
      if (e.message === 'SKIP') {
        console.log('\nSKIP: harness reports no browser — nothing measured.');
        process.exit(0);
      }
      console.error('FAILED\n' + e.message);
      process.exit(1);
    }
    artifacts[arm].push(JSON.parse(await readFile(outPath, 'utf8')));
    console.log('done');
  }
}

// ── aggregate ──────────────────────────────────────────────────────────────
// Each artifact carries ONE run (the caller passes --runs=1), so `perRunP95`
// and `aggPerRun` have a single entry; the median is taken ACROSS pairs.
const med = (a) => {
  const s = a.filter((v) => v != null && Number.isFinite(v)).slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const ms = (v) => (v == null ? '—' : v.toFixed(3));

const names = new Set();
for (const arm of ['control', 'treatment']) {
  for (const a of artifacts[arm]) for (const n of Object.keys(a.summary)) names.add(n);
}

const rows = [];
for (const name of names) {
  const pick = (arm, path) => artifacts[arm].map((a) => {
    const s = a.summary[name];
    if (!s) return null;
    return path === 'p95' ? s.perRunP95[0]
      : path === 'p50' ? s.perRunP50[0]
      : (s.aggPerRun ? s.aggPerRun[0] : null);
  });
  const gated = artifacts.treatment.some((a) => a.summary[name] && a.summary[name].gated);
  const row = {
    name, gated,
    controlP95: med(pick('control', 'p95')), treatmentP95: med(pick('treatment', 'p95')),
    controlP50: med(pick('control', 'p50')), treatmentP50: med(pick('treatment', 'p50')),
    controlAgg: med(pick('control', 'agg')), treatmentAgg: med(pick('treatment', 'agg')),
    controlRuns: pick('control', 'p95'), treatmentRuns: pick('treatment', 'p95'),
  };
  row.p95Ratio = row.controlP95 > 0 ? row.treatmentP95 / row.controlP95 : null;
  row.aggRatio = row.controlAgg > 0 ? row.treatmentAgg / row.controlAgg : null;
  // A scenario the CONTROL cannot produce (v1 keyframes every boundary, so it
  // has no continuation population) has no paired baseline. Reported, never
  // gated — inventing a budget for it would be a number with no control.
  row.comparable = row.controlP95 != null && row.treatmentP95 != null;
  rows.push(row);
}
rows.sort((a, b) => a.name.localeCompare(b.name));

const failures = [];
for (const r of rows) {
  if (!r.gated || !r.comparable) continue;
  if (r.p95Ratio != null && r.p95Ratio > CFG.budgetMultiple) {
    failures.push(r.name + ' p95 ' + ms(r.treatmentP95) + ' vs control ' + ms(r.controlP95)
      + ' (' + r.p95Ratio.toFixed(2) + 'x, budget ' + CFG.budgetMultiple + 'x)');
  }
  if (r.aggRatio != null && r.aggRatio > CFG.budgetMultiple) {
    failures.push(r.name + ' AGG ' + ms(r.treatmentAgg) + ' vs control ' + ms(r.controlAgg)
      + ' (' + r.aggRatio.toFixed(2) + 'x, budget ' + CFG.budgetMultiple + 'x)');
  }
}

console.log('\n══ paired capture perf gate ══');
console.log('control   : ' + CFG.control);
console.log('treatment : ' + CFG.treatment);
console.log('pairs     : ' + CFG.pairs + ' interleaved, gate = treatment MEDIAN <= control MEDIAN x '
  + CFG.budgetMultiple);
console.log('harness   : ' + (passThrough.join(' ') || '(defaults)'));
console.log('load      : ' + artifacts.control.map((a) => a.runs[0].loadavg[0]).join(', ') + ' (control) / '
  + artifacts.treatment.map((a) => a.runs[0].loadavg[0]).join(', ') + ' (treatment)');
console.log('');
console.log('scenario                                  ctl p95  trt p95   ratio |  ctl agg  trt agg   ratio  verdict');
for (const r of rows) {
  const verdict = !r.gated ? 'info'
    : !r.comparable ? 'no control'
    : (r.p95Ratio != null && r.p95Ratio > CFG.budgetMultiple)
      || (r.aggRatio != null && r.aggRatio > CFG.budgetMultiple) ? 'FAIL' : 'pass';
  console.log('  ' + r.name.padEnd(38)
    + ms(r.controlP95).padStart(8) + ms(r.treatmentP95).padStart(9)
    + (r.p95Ratio == null ? '      —' : (r.p95Ratio.toFixed(2) + 'x').padStart(8)) + ' |'
    + ms(r.controlAgg).padStart(9) + ms(r.treatmentAgg).padStart(9)
    + (r.aggRatio == null ? '      —' : (r.aggRatio.toFixed(2) + 'x').padStart(8))
    + '  ' + verdict);
}
console.log('\nper-pair p95 (control | treatment):');
for (const r of rows) {
  console.log('  ' + r.name.padEnd(38)
    + r.controlRuns.map((v) => ms(v)).join(' ') + '  |  ' + r.treatmentRuns.map((v) => ms(v)).join(' '));
}

const summaryPath = join(outDir, 'paired-summary.json');
await mkdir(dirname(summaryPath), { recursive: true });
const { writeFile } = await import('node:fs/promises');
await writeFile(summaryPath, JSON.stringify({ config: CFG, passThrough, rows, failures }, null, 2));
console.log('\npaired summary: ' + summaryPath);

if (failures.length) {
  console.error('\n✖ PERF GATE FAILURES');
  for (const f of failures) console.error('    ' + f);
  process.exit(1);
}
console.log('\n✔ every gated, comparable scenario is within ' + CFG.budgetMultiple + 'x of its same-session control');
