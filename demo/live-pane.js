// The live session record (spec §5.2): a persistently visible two-tab pane —
// an append-only signal stream (default) and the literal session JSON. Fed by
// demo.js from the same onSignal dispatch as the rail. Frozen at results.
//
// A per-trial tab rail (`.lp-trials`) sits on the left of the stream/
// JSON views, filtering the stream to one trial at a time. Rows never leave
// the DOM (the stream is append-only, and the raw JSON view is the literal
// record) — the rail just toggles `lp-off` on the rows that don't match, so
// filtering keeps working after freeze() (addRow/setPayload stay frozen as
// before; this is a VIEW concern layered on top). `All` is always first and
// is the default, identical to today's view.
import { escHtml } from './util.js';
import { LIVE_PANE } from './steps.js';

export function formatClock(ms) {
  var total = Math.max(0, Math.round(ms / 100)); // deciseconds
  var m = Math.floor(total / 600);
  var s = Math.floor((total % 600) / 10);
  var d = total % 10;
  return m + ':' + String(s).padStart(2, '0') + '.' + d;
}

// Pure row builder (unit-tested without a DOM). data-trial carries the
// filter key the rail matches against — the trialId when one exists, or the
// 'session' sentinel for trial-less rows (viewport shifts, session-scoped
// keyboard shortcuts). No real trialId collides with 'session' (all are
// act1-*/act2-*), so the sentinel is safe to reuse as a literal string.
//
// The trial/event cells carry their own text as a title: the rail costs the
// aside's stream ~76px, so demo.css truncates those two columns there rather
// than breaking them mid-token — the title is what makes the truncation
// lossless (the wide states show them in full anyway).
export function renderRowHtml(row) {
  var trial = row.trial || 'session';
  return '<div class="lp-row' + (row.hard ? ' hard' : '') + '" data-trial="' + escHtml(trial) + '">' +
    '<span class="lp-t">' + escHtml(formatClock(row.tMs)) + '</span>' +
    '<span class="lp-trial" title="' + escHtml(trial) + '">' + escHtml(trial) + '</span>' +
    '<span class="lp-event" title="' + escHtml(row.event) + '">' + escHtml(row.event) + '</span>' +
    '<span class="lp-detail">' + escHtml(row.detail || '—') + '</span>' +
    '</div>';
}

export function makeLivePane(mount, pid) {
  var frozen = false, count = 0, currentTab = 'stream';
  // Rail state: `trials` is the ordered list of real-trial tabs (never
  // includes 'all' or 'session'); `sessionTab` is null until the first
  // trial-less row is logged (lazy registration — see ensureTabFor below);
  // `activeTrial` is the filter key ('all' | a trialId | 'session').
  var trials = [];
  var sessionTab = null;
  var activeTrial = 'all';

  mount.innerHTML =
    '<div class="lp-head"><span class="lp-title">' + escHtml(LIVE_PANE.title) + '</span>' +
    '<div class="lp-tabs">' +
    '<button class="lp-tab active" data-tab="stream">' + escHtml(LIVE_PANE.tabs.stream) + '</button>' +
    '<button class="lp-tab" data-tab="json">' + escHtml(LIVE_PANE.tabs.json) + '</button>' +
    '</div></div>' +
    '<div class="lp-body" data-view="stream">' +
    '<div class="lp-trials" data-role="lp-trials" role="group" aria-label="' + escHtml(LIVE_PANE.trials.groupLabel) + '"></div>' +
    '<div class="lp-views">' +
    '<div class="lp-stream" data-role="lp-stream"><div class="lp-cols">' +
    '<span>time</span><span>trial</span><span>event</span><span>detail</span></div></div>' +
    '<pre class="lp-json" data-role="lp-json" hidden></pre>' +
    '</div></div>' +
    '<p class="lp-caption">' + escHtml(LIVE_PANE.caption.replace('{{pid}}', pid)) + '</p>';
  var bodyEl = mount.querySelector('.lp-body');
  var trialsEl = mount.querySelector('[data-role="lp-trials"]');
  var streamEl = mount.querySelector('[data-role="lp-stream"]');
  var jsonEl = mount.querySelector('[data-role="lp-json"]');

  // Rebuilds the rail from scratch against current state — cheap (a handful
  // of buttons) and simpler than patching individual nodes on every add/
  // click. `.lp-trial-tab` is a distinct class token from `.lp-tab` above
  // (the stream/JSON pill pair) so neither this file's own
  // querySelectorAll('.lp-tab') nor the E2E suite's `.lp-tab` locators picks
  // up these buttons.
  function renderTabs() {
    var html = '<button class="lp-trial-tab" data-trial-key="all" aria-pressed="' +
      (activeTrial === 'all') + '" title="' + escHtml(LIVE_PANE.trials.allLabel) + '">' +
      escHtml(LIVE_PANE.trials.allLabel) + '</button>';
    trials.forEach(function (t) {
      html += '<button class="lp-trial-tab" data-trial-key="' + escHtml(t.id) + '" aria-pressed="' +
        (activeTrial === t.id) + '" title="' + escHtml(t.id) + '">' + escHtml(t.label) + '</button>';
    });
    if (sessionTab) {
      html += '<button class="lp-trial-tab" data-trial-key="session" aria-pressed="' +
        (activeTrial === 'session') + '" title="' + escHtml(LIVE_PANE.trials.sessionLabel) + '">' +
        escHtml(sessionTab.label) + '</button>';
    }
    trialsEl.innerHTML = html;
  }
  renderTabs(); // 'All' is visible from the start, before any trial is reached

  // Lazily registers a tab for a row's data-trial key when nothing has
  // claimed it yet: the 'session' sentinel (labelled from steps.js) on its
  // first trial-less row, or — defensively — a raw-id tab for a trialId
  // demo.js's addTrial() never registered (a future step that forgot to),
  // so a row is never silently unreachable from the rail. Real trials
  // registered through addTrial() below hit the early-return every time.
  function ensureTabFor(trialKey) {
    if (trialKey === 'session') {
      if (sessionTab) return;
      sessionTab = { label: LIVE_PANE.trials.sessionLabel };
      renderTabs();
      return;
    }
    for (var i = 0; i < trials.length; i++) {
      if (trials[i].id === trialKey) return;
    }
    trials.push({ id: trialKey, label: trialKey, ordinal: Infinity }); // pushed to the end: still "before session"
    renderTabs();
  }

  // Toggles lp-off on every row that doesn't match activeTrial. 'All'
  // re-pins to the tail (the live view, same as addRow's default); picking
  // a specific trial scrolls to the TOP of that trial's rows — a visitor who
  // selects one wants to read it from its first event, not its last.
  function applyFilter() {
    var rows = streamEl.querySelectorAll('.lp-row');
    for (var i = 0; i < rows.length; i++) {
      var match = activeTrial === 'all' || rows[i].dataset.trial === activeTrial;
      rows[i].classList.toggle('lp-off', !match);
    }
    if (activeTrial === 'all') {
      streamEl.scrollTop = streamEl.scrollHeight;
      return;
    }
    var streamRect = streamEl.getBoundingClientRect();
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].dataset.trial === activeTrial) {
        streamEl.scrollTop += rows[j].getBoundingClientRect().top - streamRect.top;
        break;
      }
    }
  }

  // One delegated listener on the rail container — renderTabs() replaces
  // the buttons wholesale on every state change, so binding per-button would
  // mean rebinding on every rebuild for no benefit.
  trialsEl.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.lp-trial-tab');
    if (!btn) return;
    activeTrial = btn.dataset.trialKey;
    renderTabs();
    applyFilter();
  });

  // Stream/JSON pill tabs (unchanged behavior) additionally stamp data-view
  // on .lp-body — the rail filters the STREAM only, so it's hidden while the
  // raw-JSON view (the whole payload) is active; see demo.css.
  mount.querySelectorAll('.lp-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      currentTab = t.dataset.tab;
      mount.querySelectorAll('.lp-tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      streamEl.hidden = currentTab !== 'stream';
      jsonEl.hidden = currentTab !== 'json';
      bodyEl.dataset.view = currentTab;
    });
  });

  return {
    addRow: function (row) {
      if (frozen) return;
      count++;
      streamEl.insertAdjacentHTML('beforeend', renderRowHtml(row));
      var rowEl = streamEl.lastElementChild;
      ensureTabFor(rowEl.dataset.trial);
      if (activeTrial !== 'all' && rowEl.dataset.trial !== activeTrial) {
        rowEl.classList.add('lp-off'); // filtered out immediately — a filtered view shouldn't jump
      } else {
        streamEl.scrollTop = streamEl.scrollHeight; // follow the tail
      }
    },
    setPayload: function (payload) {
      if (frozen) return;
      jsonEl.textContent = JSON.stringify(payload, null, 2);
    },
    freeze: function () { frozen = true; },
    rowCount: function () { return count; },
    // Idempotent by id; inserts at `ordinal` (the trial's index in STEPS'
    // run order — see demo.js's TRIAL_TABS) so tab order matches the run
    // order regardless of how the visitor navigated (skip links, Back).
    // 'session' is a reserved sentinel, never a real trial id — defense in
    // depth alongside ensureTabFor's own handling of it.
    addTrial: function (id, label, ordinal) {
      if (id === 'session') return;
      for (var i = 0; i < trials.length; i++) {
        if (trials[i].id === id) return;
      }
      var insertAt = trials.length;
      for (var j = 0; j < trials.length; j++) {
        if (trials[j].ordinal > ordinal) { insertAt = j; break; }
      }
      trials.splice(insertAt, 0, { id: id, label: label, ordinal: ordinal });
      renderTabs();
    },
  };
}
