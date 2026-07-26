import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'fs';

describe('CLI integration', () => {
  const outputDir = 'tests/cli/output';

  before(async () => {
    const { run } = await import('../../src/cli/report.js');
    await run(['report', '--config', 'tests/cli/fixtures/test-config.json', '--data', 'tests/cli/fixtures', '--output', outputDir, '--no-visuals']);
  });

  after(() => { rmSync(outputDir, { recursive: true, force: true }); });

  it('creates summary.csv with correct row count', () => {
    const csv = readFileSync(`${outputDir}/summary.csv`, 'utf8');
    const rows = csv.trim().split('\n');
    // header + 2 participants (clean + suspicious)
    assert.equal(rows.length, 3);
  });

  it('creates triage.md', () => {
    assert.ok(existsSync(`${outputDir}/triage.md`));
  });

  it('creates event-log.csv', () => {
    assert.ok(existsSync(`${outputDir}/event-log.csv`));
    const csv = readFileSync(`${outputDir}/event-log.csv`, 'utf8');
    const rows = csv.trim().split('\n');
    // header + 2 paste events from suspicious participant
    assert.ok(rows.length >= 3, `Expected at least 3 rows, got ${rows.length}`);
  });

  it('creates extensions.csv', () => {
    assert.ok(existsSync(`${outputDir}/extensions.csv`));
  });

  it('ranks suspicious participant above clean', () => {
    const md = readFileSync(`${outputDir}/triage.md`, 'utf8');
    const susIdx = md.indexOf('P-SUS');
    const cleanIdx = md.indexOf('P-CLEAN');
    assert.ok(susIdx < cleanIdx, 'Suspicious participant should be ranked first');
  });
});
