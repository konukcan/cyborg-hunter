// tests/cli/replay-ingest.test.js
// Replay sibling-artifact ingest: discovery, gz, corruption, collisions,
// download-only warning, and exclusion from the participant file pass.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { ingest } from '../../src/cli/ingest.js';

function participantFile(pid, replayMeta) {
  return JSON.stringify({
    participantId: pid,
    trials: [{
      trialId: 'r1',
      integrity: {
        trialId: 'r1', participantId: pid, libraryVersion: '0.6.0',
        startTime: 1000, duration_ms: 5000, trialStart_perfNow: 1000,
        pasteEvents: [], copyEvents: [], dropEvents: [], tabAwayEvents: [],
        trialSoftScore: 0, trialSignals: {},
        ...(replayMeta ? { integrityReplayMeta: replayMeta } : {}),
      },
    }],
  });
}

function recording(pid, startEpoch) {
  return {
    schema_version: 1,
    metadata: {
      participant_id: pid, tier: 'trace',
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

// SessionRecording v2 (spec r2) — what the recorder has emitted since T3.
// The content sniff has to recognise it or a fresh capture is parsed as a
// participant file and never reaches the viewer (T5 Task 10).
function recordingV2(pid, startEpoch) {
  return {
    schema_version: 2,
    recorder: { name: 'cyborg-hunter-replay', version: '0.7.5' },
    host: null,
    participant_id: pid,
    recording_started_at: new Date(startEpoch).toISOString(),
    recording_started_at_perf: 0,
    user_agent: 'test-agent',
    viewport: { w: 100, h: 100, dpr: 1, scale: 1, offset_x: 0, offset_y: 0 },
    observed_root: null,
    stylesheets: [], stylesheet_events: [], viewport_changes: [],
    rng: null, rng_calls: null,
    ended_at_perf: 100, end_reason: 'finished', truncated: false,
    segments: [{
      index: 0, label: 'r1', plugin: 'x',
      t_start: null, t_dom_ready: null, t_load: 0, t_end: 100,
      initial_dom: { id: 1, kind: 'element', tag: 'body', attrs: {}, children: [] },
      initial_state: null, events: [], host_data: {}, extensions: null,
    }],
    extensions: { 'cyborg-hunter': { replay_version: '0.7.5', tier: 'dom', keys: 'full' } },
  };
}

describe('replay artifact ingest', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ch-replay-ingest-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  const config = () => ({
    dataDir: dir, filePattern: '*.json',
    integrityField: 'integrity', participantIdField: 'participantId',
  });

  it('attaches a sibling replay artifact and excludes it from the participant pass', async () => {
    writeFileSync(join(dir, 'P1.json'), participantFile('P1'));
    writeFileSync(join(dir, 'P1-replay-1751600000000.json'),
      JSON.stringify(recording('P1', 1751600000000)));
    const { participants, warnings } = await ingest(config());
    assert.strictEqual(participants.length, 1,
      'the replay artifact must not be ingested as a participant file');
    assert.ok(participants[0].replay, 'replay must be attached');
    assert.strictEqual(participants[0].replay.recording.schema_version, 1);
    assert.ok(!warnings.some(w =>
      String(w.warnings).includes('No integrity data found')),
      'no spurious warnings from replay files');
  });

  it('decompresses .json.gz artifacts', async () => {
    writeFileSync(join(dir, 'P2.json'), participantFile('P2'));
    writeFileSync(join(dir, 'P2-replay-1751600000000.json.gz'),
      gzipSync(JSON.stringify(recording('P2', 1751600000000))));
    const { participants } = await ingest({ ...config(), singleParticipant: 'P2' });
    assert.strictEqual(participants[0].replay.recording.metadata.participant_id, 'P2');
  });

  it('picks the latest artifact on filename collision and warns', async () => {
    writeFileSync(join(dir, 'P3.json'), participantFile('P3'));
    writeFileSync(join(dir, 'P3-replay-1751600000000.json'),
      JSON.stringify(recording('P3', 1751600000000)));
    writeFileSync(join(dir, 'P3-replay-1751600999999.json'),
      JSON.stringify(recording('P3', 1751600999999)));
    const { participants, warnings } = await ingest({ ...config(), singleParticipant: 'P3' });
    assert.strictEqual(
      participants[0].replay.recording.metadata.start_time,
      new Date(1751600999999).toISOString(), 'latest wins');
    assert.ok(warnings.some(w => String(w.warnings).match(/multiple replay artifacts/i)));
  });

  it('marks corrupted artifacts instead of failing', async () => {
    writeFileSync(join(dir, 'P4.json'), participantFile('P4'));
    writeFileSync(join(dir, 'P4-replay-1751600000000.json'), '{"truncated": ');
    const { participants } = await ingest({ ...config(), singleParticipant: 'P4' });
    assert.strictEqual(participants[0].replay.error, 'parse_failed');
    assert.ok(participants[0].replay.reason.length > 0);
  });

  it('warns when meta says download but no artifact file exists', async () => {
    writeFileSync(join(dir, 'P5.json'), participantFile('P5', {
      schema_version: 1, tier: 'trace', saved_to: 'download',
      bytes_uncompressed: 1234, capture_failures: [], capture_stopped: false,
    }));
    const { participants, warnings } = await ingest({ ...config(), singleParticipant: 'P5' });
    assert.strictEqual(participants[0].replay, null);
    assert.ok(warnings.some(w =>
      String(w.warnings).match(/downloaded to the participant/i)),
      'analyst must learn the artifact went to the participant machine');
  });

  it('stays silent for participants with no replay and no meta', async () => {
    // Own temp dir: the shared fixture dir accumulates corrupt artifacts
    // from other tests, whose filter-pass warnings would leak in here.
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-silent-'));
    try {
      writeFileSync(join(d, 'P6.json'), participantFile('P6'));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants[0].replay, null);
      assert.ok(!warnings.some(w => String(w.warnings).match(/replay/i)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('warns on unknown schema_version but still attaches', async () => {
    writeFileSync(join(dir, 'P7.json'), participantFile('P7'));
    const odd = recording('P7', 1751600000000);
    odd.schema_version = 3;                        // neither the v1 era nor v2
    writeFileSync(join(dir, 'P7-replay-1751600000000.json'), JSON.stringify(odd));
    const { participants, warnings } = await ingest({ ...config(), singleParticipant: 'P7' });
    assert.ok(participants[0].replay.recording, 'still attached');
    assert.ok(warnings.some(w => String(w.warnings).match(/schema_version/)));
  });

  // ── SessionRecording v2 (T5 Task 10) ──────────────────────────────────────
  // The sniff keyed on v1's `metadata.recorder` / v1 `trials[]`, so a v2
  // artifact matched neither: it was routed into the PARTICIPANT pass as
  // "contains participant data" and p.replay stayed null. Nothing downstream
  // could recover — a fresh capture never reached the report.
  it('attaches a v2 artifact and keeps it out of the participant pass', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-v2-'));
    try {
      writeFileSync(join(d, 'V2P.json'), participantFile('V2P'));
      writeFileSync(join(d, 'V2P-replay-1751600000000.json'),
        JSON.stringify(recordingV2('V2P', 1751600000000)));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants.length, 1,
        'the v2 artifact must not be ingested as a participant file');
      assert.ok(participants[0].replay && participants[0].replay.recording, 'v2 replay must attach');
      assert.strictEqual(participants[0].replay.recording.schema_version, 2);
      assert.ok(!warnings.some(w => String(w.warnings).match(/replay-artifact naming pattern/i)),
        'a v2 artifact is not a misnamed participant export');
      assert.ok(!warnings.some(w => String(w.warnings).match(/schema_version/)),
        'v2 is the version this CLI targets — warning about it is noise');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // Ownership and the latest-session pick read v1's `metadata` block. Making
  // the sniff recognise v2 without these would hand a v2 artifact to the
  // OWNERLESS branch, which verifies by filename alone — so a file recorded
  // for 'a/b' and named for the sanitized 'a_b' would attach to the wrong
  // participant, the one case the mismatch check exists for. (Commit-hook
  // finding on the first Task 10 commit; the mis-assignment half was real.)
  it('rejects a v2 artifact whose top-level participant_id mismatches', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-v2own-'));
    try {
      writeFileSync(join(d, 'ab-collision.json'), participantFile('a_b'));
      writeFileSync(join(d, 'a_b-replay-1751600000000.json'),
        JSON.stringify(recordingV2('a/b', 1751600000000)));   // belongs to 'a/b'
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json', singleParticipant: 'a_b',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants[0].replay, null,
        'a v2 artifact recorded for a different participant must never attach');
      assert.ok(warnings.some(w => String(w.warnings).match(/participant_id mismatch/i)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('verifies a v2 artifact by its own id rather than by filename luck', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-v2ownok-'));
    try {
      writeFileSync(join(d, 'P10.json'), participantFile('P10'));
      writeFileSync(join(d, 'P10-replay-1751600000000.json'),
        JSON.stringify(recordingV2('P10', 1751600000000)));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json', singleParticipant: 'P10',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(participants[0].replay.recording, 'attached');
      assert.ok(!warnings.some(w => String(w.warnings).match(/cannot verify ownership/i)),
        'v2 carries the id at the top level — claiming it cannot be verified is false');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // A v2 recording has no `metadata` block (spec §2), so one appearing on a
  // v2 file is junk — hand-edited, half-converted, or a producer's leftover.
  // Reading it in preference to the authoritative top-level field would let
  // that junk decide ownership, which is a cross-participant attachment.
  // Selection is therefore VERSION-AWARE, not a fallback chain.
  // (Second commit-hook finding on the Task 10 fix round.)
  it('ignores a stray v1 metadata block on a v2 artifact when deciding ownership', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-v2junk-'));
    try {
      writeFileSync(join(d, 'P12.json'), participantFile('P12'));
      const rec = recordingV2('SOMEONE-ELSE', 1751600000000);
      rec.metadata = { participant_id: 'P12' };     // junk that would claim ownership
      writeFileSync(join(d, 'P12-replay-1751600000000.json'), JSON.stringify(rec));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json', singleParticipant: 'P12',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants[0].replay, null,
        'the top-level participant_id governs on a v2 file, and it says SOMEONE-ELSE');
      assert.ok(warnings.some(w => String(w.warnings).match(/participant_id mismatch/i)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('ignores a stray v1 metadata start_time on a v2 artifact when picking the session', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-v2junkt-'));
    try {
      writeFileSync(join(d, 'P13.json'), participantFile('P13'));
      const older = recordingV2('P13', 1751600000000);
      older.metadata = { start_time: new Date(1799999999999).toISOString() }; // junk: claims newest
      writeFileSync(join(d, 'P13-replay-1751600000000.json'), JSON.stringify(older));
      writeFileSync(join(d, 'P13-replay-1751600999999.json'),
        JSON.stringify(recordingV2('P13', 1751600999999)));
      const { participants } = await ingest({
        dataDir: d, filePattern: '*.json', singleParticipant: 'P13',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants[0].replay.recording.recording_started_at,
        new Date(1751600999999).toISOString(),
        'the real latest session wins over a junk metadata.start_time');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('picks the latest v2 session by its own start time', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-v2latest-'));
    try {
      writeFileSync(join(d, 'P11.json'), participantFile('P11'));
      // The filename epochs are INVERTED relative to the recordings' own
      // start times, so the filename fallback picks the wrong one and only
      // reading `recording_started_at` can pass. (A real CH artifact's
      // filename epoch is derived from that field, so the two agree; this
      // pair exists to prove which one is being read.)
      writeFileSync(join(d, 'P11-replay-1751600000002.json'),
        JSON.stringify(recordingV2('P11', 1751600000000)));   // older session
      writeFileSync(join(d, 'P11-replay-1751600000001.json'),
        JSON.stringify(recordingV2('P11', 1751600999999)));   // newer session
      const { participants } = await ingest({
        dataDir: d, filePattern: '*.json', singleParticipant: 'P11',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants[0].replay.recording.recording_started_at,
        new Date(1751600999999).toISOString(), 'latest v2 session wins');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('warns that a v1 artifact is below the targeted version', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-v1warn-'));
    try {
      writeFileSync(join(d, 'V1P.json'), participantFile('V1P'));
      writeFileSync(join(d, 'V1P-replay-1751600000000.json'),
        JSON.stringify(recording('V1P', 1751600000000)));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(participants[0].replay.recording, 'still attached — ingest never drops data');
      assert.ok(warnings.some(w => String(w.warnings).match(/schema_version 1/)),
        'the analyst learns the viewer will not play it before opening the report');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('rejects an artifact whose embedded participant_id mismatches (sanitization collision)', async () => {
    // 'a/b' and 'a_b' both sanitize to 'a_b' — the filename alone is
    // ambiguous. The embedded (unsanitized) participant_id disambiguates.
    writeFileSync(join(dir, 'ab-collision.json'), participantFile('a_b'));
    writeFileSync(join(dir, 'a_b-replay-1751600000000.json'),
      JSON.stringify(recording('a/b', 1751600000000)));   // belongs to 'a/b', NOT 'a_b'
    const { participants, warnings } = await ingest({ ...config(), singleParticipant: 'a_b' });
    assert.strictEqual(participants[0].replay, null,
      'an artifact recorded for a different participant must never attach');
    assert.ok(warnings.some(w => String(w.warnings).match(/participant_id mismatch/i)));
  });

  it('attaches with a soft warning when the artifact has no embedded participant_id', async () => {
    writeFileSync(join(dir, 'P9.json'), participantFile('P9'));
    const anon = recording('P9', 1751600000000);
    delete anon.metadata.participant_id;   // e.g. a third-party #3661 recording
    writeFileSync(join(dir, 'P9-replay-1751600000000.json'), JSON.stringify(anon));
    const { participants, warnings } = await ingest({ ...config(), singleParticipant: 'P9' });
    assert.ok(participants[0].replay.recording, 'still attached');
    assert.ok(warnings.some(w => String(w.warnings).match(/cannot verify ownership/i)));
  });

  it('refuses to attach a no-id artifact when two participants share the sanitized name', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-ambig-'));
    try {
      writeFileSync(join(d, 'p-underscore.json'), participantFile('a_b'));
      writeFileSync(join(d, 'p-slash.json'), participantFile('a/b'));   // sanitizes to a_b too
      const anon = recording('ignored', 1751600000000);
      delete anon.metadata.participant_id;
      writeFileSync(join(d, 'a_b-replay-1751600000000.json'), JSON.stringify(anon));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants.length, 2);
      assert.ok(participants.every(p => p.replay === null),
        'an ownerless artifact with an ambiguous name must attach to nobody');
      assert.ok(warnings.some(w => String(w.warnings).match(/ambiguous/i)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('warns per unreadable artifact even when an older readable one attaches', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-corrupt-'));
    try {
      writeFileSync(join(d, 'PX.json'), participantFile('PX'));
      writeFileSync(join(d, 'PX-replay-1751600000000.json'),
        JSON.stringify(recording('PX', 1751600000000)));       // older, readable
      writeFileSync(join(d, 'PX-replay-1751600999999.json'), '{"broken');  // NEWER, corrupt
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(participants[0].replay.recording, 'older readable artifact attaches');
      assert.ok(warnings.some(w =>
        String(w.warnings).match(/unreadable/i) &&
        String(w.warnings).includes('PX-replay-1751600999999')),
        'the corrupt NEWER artifact must be named — a newer session may be lost');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('anchors filename matching: participant "a" never matches "a-replay-replay-*.json"', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-anchor-'));
    try {
      writeFileSync(join(d, 'pa.json'), participantFile('a'));
      writeFileSync(join(d, 'par.json'), participantFile('a-replay'));
      const anon = recording('ignored', 1751600000000);
      delete anon.metadata.participant_id;   // ownerless = the dangerous case
      writeFileSync(join(d, 'a-replay-replay-1751600000000.json'), JSON.stringify(anon));
      const { participants } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      const byId = Object.fromEntries(participants.map(p => [p.participantId, p]));
      assert.strictEqual(byId['a'].replay, null,
        'prefix overlap must not leak another participant\'s artifact');
      assert.ok(byId['a-replay'].replay.recording,
        'the true owner (unique sanitized name) still attaches');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('treats case-insensitive filename matches as ambiguous for ownerless artifacts', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-case-'));
    try {
      writeFileSync(join(d, 'upper.json'), participantFile('P1'));
      writeFileSync(join(d, 'lower.json'), participantFile('p1'));
      const anon = recording('ignored', 1751600000000);
      delete anon.metadata.participant_id;
      writeFileSync(join(d, 'p1-replay-1751600000000.json'), JSON.stringify(anon));
      const { participants } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(participants.every(p => p.replay === null),
        'an ownerless artifact must never attach to two case-variant participants');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('warns once when duplicate participant ids are ingested (report treats them as one person)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-dup-'));
    try {
      writeFileSync(join(d, 'run1.json'), participantFile('PD'));
      writeFileSync(join(d, 'run2.json'), participantFile('PD'));
      writeFileSync(join(d, 'PD-replay-1751600000000.json'),
        JSON.stringify(recording('PD', 1751600000000)));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants.length, 2);
      const dupWarnings = warnings.filter(w => String(w.warnings).match(/duplicate participant id/i));
      assert.strictEqual(dupWarnings.length, 1, 'exactly one warning per duplicated id');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('routes a participant file with a replay-like name back to the participant pass', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-name-'));
    try {
      // A participant export unluckily named like a replay artifact: content
      // sniffing must rescue it (no schema_version/recorder inside).
      writeFileSync(join(d, 'alice-replay-1720000000000.json'), participantFile('alice'));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants.length, 1, 'participant data must never be silently dropped');
      assert.strictEqual(participants[0].participantId, 'alice');
      assert.ok(warnings.some(w => String(w.warnings).match(/replay-artifact naming pattern/i)));
      assert.strictEqual(participants[0].replay, null,
        'the rescued participant file must not double as its own replay artifact');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('refuses attachment when duplicate records AND multiple artifacts coexist', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-dupmulti-'));
    try {
      writeFileSync(join(d, 'run1.json'), participantFile('PM'));
      writeFileSync(join(d, 'run2.json'), participantFile('PM'));
      writeFileSync(join(d, 'PM-replay-1751600000000.json'),
        JSON.stringify(recording('PM', 1751600000000)));
      writeFileSync(join(d, 'PM-replay-1751600999999.json'),
        JSON.stringify(recording('PM', 1751600999999)));
      const { participants, warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(participants.every(p => p.replay === null),
        'per-session mapping is ambiguous — attach nothing rather than guess');
      assert.ok(warnings.some(w => String(w.warnings).match(/cannot associate/i)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('warns about an unparseable replay-named file even when no participant matches it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-orphan-'));
    try {
      writeFileSync(join(d, 'PZ.json'), participantFile('PZ'));
      writeFileSync(join(d, 'ghost-replay-1751600000000.json'), '{"trunc');   // no participant "ghost"
      const { warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(warnings.some(w =>
        String(w.warnings).match(/could not be parsed/i) &&
        String(w.file).includes('ghost-replay')),
        'a corrupt replay-named file must never disappear silently');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('falls back to the filename epoch when start_time is not ISO', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-epoch-'));
    try {
      writeFileSync(join(d, 'PE.json'), participantFile('PE'));
      const older = recording('PE', 1751600000000);
      older.metadata.start_time = 1751600000000;            // numeric, non-ISO
      const newer = recording('PE', 1751600999999);
      newer.metadata.start_time = 'not-a-date';             // garbage
      writeFileSync(join(d, 'PE-replay-1751600000000.json'), JSON.stringify(older));
      writeFileSync(join(d, 'PE-replay-1751600999999.json'), JSON.stringify(newer));
      const { participants } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants[0].replay.file, 'PE-replay-1751600999999.json',
        'latest must be chosen via numeric/filename fallback, not NaN sort');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('ownerless artifacts require an exact-case filename match', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-exactcase-'));
    try {
      writeFileSync(join(d, 'PA.json'), participantFile('Alice'));
      const anon = recording('ignored', 1751600000000);
      delete anon.metadata.participant_id;
      writeFileSync(join(d, 'alice-replay-1751600000000.json'), JSON.stringify(anon));
      const { participants } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.strictEqual(participants[0].replay, null,
        'case-mismatched ownerless artifact must not attach to "Alice"');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('does not classify a zero-trial participant export as a replay artifact', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-empty-'));
    try {
      // schema_version + empty trials would satisfy a vacuous .every()
      writeFileSync(join(d, 'odd-replay-1751600000000.json'), JSON.stringify({
        participantId: 'odd', schema_version: 99, trials: [],
      }));
      const { warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(warnings.some(w => String(w.warnings).match(/naming pattern/i)),
        'must be routed to the participant pass (with the rename hint), not silently dropped');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('surfaces replayFinalizeError from the jsPsych data', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ch-replay-finerr-'));
    try {
      const pf = JSON.parse(participantFile('PF'));
      pf.trials[0].integrity.replayFinalizeError = 'autosave exploded';
      writeFileSync(join(d, 'PF.json'), JSON.stringify(pf));
      const { warnings } = await ingest({
        dataDir: d, filePattern: '*.json',
        integrityField: 'integrity', participantIdField: 'participantId',
      });
      assert.ok(warnings.some(w => String(w.warnings).match(/replay finalize failed/i)),
        'analysts must see replay-finalize failures in the report warnings');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('honors a separate replayDir', async () => {
    const replayDir = mkdtempSync(join(tmpdir(), 'ch-replay-dir-'));
    try {
      writeFileSync(join(dir, 'P8.json'), participantFile('P8'));
      writeFileSync(join(replayDir, 'P8-replay-1751600000000.json'),
        JSON.stringify(recording('P8', 1751600000000)));
      const { participants } = await ingest({ ...config(), singleParticipant: 'P8', replayDir });
      assert.ok(participants[0].replay.recording);
    } finally { rmSync(replayDir, { recursive: true, force: true }); }
  });
});
