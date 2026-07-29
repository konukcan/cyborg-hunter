// demo/demo.js
// Tour engine: 12-step navigation, {{path}} template substitution, capability
// snapshot, participant-id boot stamp. Renders STEPS from steps.js through
// the idempotent lifecycle helper (lifecycle.js) so every advance/Back/skip
// closes any open trial before optionally opening the next.
//
// Live-signal rail: event-driven via the monitor's onSignal callback +
// aggregation of completed trial reports (fast typing has no onSignal event —
// it's only computable at endTrial()), plus a 5s poll for session-only
// signals (viewport-width shifts have no onSignal event either; sidebar gets
// BOTH — see pollSessionSignals()).

import { STEPS, POSITIONING, CLOSING_CTA, RAIL_GROUPS, RAIL_INTRO } from './steps.js';
import { makeLifecycle } from './lifecycle.js';
import { renderRail, light, acknowledge } from './rail.js';
import { buildPayload } from './payload.js';

var SESSION_POLL_MS = 5000;

console.log('cyborg-hunter demo · library', (window.CyborgHunter && CyborgHunter.VERSION) || 'unknown');

function randomParticipantId() {
  // Math.random() === 0 renders as the 1-char string '0' (no decimal point),
  // which would slice down to only 3 characters without padding — padEnd to
  // 6 chars first so the slice below always has 4 to take.
  return 'DEMO-' + Math.random().toString(36).padEnd(6, '0').slice(2, 6);
}

// Resolves {{path.to.value}} against `signals` (signal-manifest.json's
// `signals` object — see steps.js's docblock) and the special {{version}}
// placeholder against the library's runtime VERSION.
function substitute(str, signals, version) {
  return str.replace(/\{\{([\w.]+)\}\}/g, function (_, path) {
    if (path === 'version') return version;
    var value = signals;
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (value == null) return '';
      value = value[parts[i]];
    }
    return value == null ? '' : String(value);
  });
}

function showSmallMode() {
  var cols = document.querySelector('.cols');
  if (cols) cols.style.display = 'none';
  var el = document.getElementById('smallmode');
  el.hidden = false;
  el.innerHTML =
    '<p>' + POSITIONING + '</p>' +
    '<p>This tour needs a desktop-sized browser window. Explore the docs instead:</p>' +
    '<p><a href="' + CLOSING_CTA.primaryHref + '">Quickstart</a> &middot; ' +
    '<a href="' + CLOSING_CTA.githubHref + '">GitHub</a></p>';
}

function boot() {
  var participantId = randomParticipantId();
  document.getElementById('pid').textContent = participantId;

  // Snapshotted ONCE at boot — later resizes rearrange layout but never
  // terminate a running session (states-and-edge-rules: 830→700→900px case).
  var capabilities = { interactive: window.innerWidth >= 820 };

  if (!capabilities.interactive) {
    showSmallMode();
    return;
  }

  fetch('./signal-manifest.json')
    .then(function (r) { return r.json(); })
    .then(function (manifest) { startTour(participantId, capabilities, manifest); })
    .catch(function (err) {
      console.error('cyborg-hunter demo: failed to load signal-manifest.json', err);
    });
}

// Row label lookup (RAIL_GROUPS -> {key: label}), used by acknowledge() so
// the inline "✓ detected" strip text lives in one place (steps.js) rather
// than being retyped at every signal call site.
var RAIL_LABELS = {};
['detectors', 'guard', 'recording'].forEach(function (g) {
  RAIL_GROUPS[g].forEach(function (r) { RAIL_LABELS[r.key] = r.label; });
});

function startTour(participantId, capabilities, manifest) {
  var version = (window.CyborgHunter && CyborgHunter.VERSION) || 'unknown';

  var state = {
    stepIndex: 0,
    capabilities: capabilities,
    replayOptIn: false,
    lampCounts: {},
    act2Skipped: false,
    violations: [],
    trialReports: []
  };

  var cardEl = document.getElementById('card');
  var progressEl = document.getElementById('progress');
  var railEl = document.getElementById('rail');

  renderRail(railEl, { groups: RAIL_GROUPS, intro: RAIL_INTRO });

  // Lamp wiring is lifecycle-bound (spec: "starts and stops with the tour").
  // startLampWiring/stopLampWiring are idempotent: entering the results step
  // stops the poll and turns every lamp handler into a no-op (the interactive
  // tasks are over; the monitor itself keeps running — finalization belongs
  // to the payload task); navigating Back into the tour restarts it.
  var lampWiringActive = false;
  var sessionPollId = null;

  function startLampWiring() {
    if (lampWiringActive) return;
    lampWiringActive = true;
    sessionPollId = setInterval(pollSessionSignals, SESSION_POLL_MS);
  }

  function stopLampWiring() {
    if (!lampWiringActive) return;
    lampWiringActive = false;
    clearInterval(sessionPollId);
    sessionPollId = null;
  }

  // Lights `key` only if `count` is a new high — makes both the event-driven
  // path (increments a running local count) and the 5s poll (recomputes the
  // true count from the library's own data) safe to call without double-
  // counting or re-pulsing a lamp that hasn't actually changed.
  function syncCountLamp(key, count, hard, label) {
    if (count > (state.lampCounts[key] || 0)) {
      state.lampCounts[key] = count;
      light(key, count, { hard: hard });
      if (label) acknowledge(cardEl, label);
    }
  }

  function handleSignal(sig) {
    if (!lampWiringActive) return;
    var n;
    switch (sig.type) {
      case 'paste':
        n = (state.lampCounts.paste || 0) + 1;
        syncCountLamp('paste', n, n >= manifest.signals.paste.hardCountThreshold, RAIL_LABELS.paste);
        break;
      case 'copy':
      case 'cut':
        n = (state.lampCounts.copy || 0) + 1;
        syncCountLamp('copy', n, false, RAIL_LABELS.copy);
        break;
      case 'drop':
        n = (state.lampCounts.drop || 0) + 1;
        syncCountLamp('drop', n, n >= manifest.signals.drop.hardCountThreshold, RAIL_LABELS.drop);
        break;
      case 'tabReturn':
        var duration = (sig.data && sig.data.duration_ms) || 0;
        if (duration >= 10000) {
          n = (state.lampCounts.tabAwayLong || 0) + 1;
          syncCountLamp('tabAwayLong', n, false, RAIL_LABELS.tabAwayLong);
        } else if (duration > manifest.signals.tabAway.durationMs) {
          // Strict > matches the library convention: a tab-away exactly at
          // the cutoff is an unscored flicker (scoring.js:63, summary.js
          // "same `>` boundary" comment, session-timeline.js flicker bin).
          n = (state.lampCounts.tabAwayMid || 0) + 1;
          syncCountLamp('tabAwayMid', n, false, RAIL_LABELS.tabAwayMid);
        }
        break;
      case 'sidebarOpened':
        n = (state.lampCounts.sidebar || 0) + 1;
        syncCountLamp('sidebar', n, false, RAIL_LABELS.sidebar);
        break;
      case 'typingOutsideExperiment':
        n = (state.lampCounts.foreignInput || 0) + 1;
        syncCountLamp('foreignInput', n, false, RAIL_LABELS.foreignInput);
        break;
      case 'syntheticInsertion':
        n = (state.lampCounts.syntheticInsertion || 0) + 1;
        syncCountLamp('syntheticInsertion', n, true, RAIL_LABELS.syntheticInsertion);
        break;
      case 'keyboardShortcut':
        n = (state.lampCounts.devTools || 0) + 1;
        syncCountLamp('devTools', n, false, RAIL_LABELS.devTools);
        break;
      default:
        break;
    }
  }

  // Fast typing has no onSignal event — computeTypingSpeed() only runs
  // inside endTrial() (src/core/signals/typing.js), so it's only observable
  // once a trial closes, via the lifecycle helper's onTrialReport hook.
  function handleTrialReport(report) {
    // Accumulated for the payload regardless of lamp-wiring state — the
    // monitor keeps recording after stopLampWiring() (interactive tasks
    // being over doesn't mean trials stop closing), and the download step
    // needs every trial the visitor actually ran.
    state.trialReports.push(report);
    if (!lampWiringActive) return;
    var typingSpeed = report.trialSignals && report.trialSignals.soft && report.trialSignals.soft.typingSpeed;
    if (typingSpeed && typingSpeed.hit) {
      var n = (state.lampCounts.fastTyping || 0) + 1;
      syncCountLamp('fastTyping', n, false, RAIL_LABELS.fastTyping);
    }
  }

  // Session-only signals with no (or incomplete) onSignal coverage:
  //   - viewportWidthShifts: browser.js's ResizeObserver never calls
  //     fireSignal() at all — the poll is its only path.
  //   - sidebarEvents: the innerWidth_delta method fires 'sidebarOpened'
  //     (handled instantly above), but the layout_compression method does
  //     NOT fire a signal — the poll is a backstop that also catches those.
  //   - honeypot bait: GuardHoneypot has no event callback, only polled getters.
  function pollSessionSignals() {
    var report = monitor.getSessionReport();

    var sidebarOpens = report.sidebarEvents.filter(function (e) { return e.type === 'opened'; }).length;
    syncCountLamp('sidebar', sidebarOpens, false, RAIL_LABELS.sidebar);

    syncCountLamp('viewport', report.viewportWidthShifts.length, false, RAIL_LABELS.viewport);

    if (window.GuardHoneypot) {
      var hp = window.GuardHoneypot.getHoneypotData();
      if (hp.ai_use) syncCountLamp('honeypot', 1, true, RAIL_LABELS.honeypot);
    }
  }

  var monitor = window.CyborgHunter.init({
    participantId: participantId,
    preset: 'standard',
    onSignal: handleSignal
  });
  monitor.startSession();
  var lifecycle = makeLifecycle(monitor, { onTrialReport: handleTrialReport });

  // Tab-close hygiene: don't leave the poll running into page teardown.
  window.addEventListener('pagehide', stopLampWiring);

  // Act-2 violations (GuardFriction is a separate global, not part of the
  // CyborgHunter monitor). Counts each violation the moment it starts, for
  // an immediately responsive lamp — not the same count as the honeypot's
  // own start/end-paired violations log.
  if (window.GuardFriction && typeof window.GuardFriction.onViolation === 'function') {
    window.GuardFriction.onViolation(function (violation) {
      // Recorded for the payload's guardFriction.violations[] regardless of
      // lamp-wiring state (see handleTrialReport's comment above — same reasoning).
      state.violations.push(violation);
      if (!lampWiringActive) return;
      if (violation.phase !== 'start') return;
      var n = (state.lampCounts.guardViolations || 0) + 1;
      syncCountLamp('guardViolations', n, true, RAIL_LABELS.guardViolations);
    });
  }

  function tpl(str) {
    return substitute(str, manifest.signals, version);
  }

  function guardedActIndex() {
    return STEPS.findIndex(function (s) { return s.act === 'act2'; });
  }

  function finaleIndex() {
    return STEPS.findIndex(function (s) { return s.act === 'finale'; });
  }

  // .eyebrow .act2 (demo.css) colors the "Act 2" prefix red — it's a
  // descendant selector, so act2 steps need that prefix wrapped in its own span.
  function renderEyebrow(step) {
    if (step.act !== 'act2') return step.eyebrow;
    var idx = step.eyebrow.indexOf('·');
    if (idx === -1) return step.eyebrow;
    var prefix = step.eyebrow.slice(0, idx).trim();
    var rest = step.eyebrow.slice(idx);
    return '<span class="act2">' + prefix + '</span> ' + rest;
  }

  // Builds the { filename, data } pair for one downloads-step file button.
  // Called both by the download click handler and the "show as text"
  // fallback, so both always agree on exactly what would have been saved.
  function buildDownloadFile(key) {
    if (key === 'sessionData') {
      // Wrap each raw endTrial() report the way the jsPsych extension's
      // on_finish() does — { integrity: report } — so ingest.js's Shape-1
      // reader (t[intField], default 'integrity') finds it (demo/payload.js).
      var trials = state.trialReports.map(function (r) {
        return { trialId: r.trialId, integrity: r };
      });
      var payload = buildPayload({
        pid: participantId,
        trials: trials,
        sessionReport: monitor.getSessionReport(),
        violations: state.violations
      });
      return { filename: participantId + '.json', data: payload };
    }
    if (key === 'replay') {
      // TODO(C8): the real replay recording lands in a later task. Until
      // then this button downloads a labeled placeholder rather than
      // pretending a recording exists.
      return {
        filename: participantId + '-replay-' + Date.now() + '.json',
        data: { note: 'replay recording lands in task C8' }
      };
    }
    if (key === 'config') {
      return {
        filename: 'cyborg-hunter.config.json',
        data: { dataDir: '.', filePattern: 'DEMO-*.json', participantIdField: 'participantId' }
      };
    }
    return null;
  }

  // Synchronously builds a Blob + object URL and clicks a throwaway <a
  // download> — must run inside the same call stack as the button's click
  // handler (its own user gesture) so the browser never treats it as a
  // popup/auto-download.
  function triggerDownload(filename, data) {
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Download-failure fallback: opens the shared per-step <dialog> with the
  // file's JSON in a selectable <pre> for manual copy/save.
  function openFileTextDialog(filename, json) {
    var dlg = cardEl.querySelector('dialog.filetext-dialog');
    if (!dlg) return;
    dlg.querySelector('h3').textContent = filename;
    dlg.querySelector('pre').textContent = json;
    dlg.showModal();
  }

  function renderDownloadsPanel(task) {
    // Replay opt-out drops the replay file from the download step entirely
    // (spec: "downloads drop the replay file").
    var files = task.files.filter(function (f) {
      return f.key !== 'replay' || state.replayOptIn;
    });
    var parts = ['<div class="task">', '<p class="label">' + task.kind + '</p>'];
    parts.push('<div class="files">' + files.map(function (f) {
      return (
        '<div class="file">' +
        '<div class="file-info">' + f.label + '<small>' + f.filename + '</small>' +
        '<span class="file-desc">' + f.description + '</span></div>' +
        '<div class="file-actions">' +
        '<button class="btn" data-action="download" data-key="' + f.key +
        '" data-saved-label="' + f.savedLabel + '">Save</button>' +
        '<a href="#" data-action="showtext" data-key="' + f.key + '">show as text</a>' +
        '</div></div>'
      );
    }).join('') + '</div>');
    parts.push(
      '<dialog class="filetext-dialog"><h3></h3><pre></pre>' +
      '<button class="btn" data-action="close-dialog">Close</button></dialog>'
    );
    parts.push('</div>');
    return parts.join('');
  }

  function renderTaskPanel(task) {
    if (!task) return '';
    if (task.kind === 'downloads') return renderDownloadsPanel(task);
    var parts = ['<div class="task">', '<p class="label">' + task.kind + '</p>'];
    var ruleText = task.prompt || task.ruleText;
    if (ruleText) parts.push('<p class="rule">' + tpl(ruleText) + '</p>');
    if (task.kind === 'type-answer' || task.kind === 'copy-paste') {
      parts.push('<textarea rows="3" placeholder="Type your answer here"></textarea>');
    }
    if (task.targetPastes) {
      parts.push('<p class="hint">Target pastes: ' + tpl(task.targetPastes) + '</p>');
    }
    if (task.suggestedSeconds) {
      parts.push('<p class="hint">Suggested time away: ' + task.suggestedSeconds + 's</p>');
    }
    if (task.visualCps) {
      parts.push(
        '<p class="hint">Visual speed: ' + task.visualCps + ' cps &middot; real threshold: ' +
        tpl(String(task.realThresholdCps)) + ' cps</p>'
      );
    }
    if (task.trialCount) {
      parts.push('<p class="hint">' + task.trialCount + ' trials via jsPsych</p>');
    }
    if (task.snippetSplit) {
      parts.push('<ul class="hint">' + task.snippetSplit.map(function (s) {
        return '<li>' + s.label + ' — ' + s.file + '</li>';
      }).join('') + '</ul>');
    }
    parts.push('</div>');
    return parts.join('');
  }

  function renderSecondary(step) {
    if (!step.secondary) return '';
    return step.secondary.map(function (s) {
      if (s.kind === 'toggle') {
        var checked = state.replayOptIn ? ' checked' : '';
        return '<label><input type="checkbox" data-key="' + s.key + '"' + checked + '> ' + s.label + '</label>';
      }
      if (s.kind === 'link') {
        var shortcut = s.shortcut ? ' (' + s.shortcut + ')' : '';
        return '<a href="#" data-key="' + s.key + '">' + s.label + shortcut + '</a>';
      }
      return '';
    }).join(' ');
  }

  function renderStep(i) {
    var step = STEPS[i];
    var html = '';
    html += '<p class="eyebrow">' + renderEyebrow(step) + '</p>';
    html += '<h2>' + tpl(step.title) + '</h2>';
    html += '<div class="stepcopy">' + tpl(step.body) + '</div>';
    html += renderTaskPanel(step.task);
    if (step.expect) {
      html += '<div class="expect"><span class="tag">Expect</span><span>' + tpl(step.expect) + '</span></div>';
    }
    html += '<div class="btnrow">';
    if (i > 0) html += '<button class="btn" data-action="back">Back</button>';
    html += '<button class="btn primary" data-action="primary">' + tpl(step.primaryLabel) + '</button>';
    html += '</div>';
    var secondary = renderSecondary(step);
    if (secondary) html += '<p class="secondary">' + secondary + '</p>';
    cardEl.innerHTML = html;
  }

  var resultsIndex = STEPS.findIndex(function (s) { return s.id === 'results'; });

  function goTo(i) {
    state.stepIndex = i;
    var step = STEPS[i];
    lifecycle.transitionTo(step.task ? step.task.trialId : null);
    // Lamp wiring stops at the results step (interactive tasks are over) and
    // restarts if the visitor navigates Back into the tour. Both idempotent.
    if (i >= resultsIndex) stopLampWiring(); else startLampWiring();
    document.body.dataset.view = step.act;
    renderStep(i);
    progressEl.textContent = 'Step ' + (i + 1) + ' of ' + STEPS.length;
  }

  function skipToFinale() {
    if (STEPS[state.stepIndex].act === 'act2') state.act2Skipped = true;
    goTo(finaleIndex());
  }

  cardEl.addEventListener('click', function (e) {
    var back = e.target.closest('[data-action="back"]');
    if (back) { goTo(state.stepIndex - 1); return; }
    var primary = e.target.closest('[data-action="primary"]');
    if (primary) {
      if (state.stepIndex < STEPS.length - 1) goTo(state.stepIndex + 1);
      return;
    }
    var downloadBtn = e.target.closest('[data-action="download"]');
    if (downloadBtn) {
      var toSave = buildDownloadFile(downloadBtn.dataset.key);
      if (toSave) {
        try {
          triggerDownload(toSave.filename, toSave.data);
          downloadBtn.textContent = downloadBtn.dataset.savedLabel;
        } catch (err) {
          openFileTextDialog(toSave.filename, JSON.stringify(toSave.data, null, 2));
        }
      }
      return;
    }
    var showTextBtn = e.target.closest('[data-action="showtext"]');
    if (showTextBtn) {
      e.preventDefault();
      var toShow = buildDownloadFile(showTextBtn.dataset.key);
      if (toShow) openFileTextDialog(toShow.filename, JSON.stringify(toShow.data, null, 2));
      return;
    }
    var closeDialogBtn = e.target.closest('[data-action="close-dialog"]');
    if (closeDialogBtn) {
      var dlg = closeDialogBtn.closest('dialog');
      if (dlg) dlg.close();
      return;
    }
    var link = e.target.closest('a[data-key]');
    if (link) {
      e.preventDefault();
      if (link.dataset.key === 'skipToGuardedAct') goTo(guardedActIndex());
      else if (link.dataset.key === 'skipToFinale') skipToFinale();
    }
  });

  cardEl.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('input[type="checkbox"][data-key="replayOptIn"]')) {
      state.replayOptIn = e.target.checked;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      skipToFinale();
    }
  });

  goTo(0);
}

boot();
