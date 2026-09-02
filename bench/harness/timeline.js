// =============================================================================
// timeline.js
//
// Bench harness entry point. Composes the full jsPsych timeline (vendored
// replay-test suite + custom grafted trials) and wires the cyborg-hunter
// extensions per the URL `guards` parameter:
//
//   guards=none      → cyborg-hunter only (signal collection, no deterrence)
//   guards=friction  → cyborg-hunter + guard-friction (deterrence, no bait)
//   guards=full      → cyborg-hunter + guard-friction + guard-honeypot
//
// Default is whatever `getGuardConfigFromUrl()` returns (currently `'full'`).
//
// jsPsych core + plugins + cyborg-hunter scripts are loaded via <script> tags
// in index.html and exposed as window globals. We read those globals here
// without importing them (they're not ES modules).
//
// Finalize order on `on_finish` MATTERS — per the cyborg-hunter README:
//   1. guard-friction    (stop deterrence first so the DOM is quiescent)
//   2. guard-honeypot    (attach the bait field data to the last trial)
//   3. cyborg-hunter     (write session report + score to data, then destroy)
//
// Entry trial: when friction is active, `jsPsychGuardFriction.entryTrial()`
// is pushed at the front of the timeline. It collects a real button click
// (user gesture) so the friction core can request fullscreen — fullscreen
// APIs are gated on a recent user gesture and silently fail otherwise.
//
// Per-trial extension wiring: we apply ALL active extensions to EVERY trial
// EXCEPT the entry trial (which has its own internal lifecycle and shouldn't
// be wrapped). The CH README pattern is `timeline.forEach(...)`; we skip
// index 0 when guards include friction.
//
// Timeline reorder (2026-05-14 redesign): the vendored replay-test-suite
// includes a survey-multi-choice trial and places its survey-text demographics
// trial in the middle of the timeline. We:
//   - drop survey-multi-choice unconditionally (ALWAYS_FILTERED)
//   - filter bot-incompatible trials when ?bot-mode=1 (BOT_INCOMPATIBLE_TRIALS)
//   - splice the upstream demographics survey-text to the END, just before
//     exit-fullscreen, so it's the last data-collection step
//   - insert two custom grafted trials (describe-card, recording) between the
//     pre-demographics block and demographics itself
// We assert the upstream shape (1 survey-text + 2 fullscreen trials) BEFORE
// slicing so that any upstream drift fails loudly here.
// =============================================================================

import { buildReplayTestTrials } from './trials/replay-test-suite.js';
import { buildDescribeCardTrial } from './trials/describe-card.js';
import { buildRecordingTrial } from './trials/recording-trial.js';
import { showFinishScreen } from './trials/finish-screen-injector.js';
import {
  getOrMakeRunId,
  getScenarioFromUrl,
  getGuardConfigFromUrl,
  getBotModeFromUrl,
} from './run-meta.js';

const runId = getOrMakeRunId();
const scenario = getScenarioFromUrl();
const guards = getGuardConfigFromUrl(); // 'none' | 'friction' | 'full'
const botMode = getBotModeFromUrl();

// Trials filtered for ALL audiences (humans + bots). The multi-choice trial
// was deemed low-value and bloated the timeline; removed in the 2026-05-14
// redesign.
const ALWAYS_FILTERED = new Set(['survey-multi-choice']);

// Browser Use can't complete these trial types (no clickable affordances —
// canvas drawing, sketchpad strokes, drag-and-drop, custom MediaRecorder).
// When ?bot-mode=1 is set, strip them so bot sweeps actually reach the end
// of the timeline. The custom recording trial (info.name
// 'bench-recording-trial') flows through the same mechanism as the upstream
// trials — single source of truth.
const BOT_INCOMPATIBLE_TRIALS = new Set([
  'canvas-keyboard-response',
  'sketchpad',
  'free-sort',
  'bench-recording-trial',
]);

// Compose the extensions array per the guards URL param.
// jsPsychCyborgHunter is always included — that's the whole point of the bench.
// The two guards layer on top conditionally.
const sessionExtensions = [
  {
    type: jsPsychCyborgHunter,
    params: { participantId: runId, preset: 'standard' },
  },
];
if (guards === 'friction' || guards === 'full') {
  sessionExtensions.push({ type: jsPsychGuardFriction });
}
if (guards === 'full') {
  sessionExtensions.push({ type: jsPsychGuardHoneypot });
}
// Session replay rides along in every configuration. autoSave 'download'
// hands the participant (here: whoever runs the bench) the v2 artifact as a
// file next to the CSV — piloting mode; production uses 'datapipe'.
sessionExtensions.push({
  type: jsPsychCyborgHunterReplay,
  params: { participantId: runId, tier: 'dom', autoSave: { mode: 'download' } },
});

const jsPsych = initJsPsych({
  extensions: sessionExtensions,
  on_finish: async () => {
    // DEPLOY: ON_FINISH_BLOCK_START
    if (jsPsych.extensions['guard-friction']) jsPsych.extensions['guard-friction'].finalize();
    if (jsPsych.extensions['guard-honeypot']) jsPsych.extensions['guard-honeypot'].finalize();
    jsPsych.extensions['cyborg-hunter'].finalize();
    // Replay finalizes LAST so it folds CH's finalized session report into the
    // recording, and BEFORE the save so integrityReplayMeta lands in the CSV.
    await jsPsych.extensions['cyborg-hunter-replay'].finalize();
    jsPsych.data.get().localSave('csv', `${runId}-ch.csv`);
    showFinishScreen();
    // DEPLOY: ON_FINISH_BLOCK_END
  },
});

// Build the full timeline.
const timeline = [];
if (guards === 'friction' || guards === 'full') {
  // Static helper on the extension class — internally calls
  // window.GuardFriction.createEntryTrial(opts). Collects a user
  // gesture (button click) so fullscreen can be requested.
  timeline.push(jsPsychGuardFriction.entryTrial());
}

const replayTrials = buildReplayTestTrials();

// Structural assertions on the vendored replay-test-suite shape BEFORE we
// slice. If upstream ever drifts (new survey-text trial added, fullscreen
// reordered, etc.) we want to fail loudly here rather than silently splice
// the wrong trials.
const surveyTextIndices = replayTrials
  .map((t, i) => (t?.type?.info?.name === 'survey-text' ? i : -1))
  .filter(i => i >= 0);
const fullscreenIndices = replayTrials
  .map((t, i) => (t?.type?.info?.name === 'fullscreen' ? i : -1))
  .filter(i => i >= 0);

if (surveyTextIndices.length !== 1) {
  throw new Error(
    `bench: replay-test-suite structural drift — expected exactly 1 survey-text trial, ` +
    `found ${surveyTextIndices.length}. The bench timeline composition logic assumes the ` +
    `upstream demographics trial is unique. Update bench/harness/timeline.js to match the ` +
    `new shape, or pin a different replay-test-suite version.`
  );
}
if (fullscreenIndices.length !== 2) {
  throw new Error(
    `bench: replay-test-suite structural drift — expected exactly 2 fullscreen trials ` +
    `(enter + exit), found ${fullscreenIndices.length}. Update bench/harness/timeline.js.`
  );
}

const demographicsIndex = surveyTextIndices[0];
const exitFsIndex = fullscreenIndices[1]; // second fullscreen = exit

const trialsBeforeDemographics = replayTrials.slice(0, demographicsIndex);
const demographicsTrial = replayTrials[demographicsIndex];
const exitFsTrial = replayTrials[exitFsIndex];

// Filter the pre-demographics block: always drop ALWAYS_FILTERED; conditionally
// drop bot-incompatible trials when bot-mode is active.
const baseFiltered = trialsBeforeDemographics.filter(
  t => !ALWAYS_FILTERED.has(t?.type?.info?.name)
);
const filteredReplayTrials = botMode
  ? baseFiltered.filter(t => !BOT_INCOMPATIBLE_TRIALS.has(t?.type?.info?.name))
  : baseFiltered;

if (botMode) {
  const removedCount = replayTrials.length - filteredReplayTrials.length - 2; // -2 for demographics + exit-fs spliced out separately
  console.log('[bench] bot-mode active — filtered out', removedCount, 'replay-test trial(s)');
}

// Custom grafted trials. The recording trial's plugin info.name
// ('bench-recording-trial') is in BOT_INCOMPATIBLE_TRIALS, so the same filter
// mechanism applies — single source of truth.
const customTrials = [
  buildDescribeCardTrial({ cardImage: 'assets/card-1.png' }),
  buildRecordingTrial({ cardImage: 'assets/card-2.png' }),
];
const filteredCustoms = botMode
  ? customTrials.filter(t => !BOT_INCOMPATIBLE_TRIALS.has(t?.type?.info?.name))
  : customTrials;

timeline.push(
  ...filteredReplayTrials,
  ...filteredCustoms,
  demographicsTrial,
  exitFsTrial,
);
// (No buildFinishScreen() trial — the terminal "Thank you" message is
// injected into document.body from on_finish via showFinishScreen() above.)

// Apply CH extensions to every trial EXCEPT the entry trial.
// Per-trial wiring uses just `{ type }` — the params from sessionExtensions
// are already bound at initialize() time; per-trial entries are positional
// declarations that tell jsPsych to fire that extension's on_start/on_load/
// on_finish hooks for this trial.
const perTrialExtensions = sessionExtensions.map((e) => ({ type: e.type }));
const entryTrialIndex = (guards === 'friction' || guards === 'full') ? 0 : -1;
timeline.forEach((t, i) => {
  if (i === entryTrialIndex) return;
  t.extensions = (t.extensions || []).concat(perTrialExtensions);
});

jsPsych.run(timeline);
