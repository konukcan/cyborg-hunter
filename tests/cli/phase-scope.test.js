// 0.6.1 — retro item 10: config.phaseScope lets integrity scores honor
// pre-registered phase scoping (e.g. counting classification-phase
// signals only; before this, CH triage always scored the whole session).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { applyPhaseScope, describePhaseScope } from '../../src/cli/analyzers/phase-scope.js';
import { computeParticipantSummary } from '../../src/cli/analyzers/summary.js';

const trial = (phase, extras = {}) => ({
  trialId: `t-${phase}-${Math.random().toString(36).slice(2, 6)}`,
  phase,
  pasteEvents: [], copyEvents: [], dropEvents: [],
  tabAwayEvents: [], trialSoftScore: 0,
  ...extras,
});

describe('applyPhaseScope', () => {
  const participants = [{
    participantId: 'P1',
    trials: [trial('gallery'), trial('classification'), trial('classification'), trial('end_requery')],
  }];

  it('returns the SAME array when no scope is configured (byte-identical pipeline)', () => {
    assert.strictEqual(applyPhaseScope(participants, null), participants);
    assert.strictEqual(applyPhaseScope(participants, {}), participants);
    assert.strictEqual(applyPhaseScope(participants, { include: [], exclude: [] }), participants);
  });

  it('include keeps only the listed phases', () => {
    const [p] = applyPhaseScope(participants, { include: ['classification'] });
    assert.equal(p.trials.length, 2);
    assert.ok(p.trials.every(t => t.phase === 'classification'));
    assert.equal(p.phaseScoped, true);
  });

  it('exclude removes the listed phases', () => {
    const [p] = applyPhaseScope(participants, { exclude: ['gallery', 'end_requery'] });
    assert.equal(p.trials.length, 2);
    assert.ok(p.trials.every(t => t.phase === 'classification'));
  });

  it('a trial without a phase field counts as "default"', () => {
    const noPhase = [{ participantId: 'P2', trials: [trial('gallery'), { trialId: 'bare', pasteEvents: [] }] }];
    const [inc] = applyPhaseScope(noPhase, { include: ['default'] });
    assert.equal(inc.trials.length, 1);
    assert.equal(inc.trials[0].trialId, 'bare');
    const [exc] = applyPhaseScope(noPhase, { exclude: ['default'] });
    assert.equal(exc.trials.length, 1);
    assert.equal(exc.trials[0].phase, 'gallery');
  });

  it('describePhaseScope names the active lists', () => {
    assert.equal(describePhaseScope({ include: ['classification'] }), 'include=[classification]');
    assert.equal(describePhaseScope({ exclude: ['gallery', 'erq'] }), 'exclude=[gallery, erq]');
  });
});

describe('phase-scoped participant summary', () => {
  it('ignores whole-session tabAwaySums and bins per-trial events from scoped trials', () => {
    const participants = [{
      participantId: 'P3',
      trials: [
        trial('gallery', { tabAwayEvents: [{ start: 1, duration_ms: 20000 }] }),
        trial('classification', { tabAwayEvents: [{ start: 2, duration_ms: 5000 }] }),
      ],
      session: { tabAwaySums: [20000, 5000, 7000, 100] },  // whole session
    }];
    const [scoped] = applyPhaseScope(participants, { include: ['classification'] });
    const s = computeParticipantSummary(scoped, {});
    assert.equal(s.totalTabAways, 1, 'only the classification-phase tab-away counts');
    assert.equal(s.tabAwayMediumCount, 1);
    assert.equal(s.tabAwayLongCount, 0);
    // Unscoped control: session sums drive the counts.
    const unscoped = computeParticipantSummary(participants[0], {});
    assert.equal(unscoped.totalTabAways, 4);
  });

  it('nulls the whole-session authoritative soft score so the scoped per-trial sum flags', () => {
    const participants = [{
      participantId: 'P4',
      trials: [
        trial('gallery', { trialSoftScore: 8 }),
        trial('classification', { trialSoftScore: 1 }),
      ],
      score: { softScore: 9, softScoreThreshold: 6, anyHardTriggered: false },
    }];
    const [scoped] = applyPhaseScope(participants, { include: ['classification'] });
    const s = computeParticipantSummary(scoped, {});
    assert.equal(s.authoritativeSoftScore, null);
    assert.equal(s.totalSoftScore, 1, 'scoped per-trial sum excludes the gallery-phase score');
    assert.equal(s.softScoreThreshold, 6, 'the participant threshold itself is kept');
  });

  it('re-derives the hard flag from raw counts inside the scope', () => {
    const pasteTrial = (phase, nPastes) => trial(phase, {
      pasteEvents: Array.from({ length: nPastes }, (_, i) => ({ t: i })),
      trialSignals: { hard: { paste: { trialHits: nPastes, sessionTotal: 99, countThreshold: 2 } } },
    });
    // Both pastes happened in the gallery phase → scoped-to-classification
    // must NOT hard-flag, even though sessionTotal (whole session) is over.
    const galleryPastes = [{
      participantId: 'P5',
      trials: [pasteTrial('gallery', 2), pasteTrial('classification', 0)],
      score: { anyHardTriggered: true, softScore: 0, softScoreThreshold: 6 },
    }];
    const [scopedOut] = applyPhaseScope(galleryPastes, { include: ['classification'] });
    assert.equal(computeParticipantSummary(scopedOut, {}).hardTriggered, false);

    // Pastes inside the scope still flag.
    const classPastes = [{
      participantId: 'P6',
      trials: [pasteTrial('classification', 2)],
      score: { anyHardTriggered: true, softScore: 0, softScoreThreshold: 6 },
    }];
    const [scopedIn] = applyPhaseScope(classPastes, { include: ['classification'] });
    assert.equal(computeParticipantSummary(scopedIn, {}).hardTriggered, true);
  });
});
