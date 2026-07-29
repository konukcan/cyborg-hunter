// demo/steps.js
// ALL tutorial copy as data. Numbers are {{path}} placeholders substituted
// from signal-manifest.json at runtime — never hardcode thresholds here.
// Engine renders these; edit copy freely without touching logic.
//
// {{path}} placeholders resolve against signal-manifest.json's `signals`
// object, e.g. {{paste.hardCountThreshold}} -> signals.paste.hardCountThreshold.
// The one exception is the >20cps rate named in step 6: that's this demo's
// own animation speed, not a library threshold, so it's a literal.

/**
 * Verbatim positioning paragraph (spec: "use it VERBATIM"). Rendered on the
 * welcome screen above the privacy note.
 */
export const POSITIONING =
  "Prolific's built-in Authenticity Checks give you a verdict inside one " +
  "platform. cyborg-hunter gives you the evidence — full behavioral traces, " +
  "replayable sessions, honeypot catches — on any platform: Prolific, MTurk, " +
  "classroom, or standalone, free and inspectable. Use them together: " +
  "platform-level screening plus study-level evidence you can defend in review.";

/**
 * Intro sentence for the sticky signal-checklist rail. Names the curated
 * subset explicitly — the omitted signals aren't triggerable on cue.
 */
export const RAIL_INTRO =
  "This is a curated subset of what cyborg-hunter tracks. Idle gap, window " +
  "position, zoom level, DOM mutations, and the named-extension scan run in " +
  "the background too, but they're not something you can trigger on cue, so " +
  "they're left off this list.";

/**
 * Rail row definitions, grouped detectors / guard / recording per the spec's
 * rail anatomy. hardSignal drives the --hard vs --clean lamp token.
 */
export const RAIL_GROUPS = {
  detectors: [
    { key: 'paste', label: 'paste', hardSignal: true },
    { key: 'copy', label: 'copy', hardSignal: false },
    { key: 'drop', label: 'drag & drop', hardSignal: true },
    { key: 'tabAwayLong', label: 'tab-away ≥10s', hardSignal: false },
    { key: 'tabAwayMid', label: 'tab-away 3–10s', hardSignal: false },
    { key: 'sidebar', label: 'browser sidebar', hardSignal: false },
    { key: 'viewport', label: 'viewport shift', hardSignal: false },
    { key: 'fastTyping', label: 'fast typing', hardSignal: false },
    { key: 'syntheticInsertion', label: 'synthetic insertion', hardSignal: true },
    { key: 'foreignInput', label: 'foreign input', hardSignal: false },
    { key: 'devTools', label: 'DevTools shortcut', hardSignal: false },
    { key: 'honeypot', label: 'honeypot bait', hardSignal: true },
  ],
  guard: [
    { key: 'guardViolations', label: 'guard violations', hardSignal: true },
  ],
  recording: [
    { key: 'mousePaths', label: 'mouse paths', hardSignal: false },
    { key: 'replay', label: 'replay', hardSignal: false },
  ],
};

/**
 * The 12-step tour script. Advance is always available — every task is an
 * invitation, not a gate.
 */
export const STEPS = [
  {
    id: 'welcome',
    act: 'act0',
    eyebrow: 'Act 0 · Step 1 of 12',
    title: "You're the test subject",
    body: `
<p>Nothing you do here leaves your browser. No server, no analytics, no
upload — the report at the end is built locally, from your own session.</p>
<p>The checklist on the right tracks a curated set of signals cyborg-hunter
watches during a real study. It's inert until you start. Every lamp that
lights over the next eleven steps is something you did, not a script.</p>
<aside class="teaser" aria-label="Pre-recorded session">
  <p class="teaser-label">Pre-recorded session — the tour is about YOUR data</p>
  <p>This clip shows the honeypot catching an agentic browser. Scrub it, then start your own.</p>
</aside>`.trim(),
    task: null,
    expect: null,
    primaryLabel: 'Start the tour',
    secondary: [
      { kind: 'toggle', key: 'replayOptIn', label: 'Record a replay of this session too', defaultValue: false },
    ],
  },
  {
    id: 'baseline-typing',
    act: 'act1',
    eyebrow: 'Act 1 · Unguarded · Step 2 of 12',
    title: 'Answer it like you normally would',
    body: `
<p>Type your answer to the rule below the way you normally would — no
tricks yet. This is your baseline. Nothing on the right should light up,
and that's exactly the point: a normal answer produces a normal trace.
Everything after this step is you deliberately breaking that baseline.</p>`.trim(),
    task: {
      kind: 'type-answer',
      trialId: 'act1-baseline',
      prompt: 'Rule: a hand wins when both cards share a suit and neither is below five.',
    },
    expect:
      "event-log.csv gains a plain answer_submitted row: your keystroke timing, nothing else. No lamp lights — that's the point of a baseline.",
    primaryLabel: 'I answered it →',
    secondary: [{ kind: 'link', key: 'skipToGuardedAct', label: 'Skip to the guarded act' }],
  },
  {
    id: 'copy-paste',
    act: 'act1',
    eyebrow: 'Act 1 · Unguarded · Step 3 of 12',
    title: 'Leave two fingerprints on the clipboard',
    body: `
<p>Select the rule text, copy it, and paste it into the answer box. Then
paste it again. {{paste.hardCountThreshold}} pastes are what crosses the
standard preset's HARD threshold — that's today's main instruction, though
like every task here, you can advance without doing it.</p>`.trim(),
    task: {
      kind: 'copy-paste',
      trialId: 'act1-paste',
      ruleText: 'Rule: a hand wins when both cards share a suit and neither is below five.',
      targetPastes: '{{paste.hardCountThreshold}}',
    },
    expect:
      'event-log.csv gains two paste rows carrying the full pasted text. Your triage tier flips to HARD the moment paste #{{paste.hardCountThreshold}} lands.',
    primaryLabel: 'I pasted it {{paste.hardCountThreshold}} times →',
    secondary: [{ kind: 'link', key: 'skipToGuardedAct', label: 'Skip to the guarded act' }],
  },
  {
    id: 'tab-away',
    act: 'act1',
    eyebrow: 'Act 1 · Unguarded · Step 4 of 12',
    title: 'Consult your cheat sheet',
    body: `
<p>Imagine you've got a cheat sheet open in another tab. Switch to it and
stay away for a good ten seconds, not just a glance. Then come back and
continue. A quick tab switch barely registers; a long one tells a different
story, and your report will show exactly how long you were gone.</p>`.trim(),
    task: {
      kind: 'tab-away',
      trialId: 'act1-tabaway',
      suggestedSeconds: 10,
    },
    expect:
      'The tab-away ≥10s row lights — a quick glance would only light 3–10s. Your session-timeline bar gets a red span for as long as you were gone, with exact timestamps in event-log.csv.',
    primaryLabel: "I'm back →",
    secondary: [{ kind: 'link', key: 'skipToGuardedAct', label: 'Skip to the guarded act' }],
  },
  {
    id: 'sidebar-resize',
    act: 'act1',
    eyebrow: 'Act 1 · Unguarded · Step 5 of 12',
    title: 'Rearrange your browser',
    body: `
<p>Open a browser sidebar, split your window, or just resize it — whatever
you'd naturally do mid-task. Watch the checklist while you do it. One thing
to know: resizing never ends your tour. The layout adapts; your session
keeps recording no matter what shape your window takes.</p>`.trim(),
    task: {
      kind: 'sidebar-resize',
      trialId: 'act1-sidebar',
    },
    expect:
      'event-log.csv gains a sidebar_open or viewport_shift row. Resizing mid-tour never ends your session — check the top bar, it\'s still running.',
    primaryLabel: 'Done rearranging →',
    secondary: [{ kind: 'link', key: 'skipToGuardedAct', label: 'Skip to the guarded act' }],
  },
  {
    id: 'autotype',
    act: 'act1',
    eyebrow: 'Act 1 · Unguarded · Step 6 of 12',
    title: 'Let the field type itself',
    body: `
<p>Press the button below and watch: the field disables, then text appears
on its own — well over 20 characters a second, caret and all — before
re-enabling. That's synthetic insertion, flagged immediately. The real
fast-typing threshold is {{typingSpeed.cps}} cps; the fast-typing lamp
lights when the trial closes, not while you're watching.</p>`.trim(),
    task: {
      kind: 'autotype',
      trialId: 'act1-autotype',
      visualCps: 20,
      realThresholdCps: '{{typingSpeed.cps}}',
    },
    expect:
      'event-log.csv gains a synthetic_insertion row immediately and a typing_speed row when the trial closes — the fast-typing lamp lights on close, not while you watch.',
    primaryLabel: 'Continue →',
    secondary: [{ kind: 'link', key: 'skipToGuardedAct', label: 'Skip to the guarded act' }],
  },
  {
    id: 'guard-fair-warning',
    act: 'act2',
    eyebrow: 'Act 2 · Guard armed · Step 7 of 12',
    title: 'The rules change now',
    body: `
<p>From here on, the guard is armed. Leave fullscreen — even by pressing
Esc — and your task scrambles, logged as a violation. That's the trick:
Esc is both how you'd exit and the exact thing being tracked. There's no
clean way out once you're in. Click below to enter fullscreen and
begin.</p>`.trim(),
    task: {
      kind: 'fullscreen-entry',
      trialId: 'act2-fullscreen-entry',
    },
    expect:
      "Entering fullscreen arms guard_assistance_violations tracking. Nothing's logged yet — that starts the moment you leave.",
    primaryLabel: 'Enter fullscreen',
    secondary: null,
  },
  {
    id: 'try-to-cheat',
    act: 'act2',
    eyebrow: 'Act 2 · Guard armed · Step 8 of 12',
    title: 'Now try to cheat',
    body: `
<p>Try what worked in Act 1 — paste, tab away, open a sidebar. Each
attempt gets blocked, the task scrambles, and a chip below counts it. This
is what your participants would face under enforcement. Stuck behind the
overlay? A skip-to-finale link is always visible, and Alt+S works from
anywhere — the overlay never traps you.</p>`.trim(),
    task: {
      kind: 'guard-cheat',
      trialId: 'act2-cheat',
    },
    expect:
      'Every attempt lands in guard_assistance_violations with a type and timestamp. The chips above tally them live; the scramble means nothing was readable while you were away.',
    primaryLabel: "I've tried enough →",
    secondary: [{ kind: 'link', key: 'skipToFinale', label: 'Skip to finale', shortcut: 'Alt+S' }],
  },
  {
    id: 'guard-finish',
    act: 'act2',
    eyebrow: 'Act 2 · Guard armed · Step 9 of 12',
    title: 'What enforcement left behind',
    body: `
<p>Guard's done. Every blocked attempt from the last step now sits in your
violations log with a timestamp and type — fullscreen_exit,
window_blurred, whatever you tried. None of that felt like a demo trick;
it's the same enforcement a real participant would hit. You've felt the
mechanics — here's the three-line integration that produced them.</p>`.trim(),
    task: {
      kind: 'guard-finish',
      trialId: 'act2-finish',
    },
    expect:
      "guard_assistance_violations closes out with the full list. The session-timeline bar marks each span in red next to your clean Act-1 getaway.",
    primaryLabel: 'See the finale →',
    secondary: null,
  },
  {
    id: 'jspsych-finale',
    act: 'finale',
    eyebrow: 'Finale · Step 10 of 12',
    title: 'Three lines of code did all of this',
    body: `
<p>Two more trials, this time running through jsPsych — cyborg-hunter's
actual plugin API. Beside them: the exact code that produced everything
you just did, split in two. Base monitoring is the quickstart's three
lines. Enforcement is one more extension, documented in
using-cyborg-hunter.md. That's the whole integration, not a simplified
version of it.</p>`.trim(),
    task: {
      kind: 'jspsych-finale',
      trialId: 'finale-jspsych',
      trialCount: 2,
      snippetSplit: [
        { label: 'base monitoring (quickstart)', file: 'docs/quickstart.md' },
        { label: 'add enforcement (guard-friction — using-cyborg-hunter.md)', file: 'docs/using-cyborg-hunter.md' },
      ],
    },
    expect:
      "Both trials append to the same trials array you've been building since step 2 — nothing about the finale is special-cased.",
    primaryLabel: 'Build my report →',
    secondary: null,
  },
  {
    id: 'results',
    act: 'finale',
    eyebrow: 'Finale · Step 11 of 12',
    title: "Here's what you triggered",
    body: `
<p>This report is built right here in your browser, from your own
session — nothing was uploaded to make it. <span class="loading-note">While
it builds: <em>Building your report…</em></span></p>
<p>The walkthrough below shows what you actually triggered: your timings,
your tier, your Act 1 vs. Act 2 comparison. No promised outcome, no canned
example. This is your evidence.</p>`.trim(),
    task: null,
    expect:
      'Your triage tier, timeline, and violations log are pulled straight from your own trials.',
    primaryLabel: 'Replicate it locally →',
    secondary: null,
  },
  {
    id: 'replicate-locally',
    act: 'finale',
    eyebrow: 'Finale · Step 12 of 12',
    title: 'Now run it on your own data',
    body: `
<p>One click each saves your three files, pre-named to work together.
Drop them in an empty folder and run the CLI locally — the same report
you just saw, rebuilt from the same data, on your own machine. Nothing
here was ever uploaded either.</p>`.trim(),
    task: {
      kind: 'downloads',
      trialId: null,
      files: [
        {
          key: 'sessionData',
          filename: 'DEMO-<id>.json',
          label: 'Session data',
          description: 'trials + session integrity',
          savedLabel: 'Saved ✓',
        },
        {
          key: 'replay',
          filename: 'DEMO-<id>-replay-<epoch>.json',
          label: 'Replay (if you opted in)',
          description: 'replay artifact — dropped if you skipped the opt-in',
          savedLabel: 'Saved ✓',
        },
        {
          key: 'config',
          filename: 'cyborg-hunter.config.json',
          label: 'Config',
          description: 'ready-made config for the CLI',
          savedLabel: 'Saved ✓',
        },
      ],
    },
    expect:
      "Each download button flips to 'Saved ✓' once the file lands. If a download's blocked, a 'show file as text' fallback opens it for manual save.",
    primaryLabel: 'Done',
    secondary: null,
  },
];

/**
 * Results-screen walkthrough copy, branched on how the session went. The
 * engine picks one based on the visitor's own trial data; the specific
 * facts (tier, timings) are computed and inserted at render time, not here.
 */
export const FINISH_VARIANTS = {
  full: {
    headline: "Here's what you built",
    body: 'Every line below traces back to something you did in the last eleven steps.',
    bullets: [
      'Your triage tier and the reason behind it — check event-log.csv for the pasted text that decided it.',
      'Your longest tab-away, as the red bar in the session-timeline chart.',
      "Act 1's clean getaway next to Act 2's blocked attempts in guard_assistance_violations — same tricks, different outcome.",
      'If you opted in, your replay — scrub to the moment you left the tab and watch it happen.',
    ],
  },
  act2Skipped: {
    headline: 'Here\'s what you built (Act 1 only)',
    body: "You skipped the guarded act, so there's no enforcement data to compare against — that's fine, Act 1 alone is still a real report.",
    bullets: [
      'Your triage tier and the reason behind it — check event-log.csv for the pasted text that decided it.',
      'Your longest tab-away, as the red bar in the session-timeline chart.',
      'Curious what enforcement would have caught? docs/using-cyborg-hunter.md walks through guard-friction on its own.',
    ],
  },
  zeroLamp: {
    headline: "You triggered nothing — here's what a clean report looks like",
    body: "That's a valid report too. Every row in triage.md carries a reason, even the clean ones — clean isn't the absence of a record, it's a record that says so.",
    bullets: [
      'Your event-log.csv is short, and that\'s the finding: no pastes, no long tab-aways, no guard violations.',
      'Go back and try Act 1\'s steps for real, or download this clean report as a baseline to compare against.',
    ],
  },
};

/**
 * Replicate-locally transcript. {{version}} is stamped at build time from
 * package.json / constants.js — never hardcode a version number here.
 */
export const TRANSCRIPT = {
  lines: [
    'cd <folder with the 3 files>',
    'npx cyborg-hunter@{{version}} report',
    'open cyborg-hunter-report/index.html',
  ],
  nodeNote: 'No Node.js? Install v18+ from nodejs.org first.',
};

/** Config caveat shown next to the downloadable cyborg-hunter.config.json. */
export const CONFIG_CAVEAT =
  "This config matches the demo's data shape. Your real study likely needs " +
  "participantIdField 'subject_ID' and filePattern '*.csv' — see quickstart §6.";

/**
 * Closing call-to-action on the replicate-locally screen. No issue-filing
 * link — dropped at review.
 */
export const CLOSING_CTA = {
  primaryLabel: 'Get started in your experiment',
  primaryHref: 'https://github.com/konukcan/cyborg-hunter/blob/main/docs/quickstart.md',
  installInvitation:
    "Haven't installed cyborg-hunter yet? Run npm install -g cyborg-hunter and point it at your own study's data.",
  githubHref: 'https://github.com/konukcan/cyborg-hunter',
};
