// tests/replay/persistence.test.js
// Artifact filename, integrityReplayMeta pointer, autosave dispatch, gzip.
//
// The v2 switchover moved every path this module READS: `metadata` dissolved
// into the top level and `ch_extensions` became `extensions["cyborg-hunter"]`.
// It moved nothing this module WRITES — the meta pointer is a stable contract
// with the CLI (ingest.js reads saved_to; html-index-core.js reads saved_to and
// falls back to the pointer when no artifact is on disk; extract-core.js carries
// the whole object through from the trial rows; docs/using-cyborg-hunter.md
// documents the keys to analysts). So the suite is built around a DIFFERENTIAL:
// the same session described in both wire formats must produce the same pointer
// bytes.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { gunzipSync } from 'node:zlib';
import {
  replayFilename, buildReplayMeta, autoSave, compressRecording,
} from '../../src/replay/persistence.js';

// ── the v1-era reference ────────────────────────────────────────────────────
// buildReplayMeta verbatim as it stood at 98b7f16, the last commit before the
// v2 switchover. It is the golden: the OUTPUT contract is checked against what
// v1 ACTUALLY produced, not against a literal transcribed from the new code
// (which would agree with any mistake the new code makes). Frozen — if v2 ever
// needs a different pointer, this reference stays and the test states the
// difference deliberately.
function buildReplayMetaV1Era(recording, savedTo) {
  return {
    schema_version: recording.schema_version,
    tier: recording.metadata.tier,
    saved_to: savedTo,
    bytes_uncompressed: JSON.stringify(recording).length,
    capture_failures: (recording.ch_extensions.capture_failures || [])
      .map(function (f) { return f.channel; }),
    capture_stopped: !!recording.ch_extensions.capture_stopped
  };
}

// One session, described once, rendered into both wire formats. The recordings
// differ in shape — that IS the test — so anything the pointer reads has to
// come out of two different places and land in the same slot.
function pair(scenario) {
  const s = {
    participantId: 'P1', tier: 'dom', startEpoch: 1751600000000,
    captureFailures: [], captureStopped: false, endReason: 'finished',
    ...scenario,
  };
  const startedAt = new Date(s.startEpoch).toISOString();
  return {
    v1: {
      schema_version: 1,
      metadata: {
        participant_id: s.participantId, tier: s.tier,
        start_time: startedAt, end_reason: s.endReason,
      },
      trials: [],
      ch_extensions: {
        capture_failures: s.captureFailures, capture_stopped: s.captureStopped,
      },
    },
    v2: {
      schema_version: 2,
      participant_id: s.participantId,
      recording_started_at: startedAt,
      end_reason: s.endReason,
      // Spec §5.7's top-level truncation flag, which mirrors the
      // `recording.capture_stopped` EVENT. The vendor boolean below is a
      // different thing: CH's own v1 diagnostic, carried under §9. Both come
      // off one recorder field at serializer.js:175 and :210, so an equivalent
      // session sets both.
      truncated: s.captureStopped,
      segments: [],
      extensions: {
        'cyborg-hunter': {
          tier: s.tier,
          capture_failures: s.captureFailures,
          capture_stopped: s.captureStopped,
        },
      },
    },
  };
}

// The recording used by the autosave/filename tests: the v2 side of a plain
// session, with overrides applied on top.
function recording(overrides) {
  return { ...pair({}).v2, ...overrides };
}

// The pointer's bytes, with the two RECORDING-DERIVED values blanked.
//
// `schema_version` is a pass-through of the recording's own version and
// `bytes_uncompressed` is a measurement of its length: a v2 file is a
// different document, so both differ by construction and pinning them across
// formats would pin nothing (their derivations are pinned separately below).
// Everything else is compared as BYTES — key order included, because
// JSON.stringify writes insertion order and the pointer's whole life is spent
// as one JSON string in a CSV cell.
function pointerBytes(meta) {
  return JSON.stringify(meta, (k, v) =>
    (k === 'schema_version' || k === 'bytes_uncompressed') ? '<derived>' : v);
}

const SAVED_TO = 'datapipe:ABC/P1-replay-1751600000000.json';

// The same string as a literal, so the contract is readable without executing
// the reference and a key-order or key-name change fails with a diff a human
// can read. Its capture_failures row carries `observed_root` because Task 6's
// I-1 fix made a misconfigured capture root report itself through exactly this
// channel — the newest producer of a value the CLI displays.
const GOLDEN_POINTER =
  '{"schema_version":"<derived>",' +
  '"tier":"dom",' +
  `"saved_to":"${SAVED_TO}",` +
  '"bytes_uncompressed":"<derived>",' +
  '"capture_failures":["observed_root","mutations"],' +
  '"capture_stopped":true}';

const GOLDEN_SCENARIO = {
  captureStopped: true,
  captureFailures: [
    { channel: 'observed_root', message: 'root selector "#stage" matched nothing', t: 12 },
    { channel: 'mutations', message: 'observer threw', t: 340 },
  ],
};

describe('replayFilename', () => {
  it('builds <pid>-replay-<epochMs>.json from the v2 top-level fields', () => {
    assert.strictEqual(replayFilename(recording()), 'P1-replay-1751600000000.json');
  });

  it('sanitizes participant ids for filesystem safety', () => {
    const rec = recording({ participant_id: 'p/1:weird id' });
    assert.strictEqual(replayFilename(rec), 'p_1_weird_id-replay-1751600000000.json');
  });

  it('names the same file for a v1 and a v2 recording of the same session', () => {
    // The v1-era builder read metadata.participant_id/start_time; the CLI
    // matches artifacts with an anchored ^<sane>-replay-\d+\.json$ regex
    // (ingest.js), so a filename drift at the switchover would silently
    // orphan every artifact.
    const { v1, v2 } = pair({ participantId: 'sub 12', startEpoch: 1700000001234 });
    const v1Name = 'sub_12-replay-' + Date.parse(v1.metadata.start_time) + '.json';
    assert.strictEqual(replayFilename(v2), v1Name);
  });

  it('degrades to a literal "null" prefix when participant_id is absent', () => {
    // Spec §2 made participant_id nullable ([NEW]); v1's metadata field was
    // always a string. sanitizeId stringifies, so the artifact is still named
    // and still matches the CLI's pattern — it just cannot be attributed. Worth
    // knowing rather than discovering from an unattached artifact.
    assert.strictEqual(replayFilename(recording({ participant_id: null })),
      'null-replay-1751600000000.json');
  });
});

describe('buildReplayMeta — the OUTPUT contract (byte-stable across the v2 move)', () => {
  it('matches the v1-era pointer byte for byte, key order included', () => {
    const { v1, v2 } = pair(GOLDEN_SCENARIO);
    assert.strictEqual(
      pointerBytes(buildReplayMeta(v2, SAVED_TO)),
      pointerBytes(buildReplayMetaV1Era(v1, SAVED_TO)));
  });

  it('matches the written-out golden (readable form of the same claim)', () => {
    const { v2 } = pair(GOLDEN_SCENARIO);
    assert.strictEqual(pointerBytes(buildReplayMeta(v2, SAVED_TO)), GOLDEN_POINTER);
  });

  it('and the v1-era reference produces that same golden (the oracle is honest)', () => {
    const { v1 } = pair(GOLDEN_SCENARIO);
    assert.strictEqual(pointerBytes(buildReplayMetaV1Era(v1, SAVED_TO)), GOLDEN_POINTER);
  });

  // Every scenario the pointer distinguishes, differentially. Each row moves at
  // least one of the four keys whose READ PATH changed.
  const SCENARIOS = [
    ['a clean session', {}],
    ['capture failures', { captureFailures: [{ channel: 'scroll', message: 'x' }] }],
    ['the observed_root channel', GOLDEN_SCENARIO],
    ['a truncated recording', { captureStopped: true }],
    ['trace tier', { tier: 'trace' }],
    ['a duplicated channel (no dedup — one entry per failure)', {
      captureFailures: [{ channel: 'mutations' }, { channel: 'mutations' }],
    }],
  ];
  for (const [name, scenario] of SCENARIOS) {
    it(`agrees with the v1-era pointer for ${name}`, () => {
      const { v1, v2 } = pair(scenario);
      assert.strictEqual(
        pointerBytes(buildReplayMeta(v2, 'none')),
        pointerBytes(buildReplayMetaV1Era(v1, 'none')));
    });
  }

  it('measures bytes_uncompressed over the whole recording', () => {
    // One of the two values the differential blanks. Not part of the moved read
    // paths, but part of the pointer, so its derivation is pinned here instead.
    const rec = recording({ segments: [{ index: 0, events: [] }] });
    assert.strictEqual(buildReplayMeta(rec, 'none').bytes_uncompressed,
      JSON.stringify(rec).length);
  });

  it("passes the recording's own schema_version through, rather than assuming 2", () => {
    // The other blanked value, and the one whose first pin did not bite: every
    // fixture in this file is schema_version 2, so `=== 2` is satisfied by a
    // hard-coded 2 in the builder (Task 7 review I-1 injected exactly that and
    // all 417 tests passed). A sentinel is the only version of this assertion
    // that can fail. The pointer states the version of the file it points AT,
    // which is what makes it useful next to a v1 artifact.
    const sentinel = recording({ schema_version: 7 });
    assert.strictEqual(buildReplayMeta(sentinel, 'none').schema_version, 7);
  });

  it('reads capture_stopped from the standard top-level flag, not the vendor mirror', () => {
    // The serializer writes both from one field, so they agree in practice.
    // Reading the standard one is what keeps the pointer meaningful for a v2
    // recording produced by someone other than CH — pinned by making them
    // disagree, which nothing else in the suite can do.
    const { v2 } = pair({});
    v2.truncated = true;
    v2.extensions['cyborg-hunter'].capture_stopped = false;
    assert.strictEqual(buildReplayMeta(v2, 'none').capture_stopped, true);
  });

  it('survives a v2 recording with no CH vendor namespace at all', () => {
    // buildReplayMeta is exported from index.js, so a researcher can point it
    // at any v2 file. Nothing CH-specific is then knowable, but the six keys
    // still have to be there — a missing key reads as a corrupt CSV cell to
    // the CLI, where a null reads as "not recorded".
    const foreign = {
      schema_version: 2, participant_id: 'X', recording_started_at: new Date(0).toISOString(),
      truncated: false, segments: [],
    };
    const meta = buildReplayMeta(foreign, 'none');
    assert.deepStrictEqual(Object.keys(meta), [
      'schema_version', 'tier', 'saved_to', 'bytes_uncompressed',
      'capture_failures', 'capture_stopped',
    ]);
    assert.strictEqual(meta.tier, null);
    assert.deepStrictEqual(meta.capture_failures, []);
    assert.strictEqual(meta.capture_stopped, false);
  });
});

describe('autoSave dispatch (v2 recordings)', () => {
  beforeEach(() => {
    delete globalThis.window;
    delete globalThis.document;
  });

  it('datapipe mode prefers window.jsPsychPipe.saveData', async () => {
    const calls = [];
    globalThis.window = {
      jsPsychPipe: { saveData: async (expId, filename, data) => calls.push({ expId, filename, len: data.length }) },
    };
    const result = await autoSave(recording(), { mode: 'datapipe', experimentId: 'EXP9' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].expId, 'EXP9');
    assert.strictEqual(calls[0].filename, 'P1-replay-1751600000000.json');
    assert.match(result.saved_to, /^datapipe:EXP9\/P1-replay/);
  });

  it('sends the recording verbatim — the payload is the file, not a projection', async () => {
    // autoSave is schema-agnostic: it stringifies whatever it is handed. Pinned
    // against a v2 recording carrying the shapes v1 never had (segments with a
    // DomNode keyframe, the vendor namespace), because "schema-agnostic" is a
    // claim about this function and the switchover is when it would break.
    let sent = null;
    globalThis.window = {
      jsPsychPipe: { saveData: async (_id, _fn, data) => { sent = data; } },
    };
    const rec = recording({
      segments: [{
        index: 0, label: 'r1', initial_dom: { id: 1, kind: 'element', tag: 'body', attrs: {}, children: [] },
        events: [{ t: 1.5, type: 'mouse.move', x: 3, y: 4 }],
      }],
    });
    await autoSave(rec, { mode: 'datapipe', experimentId: 'EXP9' });
    assert.strictEqual(sent, JSON.stringify(rec));
    assert.deepStrictEqual(JSON.parse(sent), rec);
  });

  it('datapipe mode falls back to fetch POST when jsPsychPipe is absent', async () => {
    const posts = [];
    globalThis.window = {
      fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
    };
    const result = await autoSave(recording(), { mode: 'datapipe', experimentId: 'EXP9' });
    assert.strictEqual(posts.length, 1);
    assert.match(posts[0].url, /pipe\.jspsych\.org/);
    assert.strictEqual(posts[0].body.experimentID, 'EXP9');
    assert.strictEqual(posts[0].body.filename, 'P1-replay-1751600000000.json');
    assert.match(result.saved_to, /^datapipe:/);
  });

  it('datapipe failure reports saved_to "failed" without throwing', async () => {
    globalThis.window = {
      jsPsychPipe: { saveData: async () => { throw new Error('quota'); } },
    };
    const result = await autoSave(recording(), { mode: 'datapipe', experimentId: 'EXP9' });
    assert.strictEqual(result.saved_to, 'failed');
    assert.match(result.error, /quota/);
  });

  it('datapipe mode without experimentId fails loudly in the result', async () => {
    globalThis.window = {};
    const result = await autoSave(recording(), { mode: 'datapipe' });
    assert.strictEqual(result.saved_to, 'failed');
    assert.match(result.error, /experimentId/);
  });

  it('download mode clicks a temporary object-URL anchor', async () => {
    const clicks = [];
    globalThis.window = {
      URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
      Blob: class { constructor(parts) { this.size = String(parts[0]).length; } },
    };
    globalThis.document = {
      createElement: () => ({ click() { clicks.push(this.download); }, set href(v) { this._h = v; }, get href() { return this._h; } }),
      body: { appendChild() {}, removeChild() {} },
    };
    const result = await autoSave(recording(), { mode: 'download' });
    assert.strictEqual(clicks.length, 1);
    assert.strictEqual(clicks[0], 'P1-replay-1751600000000.json');
    assert.strictEqual(result.saved_to, 'download');
  });

  it('mode "none" saves nothing and says so', async () => {
    const result = await autoSave(recording(), { mode: 'none' });
    assert.strictEqual(result.saved_to, 'none');
  });
});

describe('compressRecording', () => {
  beforeEach(() => {
    delete globalThis.window;
  });

  it('gzips a v2 recording and round-trips it byte for byte', async () => {
    // The other schema-agnostic path. A gzip that loses a byte is invisible
    // until an analyst opens the artifact months later, so the check is the
    // whole file back out, not just a plausible blob.
    const rec = recording({
      segments: [{
        index: 0, label: 'r1',
        initial_dom: { id: 1, kind: 'element', tag: 'body', attrs: {}, children: [] },
        initial_state: null, events: [{ t: 0.5, type: 'key.down', key: 'a' }],
      }],
    });
    const blob = await compressRecording(rec);
    assert.strictEqual(blob.type, 'application/gzip');
    const bytes = Buffer.from(await blob.arrayBuffer());
    assert.deepStrictEqual(JSON.parse(gunzipSync(bytes).toString('utf8')), rec);
  });
});
