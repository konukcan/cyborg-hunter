import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { renderHtmlIndex } from '../../src/cli/renderers/html-index.js';

describe('renderHtmlIndex (cohort-triage redesign)', () => {
  const outDir = '/tmp/cyborg-hunter-html-test';

  function buildFixture() {
    // Minimal hand-built triage/summary/participants arrays. The renderer
    // should not read anything not present here; if it does, it's pulling
    // fields outside the documented contract.
    const participants = [
      {
        participantId: 'P-HARD',
        trials: [{
          trialId: 't1',
          pasteEvents: [{ t: 100, text: 'pasted essay here — suspicious content' }]
        }],
        session: {
          aiExtensionsFound: [{ name: 'ChatGPT Sidebar' }],
          sidebarEvents: [{ t: 12000, type: 'opened', deltaIW: 312 }],
          keyboardShortcuts: []
        }
      },
      { participantId: 'P-SOFT',  trials: [{ trialId: 't1', pasteEvents: [] }], session: {} },
      { participantId: 'P-CLEAN', trials: [{ trialId: 't1', pasteEvents: [] }], session: {} },
      // P-LEGACY exercises three edge cases at once that pilot data routinely hits:
      //   - session field absent entirely (Shape-2 legacy data)
      //   - trial uses ruleId instead of trialId (also Shape-2)
      //   - paste text is a non-string (numeric, e.g. from a malformed source)
      // The renderer must render this without throwing or showing [undefined].
      {
        participantId: 'P-LEGACY',
        trials: [
          { ruleId: 'r1', pasteEvents: [{ t: 50, text: 42 }] },
          { trialId: 't2', pasteEvents: [] }
        ]
        // session: omitted on purpose — participants[i].session may be null/undefined
      }
    ];

    const summary = (pid, overrides = {}) => ({
      participantId: pid,
      trialCount: 1,
      totalPasteEvents: 0, totalCopyEvents: 0, totalDropEvents: 0,
      totalTabAways: 0, tabAwayFlickerCount: 0, tabAwayMediumCount: 0, tabAwayLongCount: 0,
      totalTabAwayDuration_ms: 0, trialsWithTabAway: 0,
      meanTypingSpeed: 0, trialsWithFastTyping: 0,
      meanMouseEvents: 0, meanPathEfficiency: 0,
      extensionsDetected: [], sidebarDetected: false,
      totalIdleGaps: 0, totalSyntheticInsertions: 0, totalForeignInputEvents: 0,
      totalSoftScore: 0, authoritativeSoftScore: null,
      sidebarEventCount: 0, aiExtensionsFound: [],
      keyboardShortcutCount: 0, layoutShiftCount: 0, zoomChangeCount: 0,
      extensionInjectionCount: 0, devToolsEventCount: 0,
      hardTriggered: false, metadata: {},
      ...overrides
    });

    const summaries = [
      summary('P-HARD', {
        totalPasteEvents: 1, hardTriggered: true,
        aiExtensionsFound: [{ name: 'ChatGPT Sidebar' }],
        sidebarEventCount: 1
      }),
      summary('P-SOFT', {
        totalTabAways: 3, tabAwayLongCount: 3,
        totalSoftScore: 9, authoritativeSoftScore: 9
      }),
      summary('P-CLEAN'),
      summary('P-LEGACY', { totalPasteEvents: 1 })  // 1 paste (scores 5); no tier flags → clean tier
    ];

    // Scores follow the current decomposeScore policy (paste×5, copy×5,
    // sidebar×3, tab-away≥3s×1) so the rendered breakdown terms sum to Total:
    //   P-HARD   = 1 paste×5 + 1 sidebar×3                 = 8
    //   P-SOFT   = 3 tab-aways ≥10s ×1                     = 3
    //   P-CLEAN  = no signals                              = 0
    //   P-LEGACY = 1 paste×5                               = 5
    // Note P-HARD is still hard-TIERED (hardTriggered) even though hard-trigger
    // no longer boosts the numeric score.
    const triage = [
      { participantId: 'P-HARD',  score: 8,  reason: '1 paste event; ChatGPT Sidebar detected; 1 sidebar event',
        hardTriggered: true,  softFlagged: false, summary: summaries[0], edgeExitCount: 0 },
      { participantId: 'P-SOFT',  score: 3,  reason: '3 tab-aways ≥10s',
        hardTriggered: false, softFlagged: true,  summary: summaries[1], edgeExitCount: 0 },
      { participantId: 'P-CLEAN', score: 0,  reason: 'clean',
        hardTriggered: false, softFlagged: false, summary: summaries[2], edgeExitCount: 0 },
      { participantId: 'P-LEGACY', score: 5, reason: '1 paste event',
        hardTriggered: false, softFlagged: false, summary: summaries[3], edgeExitCount: 0 }
    ];

    return { participants, summaries, triage };
  }

  it('renders a 4-participant hard/soft/clean/legacy mix with all expected structure', async () => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const { participants, summaries, triage } = buildFixture();

    await renderHtmlIndex(summaries, triage, participants, { outputDir: outDir }, true);

    const html = readFileSync(join(outDir, 'index.html'), 'utf8');

    // Structural
    assert.ok(html.includes('Cyborg Hunter Report'), 'title');
    assert.ok(html.includes('id="legend-modal"'), 'legend modal present');
    assert.ok(html.includes('id="lightbox"'), 'lightbox present');
    assert.ok(html.includes('data-pid='), 'cohort rows carry data-pid');
    assert.ok(html.includes('data-tier='), 'cohort rows carry data-tier');
    assert.ok(html.includes('data-score='), 'cohort rows carry data-score');

    // Per-participant ids and tiers
    for (const pid of ['P-HARD', 'P-SOFT', 'P-CLEAN']) {
      assert.ok(html.includes(pid), `${pid} id appears`);
    }
    assert.ok(html.includes('data-tier="hard"'),  'hard tier row');
    assert.ok(html.includes('data-tier="soft"'),  'soft tier row');
    assert.ok(html.includes('data-tier="clean"'), 'clean tier row');

    // Detail content
    assert.ok(html.includes('pasted essay here'), 'paste evidence text rendered');
    assert.ok(html.includes('ChatGPT Sidebar'),   'session signals AI extension rendered');

    // Signal grid: every detail pane should render a stable 16-tile census.
    // Critical-tone class fires for P-HARD (paste + AI extension are critical signals).
    assert.ok(html.includes('class="signal-grid"'), 'signal grid renders');
    assert.ok(/signal-tile\s+tone-critical/.test(html), 'critical-tone tile fires for P-HARD signals');
    // Sanity: a tone-zero tile also exists somewhere (every pane has misses too).
    assert.ok(/signal-tile\s+tone-zero/.test(html), 'tone-zero tile renders for unfired signals');

    // Score breakdown: weighted contributions (only non-zero) ending in Total: N.
    // Sourced from decomposeScore so the displayed terms always sum to t.score.
    // P-HARD scores paste (1×5) + sidebar (1×3) = 8 under the current policy.
    assert.ok(/paste[^0-9]*\+?\s*5/i.test(html), 'score breakdown shows paste +5 term');
    assert.ok(/sidebar[^0-9]*\+?\s*3/i.test(html), 'score breakdown shows sidebar +3 term');
    assert.ok(/Total:\s*8/.test(html), 'P-HARD detail pane shows Total: 8');

    // Image wiring — filenames must use sanitize(participantId)
    assert.ok(html.includes('images/trajectories_P-HARD.png'),   'trajectories image reference');
    assert.ok(html.includes('images/session_timeline_P-HARD.png'),   'session-timeline image reference');
    assert.ok(html.includes('images/typing_profile_P-HARD.png'), 'typing-profile image reference');

    // P-LEGACY edge cases: missing session, ruleId fallback, non-string paste text
    assert.ok(html.includes('P-LEGACY'), 'legacy participant rendered');
    assert.ok(/\[r1\]/.test(html), 'ruleId fallback shows in paste evidence when trialId is absent');
    // Numeric paste text (42) must coerce to a string for safe rendering, not crash.
    // Proximity check: [r1] and 42 must appear within ~300 chars of each other —
    // loose enough to allow the natural three-span paste-entry markup but tight
    // enough to ensure they're in the same paste entry.
    assert.ok(/\[r1\][\s\S]{0,300}42/.test(html), 'numeric paste text is coerced to string');
  });

  it('handles visualsRendered=false by collapsing image sections', async () => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const { participants, summaries, triage } = buildFixture();

    await renderHtmlIndex(summaries, triage, participants, { outputDir: outDir }, false);

    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    assert.ok(html.includes('Visual renderers not available'), 'fallback note present');
    assert.ok(!html.includes('images/trajectories_'), 'no trajectory image refs');
    assert.ok(!html.includes('images/tab_timeline_'), 'no tab-timeline refs');
    assert.ok(!html.includes('images/typing_profile_'), 'no typing-profile refs');
  });
});

// 0.6.1 — retro item 8: platform (Prolific/MTurk) ID as a secondary line in
// the participant detail header, behind showPlatformId (default OFF, privacy).
describe('renderHtmlIndex — platform ID line (0.6.1)', () => {
  const outDir = '/tmp/cyborg-hunter-html-platform-test';

  const participants = [{
    participantId: 'SID-1',
    trials: [{ trialId: 't1', pasteEvents: [] }],
    session: {},
    metadata: { prolificPID: 'PROLIFIC-ABC-123' },
  }];
  const summaries = [{
    participantId: 'SID-1', trialCount: 1,
    totalPasteEvents: 0, totalCopyEvents: 0, totalDropEvents: 0,
    totalTabAways: 0, tabAwayFlickerCount: 0, tabAwayMediumCount: 0, tabAwayLongCount: 0,
    totalTabAwayDuration_ms: 0, trialsWithTabAway: 0,
    meanTypingSpeed: 0, trialsWithFastTyping: 0,
    meanMouseEvents: 0, meanPathEfficiency: 0,
    extensionsDetected: [], sidebarDetected: false,
    totalIdleGaps: 0, totalSyntheticInsertions: 0, totalForeignInputEvents: 0,
    totalSoftScore: 0, authoritativeSoftScore: null,
    sidebarEventCount: 0, aiExtensionsFound: [],
    keyboardShortcutCount: 0, layoutShiftCount: 0, zoomChangeCount: 0,
    extensionInjectionCount: 0, devToolsEventCount: 0,
    hardTriggered: false, metadata: {},
  }];
  const triage = [{
    participantId: 'SID-1', score: 0, reason: 'clean',
    hardTriggered: false, softFlagged: false, summary: summaries[0], edgeExitCount: 0,
  }];

  async function renderWith(config) {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    await renderHtmlIndex(summaries, triage, participants, { outputDir: outDir, ...config }, false);
    return readFileSync(join(outDir, 'index.html'), 'utf8');
  }

  it('OFF by default: platformIdField alone must not leak the platform ID', async () => {
    const html = await renderWith({ platformIdField: 'prolificPID' });
    assert.ok(!html.includes('PROLIFIC-ABC-123'), 'platform ID must not appear');
    assert.ok(!html.includes('platform ID:'), 'no platform line rendered');
  });

  it('renders the platform ID line when showPlatformId is true', async () => {
    const html = await renderWith({ platformIdField: 'prolificPID', showPlatformId: true });
    assert.ok(html.includes('platform ID: PROLIFIC-ABC-123'), 'platform line rendered');
  });

  it('showPlatformId without a mapped platformIdField renders nothing', async () => {
    const html = await renderWith({ showPlatformId: true });
    assert.ok(!html.includes('platform ID:'));
  });

  it('supports dotted platformIdField paths', async () => {
    participants[0].metadata = { platform: { pid: 'NESTED-99' } };
    const html = await renderWith({ platformIdField: 'platform.pid', showPlatformId: true });
    assert.ok(html.includes('platform ID: NESTED-99'));
    participants[0].metadata = { prolificPID: 'PROLIFIC-ABC-123' };
  });
});
