// demo/demo.js
// Tour engine: 12-step navigation, {{path}} template substitution, capability
// snapshot, participant-id boot stamp. Renders STEPS from steps.js through
// the idempotent lifecycle helper (lifecycle.js) so every advance/Back/skip
// closes any open trial before optionally opening the next.
//
// Live-signal rail wiring (onSignal → lamps) lands in demo/rail.js.

import { STEPS, POSITIONING, CLOSING_CTA } from './steps.js';
import { makeLifecycle } from './lifecycle.js';

console.log('cyborg-hunter demo · library', (window.CyborgHunter && CyborgHunter.VERSION) || 'unknown');

function randomParticipantId() {
  // Pad before slicing so a rare short toString(36) result (e.g. Math.random()
  // landing near 0) still yields 4 characters.
  return 'DEMO-' + (Math.random().toString(36) + '0000').slice(2, 6);
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

function startTour(participantId, capabilities, manifest) {
  var version = (window.CyborgHunter && CyborgHunter.VERSION) || 'unknown';
  var monitor = window.CyborgHunter.init({ participantId: participantId, preset: 'standard' });
  monitor.startSession();
  var lifecycle = makeLifecycle(monitor);

  var state = {
    stepIndex: 0,
    capabilities: capabilities,
    replayOptIn: false,
    lampCounts: {},
    act2Skipped: false,
    violations: []
  };

  var cardEl = document.getElementById('card');
  var progressEl = document.getElementById('progress');

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

  function renderTaskPanel(task) {
    if (!task) return '';
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
    if (task.files) {
      parts.push('<div class="files">' + task.files.map(function (f) {
        return '<div class="file">' + f.label + '<small>' + f.filename + '</small></div>';
      }).join('') + '</div>');
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

  function goTo(i) {
    state.stepIndex = i;
    var step = STEPS[i];
    lifecycle.transitionTo(step.task?.trialId ?? null);
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
