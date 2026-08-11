// tests/replay/persistence.test.js
// Artifact filename, integrityReplayMeta pointer, autosave dispatch.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  replayFilename, buildReplayMeta, autoSave,
} from '../../src/replay/persistence.js';

// A v2 recording (spec §2). Task 6 moved the paths persistence reads —
// `metadata` dissolved into the top level and `ch_extensions` became
// `extensions["cyborg-hunter"]` — in lockstep with the serializer; the meta
// pointer's own OUTPUT shape is unchanged and stays Task 7's contract.
function recording(overrides) {
  return {
    schema_version: 2,
    participant_id: 'P1',
    recording_started_at: new Date(1751600000000).toISOString(),
    end_reason: 'finished',
    truncated: false,
    segments: [],
    extensions: {
      'cyborg-hunter': { tier: 'dom', capture_failures: [], capture_stopped: false },
    },
    ...overrides,
  };
}

describe('replayFilename', () => {
  it('builds <pid>-replay-<epochMs>.json from the recording metadata', () => {
    assert.strictEqual(replayFilename(recording()), 'P1-replay-1751600000000.json');
  });

  it('sanitizes participant ids for filesystem safety', () => {
    const rec = recording();
    rec.participant_id = 'p/1:weird id';
    assert.strictEqual(replayFilename(rec), 'p_1_weird_id-replay-1751600000000.json');
  });
});

describe('buildReplayMeta', () => {
  it('summarizes the recording and where it went', () => {
    const rec = recording();
    rec.extensions['cyborg-hunter'].capture_failures = [{ channel: 'scroll', message: 'x' }];
    const meta = buildReplayMeta(rec, 'datapipe:ABC/P1-replay-1751600000000.json');
    assert.strictEqual(meta.schema_version, 2);
    assert.strictEqual(meta.tier, 'dom');
    assert.strictEqual(meta.saved_to, 'datapipe:ABC/P1-replay-1751600000000.json');
    assert.ok(meta.bytes_uncompressed > 100);
    assert.deepStrictEqual(meta.capture_failures, ['scroll']);
    assert.strictEqual(meta.capture_stopped, false);
  });
});

describe('autoSave dispatch', () => {
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
