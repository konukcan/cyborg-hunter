// tests/cli/replay-render.test.js
// Viewer model conversion (wire → trial-relative), JSONP asset emission,
// html-index Replay section states, viewer client syntactic health.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildViewerModel, renderReplayAssets,
} from '../../src/cli/renderers/replay-assets.js';
import { renderHtmlIndex } from '../../src/cli/renderers/html-index.js';

// SessionRecording v2 (spec r2). Re-pointed from the v1 wire in T5 Task 1,
// when buildViewerModel became v2-only; Task 10 rewrites this file to cover
// all four replay-section states against v2 input.
function wireRecording() {
  return {
    schema_version: 2,
    recorder: { name: 'cyborg-hunter-replay', version: '0.7.5' },
    host: null,
    participant_id: 'P1',
    recording_started_at: new Date(1751600000000).toISOString(),
    recording_started_at_perf: 0,
    user_agent: 'test-agent',
    viewport: { w: 1280, h: 800, dpr: 2, scale: 1, offset_x: 0, offset_y: 0 },
    observed_root: null,
    stylesheets: [{ id: 1, kind: 'inline', css: '.a{color:red}', media: null }],
    stylesheet_events: [],
    viewport_changes: [],
    rng: null,
    rng_calls: null,
    ended_at_perf: 60000,
    end_reason: 'finished',
    truncated: false,
    segments: [{
      index: 0, label: 'rule-1', plugin: 'html-button-response',
      t_start: null, t_dom_ready: null, t_load: 1000, t_end: 6000,
      initial_dom: {
        id: 1, kind: 'element', tag: 'body', attrs: {}, children: [
          { id: 2, kind: 'element', tag: 'div', attrs: { id: 'stim' },
            children: [{ id: 3, kind: 'text', text: 'Which card?' }] },
        ],
      },
      initial_state: null,
      events: [
        { type: 'mouse.move', t: 1500, x: 10, y: 20 },
        { type: 'clipboard.paste', t: 2000, target: 2, len: 42, redacted: true },
        { type: 'dom.text', t: 5500, node: 3, text: 'done' },
      ],
      host_data: {}, extensions: null,
    }],
    extensions: {
      'cyborg-hunter': {
        replay_version: '0.7.5', tier: 'dom', keys: 'full',
        viewport_client: { w: 1265, h: 800 },
        scoring: { soft_score: 3, any_hard_triggered: false },
        capture_failures: [{ channel: 'scroll', message: 'x', t: 100 }],
        capture_stopped: false,
        guard_violations: [],
      },
    },
  };
}

describe('buildViewerModel', () => {
  it('converts event times to segment-relative and carries tier/scoring', () => {
    const m = buildViewerModel(wireRecording());
    assert.strictEqual(m.pid, 'P1');
    assert.strictEqual(m.tier, 'dom');
    assert.strictEqual(m.foreign, false);
    assert.strictEqual(m.segments.length, 1);
    const s = m.segments[0];
    assert.strictEqual(s.durMs, 5000);                    // t_end − origin
    assert.strictEqual(s.events[0].t, 500);               // 1500 − 1000
    assert.strictEqual(s.events[1].type, 'clipboard.paste');
    assert.strictEqual(s.initialDom.tag, 'body');         // a DomNode tree, not markup
    assert.strictEqual(m.scoring.soft_score, 3);
    assert.deepStrictEqual(m.captureFailures, ['scroll']);
    assert.strictEqual(m.stylesheets[0].css, '.a{color:red}');
  });

  it('guards a segment stating no anchor at all', () => {
    const rec = wireRecording();
    rec.segments[0].t_load = null;                        // hostile input
    rec.segments[0].t_end = null;
    const m = buildViewerModel(rec);
    assert.strictEqual(m.segments[0].origin, 1500, 'falls back to the first event');
    assert.ok(Number.isFinite(m.segments[0].durMs), 'durMs must never be NaN');
    assert.ok(m.segments[0].events.every(e => Number.isFinite(e.t)));
  });
});

describe('renderReplayAssets', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ch-replay-assets-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes JSONP-style per-participant files and reports totals', () => {
    const participants = [
      { participantId: 'P1', replay: { recording: wireRecording(), file: 'x.json', meta: null } },
      { participantId: 'P2', replay: null },
    ];
    const res = renderReplayAssets(participants, dir);
    assert.strictEqual(res.count, 1);
    assert.ok(res.totalBytes > 200);
    const files = readdirSync(join(dir, 'replay'));
    assert.deepStrictEqual(files, ['P1.replay.js']);
    // The file must be executable JS assigning into window.__chReplay
    const src = readFileSync(join(dir, 'replay', 'P1.replay.js'), 'utf8');
    const windowStub = {};
    new Function('window', src)(windowStub);
    assert.ok(windowStub.__chReplay['P1']);
    assert.strictEqual(windowStub.__chReplay['P1'].tier, 'dom');
    assert.strictEqual(Object.getPrototypeOf(windowStub.__chReplay), null,
      'store must be null-prototype: a pid like "__proto__" must not pollute');
  });

  it('disambiguates colliding sanitized filenames and stamps assetPath', () => {
    const sub = mkdtempSync(join(tmpdir(), 'ch-replay-collide-'));
    try {
      const recA = wireRecording(); recA.participant_id = 'a/b';
      const recB = wireRecording(); recB.participant_id = 'a_b';
      const participants = [
        { participantId: 'a/b', replay: { recording: recA, file: 'x', meta: null } },
        { participantId: 'a_b', replay: { recording: recB, file: 'y', meta: null } },
      ];
      const res = renderReplayAssets(participants, sub);
      assert.strictEqual(res.count, 2);
      const files = readdirSync(join(sub, 'replay')).sort();
      assert.strictEqual(files.length, 2, 'colliding names must not overwrite');
      assert.notStrictEqual(participants[0].replay.assetPath, participants[1].replay.assetPath);
      // each asset defines its OWN raw pid key
      for (const p of participants) {
        const src = readFileSync(join(sub, p.replay.assetPath), 'utf8');
        const w = {};
        new Function('window', src)(w);
        assert.ok(w.__chReplay[p.participantId], `store key for ${p.participantId}`);
      }
    } finally { rmSync(sub, { recursive: true, force: true }); }
  });

  it('writes nothing when no participant has a replay', () => {
    const sub = mkdtempSync(join(tmpdir(), 'ch-replay-none-'));
    try {
      const res = renderReplayAssets([{ participantId: 'X', replay: null }], sub);
      assert.strictEqual(res.count, 0);
      assert.ok(!existsSync(join(sub, 'replay')));
    } finally { rmSync(sub, { recursive: true, force: true }); }
  });
});

describe('html-index replay section', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ch-replay-html-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  function baseTriage(pid) {
    return [{
      participantId: pid, score: 0, reason: 'clean', hardTriggered: false,
      softFlagged: false, edgeExitCount: 0,
      summary: { participantId: pid, trialCount: 1 },
    }];
  }

  async function render(participant) {
    const config = { outputDir: dir };
    await renderHtmlIndex(
      [participant.summary || { participantId: participant.participantId, trialCount: 1 }],
      baseTriage(participant.participantId),
      [participant], config, false);
    return readFileSync(join(dir, 'index.html'), 'utf8');
  }

  it('renders a lazy-loading replay block when a recording is attached', async () => {
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { recording: wireRecording(), file: 'x.json', meta: null },
    });
    assert.match(html, /Session replay/);
    assert.match(html, /data-replay-src="replay\/P1\.replay\.js"/);
    assert.match(html, /initChReplayViewer/, 'viewer client must be embedded');
  });

  it('renders a corruption note for parse-failed artifacts', async () => {
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { error: 'parse_failed', reason: 'unexpected end of JSON', file: 'x.json' },
    });
    assert.match(html, /Replay artifact corrupted/i);
  });

  it('renders a placeholder with the saved_to reason when absent', async () => {
    const html = await render({
      participantId: 'P1',
      trials: [{ integrityReplayMeta: { saved_to: 'download', tier: 'dom' } }],
      replay: null,
    });
    assert.match(html, /No replay artifact/i);
    assert.match(html, /download/i, 'saved_to reason surfaces to the analyst');
  });
});

describe('viewer client file', () => {
  it('is syntactically valid and defines initChReplayViewer', () => {
    const src = readFileSync(
      new URL('../../src/cli/renderers/replay-viewer.client.js', import.meta.url), 'utf8');
    assert.doesNotThrow(() => new Function(src));
    assert.match(src, /window\.initChReplayViewer\s*=/);
  });

  it('escapes < in JSONP payloads (script-breakout proofing)', () => {
    const sub = mkdtempSync(join(tmpdir(), 'ch-replay-esc-'));
    try {
      const rec = wireRecording();
      // v2 carries the hostile string as DomNode TEXT, never as markup — the
      // reconstruction is instantiated, not parsed. The JSONP escape is still
      // required: the asset is a <script> in the report.
      rec.segments[0].initial_dom.children[0].children[0].text =
        '</script><script>alert(1)</script>';
      renderReplayAssets([{ participantId: 'PX', replay: { recording: rec, file: 'x', meta: null } }], sub);
      const src = readFileSync(join(sub, 'replay', 'PX.replay.js'), 'utf8');
      assert.ok(!src.includes('</script>'), 'no literal </script> in the asset');
      const w = {};
      new Function('window', src)(w);
      assert.strictEqual(
        w.__chReplay['PX'].segments[0].initialDom.children[0].children[0].text,
        '</script><script>alert(1)</script>',
        'payload still decodes to the original content');
    } finally { rmSync(sub, { recursive: true, force: true }); }
  });

  it('viewer frame is non-interactive and CSP blocks forms/frames/connect', () => {
    const src = readFileSync(
      new URL('../../src/cli/renderers/replay-viewer.client.js', import.meta.url), 'utf8');
    assert.match(src, /pointer-events\s*:?\s*none|pointerEvents\s*=\s*'none'/i,
      'iframe must be non-interactive (clicks inside the reconstruction act on live untrusted DOM)');
    assert.match(src, /form-action 'none'/);
    assert.match(src, /frame-src 'none'/);
    assert.match(src, /connect-src 'none'/);
    assert.match(src, /base-uri 'none'/);
    // External stylesheets load only behind the analyst's explicit opt-in
    // (default-safe): the <link> emission must be gated by allowExternalCss.
    assert.match(src, /allowExternalCss && sheet\.href/,
      'external stylesheet links must be gated by the opt-in flag');
    assert.match(src, /allowExternalCss = false/,
      'the opt-in must default to off');
  });

  it('hardens the srcdoc reconstruction with a CSP + no-referrer meta', () => {
    const src = readFileSync(
      new URL('../../src/cli/renderers/replay-viewer.client.js', import.meta.url), 'utf8');
    assert.match(src, /Content-Security-Policy/,
      'recorded DOM is untrusted — the srcdoc must carry a restrictive CSP');
    assert.match(src, /default-src 'none'/);
    assert.match(src, /no-referrer/);
  });
});
