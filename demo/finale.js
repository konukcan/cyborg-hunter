// demo/finale.js
// Step 10's jsPsych finale: lazily loads the vendored jsPsych 7 files (only
// when this step is reached — the base page must not 404 when demo/vendor/
// is absent, since demo/vendor/ is a gitignored build artifact fetched by
// `npm run demo:vendor`), then runs two real html-keyboard-response trials
// with the cyborg-hunter extension wired exactly as README.md's "Plug into
// a jsPsych experiment" block shows. Rejects (letting the caller degrade to
// the static code panel + note) when vendor files are missing or fail to
// load — spec: "jsPsych finale failure (vendored files missing/broken):
// static code panel with a note."
//
// IMPORTANT: this calls window.CyborgHunter.init() a second time, via the
// jsPsychCyborgHunter extension's initialize(). CyborgHunter.init() is a
// module-level singleton (src/core/monitor.js: "Idempotent: if already
// initialized, destroy previous instance") — a second init() destroys
// whichever instance is currently active, i.e. the demo's own outer
// monitor. That's why steps.js sets this step's task.trialId to null:
// demo.js's lifecycle helper must have no open trial on the outer monitor
// when this runs, and must never call startTrial/endTrial on it again
// afterward (results/replicate-locally both have task.trialId null too, so
// that holds structurally). The outer monitor's read-only methods
// (getSessionReport()) keep returning its last-accumulated data after
// destroy() — they don't check lifecycle state — which is all
// buildDownloadFile() needs; the interactive detector steps are long over
// by step 10, so losing further live event capture on the outer instance
// costs nothing.

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('failed to load ' + src)); };
    document.head.appendChild(s);
  });
}

function loadStylesheet(href) {
  return new Promise(function (resolve, reject) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = function () { resolve(); };
    l.onerror = function () { reject(new Error('failed to load ' + href)); };
    document.head.appendChild(l);
  });
}

// Vendor scripts are only ever injected once per page load — a Back/forward
// revisit of step 10 must not re-request them (and re-running jsPsych.run()
// is a fresh call each time regardless).
var vendorLoaded = false;

function loadVendor() {
  if (vendorLoaded) return Promise.resolve();
  return loadScript('./vendor/jspsych.js')
    .then(function () { return loadScript('./vendor/plugin-html-keyboard-response.js'); })
    .then(function () { return loadStylesheet('./vendor/jspsych.css'); })
    .then(function () { vendorLoaded = true; });
}

// Runs the finale's two real jsPsych trials inside mountEl.
// opts: { participantId, onTrialReport }. onTrialReport is called once per
// trial with that trial's cyborg-hunter report — the same shape
// monitor.endTrial() returns, since the extension's on_finish() returns
// exactly `{ integrity: report }` from `this.monitor.endTrial()`
// (src/jspsych/extension-cyborg-hunter.js). demo.js passes its existing
// handleTrialReport here, so these two reports land in state.trialReports
// alongside every other step's, and survive into buildPayload's trials[]
// unchanged.
//
// Resolves once jsPsych's on_finish has run and both reports were handed
// off. Rejects if vendor files fail to load or the expected globals aren't
// present after loading (a partial/corrupt vendor drop).
export function runFinale(mountEl, opts) {
  return loadVendor().then(function () {
    // Vendor scripts are ready and the trials are about to render — lets the
    // caller move the status text on from "Loading jsPsych…" before the
    // (possibly longer) wait for the visitor to actually press through both
    // trials.
    if (opts.onReady) opts.onReady();
    return new Promise(function (resolve, reject) {
      if (!window.initJsPsych || !window.jsPsychHtmlKeyboardResponse || !window.jsPsychCyborgHunter) {
        reject(new Error('jsPsych globals unavailable after vendor load'));
        return;
      }

      var jsPsych = window.initJsPsych({
        display_element: mountEl,
        extensions: [
          { type: window.jsPsychCyborgHunter, params: { participantId: opts.participantId, preset: 'standard' } }
        ],
        on_finish: function () {
          jsPsych.extensions['cyborg-hunter'].finalize();
          jsPsych.data.get().values().forEach(function (row) {
            if (row && row.integrity) opts.onTrialReport(row.integrity);
          });
          resolve();
        }
      });

      var timeline = [
        {
          type: window.jsPsychHtmlKeyboardResponse,
          stimulus:
            "<p>Two real trials, running through jsPsych — cyborg-hunter's " +
            'actual plugin API, not a simplified stand-in. Press any key to continue.</p>',
          choices: 'ALL_KEYS',
          extensions: [{ type: window.jsPsychCyborgHunter, params: { trialId: 'finale-instruction' } }],
        },
        {
          type: window.jsPsychHtmlKeyboardResponse,
          stimulus:
            "<p>Quick check: press <b>Y</b> if you've been following along, <b>N</b> if not.</p>",
          choices: ['y', 'n'],
          extensions: [{ type: window.jsPsychCyborgHunter, params: { trialId: 'finale-question' } }],
        },
      ];
      jsPsych.run(timeline);
    });
  });
}
