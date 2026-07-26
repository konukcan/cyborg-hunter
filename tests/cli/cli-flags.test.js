import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseFlags, loadConfig } from '../../src/cli/config.js';

// Regression for the bug found in quillien-2a verification (April 2026):
// Passing --data-dir, --participant-id-field, --output-dir on the command
// line printed "Unknown argument: ..." and the CLI silently fell back to
// whatever cyborg-hunter.config.json was found in cwd. Easy footgun: you
// thought you were analyzing one dataset but were really analyzing another.

describe('CLI flag parsing', () => {
  it('accepts --data and --data-dir as aliases', () => {
    assert.equal(parseFlags(['--data', '/x']).data, '/x');
    assert.equal(parseFlags(['--data-dir', '/y']).data, '/y');
  });

  it('accepts --output and --output-dir as aliases', () => {
    assert.equal(parseFlags(['--output', '/x']).output, '/x');
    assert.equal(parseFlags(['--output-dir', '/y']).output, '/y');
  });

  it('accepts --participant-id-field, --file-pattern, --integrity-field', () => {
    const f = parseFlags([
      '--participant-id-field', 'subject_ID',
      '--file-pattern', '*.csv',
      '--integrity-field', 'integrity',
    ]);
    assert.equal(f.participantIdField, 'subject_ID');
    assert.equal(f.filePattern, '*.csv');
    assert.equal(f.integrityField, 'integrity');
  });

  it('accepts --participant (single-participant filter, distinct from id-field)', () => {
    assert.equal(parseFlags(['--participant', 'P001']).participant, 'P001');
  });

  it('throws on unknown flags (no more silent fallback to config)', () => {
    assert.throws(() => parseFlags(['--bogus', 'x']), /Unknown argument.*--bogus/);
    assert.throws(() => parseFlags(['--data-direction', '/x']), /Unknown argument/);
  });

  it('skips the "report" subcommand keyword', () => {
    assert.deepEqual(parseFlags(['report', '--data', '/x']), { data: '/x' });
  });

  it('loadConfig overrides config-file values with CLI flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch-cfg-'));
    writeFileSync(join(dir, 'cyborg-hunter.config.json'), JSON.stringify({
      dataDir: '/from/file', outputDir: '/from/file/out', participantIdField: 'fileField',
    }));
    try {
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const cfg = loadConfig([
          '--data-dir', '/from/cli',
          '--participant-id-field', 'cliField',
        ]);
        assert.match(cfg.dataDir, /\/from\/cli$/, 'CLI --data-dir should win over config file');
        assert.equal(cfg.participantIdField, 'cliField');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 0.6.1 — retro item 7: --config-file alias (matches the --data-dir /
// --output-dir kebab convention; typing it used to hard-error), plus the new
// --session-integrity-path flag for the ingest knob.
describe('CLI flag parsing — 0.6.1 additions', () => {
  it('accepts --config and --config-file as aliases', () => {
    assert.equal(parseFlags(['--config', '/a.json']).config, '/a.json');
    assert.equal(parseFlags(['--config-file', '/b.json']).config, '/b.json');
  });

  it('accepts --session-integrity-path', () => {
    const f = parseFlags(['--session-integrity-path', 'payload.cyborgHunter']);
    assert.equal(f.sessionIntegrityPath, 'payload.cyborgHunter');
  });
});
