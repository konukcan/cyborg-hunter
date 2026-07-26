// =============================================================================
// finish-screen-injector.js
//
// Inject a persistent "Thank you" screen into `document.body`. Called from
// the experiment's global `on_finish`, AFTER all save/finalize work has
// completed.
//
// NOTE: this is NOT a jsPsych trial. An earlier draft of the redesign
// attempted to make the terminal a non-advancing `jsPsych.Instructions` trial
// (`show_clickable_nav: false` + `allow_keys: false`), which would have
// prevented `on_finish` from firing at all — `on_finish` runs when the LAST
// trial COMPLETES, not when it RENDERS. That bug would have silently
// destroyed every run's data. This module is the v2 fix: a plain DOM
// injection that runs after jsPsych is fully done.
//
// Why DOM injection over a trial:
//   - Guarantees on_finish fires (exit-fullscreen, the last real trial,
//     advances normally and completes).
//   - The "Thank you" content shows AFTER save/finalize, not before.
//   - The body is replaced wholesale — no advance affordance for bot or
//     human, so the message persists until tab close.
//   - No dependency on jsPsych's internal lifecycle for the terminal state.
// =============================================================================

/**
 * Replace `document.body.innerHTML` with a centered "Thank you" panel.
 * Safe to call multiple times (idempotent).
 */
export function showFinishScreen() {
  document.body.innerHTML = `
    <div style="
      display: flex; align-items: center; justify-content: center;
      min-height: 80vh; text-align: center; font-family: sans-serif;
      padding: 40px;
    ">
      <div>
        <h2 style="margin-bottom: 16px;">Thank you for completing the experiment.</h2>
        <p>Your responses have been saved. You may close this tab.</p>
      </div>
    </div>
  `;
}
