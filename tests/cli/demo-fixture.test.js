// tests/cli/demo-fixture.test.js
// Testing layer 1 (spec: "Ingest fixture"): the demo's three-file download
// trio, committed under tests/fixtures/demo/ (see that dir's README.md for
// how it was produced and how to regenerate it), run through the REAL CLI
// ingest — not a hand-built payload. Regenerate the fixture whenever the
// payload assembler (demo/payload.js / demo/demo.js's buildDownloadFile)
// changes shape.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ingest } from '../../src/cli/ingest.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo');

describe('demo download-trio fixture (real ingest)', () => {
  it('resolves exactly one participant with zero warnings and an attached replay', async () => {
    const config = {
      dataDir: FIXTURE_DIR,
      filePattern: 'DEMO-*.json',
      participantIdField: 'participantId',
      integrityField: 'integrity',
    };

    const { participants, warnings } = await ingest(config);

    assert.strictEqual(warnings.length, 0,
      `expected zero ingest warnings, got: ${JSON.stringify(warnings, null, 2)}`);

    assert.strictEqual(participants.length, 1,
      'expected exactly one participant from the fixture trio');
    assert.strictEqual(participants[0].participantId, 'DEMO-FIXT');

    // Replay artifact attachment (attachReplayArtifacts in ingest.js): a
    // successfully attached replay carries { recording, file, meta }.
    assert.ok(participants[0].replay, 'expected a replay artifact attached');
    assert.ok(participants[0].replay.recording, 'expected the replay recording to be parsed');
    assert.strictEqual(participants[0].replay.recording.schema_version, 1);
    assert.strictEqual(participants[0].replay.recording.metadata.participant_id, 'DEMO-FIXT');
  });
});
