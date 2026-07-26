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

function wireRecording() {
  return {
    schema_version: 1,
    metadata: {
      participant_id: 'P1', tier: 'dom', keys: 'full',
      start_time: new Date(1751600000000).toISOString(),
      end_time: new Date(1751600060000).toISOString(),
      end_reason: 'finished', recorder: 'cyborg-hunter-replay@0.7.0',
    },
    viewport: { width: 1280, height: 800, dpr: 2, visual_viewport: null },
    stylesheets: { initial: [{ css: '.a{color:red}' }], events: [] },
    rng_calls: [],
    trials: [{
      trial_index: 0, trial_id: 'rule-1', plugin: 'html-button-response',
      t_start: null, t_dom_ready: null, t_load: 1000, t_end: 6000,
      initial_dom: '<div id="stim">Which card?</div>',
      events: [
        { t: 1500, kind: 'mousemove', x: 10, y: 20 },
        { t: 2000, kind: 'paste', len: 42 },
        { t: 5500, kind: 'mutation', op: 'childList', path: [], html: '<p>done</p>' },
      ],
      trial_data: {},
    }],
    ch_extensions: {
      scoring: { soft_score: 3, any_hard_triggered: false },
      capture_failures: [{ channel: 'scroll', message: 'x', t: 100 }],
      capture_stopped: false,
      guard_violations: [],
    },
  };
}

describe('buildViewerModel', () => {
  it('converts event times to trial-relative and carries tier/scoring', () => {
    const m = buildViewerModel(wireRecording());
    assert.strictEqual(m.pid, 'P1');
    assert.strictEqual(m.tier, 'dom');
    assert.strictEqual(m.trials.length, 1);
    const t = m.trials[0];
    assert.strictEqual(t.durMs, 5000);                    // t_end − t_load
    assert.strictEqual(t.events[0].t, 500);               // 1500 − 1000
    assert.strictEqual(t.events[1].kind, 'paste');
    assert.strictEqual(t.initialDom, '<div id="stim">Which card?</div>');
    assert.strictEqual(m.scoring.soft_score, 3);
    assert.deepStrictEqual(m.captureFailures, ['scroll']);
    assert.strictEqual(m.stylesheets[0].css, '.a{color:red}');
  });

  it('guards null t_load on standalone implicit trials', () => {
    const rec = wireRecording();
    rec.trials[0].t_load = null;                          // hostile input
    rec.trials[0].t_end = null;
    const m = buildViewerModel(rec);
    assert.ok(Number.isFinite(m.trials[0].durMs), 'durMs must never be NaN');
    assert.ok(m.trials[0].events.every(e => Number.isFinite(e.t)));
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
      const recA = wireRecording(); recA.metadata.participant_id = 'a/b';
      const recB = wireRecording(); recB.metadata.participant_id = 'a_b';
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
      rec.trials[0].initial_dom = '<div></script><script>alert(1)</script></div>';
      renderReplayAssets([{ participantId: 'PX', replay: { recording: rec, file: 'x', meta: null } }], sub);
      const src = readFileSync(join(sub, 'replay', 'PX.replay.js'), 'utf8');
      assert.ok(!src.includes('</script>'), 'no literal </script> in the asset');
      const w = {};
      new Function('window', src)(w);
      assert.match(w.__chReplay['PX'].trials[0].initialDom, /<\/script>/ig ? /script/ : /script/,
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
