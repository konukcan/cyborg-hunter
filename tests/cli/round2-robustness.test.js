// CLI ingest/analyzer robustness.
// Every fix here is a no-op on well-formed data; these tests exercise the
// malformed/misconfigured paths that used to fail silently or crash the
// whole run.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractIntegrityData, ingest } from '../../src/cli/ingest.js';
import { findUnmatchedPhaseScopePhases } from '../../src/cli/analyzers/phase-scope.js';
import { cliConfigWarnings } from '../../src/cli/config.js';

const cfg = { integrityField: 'integrity', participantIdField: 'participantId' };

describe('F3 — Shape-2 (responses) must not clobber extracted Shape-1 (trials)', () => {
  it('keeps integrity trials when a payload has BOTH trials and responses', () => {
    const raw = {
      participantId: 'P',
      trials: [{ integrity: { trialId: 't1', pasteEvents: [{ t: 1 }], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 5, trialSignals: {} } }],
      responses: [{ answer: 'yes' }],
    };
    const r = extractIntegrityData(raw, cfg);
    assert.equal(r.trials.length, 1);
    assert.equal(r.trials[0].pasteEvents.length, 1, 'the paste-bearing integrity trial must survive');
  });

  it('a stray empty responses[] does not wipe a real participant', () => {
    const raw = {
      participantId: 'P',
      trials: [{ integrity: { trialId: 't1', pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} } }],
      responses: [],
    };
    const r = extractIntegrityData(raw, cfg);
    assert.equal(r.trials.length, 1, 'responses:[] must not drop the participant');
  });

  it('still ingests a pure Shape-2 payload (no trials key)', () => {
    const raw = { metadata: { participantId: 'P' }, responses: [{ ruleId: 'r1', mouseTrack: [{ x: 1, y: 2, t: 0 }] }] };
    const r = extractIntegrityData(raw, cfg);
    assert.equal(r.trials.length, 1, 'legacy responses-only data still works');
  });
});

describe('F1 — a non-array signal field must not crash the run', () => {
  it('coerces a malformed array field to [] and warns', () => {
    const raw = {
      participantId: 'P',
      trials: [{ integrity: { trialId: 't1', pasteEvents: {}, copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} } }],
    };
    const r = extractIntegrityData(raw, cfg);
    assert.ok(Array.isArray(r.trials[0].pasteEvents), 'pasteEvents coerced to an array');
    assert.equal(r.trials[0].pasteEvents.length, 0);
    assert.ok(r.warnings.some(w => /pasteEvents/.test(w) && /array/i.test(w)),
      `expected a coercion warning, got:\n${r.warnings.join('\n')}`);
  });
});

describe('F1b (re-review) — array coercion must not mutate caller-owned/frozen objects', () => {
  it('coerces a Shape-3 trial without throwing on a frozen integrity object', () => {
    const integrity = Object.freeze({ trialId: 't1', pasteEvents: {}, copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} });
    const raw = [{ integrity }]; // Shape 3: top-level array of trials
    let r;
    assert.doesNotThrow(() => { r = extractIntegrityData(raw, cfg); });
    assert.ok(Array.isArray(r.trials[0].pasteEvents), 'coerced to an array');
    assert.deepEqual(integrity.pasteEvents, {}, 'the caller\'s frozen object must be left untouched');
  });
});

describe('F5 — an unresolved participantId must warn, not silently become "unknown"', () => {
  it('warns when the id field resolves to nothing', () => {
    const raw = { subject_ID: 'P1', trials: [{ integrity: { trialId: 't1', pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} } }] };
    const r = extractIntegrityData(raw, { integrityField: 'integrity', participantIdField: 'participantId' });
    assert.equal(r.participantId, 'unknown');
    assert.ok(r.warnings.some(w => /participant/i.test(w) && /unknown/.test(w)),
      `expected an unresolved-participantId warning, got:\n${r.warnings.join('\n')}`);
  });
});

describe('F2 — a numeric trialId must not crash string handling', () => {
  it('carries a numeric trialId through ingest without throwing downstream', () => {
    // The trajectories renderer calls trialId.substring(); the fix wraps it in
    // String(). We assert ingest keeps the trial (no crash) and that a String()
    // of the resulting id is safe.
    const raw = { participantId: 'P', trials: [{ integrity: { trialId: 123, pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} } }] };
    const r = extractIntegrityData(raw, cfg);
    assert.equal(r.trials.length, 1);
    assert.doesNotThrow(() => String(r.trials[0].trialId).substring(0, 20));
  });
});

describe('candidate-3 — findGuardViolations must scan all trials, not lock onto the first truthy-but-empty one', () => {
  it('finds real violations on a later trial when earlier trials carry "[]"', () => {
    const raw = {
      participantId: 'P',
      trials: [
        { integrity: { trialId: 't1', pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} }, guard_assistance_violations_session: '[]' },
        { integrity: { trialId: 't2', pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} }, guard_assistance_violations_session: '[{"reason":"sidebar_open","start":123,"duration":9}]' },
        { integrity: { trialId: 't3', pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} }, guard_assistance_violations_session: '[]' },
      ],
    };
    const r = extractIntegrityData(raw, cfg);
    assert.ok(r.guardFriction, 'guard lane synthesized from the honeypot log');
    assert.equal(r.guardFriction.violations.length, 1);
    assert.equal(r.guardFriction.violations[0].reason, 'sidebar_open');
  });

  it('uniform stamping (every trial identical) still resolves correctly', () => {
    const v = '[{"reason":"tab_hidden","start":5,"duration":3}]';
    const raw = {
      participantId: 'P',
      trials: [1, 2, 3].map(i => ({ integrity: { trialId: 't' + i, pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} }, guard_assistance_violations_session: v })),
    };
    const r = extractIntegrityData(raw, cfg);
    assert.equal(r.guardFriction.violations.length, 1);
    assert.equal(r.guardFriction.violations[0].reason, 'tab_hidden');
  });
});

describe('F4 — duplicate participant IDs across files must warn', () => {
  it('flags two files that resolve to the same participantId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch-dup-'));
    const mk = (n) => ({ participantId: 'DUP', trials: [{ integrity: { trialId: n, pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 0, trialSignals: {} } }] });
    writeFileSync(join(dir, 'a.json'), JSON.stringify(mk('t1')));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(mk('t2')));
    const { warnings } = await ingest({ dataDir: dir, filePattern: '*.json', integrityField: 'integrity', participantIdField: 'participantId' });
    const flat = warnings.flatMap(w => w.warnings || [w]);
    assert.ok(flat.some(w => /duplicate/i.test(w) && /DUP/.test(w)),
      `expected a duplicate-id warning, got:\n${JSON.stringify(warnings)}`);
  });
});

describe('F6 — a phaseScope phase that matches no trial must be reported', () => {
  it('detects a mistyped include phase', () => {
    const participants = [
      { trials: [{ phase: 'classification' }, { phase: 'gallery' }] },
      { trials: [{ phase: 'classification' }] },
    ];
    const unmatched = findUnmatchedPhaseScopePhases(participants, { include: ['clasification'] });
    assert.deepEqual(unmatched, ['clasification']);
  });

  it('returns [] when every configured phase is present', () => {
    const participants = [{ trials: [{ phase: 'classification' }, { phase: 'gallery' }] }];
    assert.deepEqual(findUnmatchedPhaseScopePhases(participants, { include: ['classification'], exclude: ['gallery'] }), []);
  });
});

describe('F7 — a non-numeric softScoreThreshold must warn', () => {
  it('warns on a string threshold', () => {
    const warnings = cliConfigWarnings({ scoring: { softScoreThreshold: 'six' } });
    assert.ok(warnings.some(w => /softScoreThreshold/.test(w)),
      `expected a softScoreThreshold warning, got:\n${warnings.join('\n')}`);
  });

  it('does not warn on a numeric threshold or when scoring is absent', () => {
    assert.equal(cliConfigWarnings({ scoring: { softScoreThreshold: 6 } }).length, 0);
    assert.equal(cliConfigWarnings({ scoring: null }).length, 0);
    assert.equal(cliConfigWarnings({}).length, 0);
  });
});
