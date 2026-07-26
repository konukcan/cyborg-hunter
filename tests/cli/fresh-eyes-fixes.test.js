// tests/cli/fresh-eyes-fixes.test.js
// Pin fixes from the 2026-07-04 fresh-eyes review (pre-replay build).
//
// Fix 1: edge-exit compared trial-relative mouse t against session-absolute
//        tabAway start — always false on modern (normalized) payloads.
// Fix 2: Shape-3 ingest (top-level array) dropped outer trial fields and
//        skipped tab-away normalization, unlike Shapes 1 and 2.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectEdgeExitForTrial } from '../../src/cli/analyzers/edge-exit.js';
import { extractIntegrityData } from '../../src/cli/ingest.js';

describe('edge-exit on normalized (modern) payloads', () => {
  it('detects an edge exit using startRel_ms when present', () => {
    const trial = {
      windowWidth: 1920,
      // trial-relative mouse events: cursor parked at the left edge at t=4.5s
      mouseEvents: [
        { type: 'move', x: 400, y: 300, t: 1000 },
        { type: 'move', x: 10, y: 250, t: 4500 },
      ],
      // Modern ingest adds startRel_ms (trial-relative); start stays absolute.
      tabAwayEvents: [
        { start: 987654.3, startRel_ms: 5000, duration_ms: 12000, type: 'windowBlur' },
      ],
    };
    const result = detectEdgeExitForTrial(trial, {});
    assert.strictEqual(result.edgeExitCount, 1,
      'edge exit at left edge 500ms before tab-away must be detected');
    assert.strictEqual(result.events[0].exitEdge, 'left');
  });

  it('still works on legacy payloads where start is already trial-relative', () => {
    const trial = {
      windowWidth: 1920,
      mouseEvents: [{ type: 'move', x: 1900, y: 300, t: 4500 }],
      tabAwayEvents: [{ start: 5000, duration_ms: 4000, type: 'tabHidden' }],
    };
    const result = detectEdgeExitForTrial(trial, {});
    assert.strictEqual(result.edgeExitCount, 1);
    assert.strictEqual(result.events[0].exitEdge, 'right');
  });
});

describe('Shape-3 ingest (top-level array of trials)', () => {
  const config = { integrityField: 'integrity', participantIdField: 'participantId' };

  it('preserves outer trial fields when merging the integrity sub-object', () => {
    const raw = [
      {
        trialId: 'rule-7', ruleId: 'R7', rt: 1234,
        integrity: {
          trialId: 'rule-7', startTime: 10000, duration_ms: 5000,
          pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [],
          trialSoftScore: 0, trialSignals: {}, libraryVersion: '0.6.0',
          participantId: 'P1',
        },
      },
    ];
    const { trials } = extractIntegrityData(raw, config);
    assert.strictEqual(trials.length, 1);
    assert.strictEqual(trials[0].ruleId, 'R7', 'outer trial fields must survive the merge');
    assert.strictEqual(trials[0].rt, 1234, 'outer trial fields must survive the merge');
    assert.strictEqual(trials[0].duration_ms, 5000, 'integrity fields must also be present');
  });

  it('normalizes tab-away timestamps like Shapes 1 and 2 do', () => {
    const raw = [
      {
        trialId: 'rule-1',
        integrity: {
          trialId: 'rule-1', startTime: 20000, duration_ms: 8000,
          pasteEvents: [], copyEvents: [], dropEvents: [],
          tabAwayEvents: [{ start: 23000, duration_ms: 4000, type: 'tabHidden' }],
          trialSoftScore: 0, trialSignals: {}, libraryVersion: '0.6.0',
          participantId: 'P1',
        },
      },
    ];
    const { trials } = extractIntegrityData(raw, config);
    assert.strictEqual(trials[0].tabAwayEvents[0].startRel_ms, 3000,
      'startRel_ms must be start − trial startTime (fast path anchor)');
  });

  it('normalizes correctly when non-integrity entries are interleaved', () => {
    // Filtering happens before normalization; each trial normalizes against
    // its OWN startTime anchor (never by index into the source array), so
    // interleaved instruction/fixation entries cannot misalign anything.
    const integrityTrial = (id, startTime, tabStart) => ({
      trialId: id,
      integrity: {
        trialId: id, startTime, duration_ms: 8000,
        pasteEvents: [], copyEvents: [], dropEvents: [],
        tabAwayEvents: [{ start: tabStart, duration_ms: 4000, type: 'tabHidden' }],
        trialSoftScore: 0, trialSignals: {}, libraryVersion: '0.6.0',
        participantId: 'P1',
      },
    });
    const raw = [
      { trial_type: 'instructions' },              // no integrity — filtered out
      integrityTrial('rule-1', 20000, 23000),
      null,                                        // tolerated, filtered out
      { trial_type: 'fixation' },                  // no integrity — filtered out
      integrityTrial('rule-2', 40000, 41000),
    ];
    const { trials } = extractIntegrityData(raw, config);
    assert.strictEqual(trials.length, 2);
    assert.strictEqual(trials[0].tabAwayEvents[0].startRel_ms, 3000);
    assert.strictEqual(trials[1].tabAwayEvents[0].startRel_ms, 1000,
      'second trial must normalize against its own anchor despite skipped entries');
  });
});
