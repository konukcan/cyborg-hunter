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
  it('resolves exactly one participant with a clean, v2 replay attached', async () => {
    const config = {
      dataDir: FIXTURE_DIR,
      filePattern: 'DEMO-*.json',
      participantIdField: 'participantId',
      integrityField: 'integrity',
    };

    const { participants, warnings } = await ingest(config);

    // A6 regenerated the trio via the fresh-capture path (the current v2
    // recorder), so the committed replay artifact is now a SessionRecording
    // v2 — the format the CLI's viewer targets. There is nothing for ingest
    // to warn about: no version mismatch (it's v2), no conversion (it's native
    // v2, not jsPsych-v1), a resolvable embedded participant_id, one session.
    // The pre-A6 era committed a v1 artifact and this expected the one
    // "schema_version 1 … will report this artifact as unloadable" warning;
    // taking that to zero is the last owed A6 item.
    assert.strictEqual(warnings.length, 0,
      `expected a clean ingest with no warnings, got: ${JSON.stringify(warnings, null, 2)}`);

    assert.strictEqual(participants.length, 1,
      'expected exactly one participant from the fixture trio');
    assert.strictEqual(participants[0].participantId, 'DEMO-FIXT');

    // Replay artifact attachment (attachReplayArtifacts in ingest.js): a
    // successfully attached replay carries { recording, file, meta }.
    assert.ok(participants[0].replay, 'expected a replay artifact attached');
    assert.ok(participants[0].replay.recording, 'expected the replay recording to be parsed');
    assert.strictEqual(participants[0].replay.recording.schema_version, 2);
    // v2 carries the id at the top level (serializer.js), not under metadata.*.
    assert.strictEqual(participants[0].replay.recording.participant_id, 'DEMO-FIXT');
  });
});
