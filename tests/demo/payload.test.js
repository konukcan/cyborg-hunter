import { it } from 'node:test';
import assert from 'node:assert';
import { buildPayload } from '../../demo/payload.js';

it('assembles a Shape-1 payload per src/cli/ingest.js conventions', () => {
  const sessionReport = { softScore: 0 };
  const result = buildPayload({
    pid: 'DEMO-TEST',
    trials: [{ trialId: 's2', integrity: { trialId: 's2', pasteEvents: [] } }],
    sessionReport,
    violations: [{ type: 'fullscreen_exit' }],
  });

  assert.strictEqual(result.participantId, 'DEMO-TEST');
  assert.strictEqual(result.metadata.integritySession, sessionReport);
  assert.ok(Array.isArray(result.trials));
  assert.strictEqual(result.guardFriction.violations.length, 1);
});

it('omits guardFriction entirely when violations is omitted (no empty override)', () => {
  const result = buildPayload({
    pid: 'DEMO-TEST',
    trials: [],
    sessionReport: { softScore: 0 },
  });

  assert.strictEqual('guardFriction' in result, false);
});
