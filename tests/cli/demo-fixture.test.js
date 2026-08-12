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
  it('resolves exactly one participant with the v1 version warning and an attached replay', async () => {
    const config = {
      dataDir: FIXTURE_DIR,
      filePattern: 'DEMO-*.json',
      participantIdField: 'participantId',
      integrityField: 'integrity',
    };

    const { participants, warnings } = await ingest(config);

    // The committed trio's replay artifact is a v1 recording, and since T5
    // the CLI targets v2 — so ingest says so (once) and attaches it anyway.
    // The warning is TRUE of this fixture, not a regression: the v2 viewer
    // cannot play it, and the report would render it as unloadable. A6
    // regenerates the demo assets with the v2 pipeline, at which point this
    // expectation goes back to zero.
    const versionWarnings = warnings.filter(w => String(w.warnings).match(/schema_version 1/));
    assert.strictEqual(versionWarnings.length, 1,
      'exactly one v1-version warning, for the committed v1 replay artifact');
    assert.strictEqual(warnings.length, 1,
      `expected no OTHER ingest warnings, got: ${JSON.stringify(warnings, null, 2)}`);

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
