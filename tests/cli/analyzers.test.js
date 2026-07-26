import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeParticipantSummary } from '../../src/cli/analyzers/summary.js';
import { detectEdgeExitForTrial } from '../../src/cli/analyzers/edge-exit.js';
import { generateTriageReason, rankTriage } from '../../src/cli/analyzers/triage.js';

describe('summary', () => {
  it('aggregates paste events across trials', () => {
    const participant = {
      participantId: 'P001',
      trials: [
        { pasteEvents: [{ t: 100 }], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 1 },
        { pasteEvents: [{ t: 200 }, { t: 300 }], copyEvents: [], dropEvents: [], tabAwayEvents: [], trialSoftScore: 2 }
      ]
    };
    const summary = computeParticipantSummary(participant, {});
    assert.equal(summary.totalPasteEvents, 3);
    assert.equal(summary.totalSoftScore, 3);
  });

  it('hard-flag fallback fires when cumulative sessionTotal crosses countThreshold', () => {
    const participant = {
      participantId: 'P1',
      trials: [
        { trialSignals: { hard: { paste: { trialHits: 1, sessionTotal: 1, countThreshold: 2 } } } },
        { trialSignals: { hard: { paste: { trialHits: 1, sessionTotal: 2, countThreshold: 2 } } } }, // crosses
      ],
      metadata: {}
    };
    const summary = computeParticipantSummary(participant, {});
    assert.equal(summary.hardTriggered, true);
  });

  it('hard-flag fallback does NOT fire when sessionTotal stays below threshold', () => {
    // A single paste (sessionTotal 1) with threshold 2 is not a hard trigger;
    // the old trialHits>0 fallback wrongly flagged this as hard.
    const participant = {
      participantId: 'P1',
      trials: [
        { trialSignals: { hard: { paste: { trialHits: 1, sessionTotal: 1, countThreshold: 2 } } } },
        { trialSignals: { hard: { paste: { trialHits: 0, sessionTotal: 1, countThreshold: 2 } } } },
      ],
      metadata: {}
    };
    const summary = computeParticipantSummary(participant, {});
    assert.equal(summary.hardTriggered, false, '1 paste < threshold 2 is not hard');
  });

  it('bins tab-aways with a strict (>) cutoff matching the runtime soft-score rule', () => {
    const participant = {
      participantId: 'P1',
      trials: [
        { pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [
          { duration_ms: 500 },    // flicker
          { duration_ms: 2999 },   // flicker (just under 3s)
          { duration_ms: 3000 },   // flicker — exactly at cutoff: NOT scored (runtime uses >)
          { duration_ms: 3001 },   // medium — just over cutoff
          { duration_ms: 9999 },   // medium
          { duration_ms: 10000 },  // long (exactly at 10s display split)
          { duration_ms: 25000 },  // long
        ]}
      ]
    };
    const s = computeParticipantSummary(participant, {});
    assert.equal(s.totalTabAways, 7);
    assert.equal(s.tabAwayFlickerCount, 3, '500, 2999, and exactly 3000 are all flicker');
    assert.equal(s.tabAwayMediumCount, 2, '3001 and 9999');
    assert.equal(s.tabAwayLongCount, 2, '10000 and 25000');
  });

  // Regression for the runtime↔CLI tab-away contract: a tab-away exactly at the
  // cutoff must be treated identically by scoring (>) and the CLI bins (<= cutoff
  // => flicker). Covers both the 3000ms default and the 5000ms strict cutoff.
  it('a tab-away exactly at the cutoff is a flicker, not a meaningful tab-away', () => {
    const at3000 = computeParticipantSummary({
      participantId: 'P', trials: [{ tabAwayEvents: [{ duration_ms: 3000 }, { duration_ms: 3001 }] }]
    }, {});
    assert.equal(at3000.tabAwayFlickerCount, 1, '3000 == default cutoff => flicker');
    assert.equal(at3000.tabAwayMediumCount, 1, '3001 => medium');

    const at5000 = computeParticipantSummary({
      participantId: 'P',
      trials: [{ tabAwayEvents: [{ duration_ms: 5000 }, { duration_ms: 5001 }] }],
      session: { config: { thresholds: { tabAwayDurationMs: 5000 } } }
    }, {});
    assert.equal(at5000.tabAwayFlickerCount, 1, '5000 == strict cutoff => flicker');
    assert.equal(at5000.tabAwayMediumCount, 1, '5001 => medium');
  });

  it('flicker cutoff follows config.thresholds.tabAwayDurationMs when set', () => {
    const participant = {
      participantId: 'P1',
      trials: [{ pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [
        { duration_ms: 4000 },   // flicker under a 5s scoring cutoff
        { duration_ms: 6000 },   // medium
        { duration_ms: 12000 },  // long
      ]}]
    };
    const s = computeParticipantSummary(participant, { thresholds: { tabAwayDurationMs: 5000 } });
    assert.equal(s.tabAwayFlickerCount, 1);
    assert.equal(s.tabAwayMediumCount, 1);
    assert.equal(s.tabAwayLongCount, 1);
  });

  it('bins tab-aways using the participant saved tabAwayDurationMs (strict preset)', () => {
    // The library screened this participant at a 5s cutoff (saved in
    // session.config.thresholds). The report must bin at 5s, not the 3s default.
    const participant = {
      participantId: 'P1',
      trials: [{ pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [] }],
      session: {
        tabAwaySums: [4000, 6000, 12000],
        config: { preset: 'strict', thresholds: { tabAwayDurationMs: 5000, typingSpeedCps: 8 } },
      },
    };
    const s = computeParticipantSummary(participant, {});
    assert.equal(s.tabAwayFlickerCount, 1, '4000 < 5000 saved cutoff => flicker');
    assert.equal(s.tabAwayMediumCount, 1, '6000 in [5000,10000) => medium');
    assert.equal(s.tabAwayLongCount, 1, '12000 >= 10000 => long');
    assert.equal(s.preset, 'strict', 'surfaces the saved runtime preset');
  });

  it('computeParticipantSummary prefers session.integrityScore.anyHardTriggered when present', () => {
    const participant = {
      participantId: 'P1',
      trials: [{ trialSignals: { hard: { paste: { trialHits: 0 } } } }], // per-trial says no
      // Two open cycles (each opened+closed) — sidebarEventCount counts opens, so 2.
      session: { pasteCount: 3, sidebarEvents: [
        { type: 'opened' }, { type: 'closed' }, { type: 'opened' }, { type: 'closed' }
      ], aiExtensionsFound: [{name: 'X'}] },
      score: { anyHardTriggered: true, hardScore: { paste: {count:3, threshold:2, triggered:true} }, softScore: 80 },
      metadata: {}
    };
    const s = computeParticipantSummary(participant, {});
    assert.equal(s.hardTriggered, true, 'session.score.anyHardTriggered should win');
    assert.equal(s.sidebarEventCount, 2, 'counts open cycles (2 opens), not raw entries (4)');
    assert.deepEqual(s.aiExtensionsFound.map(e => e.name), ['X']);
    assert.equal(s.authoritativeSoftScore, 80);
  });

  it('counts one sidebar incident when both detection methods fire (same poll tick)', () => {
    const participant = {
      participantId: 'P1', trials: [{}],
      session: { sidebarEvents: [
        // One physical sidebar: innerWidth_delta + layout_compression both fire
        // at t=1000, then both close at t=5000.
        { type: 'opened', method: 'innerWidth_delta', t: 1000 },
        { type: 'opened', method: 'layout_compression', t: 1000 },
        { type: 'closed', method: 'innerWidth_delta', t: 5000 },
        { type: 'closed', method: 'layout_compression', t: 5000 },
      ] }, metadata: {}
    };
    const s = computeParticipantSummary(participant, {});
    assert.equal(s.sidebarEventCount, 1, 'two coincident opens = one opening');
  });

  it('counts two sidebar incidents when opens are far apart in time', () => {
    const participant = {
      participantId: 'P1', trials: [{}],
      session: { sidebarEvents: [
        { type: 'opened', method: 'innerWidth_delta', t: 1000 },
        { type: 'closed', method: 'innerWidth_delta', t: 3000 },
        { type: 'opened', method: 'innerWidth_delta', t: 20000 },
        { type: 'closed', method: 'innerWidth_delta', t: 22000 },
      ] }, metadata: {}
    };
    const s = computeParticipantSummary(participant, {});
    assert.equal(s.sidebarEventCount, 2, 'two well-separated opens = two openings');
  });

  it('counts a fast open->close->open reopen as two incidents (close is a boundary)', () => {
    const participant = {
      participantId: 'P1', trials: [{}],
      session: { sidebarEvents: [
        // A genuine reopen well within the 2000ms poll window: the intervening
        // close means it is two incidents, not one.
        { type: 'opened', method: 'innerWidth_delta', t: 1000 },
        { type: 'closed', method: 'innerWidth_delta', t: 1200 },
        { type: 'opened', method: 'innerWidth_delta', t: 1400 },
        { type: 'closed', method: 'innerWidth_delta', t: 1600 },
      ] }, metadata: {}
    };
    const s = computeParticipantSummary(participant, {});
    assert.equal(s.sidebarEventCount, 2, 'a close between opens starts a new incident');
  });

  it('surfaces participant.honeypot disclosure onto the summary', () => {
    const participant = {
      participantId: 'P1', trials: [{}],
      honeypot: { aiUse: true, aiReport: 'used an AI' }, metadata: {}
    };
    const s = computeParticipantSummary(participant, {});
    assert.equal(s.honeypotAiUse, true);
    assert.equal(s.honeypotAiReport, 'used an AI');
  });
});

describe('edge-exit', () => {
  it('detects mouse near edge before tab-away', () => {
    const trial = {
      mouseEvents: [
        { x: 5, y: 300, t: 1000, type: 'move' },
        { x: 5, y: 300, t: 1100, type: 'move' }
      ],
      tabAwayEvents: [{ start: 1200, duration_ms: 5000 }]
    };
    const result = detectEdgeExitForTrial(trial, { width: 1920 });
    assert.equal(result.edgeExitCount, 1);
  });

  it('does not flag mouse away from edges', () => {
    const trial = {
      mouseEvents: [
        { x: 500, y: 300, t: 1000, type: 'move' }
      ],
      tabAwayEvents: [{ start: 1200, duration_ms: 5000 }]
    };
    const result = detectEdgeExitForTrial(trial, { width: 1920 });
    assert.equal(result.edgeExitCount, 0);
  });
});

describe('triage', () => {
  it('generates one-line reason from signals', () => {
    const summary = { totalPasteEvents: 3, totalTabAways: 8, extensionsDetected: ['ChatGPT'] };
    const reason = generateTriageReason(summary);
    assert.ok(reason.includes('paste'));
    assert.ok(reason.includes('ChatGPT'));
  });

  it('splits tab-aways three-way in the reason when bin fields are present', () => {
    const summary = {
      totalPasteEvents: 0, totalDropEvents: 0, totalCopyEvents: 0,
      totalTabAways: 6, tabAwayLongCount: 2, tabAwayMediumCount: 3, tabAwayFlickerCount: 1,
      trialsWithFastTyping: 0, extensionsDetected: [],
      sidebarDetected: false, totalSyntheticInsertions: 0, totalForeignInputEvents: 0
    };
    const reason = generateTriageReason(summary);
    assert.ok(reason.includes('2 tab-aways ≥10s'), reason);
    assert.ok(reason.includes('3 tab-aways 3–10s'), reason);   // default 3s cutoff
    assert.ok(reason.includes('1 flicker ≤3s'), reason);       // flicker is at-or-below cutoff
    assert.ok(!reason.includes('6 tab-aways'), reason);
  });

  it('describes tab-away bins with the participant cutoff (strict = 5s)', () => {
    const summary = {
      totalTabAways: 2, tabAwayLongCount: 0, tabAwayMediumCount: 1, tabAwayFlickerCount: 1,
      tabAwayCutoffMs: 5000,  // strict preset
    };
    const reason = generateTriageReason(summary);
    assert.ok(reason.includes('1 tab-away 5–10s'), reason);
    assert.ok(reason.includes('1 flicker ≤5s'), reason);
    assert.ok(!reason.includes('3–10s') && !reason.includes('≤3s'), reason);
  });

  it('surfaces honeypot self-disclosure in the reason', () => {
    const reason = generateTriageReason({ totalPasteEvents: 0, honeypotAiUse: true });
    assert.ok(reason.includes('self-reported AI use'), reason);
  });

  it('returns clean for no signals', () => {
    const summary = {
      totalPasteEvents: 0, totalDropEvents: 0, totalCopyEvents: 0,
      totalTabAways: 0, trialsWithFastTyping: 0, extensionsDetected: [],
      sidebarDetected: false, totalSyntheticInsertions: 0, totalForeignInputEvents: 0
    };
    const reason = generateTriageReason(summary);
    assert.equal(reason, 'clean');
  });

  // Triage score policy (fixed 2026-06-01): only paste, copy, sidebar,
  // and tab-aways ≥3s contribute. Signals like AI extensions, keyboard
  // shortcuts, layout shifts and zoom changes are surfaced in the detail panes
  // but no longer affect the score.
  //   2 paste × 5 = 10 + 1 copy × 5 = 5 + 2 sidebar × 3 = 6
  //   + (1 long + 1 medium) tab-away × 1 = 2  →  total 23
  it('computes triage score from the four scoring signals', () => {
    const summary = {
      participantId: 'P1',
      hardTriggered: false,
      totalSoftScore: 4,
      authoritativeSoftScore: null,
      totalPasteEvents: 2,
      totalCopyEvents: 1,
      sidebarEventCount: 2,
      tabAwayLongCount: 1,
      tabAwayMediumCount: 1,
      // Present but non-scoring under the current policy — must NOT contribute:
      aiExtensionsFound: [{ name: 'Monica' }],
      keyboardShortcutCount: 3,
      layoutShiftCount: 1,
      zoomChangeCount: 1,
      totalSyntheticInsertions: 0,
      totalForeignInputEvents: 0,
    };
    const edgeExits = [{ edgeExits: [] }];
    const ranked = rankTriage([summary], edgeExits, {});
    assert.equal(ranked[0].score, 23);
  });

  it('sidebar contribution to triage score is no longer capped', () => {
    // 10 sidebar events × 3 = 30, uncapped (the previous ≤15 cap was removed).
    const summary = {
      participantId: 'P1',
      hardTriggered: false,
      totalSoftScore: 0,
      authoritativeSoftScore: null,
      totalPasteEvents: 0,
      totalCopyEvents: 0,
      sidebarEventCount: 10,
      tabAwayLongCount: 0,
      tabAwayMediumCount: 0,
    };
    const ranked = rankTriage([summary], [{ edgeExits: [] }], {});
    assert.equal(ranked[0].score, 30);
  });

  it('softFlagged uses authoritativeSoftScore when present (Task 4)', () => {
    // totalSoftScore below threshold, authoritative above → should flag.
    const summary = {
      participantId: 'P1',
      hardTriggered: false,
      totalSoftScore: 3,
      authoritativeSoftScore: 10,
      aiExtensionsFound: [],
      sidebarEventCount: 0,
      keyboardShortcutCount: 0,
      layoutShiftCount: 0,
      zoomChangeCount: 0,
      totalSyntheticInsertions: 0,
      totalForeignInputEvents: 0,
    };
    const ranked = rankTriage([summary], [{ edgeExits: [] }], { scoring: { softScoreThreshold: 6 } });
    assert.equal(ranked[0].softFlagged, true, 'authoritativeSoftScore=10 should exceed threshold=6');
  });

  // Round 3 fix: use the participant's OWN saved threshold (e.g. 4 for strict)
  // rather than a hardcoded default 6 when the analyst hasn't overridden it.
  it('soft-flags using the participant saved softScoreThreshold (no CLI override)', () => {
    const summary = {
      participantId: 'P1', hardTriggered: false,
      totalSoftScore: 5, authoritativeSoftScore: 5,
      softScoreThreshold: 4,  // strict preset saved this
    };
    // No config.scoring → must use the saved 4, so 5 >= 4 → soft-flagged.
    const ranked = rankTriage([summary], [{ edgeExits: [] }], {});
    assert.equal(ranked[0].softFlagged, true, 'saved threshold 4 used, not the default 6');
  });

  it('an explicit CLI scoring.softScoreThreshold overrides the saved threshold', () => {
    const summary = {
      participantId: 'P1', hardTriggered: false,
      totalSoftScore: 5, authoritativeSoftScore: 5,
      softScoreThreshold: 4,
    };
    // Analyst deliberately re-screens at 8 → 5 < 8 → not flagged.
    const ranked = rankTriage([summary], [{ edgeExits: [] }], { scoring: { softScoreThreshold: 8 } });
    assert.equal(ranked[0].softFlagged, false, 'explicit CLI override wins');
  });

  // Round 1 fix: hard-triggered participants must lead the ranked triage even
  // when a soft-only participant has a higher numeric score. The four-term score
  // no longer carries a hard-trigger term, so ranking is tier-first (hard, soft,
  // clean) then score-desc within tier.
  it('ranks hard-triggered participants above higher-scoring soft-only ones', () => {
    const summaries = [
      // soft-only but very high score (10 sidebar × 3 = 30); softFlagged via authoritative
      { participantId: 'P-SOFT', hardTriggered: false, totalSoftScore: 0,
        authoritativeSoftScore: 10, sidebarEventCount: 10 },
      // hard-triggered but low score (1 paste × 5 = 5)
      { participantId: 'P-HARD', hardTriggered: true, totalSoftScore: 0,
        authoritativeSoftScore: null, totalPasteEvents: 1 },
      // clean
      { participantId: 'P-CLEAN', hardTriggered: false, totalSoftScore: 0,
        authoritativeSoftScore: 0 },
    ];
    const edgeExits = summaries.map(() => ({ edgeExits: [] }));
    const ranked = rankTriage(summaries, edgeExits, { scoring: { softScoreThreshold: 6 } });
    assert.equal(ranked[0].participantId, 'P-HARD', 'hard tier first despite lower score');
    assert.equal(ranked[1].participantId, 'P-SOFT', 'soft tier second');
    assert.equal(ranked[2].participantId, 'P-CLEAN', 'clean tier last');
    assert.ok(ranked[0].score < ranked[1].score, 'hard outranks soft even with a lower score');
  });
});
