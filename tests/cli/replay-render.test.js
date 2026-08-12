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
// when buildViewerModel became v2-only; rewritten here (T5 Task 10) to cover
// all four replay-section states, the tier line, and the unloadable-artifact
// decision against v2 input.
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

// A foreign producer's v2 file: carries a keyframe but states no CH tier.
// The badge must be INFERRED structurally rather than defaulted to "trace"
// (design §10). It still carries the `cyborg-hunter` namespace, because the
// T4 converter stamps provenance there — presence of the namespace is not
// evidence about the producer.
function foreignRecording() {
  const rec = wireRecording();
  rec.recorder = { name: 'jspsych-record', version: '1.0.0' };
  rec.extensions = { 'cyborg-hunter': { converter: { tool: 'x', version: '1' } } };
  return rec;
}

// Trace tier under v2: `initial_dom: null` on every segment and no stated
// tier. Not a §3 defect — "null before any keyframe = trace-only so far".
function traceRecording() {
  const rec = foreignRecording();
  rec.segments[0].initial_dom = null;
  rec.segments[0].events = [{ type: 'mouse.move', t: 1500, x: 10, y: 20 }];
  return rec;
}

// A CH-v1 artifact. The §11 tolerant profile rejects it and buildViewerModel
// throws (there is no v1 playback path — design §12). What the CLI does when
// one reaches it is Task 10(b)'s decision, pinned below.
function v1Recording() {
  return {
    schema_version: 1,
    metadata: { participant_id: 'P1', tier: 'dom', recorder: 'cyborg-hunter-replay@0.7.0' },
    trials: [{ trial_id: 't1', initial_dom: '<body></body>', events: [] }],
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

  // ── Task 10(b): the buildViewerModel throw ────────────────────────────────
  // buildViewerModel throws on the §11 rejection set, and one unloadable
  // artifact must not cost a cohort its whole report. DECIDED: skip that
  // participant, stamp the failure where the report already has a state for
  // it (renderReplaySection's error branch), and keep going.
  it('skips an unloadable artifact and still writes the rest of the cohort', () => {
    const sub = mkdtempSync(join(tmpdir(), 'ch-replay-unloadable-'));
    try {
      const participants = [
        { participantId: 'BAD', replay: { recording: v1Recording(), file: 'BAD-replay-1.json', meta: null } },
        { participantId: 'GOOD', replay: { recording: wireRecording(), file: 'GOOD-replay-2.json', meta: null } },
      ];
      const res = renderReplayAssets(participants, sub);
      assert.strictEqual(res.count, 1, 'the healthy participant still gets an asset');
      assert.deepStrictEqual(readdirSync(join(sub, 'replay')), ['GOOD.replay.js']);
      assert.strictEqual(res.skipped.length, 1);
      assert.strictEqual(res.skipped[0].participantId, 'BAD');
      assert.match(res.skipped[0].reason, /schema_version/,
        'the §11 rejection reason travels, not a bare "failed"');
    } finally { rmSync(sub, { recursive: true, force: true }); }
  });

  it('stamps the skipped participant so the report can say why', () => {
    const sub = mkdtempSync(join(tmpdir(), 'ch-replay-stamp-'));
    try {
      const p = { participantId: 'BAD', replay: { recording: v1Recording(), file: 'BAD-replay-1.json', meta: null } };
      renderReplayAssets([p], sub);
      assert.strictEqual(p.replay.error, 'unloadable');
      assert.match(p.replay.reason, /schema_version must be the integer 2/);
      assert.strictEqual(p.replay.file, 'BAD-replay-1.json');
      assert.ok(!p.replay.recording,
        'the recording must be cleared, or the index renders a load button for an asset that was never written');
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

  async function renderAll(participants) {
    const config = { outputDir: dir };
    await renderHtmlIndex(
      participants.map(p => p.summary || { participantId: p.participantId, trialCount: 1 }),
      participants.flatMap(p => baseTriage(p.participantId)),
      participants, config, false);
    return readFileSync(join(dir, 'index.html'), 'utf8');
  }
  const render = (participant) => renderAll([participant]);

  // ── State 1: attached ─────────────────────────────────────────────────────
  it('renders a lazy-loading replay block when a recording is attached', async () => {
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { recording: wireRecording(), file: 'x.json', meta: null },
    });
    assert.match(html, /Session replay/);
    assert.match(html, /data-replay-src="replay\/P1\.replay\.js"/);
    assert.match(html, /initChReplayViewer/, 'viewer client must be embedded');
  });

  // ── The tier line (Task 10(a)) ────────────────────────────────────────────
  // v2 has no `metadata` block: the tier moved to
  // extensions['cyborg-hunter'].tier (serializer.js:145). Reading `metadata`
  // badged EVERY v2 recording "trace".
  it('reads the tier from the cyborg-hunter extension, not a v1 metadata block', async () => {
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { recording: wireRecording(), file: 'x.json', meta: null },
    });
    assert.match(html, /\(dom tier\)/);
    assert.doesNotMatch(html, /\(trace tier\)/);
  });

  it('infers the tier structurally for a foreign file that states none', async () => {
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { recording: foreignRecording(), file: 'x.json', meta: null },
    });
    assert.match(html, /\(dom tier\)/, 'a keyframe means a reconstruction exists');
  });

  it('badges a trace recording as trace', async () => {
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { recording: traceRecording(), file: 'x.json', meta: null },
    });
    assert.match(html, /\(trace tier\)/);
  });

  it('lets a stated tier win over the structural inference', async () => {
    const rec = wireRecording();
    rec.extensions['cyborg-hunter'].tier = 'trace';   // keyframe present, tier says trace
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { recording: rec, file: 'x.json', meta: null },
    });
    assert.match(html, /\(trace tier\)/);
  });

  // ── State 2: corrupted ────────────────────────────────────────────────────
  it('renders a corruption note for parse-failed artifacts', async () => {
    const html = await render({
      participantId: 'P1', trials: [{}],
      replay: { error: 'parse_failed', reason: 'unexpected end of JSON', file: 'x.json' },
    });
    assert.match(html, /Replay artifact corrupted/i);
  });

  // ── State 2b (Task 10(b)): unloadable, and the cohort survives it ─────────
  it('renders the unloadable note for a rejected artifact while the rest of the cohort loads', async () => {
    const participants = [
      { participantId: 'BAD', trials: [{}],
        replay: { recording: v1Recording(), file: 'BAD-replay-1.json', meta: null } },
      { participantId: 'GOOD', trials: [{}],
        replay: { recording: wireRecording(), file: 'GOOD-replay-2.json', meta: null } },
    ];
    // Real report order: assets first (report.js:149), index second (:156),
    // over the SAME participant array — which is how the stamp travels.
    renderReplayAssets(participants, dir);
    const html = await renderAll(participants);
    assert.match(html, /Replay artifact could not be loaded/i);
    assert.match(html, /schema_version must be the integer 2/);
    assert.match(html, /BAD-replay-1\.json/);
    assert.doesNotMatch(html, /Replay artifact corrupted \(schema_version/i,
      'a readable v1 file is not "corrupted" — say what actually happened');
    assert.match(html, /data-replay-src="replay\/GOOD\.replay\.js"/,
      'one unloadable artifact must not cost the cohort its report');
  });

  // ── State 3: absent, with the saved_to reason ─────────────────────────────
  it('renders a placeholder with the saved_to reason when absent', async () => {
    const html = await render({
      participantId: 'P1',
      trials: [{ integrityReplayMeta: { saved_to: 'download', tier: 'dom' } }],
      replay: null,
    });
    assert.match(html, /No replay artifact/i);
    assert.match(html, /download/i, 'saved_to reason surfaces to the analyst');
  });

  // ── State 4: nothing at all ───────────────────────────────────────────────
  it('says recording was not enabled when there is no artifact and no meta', async () => {
    const html = await render({ participantId: 'P1', trials: [{}], replay: null });
    assert.match(html, /recording was not enabled/i);
  });
});

describe('the inlined viewer client survives HTML parsing', () => {
  // The report inlines the whole assembled client into one <script> tag. An
  // HTML parser ends that tag at the FIRST "</script" in the text — including
  // one inside a comment or a string — so an unescaped occurrence truncates
  // the viewer mid-source and the report boots with a SyntaxError and no
  // player. Found by the revived e2e dogfood (T5 Task 10(c)): two of the v2
  // modules discuss "</script> breakouts" in their comments, so the report
  // shipped a viewer that could not parse. demo/replay-host.js already
  // neutralizes the sequence for its own inlining; the report did not.
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ch-replay-inline-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses as JavaScript when cut the way a browser cuts it', async () => {
    await renderHtmlIndex(
      [{ participantId: 'P1', trialCount: 1 }],
      [{ participantId: 'P1', score: 0, reason: 'clean', hardTriggered: false,
        softFlagged: false, edgeExitCount: 0, summary: { participantId: 'P1', trialCount: 1 } }],
      [{ participantId: 'P1', trials: [{}],
        replay: { recording: wireRecording(), file: 'x.json', meta: null } }],
      { outputDir: dir }, false);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    // Exactly the browser's rule: from the tag open to the first closer.
    const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script/g)].map(m => m[1]);
    const viewerBlock = blocks.find(b => b.includes('initChReplayViewer'));
    assert.ok(viewerBlock, 'the viewer client is inlined');
    assert.doesNotThrow(() => new Function(viewerBlock),
      'the inlined viewer must still be complete JavaScript after the parser cuts it');
    assert.match(viewerBlock, /window\.initChReplayViewer\s*=/,
      'the assignment that boots the viewer must be inside the surviving block');
    // The report's <style> block is a hand-kept copy of the viewer's rules, so
    // a renamed control loses its styling silently. `replay-trial-select` was
    // the v1 name; the client emits `replay-segment-select` since Task 4.
    assert.match(html, /\.replay-segment-select/, 'the report styles the control the client emits');
    assert.doesNotMatch(html, /\.replay-trial-select/, 'no rule for a class nothing emits');
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
