// demo/playground.js
// Step 12's config playground (spec §7.4): curated scoring controls next to
// the report — move a threshold, the FULL pipeline re-runs (plots included)
// via the rerun hook results.js's buildResults() hands mountPlayground
// through hooks.onReady, and both tier boundaries can visibly move: the
// paste control flips HARD, the tab-away/typing controls (with the preset's
// weights) move the SOFT/CLEAN line, and the triage order follows.
//
// Why a data pre-pass and not just config overrides (the plan's C3
// correction + its review follow-up): the analyzers trust DATA-CARRIED
// verdicts over analyst config on BOTH tiers —
//   HARD: summary.js prefers metadata.integritySession.anyHardTriggered
//         (falling back to trialSignals.hard.*.sessionTotal/countThreshold);
//   SOFT: triage.js flags against authoritativeSoftScore — the session's
//         softScore, computed once at collection (scoring.js) and never
//         re-derived by the CLI — and the participant's SAVED runtime
//         thresholds (session.config.thresholds.*) shadow CLI-side ones.
// So recomputeSignals() rewrites the records themselves, as if the
// participant had been screened under the playground's settings from the
// start, and the standard pipeline runs unchanged on the rewritten copy.
// The scoring weights are NOT hand-mirrored here: they arrive via the
// manifest's `presets` block, generated from src/shared/constants.js by
// tools/gen-signal-manifest.mjs and pinned to it by
// tests/tools/signal-manifest.test.js — single source, zero drift.
import { escHtml } from './util.js';

// JSON round-trip: every payload here is plain JSON (the exact shape saved
// to <pid>.json), so this is a safe, dependency-free deep clone.
// src/core/state-machine.js has its own deepCopy, but demo/*.js can only
// import files that ship to the site (tools/assemble-demo-site.mjs copies
// demo/ + dist/ only, not src/), so it isn't reachable from here.
function deepCopy(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

export function makeDebounced(fn, ms) {
  var id = null;
  return function () {
    var args = arguments;
    clearTimeout(id);
    id = setTimeout(function () { fn.apply(null, args); }, ms);
  };
}

// Pure pre-pass: deep-copies `payloads`, then rewrites them as if the
// participant(s) had been screened under `controls` (pasteHardCount,
// tabAwayCutoffMs, typingSpeedCps) with `scoring` — one manifest
// presets[*].scoring entry, {soft: {signal: {weight, maxPerTrial?}},
// softScoreThreshold} — instead of whatever actually ran. A faithful mirror
// of the library's collection-time logic, read from the source:
//
// 1. The paste HARD signal (src/core/scoring.js computeTrialScores +
//    src/core/monitor.js endTrial/getSessionReport):
//    - trialSignals.hard.paste.sessionTotal is the CUMULATIVE paste count
//      through that trial (monitor.js's sessionData.pasteCount, which only
//      ever increments) — recomputed here as a running total over trials in
//      array order, same as collection time.
//    - session.hardScore.paste = {count, threshold, triggered} and
//      session.anyHardTriggered = "any hard signal's triggered flag"
//      (monitor.js:428-433) — recomputed from that same running total vs.
//      controls.pasteHardCount. Other hard signals (drop; copy under
//      strict) have no playground control, so their collection-time
//      triggered flag carries through unchanged and still contributes to
//      anyHardTriggered.
//
// 2. The FULL soft score (scoring.js's soft section, lines 50-125),
//    recomputed per trial from raw stored events with the manifest's
//    weights, then summed into session.softScore — the authoritative
//    number triage.js flags against:
//    - copy: copyEvents.length, capped at maxPerTrial, × weight (only when
//      the preset scores copy soft — strict doesn't);
//    - tabAway: tabAwayEvents with duration_ms STRICTLY > the control's
//      cutoff (same `>` boundary as scoring.js:63), capped, × weight;
//    - typingSpeed: stored raw charsPerSec > control cps → 1 hit × weight
//      (charsPerSec is measured data and never changes — only the verdict
//      on it does); skipped when the trial has no charsPerSec, same as
//      collection;
//    - sidebarEvent / devTools: the session-level event logs
//      (session.sidebarEvents / keyboardShortcuts) filtered to the trial's
//      [startTime, startTime + duration_ms] window, weight counted ONCE
//      when any hit lands in-window (scoring.js:95-117);
//    - foreignInput: weight once when the trial has any foreignInputEvents.
//    trialSignals.soft is rebuilt exactly as scoring.js builds it (copy/
//    tabAway entries always present when the preset scores them;
//    typingSpeed only with a charsPerSec; the last three only on hits).
//    All six soft signals' raw inputs ARE persisted in the payload (the
//    per-trial event arrays plus the session logs), so no term is carried
//    stale; a hand-crafted payload missing an array recomputes that term
//    to 0 hits — the same result collection-time scoring gives a genuinely
//    empty log.
//
// 3. session.softScoreThreshold ← scoring.softScoreThreshold, and the
//    saved runtime thresholds (session.config.thresholds.*) ← the controls:
//    summary.js / session-timeline-core.js / typing-profile-core.js resolve
//    thresholds as `participant.session?.config?.thresholds?.X ?? config…`
//    — the participant's saved values win — so the controls must land there
//    to move the binning and plots. metadata.integrityScore (payload.js's
//    mirror, which extract-core.js prefers when present) is kept in sync
//    throughout.
//
// Known non-emulated knob, disclosed: the strict preset's hard.copy
// countThreshold has no playground control, so the preset select re-scores
// with strict weights/thresholds but never flags copy as HARD — the
// curated controls expose paste as the single hard knob.
export function recomputeSignals(payloads, controls, scoring) {
  var soft = (scoring && scoring.soft) || {};
  return (payloads || []).map(function (payload) {
    var p = deepCopy(payload);
    var trials = p.trials || [];
    var session = p.metadata && p.metadata.integritySession;
    var sessionSidebarEvents = (session && session.sidebarEvents) || [];
    var sessionKeyboardShortcuts = (session && session.keyboardShortcuts) || [];

    var runningPasteTotal = 0;
    var sessionSoftScore = 0;
    trials.forEach(function (t) {
      var integ = t && t.integrity;
      if (!integ) return;

      // ── Hard: paste — running session total vs. the control threshold ──
      var trialHits = (integ.pasteEvents || []).length;
      runningPasteTotal += trialHits;
      if (integ.trialSignals && integ.trialSignals.hard && integ.trialSignals.hard.paste) {
        integ.trialSignals.hard.paste = {
          trialHits: trialHits,
          sessionTotal: runningPasteTotal,
          countThreshold: controls.pasteHardCount,
        };
      }

      // ── Soft: full per-trial recompute, mirroring scoring.js:50-125 ──
      var trialSoftScore = 0;
      var softSignals = {};

      if (soft.copy) {
        var copyHits = (integ.copyEvents || []).length;
        var copyCapped = soft.copy.maxPerTrial != null
          ? Math.min(copyHits, soft.copy.maxPerTrial) : copyHits;
        var copyScore = copyCapped * soft.copy.weight;
        trialSoftScore += copyScore;
        softSignals.copy = { hits: copyHits, capped: copyCapped, score: copyScore };
      }

      if (soft.tabAway) {
        var tabHits = (integ.tabAwayEvents || []).filter(function (e) {
          return (e.duration_ms || 0) > controls.tabAwayCutoffMs;
        }).length;
        var tabCapped = soft.tabAway.maxPerTrial != null
          ? Math.min(tabHits, soft.tabAway.maxPerTrial) : tabHits;
        var tabScore = tabCapped * soft.tabAway.weight;
        trialSoftScore += tabScore;
        softSignals.tabAway = { hits: tabHits, capped: tabCapped, score: tabScore };
      }

      if (soft.typingSpeed && integ.charsPerSec != null) {
        var speedHit = integ.charsPerSec > controls.typingSpeedCps ? 1 : 0;
        var speedScore = speedHit * soft.typingSpeed.weight;
        trialSoftScore += speedScore;
        softSignals.typingSpeed = {
          charsPerSec: integ.charsPerSec, threshold: controls.typingSpeedCps,
          hit: speedHit, score: speedScore,
        };
      }

      // Session-scoped signals count toward this trial only inside its time
      // window — scoring.js's "trial window upper bound". Stored reports
      // always carry startTime + duration_ms; a payload missing either gets
      // an empty window (0 hits), never a widened one.
      var windowOk = typeof integ.startTime === 'number' && typeof integ.duration_ms === 'number';
      var trialEnd = windowOk ? integ.startTime + integ.duration_ms : 0;
      function hitsInWindow(events) {
        if (!windowOk) return 0;
        return events.filter(function (e) {
          return e.t >= integ.startTime && e.t <= trialEnd;
        }).length;
      }

      if (soft.sidebarEvent) {
        var sidebarHits = hitsInWindow(sessionSidebarEvents);
        if (sidebarHits > 0) {
          trialSoftScore += soft.sidebarEvent.weight;
          softSignals.sidebarEvent = { hits: sidebarHits, score: soft.sidebarEvent.weight };
        }
      }

      if (soft.devTools) {
        var devToolsHits = hitsInWindow(sessionKeyboardShortcuts);
        if (devToolsHits > 0) {
          trialSoftScore += soft.devTools.weight;
          softSignals.devTools = { hits: devToolsHits, score: soft.devTools.weight };
        }
      }

      if (soft.foreignInput && (integ.foreignInputEvents || []).length > 0) {
        trialSoftScore += soft.foreignInput.weight;
        softSignals.foreignInput = {
          hits: integ.foreignInputEvents.length, score: soft.foreignInput.weight,
        };
      }

      integ.trialSoftScore = trialSoftScore;
      if (integ.trialSignals) integ.trialSignals.soft = softSignals;
      sessionSoftScore += trialSoftScore;
    });
    var pasteTriggered = runningPasteTotal >= controls.pasteHardCount;

    if (session) {
      var otherHardTriggered = session.hardScore
        ? Object.keys(session.hardScore).some(function (k) {
            return k !== 'paste' && session.hardScore[k] && session.hardScore[k].triggered;
          })
        : false;
      var anyHardTriggered = pasteTriggered || otherHardTriggered;
      var newPasteHardScore = {
        count: runningPasteTotal, threshold: controls.pasteHardCount, triggered: pasteTriggered,
      };

      if (session.hardScore && session.hardScore.paste) session.hardScore.paste = newPasteHardScore;
      session.anyHardTriggered = anyHardTriggered;
      session.softScore = sessionSoftScore;
      session.softScoreThreshold = scoring.softScoreThreshold;

      if (session.config && session.config.thresholds) {
        session.config.thresholds.typingSpeedCps = controls.typingSpeedCps;
        session.config.thresholds.tabAwayDurationMs = controls.tabAwayCutoffMs;
      }

      var scoreMirror = p.metadata.integrityScore;
      if (scoreMirror) {
        if (scoreMirror.hardScore && scoreMirror.hardScore.paste) scoreMirror.hardScore.paste = newPasteHardScore;
        scoreMirror.anyHardTriggered = anyHardTriggered;
        scoreMirror.softScore = sessionSoftScore;
        scoreMirror.softScoreThreshold = scoring.softScoreThreshold;
      }
    }

    return p;
  });
}

// Resolves ONE canonical { preset, controls, scoring } view from the
// manifest's presets block + a state.scoringOverrides object (CODEX
// override contract: { weights, controls, preset }) — the merge every
// caller that needs "what should the pipeline run under right now" shares:
// step 11's live soft-score readout, results.js's initial-render
// persistence seam (demo.js), and this file's own mountPlayground()/
// rebuild(). `weights` only ever overrides a signal's WEIGHT — maxPerTrial
// always comes from the preset (step 11 has no maxPerTrial editor); a
// weight key the selected preset doesn't score (e.g. copy under strict) is
// silently ignored, same "no editor for a term that isn't scored" rule
// renderScoringPanel (demo.js) already follows. Returns null when the
// manifest has no presets block — nothing honest to recompute.
export function mergePlaygroundConfig(manifest, scoringOverrides) {
  var overrides = scoringOverrides || {};
  var presets = manifest.presets || {};
  var presetName = overrides.preset || manifest.preset || 'standard';
  var presetEntry = presets[presetName] || presets.standard;
  if (!presetEntry) return null;

  var controls = Object.assign({}, presetEntry.controls, overrides.controls || {});

  var baseSoft = (presetEntry.scoring && presetEntry.scoring.soft) || {};
  var weights = overrides.weights || {};
  var soft = {};
  Object.keys(baseSoft).forEach(function (key) {
    soft[key] = Object.assign({}, baseSoft[key],
      weights[key] != null ? { weight: weights[key] } : {});
  });

  return {
    preset: presetName,
    controls: controls,
    scoring: { soft: soft, softScoreThreshold: presetEntry.scoring.softScoreThreshold },
  };
}

function readControls(mount) {
  var controls = {};
  mount.querySelectorAll('[data-k]').forEach(function (el) {
    controls[el.dataset.k] = el.type === 'number' ? Number(el.value) : el.value;
  });
  return controls;
}

export function mountPlayground(ctx) {
  var mount = ctx.container.querySelector('[data-role="playground"]');
  if (!mount) return;
  // Both selectable presets' control prefills + scoring maps, generated
  // into the manifest from src/shared/constants.js — the single source of
  // weights (no hand-mirrored table here).
  var presets = ctx.manifest.presets || {};
  // CODEX override contract (walkthrough item 7): step 11 may already have
  // set weights, and a Back-then-forward visit may already have settled
  // controls/preset here — initialize from the SHARED state via
  // mergePlaygroundConfig, not fresh manifest defaults, so the two UIs
  // agree instead of quietly resetting each other.
  var overrides = ctx.scoringOverrides || { weights: {}, controls: null, preset: null };
  var merged = mergePlaygroundConfig(ctx.manifest, overrides) || {
    preset: ctx.manifest.preset || 'standard',
    controls: {
      pasteHardCount: ctx.manifest.signals.paste.hardCountThreshold,
      tabAwayCutoffMs: Math.round(ctx.manifest.signals.tabAway.durationMs),
      typingSpeedCps: ctx.manifest.signals.typingSpeed.cps,
    },
    scoring: null,
  };
  var defaults = {
    preset: merged.preset,
    pasteHardCount: merged.controls.pasteHardCount,
    tabAwayCutoffMs: Math.round(merged.controls.tabAwayCutoffMs),
    typingSpeedCps: merged.controls.typingSpeedCps,
  };

  mount.innerHTML =
    '<div class="task playground"><h3>Play with the scoring</h3>' +
    '<p class="hint">These are the choices your report is built from. Move one and watch your ' +
    'tier and the triage order change. Per-signal weights are set on the previous step; the ' +
    'config file you download next carries the analysis-side settings this report ran with, ' +
    'your changes included.</p>' +
    '<label>preset <select data-k="preset">' +
    '<option value="standard"' + (defaults.preset === 'standard' ? ' selected' : '') + '>standard</option>' +
    '<option value="strict"' + (defaults.preset === 'strict' ? ' selected' : '') + '>strict</option>' +
    '</select></label> ' +
    '<label>paste flags a trial at <input type="number" min="1" max="10" data-k="pasteHardCount" ' +
    'value="' + escHtml(defaults.pasteHardCount) + '"> pastes</label> ' +
    '<label>tab-away counts past <input type="number" min="500" step="500" data-k="tabAwayCutoffMs" ' +
    'value="' + escHtml(defaults.tabAwayCutoffMs) + '"> ms</label> ' +
    '<label>fast typing above <input type="number" min="1" max="40" data-k="typingSpeedCps" ' +
    'value="' + escHtml(defaults.typingSpeedCps) + '"> cps</label>' +
    '<p class="hint" data-role="pg-weights-summary"></p>' +
    '<p class="hint" data-role="pg-status"></p></div>';

  var status = mount.querySelector('[data-role="pg-status"]');
  var weightsSummaryEl = mount.querySelector('[data-role="pg-weights-summary"]');

  // Read-only summary of the weights actively driving the score (per-signal
  // editors live on step 11 only — CODEX amendment: "both UIs visibly agree
  // without duplicating weight editors").
  function renderWeightsSummary(scoring) {
    if (!weightsSummaryEl) return;
    if (!scoring) { weightsSummaryEl.textContent = ''; return; }
    var parts = Object.keys(scoring.soft).map(function (key) {
      return key + ' ' + scoring.soft[key].weight;
    });
    weightsSummaryEl.textContent = 'Per-signal weights (set on the previous step): ' + parts.join(', ') + '.';
  }
  renderWeightsSummary(merged.scoring);

  var rebuild = makeDebounced(function () {
    var controls = readControls(mount);
    // Layer this rebuild's DOM controls + selected preset on top of step
    // 11's weight overrides — the inputs stay the source of truth for
    // controls/preset (comment below), while weights only ever come from
    // the previous step.
    var liveMerged = mergePlaygroundConfig(ctx.manifest, Object.assign({}, overrides, {
      preset: controls.preset,
      controls: controls,
    }));
    if (!liveMerged) { // manifest without a presets block: can't recompute honestly
      status.textContent = 'preset data unavailable';
      return;
    }
    var scoring = liveMerged.scoring;
    status.textContent = 'rebuilding…';
    var t0 = performance.now();
    // The two thresholds are ALSO analysis-time config keys (summary.js
    // reads them as fallbacks behind the saved runtime thresholds), and
    // scoring.softScoreThreshold is the analyst-side override triage.js
    // honors — passed through so the pipeline config matches the rewritten
    // data AND the downloadable config file (demo.js reads the same values
    // back via ctx.onControls below).
    var configOverrides = {
      thresholds: { tabAwayDurationMs: controls.tabAwayCutoffMs },
      typingSpeedThreshold_cps: controls.typingSpeedCps,
      scoring: { softScoreThreshold: scoring.softScoreThreshold },
    };
    ctx.rerun(configOverrides, function (payloads) { return recomputeSignals(payloads, controls, scoring); })
      .then(function () {
        var ms = Math.round(performance.now() - t0);
        status.textContent = 'rebuilt in ' + ms + ' ms';
        // Budget note (spec §7.4): a playground rerun should feel instant.
        // Flagged rather than enforced — the browser's own canvas/paint cost
        // varies too much across machines to hard-fail on.
        if (ms > 1000) console.warn('cyborg-hunter demo: playground rebuild took ' + ms + 'ms (budget: 1000ms)');
        renderWeightsSummary(scoring);
        // Write the settled controls/preset back into the SHARED state
        // object (ctx.scoringOverrides === state.scoringOverrides in
        // demo.js, same reference) so a later visit to step 11's
        // live-score readout, or a later results rebuild, sees them too.
        if (ctx.scoringOverrides) {
          ctx.scoringOverrides.controls = {
            pasteHardCount: controls.pasteHardCount,
            tabAwayCutoffMs: controls.tabAwayCutoffMs,
            typingSpeedCps: controls.typingSpeedCps,
          };
          ctx.scoringOverrides.preset = controls.preset;
        }
        // Settled settings for the downloads step: demo.js stores these so
        // the downloaded config carries what the report actually ran with,
        // including the playground tweaks (only CLI-honored keys are
        // written into the file — see buildDownloadFile('config')).
        if (ctx.onControls) {
          ctx.onControls({
            preset: controls.preset,
            pasteHardCount: controls.pasteHardCount,
            tabAwayCutoffMs: controls.tabAwayCutoffMs,
            typingSpeedCps: controls.typingSpeedCps,
            softScoreThreshold: scoring.softScoreThreshold,
          });
        }
      })
      .catch(function (err) {
        status.textContent = 'rebuild failed';
        console.warn('cyborg-hunter demo: playground rebuild failed', err);
      });
  }, 250);

  mount.addEventListener('change', function (e) {
    var el = e.target.closest('[data-k]');
    if (!el) return;
    // Preset select: prefill the three inputs with that preset's real
    // values (manifest presets[*].controls). The inputs stay the source of
    // truth — whatever they show after the prefill is what runs.
    if (el.dataset.k === 'preset' && presets[el.value]) {
      var pc = presets[el.value].controls;
      mount.querySelector('[data-k="pasteHardCount"]').value = pc.pasteHardCount;
      mount.querySelector('[data-k="tabAwayCutoffMs"]').value = pc.tabAwayCutoffMs;
      mount.querySelector('[data-k="typingSpeedCps"]').value = pc.typingSpeedCps;
    }
    rebuild();
  });
}
