// tests/cli/integration-070.test.js
// Regressions found during 0.7.0 integration testing.
//
// The replay attach pass kept its participant-id censuses in plain object
// literals, so a participant id that collides with an Object.prototype key
// ("__proto__", "constructor", ...) never recorded a count: assigning a
// primitive to obj.__proto__ is a silent no-op. Two duplicate "__proto__"
// records with two owned replay artifacts then skipped the
// ambiguous-association guard and BOTH records were handed the latest replay,
// with no duplicate warning from the attach pass.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ingest } from '../../src/cli/ingest.js';

function participantFile(pid) {
  return JSON.stringify({
    participantId: pid,
    trials: [{
      trialId: 'r1',
      integrity: {
        trialId: 'r1', participantId: pid, libraryVersion: '0.7.0',
        startTime: 1000, duration_ms: 5000, trialStart_perfNow: 1000,
        pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [],
        trialSoftScore: 0, trialSignals: {},
      },
    }],
  });
}

function recording(pid, startEpoch) {
  return {
    schema_version: 1,
    metadata: {
      // pid === null → an OWNERLESS artifact (no embedded participant_id),
      // which exercises the saneCounts filename-ambiguity branch instead of
      // the embedded-id ownership check.
      ...(pid === null ? {} : { participant_id: pid }),
      tier: 'trace',
      start_time: new Date(startEpoch).toISOString(),
      end_reason: 'finished', recorder: 'cyborg-hunter-replay@0.7.0',
    },
    viewport: { width: 100, height: 100, dpr: 1, visual_viewport: null },
    stylesheets: { initial: [], events: [] },
    rng_calls: [],
    trials: [{ trial_index: 0, trial_id: 'r1', plugin: 'x', t_start: null,
      t_dom_ready: null, t_load: 0, t_end: 100, initial_dom: '', events: [],
      trial_data: {} }],
    ch_extensions: { capture_failures: [], capture_stopped: false, scoring: null },
  };
}

describe('attach-pass censuses survive prototype-key participant ids', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ch-proto-'));
    // Two duplicate records for id "__proto__" (sanitizeId passes it through
    // unchanged) plus two owned replay artifacts — the genuinely-ambiguous
    // association case the attach pass must refuse.
    writeFileSync(join(dir, 'a.json'), participantFile('__proto__'));
    writeFileSync(join(dir, 'b.json'), participantFile('__proto__'));
    writeFileSync(join(dir, '__proto__-replay-1750000000001.json'),
      JSON.stringify(recording('__proto__', 1750000000001)));
    writeFileSync(join(dir, '__proto__-replay-1750000000002.json'),
      JSON.stringify(recording('__proto__', 1750000000002)));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses the ambiguous association instead of attaching to both records', async () => {
    const { participants, warnings } = await ingest({
      dataDir: dir, filePattern: '*.json',
      integrityField: 'integrity', participantIdField: 'participantId',
    });
    assert.strictEqual(participants.length, 2);
    for (const p of participants) {
      assert.strictEqual(p.replay, null,
        'ambiguous duplicate-id + multi-artifact case must attach nothing');
    }
    const flat = warnings.flatMap(w => w.warnings);
    assert.ok(flat.some(w => /Cannot associate 2 replay artifacts/.test(w)),
      `expected the ambiguous-association warning, got:\n${flat.join('\n')}`);
    assert.ok(flat.some(w => /Duplicate participant id "__proto__"/.test(w)),
      `expected the attach-pass duplicate-id warning, got:\n${flat.join('\n')}`);
  });
});

describe('saneCounts census survives prototype-key sanitized names (Sol R2)', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ch-proto-sane-'));
    // Two DISTINCT ids that sanitize to the same filename stem:
    // sanitizeId('__proto/_') === '__proto__'. One OWNERLESS artifact
    // (no embedded participant_id) named for that stem: ownership is
    // decided purely by the saneCounts filename census, which must count 2
    // and refuse the ambiguous attachment.
    writeFileSync(join(dir, 'a.json'), participantFile('__proto__'));
    writeFileSync(join(dir, 'b.json'), participantFile('__proto/_'));
    writeFileSync(join(dir, '__proto__-replay-1750000000001.json'),
      JSON.stringify(recording(null, 1750000000001)));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses the ownerless artifact when 2 participants sanitize to its stem', async () => {
    const { participants, warnings } = await ingest({
      dataDir: dir, filePattern: '*.json',
      integrityField: 'integrity', participantIdField: 'participantId',
    });
    assert.strictEqual(participants.length, 2);
    for (const p of participants) {
      assert.strictEqual(p.replay, null,
        `ownerless artifact with an ambiguous sanitized stem must not attach (got one on ${p.participantId})`);
    }
    const flat = warnings.flatMap(w => w.warnings);
    assert.ok(flat.some(w => /filename is ambiguous \(2 participants sanitize to "__proto__"\)/.test(w)),
      `expected the sanitized-stem ambiguity warning, got:\n${flat.join('\n')}`);
  });
});
