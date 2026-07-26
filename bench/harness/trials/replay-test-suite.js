// =============================================================================
// replay-test-suite.js
//
// Vendored port of the jsPsych "replay test" demo timeline.
//
//   Upstream repo:   https://github.com/jodeleeuw/jspsych-replay-test
//   Upstream commit: 95c6ef9c3b4500787f43ee3f8e96d8bd16e4e5fa
//                    ("Add gzip download button and bump preview SHA")
//   jsPsych pin:     git SHA 4706a5e751c572c09a44a1b9a60d910e0c251d4a
//                    (PR-3661 preview branch of jspsych/jsPsych — includes
//                    the `record_session` feature). Loaded via jsDelivr in
//                    bench's index.html, same SHA as upstream.
//
// The bench harness loads each jsPsych plugin via its own <script> tag, so
// plugin classes are exposed as globals (e.g. `jsPsychHtmlKeyboardResponse`).
// This module reads them off `globalThis` at call time and throws a clear
// error if any are missing — keeping the failure mode loud rather than
// producing trials with `type: undefined`.
//
// We deliberately mirror upstream's timeline order and trial count exactly
// (14 trials total) so the bench is a faithful reproduction of the demo.
// Cosmetic helpers (the gzip download button, `on_finish` showRecording, etc.)
// are NOT ported — those belong to the host page, not the timeline.
// =============================================================================

// Plugin globals the timeline references. Listed once here so the missing-
// plugin error message can be specific.
const REQUIRED_PLUGIN_GLOBALS = [
  'jsPsychInstructions',
  'jsPsychFullscreen',
  'jsPsychHtmlKeyboardResponse',
  'jsPsychHtmlButtonResponse',
  'jsPsychHtmlSliderResponse',
  'jsPsychCanvasKeyboardResponse',
  'jsPsychSketchpad',
  'jsPsychFreeSort',
  'jsPsychSurveyMultiChoice',
  'jsPsychSurveyText',
];

// --- Free-sort stimulus helper (ported verbatim from upstream) --------------
// Returns a data: URI for an 80x80 colored SVG square with a label, used as
// stimulus images in the jsPsychFreeSort trial.
function colorSquareSvg(color, label) {
  const encoded = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">` +
    `<rect width="80" height="80" rx="8" fill="${color}"/>` +
    `<text x="40" y="50" text-anchor="middle" fill="white" font-size="14" font-family="sans-serif">${label}</text>` +
    `</svg>`
  );
  return 'data:image/svg+xml,' + encoded;
}

/**
 * Build the jsPsych trial timeline for the replay-test bench scenario.
 *
 * Returns an array of 14 jsPsych trial objects, in upstream order:
 *   1.  instructions       (jsPsychInstructions)
 *   2.  enterFullscreen    (jsPsychFullscreen)
 *   3.  fixation           (jsPsychHtmlKeyboardResponse)
 *   4-6. stroopTrials      (3x jsPsychHtmlKeyboardResponse, spread inline)
 *   7.  buttonChoice       (jsPsychHtmlButtonResponse)
 *   8.  sliderRating       (jsPsychHtmlSliderResponse)
 *   9.  canvasTrial        (jsPsychCanvasKeyboardResponse)
 *   10. sketchpad          (jsPsychSketchpad)
 *   11. freeSort           (jsPsychFreeSort)
 *   12. surveyMultiChoice  (jsPsychSurveyMultiChoice)
 *   13. surveyText         (jsPsychSurveyText)
 *   14. exitFullscreen     (jsPsychFullscreen)
 *
 * @throws Error if any required jsPsych plugin global is missing.
 * @returns {Array<object>} jsPsych timeline.
 */
export function buildReplayTestTrials() {
  const missing = REQUIRED_PLUGIN_GLOBALS.filter(
    name => typeof globalThis[name] === 'undefined'
  );
  if (missing.length) {
    throw new Error(
      `replay-test-suite: missing jsPsych plugin globals: ${missing.join(', ')}. ` +
      `Load them via <script> tags in the bench harness HTML before importing ` +
      `this module.`
    );
  }

  // --- Stimuli for the free-sort trial -------------------------------------
  const freeSortStimuli = [
    colorSquareSvg('#e74c3c', 'Red'),
    colorSquareSvg('#2ecc71', 'Green'),
    colorSquareSvg('#3498db', 'Blue'),
    colorSquareSvg('#f39c12', 'Yellow'),
    colorSquareSvg('#9b59b6', 'Purple'),
    colorSquareSvg('#1abc9c', 'Teal'),
  ];

  // TRIAL 1 — Instructions (button navigation -> mouse.click) ---------------
  const instructions = {
    type: globalThis.jsPsychInstructions,
    pages: [
      `<h2>Welcome to the jsPsych Replay Demo</h2>
       <p>This experiment tests a variety of input types so that the
       session recording feature can be validated against different
       plugin interactions.</p>
       <p>Use the <strong>Next</strong> and <strong>Previous</strong>
       buttons to navigate through these instructions.</p>`,

      `<h2>What you will do</h2>
       <ol style="text-align:left;max-width:480px;margin:auto">
         <li>Switch the experiment into fullscreen mode</li>
         <li>Press a key in response to a fixation cross</li>
         <li>Identify the ink colour of a word (Stroop task)</li>
         <li>Answer a multiple-choice question using buttons</li>
         <li>Rate your confidence using a slider</li>
         <li>Indicate which side of a canvas a circle appears on</li>
         <li>Draw freely on a sketchpad</li>
         <li>Drag and drop coloured tiles to organise them</li>
         <li>Answer a longer multiple-choice survey (you'll need to scroll)</li>
         <li>Type answers to short text questions</li>
         <li>Exit fullscreen mode</li>
       </ol>`,

      `<h2>Ready?</h2>
       <p>Press <strong>Start</strong> when you are ready to begin.</p>`,
    ],
    show_clickable_nav: true,
    button_label_next: 'Next',
    button_label_previous: 'Previous',
  };

  // TRIAL 2 — Enter fullscreen ----------------------------------------------
  const enterFullscreen = {
    type: globalThis.jsPsychFullscreen,
    fullscreen_mode: true,
    message: `<p>The experiment will switch to fullscreen mode when you press the button.</p>`,
    button_label: 'Enter fullscreen',
  };

  // TRIAL 3 — Fixation cross (keyboard) -------------------------------------
  const fixation = {
    type: globalThis.jsPsychHtmlKeyboardResponse,
    stimulus: `<div style="font-size:3rem;font-weight:bold;text-align:center">+</div>
               <p style="text-align:center;color:#888">Press <kbd>Space</kbd> to continue</p>`,
    choices: [' '],
  };

  // TRIALS 4-6 — Stroop colour-naming task (keyboard) -----------------------
  const stroopTrials = [
    { word: 'RED',   color: 'blue',  correct: 'b' },
    { word: 'GREEN', color: 'red',   correct: 'r' },
    { word: 'BLUE',  color: 'green', correct: 'g' },
  ].map(item => ({
    type: globalThis.jsPsychHtmlKeyboardResponse,
    stimulus: `<p class="stroop-word" style="color:${item.color}">${item.word}</p>
               <p style="text-align:center;color:#888">Press <kbd>R</kbd> = red &nbsp;
               <kbd>G</kbd> = green &nbsp; <kbd>B</kbd> = blue</p>`,
    choices: ['r', 'g', 'b'],
    data: { correct_response: item.correct },
    on_finish: function (data) {
      data.correct = data.response === data.correct_response;
    },
  }));

  // TRIAL 7 — Multiple-choice question (button clicks) ----------------------
  const buttonChoice = {
    type: globalThis.jsPsychHtmlButtonResponse,
    stimulus: `<h3 style="text-align:center">Which best describes how you are feeling right now?</h3>`,
    choices: ['😊 Happy', '😐 Neutral', '😞 Sad', '😤 Frustrated', '😴 Tired'],
    button_html: (choice) =>
      `<button class="jspsych-btn" style="font-size:1.1rem;padding:0.5rem 1.2rem;margin:0.25rem">${choice}</button>`,
  };

  // TRIAL 8 — Slider confidence rating --------------------------------------
  const sliderRating = {
    type: globalThis.jsPsychHtmlSliderResponse,
    stimulus: `<p style="text-align:center;font-size:1.2rem">
                 How confident are you in your Stroop answers?
               </p>`,
    min: 0,
    max: 100,
    start: 50,
    step: 1,
    labels: ['Not at all confident', 'Somewhat', 'Very confident'],
    require_movement: true,
    prompt: `<p style="text-align:center;color:#888;font-size:0.9rem">
               Drag the slider, then click Continue.
             </p>`,
  };

  // TRIAL 9 — Canvas drawing stimulus (canvas + keyboard) -------------------
  const canvasTrial = {
    type: globalThis.jsPsychCanvasKeyboardResponse,
    canvas_size: [300, 400],
    stimulus: function (canvas) {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;

      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#667eea');
      grad.addColorStop(1, '#764ba2');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
      ctx.stroke();
      ctx.setLineDash([]);

      const cx = (Math.random() < 0.5 ? 0.25 : 0.75) * W;
      const cy = H / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 40, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    },
    choices: ['f', 'j'],
    prompt: `<p style="text-align:center;color:#888;margin-top:0.5rem">
               Press <kbd>F</kbd> if the circle is on the left, <kbd>J</kbd> if it's on the right.
             </p>`,
  };

  // TRIAL 10 — Sketchpad (free drawing) -------------------------------------
  const sketchpad = {
    type: globalThis.jsPsychSketchpad,
    canvas_width: 400,
    canvas_height: 300,
    canvas_border_width: 2,
    canvas_border_color: '#aaa',
    background_color: '#fefefe',
    stroke_width: 4,
    stroke_color: '#2c3e50',
    show_finished_button: true,
    finished_button_label: 'Done drawing',
    prompt: `<p style="text-align:center">Draw anything you like in the space above,
             then click <strong>Done drawing</strong>.</p>`,
  };

  // TRIAL 11 — Free sort (drag-and-drop) ------------------------------------
  const freeSort = {
    type: globalThis.jsPsychFreeSort,
    stimuli: freeSortStimuli,
    stim_height: 80,
    stim_width: 80,
    sort_area_height: 400,
    sort_area_width: 600,
    sort_area_shape: 'square',
    prompt: `<p style="text-align:center">
               Drag the coloured tiles into the sorting area and arrange them
               however you like, then click <strong>Continue</strong>.
             </p>`,
    prompt_location: 'above',
  };

  // TRIAL 12 — Long multi-choice survey -------------------------------------
  const surveyMultiChoice = {
    type: globalThis.jsPsychSurveyMultiChoice,
    preamble: `<p style="text-align:center;font-size:1.1rem">
                 Tell us about your experience. Scroll down to see all the questions before submitting.
               </p>`,
    questions: [
      { prompt: 'Which device are you using right now?', name: 'device',
        options: ['Laptop', 'Desktop', 'Tablet', 'Phone', 'Other'], required: false },
      { prompt: 'Which browser do you usually prefer?', name: 'browser',
        options: ['Chrome', 'Firefox', 'Safari', 'Edge', 'Other'], required: false },
      { prompt: 'How often do you participate in online experiments?', name: 'frequency',
        options: ['Never before', 'Rarely', 'Occasionally', 'Often', 'Very often'], required: false },
      { prompt: 'How would you rate the visual design of this demo so far?', name: 'design',
        options: ['Poor', 'Fair', 'Good', 'Very good', 'Excellent'], required: false },
      { prompt: 'How clear were the instructions?', name: 'clarity',
        options: ['Very unclear', 'Unclear', 'Neutral', 'Clear', 'Very clear'], required: false },
      { prompt: 'Was the pace of the demo comfortable?', name: 'pace',
        options: ['Too slow', 'Slightly slow', 'Just right', 'Slightly fast', 'Too fast'], required: false },
      { prompt: 'Which trial did you find most engaging?', name: 'favorite',
        options: ['Stroop task', 'Mood rating', 'Confidence slider', 'Canvas circle', 'Sketchpad', 'Free sort'], required: false },
      { prompt: 'Which trial did you find most difficult?', name: 'difficult',
        options: ['Stroop task', 'Mood rating', 'Confidence slider', 'Canvas circle', 'Sketchpad', 'Free sort'], required: false },
      { prompt: 'How responsive did the interactions feel?', name: 'responsive',
        options: ['Very sluggish', 'Sluggish', 'Acceptable', 'Snappy', 'Very snappy'], required: false },
      { prompt: 'How comfortable was fullscreen mode for you?', name: 'fullscreen',
        options: ['Very uncomfortable', 'Uncomfortable', 'Neutral', 'Comfortable', 'Very comfortable'], required: false },
      { prompt: 'Did anything in the demo feel buggy or unexpected?', name: 'bugs',
        options: ['Nothing felt off', 'Minor glitches', 'A few notable issues', 'Major problems'], required: false },
      { prompt: 'Would you like to participate in similar studies again?', name: 'again',
        options: ['Definitely not', 'Probably not', 'Maybe', 'Probably yes', 'Definitely yes'], required: false },
    ],
    button_label: 'Continue',
  };

  // TRIAL 13 — Survey text (keyboard text input) ----------------------------
  const surveyText = {
    type: globalThis.jsPsychSurveyText,
    questions: [
      { prompt: 'What is your first name? (you may use a pseudonym)',
        placeholder: 'e.g. Alex', name: 'name', required: true },
      { prompt: 'How old are you?',
        placeholder: 'e.g. 25', name: 'age', required: true },
      { prompt: 'In one sentence, what did you think of this demo?',
        placeholder: 'Type your thoughts here…', name: 'feedback',
        rows: 3, columns: 50 },
    ],
    preamble: `<p style="text-align:center;font-size:1.1rem">Please answer the questions below.</p>`,
    button_label: 'Submit',
  };

  // TRIAL 14 — Exit fullscreen ----------------------------------------------
  // (12 named entries + 3-element stroopTrials spread - 1 placeholder = 14)
  const exitFullscreen = {
    type: globalThis.jsPsychFullscreen,
    fullscreen_mode: false,
  };

  return [
    instructions,
    enterFullscreen,
    fixation,
    ...stroopTrials,
    buttonChoice,
    sliderRating,
    canvasTrial,
    sketchpad,
    freeSort,
    surveyMultiChoice,
    surveyText,
    exitFullscreen,
  ];
}
