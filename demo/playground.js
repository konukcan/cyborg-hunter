// demo/playground.js
// Step 12's config playground (spec §7.4): curated scoring controls next to
// the report — move a threshold, the FULL pipeline re-runs (plots included)
// via the rerun hook results.js's buildResults() hands mountPlayground
// through hooks.onReady, and the visitor's own tier + the triage order can
// visibly change.
//
// C3 correction (see the plan's Codex-review note): config overrides alone
// can NEVER flip a HARD tier. summary.js's hardTriggered prefers the
// DATA-CARRIED metadata.integritySession.anyHardTriggered (falling back to
// trialSignals.hard.*.sessionTotal/countThreshold) over anything the CLI
// config passes in — that's deliberate, it's what makes the hard tier
// "trust the record, not the analyst's dial." So instead of inventing
// thresholds.pasteHardCount/typingSpeedCps config keys (which the analyzers
// don't read — see src/shared/constants.js's real PRESETS/DEFAULT_THRESHOLDS
// shape), recomputeSignals() is a PURE pre-pass: it rewrites the raw
// session/trial records themselves, as if the participant had been screened
// under the playground's thresholds from the start. The standard pipeline
// then runs unchanged against that rewritten data, plus a real config
// override for the one knob analyzers DO read post-hoc
// (thresholds.tabAwayDurationMs / typingSpeedThreshold_cps — see the
// docblock on recomputeSignals for why both are needed together).
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
// tabAwayCutoffMs, typingSpeedCps) instead of whatever thresholds actually
// ran. Two things this has to mirror faithfully, read from the source
// rather than guessed:
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
//      controls.pasteHardCount. Other hard signals (copy/drop) have no
//      playground control, so their own collection-time triggered flag is
//      left as-is and still contributes to anyHardTriggered.
//    - metadata.integrityScore is payload.js's mirror of the same fields —
//      extract-core.js prefers THIS over metadata.integritySession when
//      both are present, so it has to be kept in sync too.
//
// 2. The tab-away/typing thresholds: config.thresholds.tabAwayDurationMs
//    and config.typingSpeedThreshold_cps are real analysis-time CLI config
//    keys (src/cli/analyzers/summary.js:22,33-36) — but summary.js and
//    session-timeline-core.js/typing-profile-core.js all resolve them as
//    `participant.session?.config?.thresholds?.X ?? config...X`, i.e. a
//    participant's OWN saved runtime thresholds win over any CLI override.
//    Every payload here carries those (monitor.js's getSessionReport always
//    stamps report.config.thresholds), so a bare config override would be
//    silently shadowed — the playground's tab-away/typing controls have to
//    land on metadata.integritySession.config.thresholds directly to have
//    any visible effect. (results.js's rerun ALSO threads a real config
//    override for these two keys, so a hand-crafted payload without saved
//    thresholds still responds.)
export function recomputeSignals(payloads, controls) {
  return (payloads || []).map(function (payload) {
    var p = deepCopy(payload);
    var trials = p.trials || [];
    var pasteHardCount = controls.pasteHardCount;
    var typingSpeedCps = controls.typingSpeedCps;

    var runningPasteTotal = 0;
    trials.forEach(function (t) {
      var integ = t && t.integrity;
      if (!integ) return;

      var trialHits = (integ.pasteEvents || []).length;
      runningPasteTotal += trialHits;
      if (integ.trialSignals && integ.trialSignals.hard && integ.trialSignals.hard.paste) {
        integ.trialSignals.hard.paste = {
          trialHits: trialHits,
          sessionTotal: runningPasteTotal,
          countThreshold: pasteHardCount,
        };
      }

      // Typing "flag": scoring.js's soft.typingSpeed.hit is derived from
      // the trial's own stored raw charsPerSec vs. the runtime cps
      // threshold — recomputed the same way against controls.typingSpeedCps
      // (report.charsPerSec itself is measured data; it never changes).
      if (typeof integ.charsPerSec === 'number' &&
          integ.trialSignals && integ.trialSignals.soft && integ.trialSignals.soft.typingSpeed) {
        integ.trialSignals.soft.typingSpeed.threshold = typingSpeedCps;
        integ.trialSignals.soft.typingSpeed.hit = integ.charsPerSec > typingSpeedCps ? 1 : 0;
      }
    });
    var pasteTriggered = runningPasteTotal >= pasteHardCount;

    var session = p.metadata && p.metadata.integritySession;
    if (session) {
      var otherHardTriggered = session.hardScore
        ? Object.keys(session.hardScore).some(function (k) {
            return k !== 'paste' && session.hardScore[k] && session.hardScore[k].triggered;
          })
        : false;
      var anyHardTriggered = pasteTriggered || otherHardTriggered;
      var newPasteHardScore = { count: runningPasteTotal, threshold: pasteHardCount, triggered: pasteTriggered };

      if (session.hardScore && session.hardScore.paste) session.hardScore.paste = newPasteHardScore;
      session.anyHardTriggered = anyHardTriggered;

      if (session.config && session.config.thresholds) {
        session.config.thresholds.typingSpeedCps = typingSpeedCps;
        session.config.thresholds.tabAwayDurationMs = controls.tabAwayCutoffMs;
      }

      var scoreMirror = p.metadata.integrityScore;
      if (scoreMirror) {
        if (scoreMirror.hardScore && scoreMirror.hardScore.paste) scoreMirror.hardScore.paste = newPasteHardScore;
        scoreMirror.anyHardTriggered = anyHardTriggered;
      }
    }

    return p;
  });
}

// Small local mirror of src/shared/constants.js PRESETS — only the three
// numbers the playground's own inputs control. Not imported directly:
// tools/assemble-demo-site.mjs ships demo/ + dist/ only, so demo/*.js can't
// reach src/shared/constants.js in the deployed site. Selecting a preset
// here is a convenience that fills in the three inputs below with that
// preset's real numbers; it does not add a separate "preset" config knob —
// whatever the three inputs currently show is what actually runs.
var PRESET_DEFAULTS = {
  standard: { pasteHardCount: 2, tabAwayCutoffMs: 3000, typingSpeedCps: 10 },
  strict: { pasteHardCount: 1, tabAwayCutoffMs: 5000, typingSpeedCps: 8 },
};

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
  var m = ctx.manifest.signals;
  var defaults = {
    preset: ctx.manifest.preset || 'standard',
    pasteHardCount: m.paste.hardCountThreshold,
    tabAwayCutoffMs: Math.round(m.tabAway.durationMs),
    typingSpeedCps: m.typingSpeed.cps,
  };

  mount.innerHTML =
    '<div class="task playground"><h3>Play with the scoring</h3>' +
    '<p class="hint">These are the choices your report is built from. Move one and watch your ' +
    'tier and the triage order change. Finer control — a score for each individual signal — ' +
    'lives in the config file you download next.</p>' +
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
    '<p class="hint" data-role="pg-status"></p></div>';

  var status = mount.querySelector('[data-role="pg-status"]');

  var rebuild = makeDebounced(function () {
    var controls = readControls(mount);
    status.textContent = 'rebuilding…';
    var t0 = performance.now();
    var configOverrides = {
      thresholds: { tabAwayDurationMs: controls.tabAwayCutoffMs },
      typingSpeedThreshold_cps: controls.typingSpeedCps,
    };
    ctx.rerun(configOverrides, function (payloads) { return recomputeSignals(payloads, controls); })
      .then(function () {
        var ms = Math.round(performance.now() - t0);
        status.textContent = 'rebuilt in ' + ms + ' ms';
        // Budget note (spec §7.4): a playground rerun should feel instant.
        // Flagged rather than enforced — the browser's own canvas/paint cost
        // varies too much across machines to hard-fail on.
        if (ms > 1000) console.warn('cyborg-hunter demo: playground rebuild took ' + ms + 'ms (budget: 1000ms)');
      })
      .catch(function (err) {
        status.textContent = 'rebuild failed';
        console.warn('cyborg-hunter demo: playground rebuild failed', err);
      });
  }, 250);

  mount.addEventListener('change', function (e) {
    var el = e.target.closest('[data-k]');
    if (!el) return;
    if (el.dataset.k === 'preset' && PRESET_DEFAULTS[el.value]) {
      var p = PRESET_DEFAULTS[el.value];
      mount.querySelector('[data-k="pasteHardCount"]').value = p.pasteHardCount;
      mount.querySelector('[data-k="tabAwayCutoffMs"]').value = p.tabAwayCutoffMs;
      mount.querySelector('[data-k="typingSpeedCps"]').value = p.typingSpeedCps;
    }
    rebuild();
  });
}
