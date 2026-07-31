// The live session record (spec §5.2): a persistently visible two-tab pane —
// an append-only signal stream (default) and the literal session JSON. Fed by
// demo.js from the same onSignal dispatch as the rail. Frozen at results.
import { escHtml } from './util.js';
import { LIVE_PANE } from './steps.js';

export function formatClock(ms) {
  var total = Math.max(0, Math.round(ms / 100)); // deciseconds
  var m = Math.floor(total / 600);
  var s = Math.floor((total % 600) / 10);
  var d = total % 10;
  return m + ':' + String(s).padStart(2, '0') + '.' + d;
}

// Pure row builder (unit-tested without a DOM).
export function renderRowHtml(row) {
  return '<div class="lp-row' + (row.hard ? ' hard' : '') + '">' +
    '<span class="lp-t">' + escHtml(formatClock(row.tMs)) + '</span>' +
    '<span class="lp-trial">' + escHtml(row.trial || 'session') + '</span>' +
    '<span class="lp-event">' + escHtml(row.event) + '</span>' +
    '<span class="lp-detail">' + escHtml(row.detail || '—') + '</span>' +
    '</div>';
}

export function makeLivePane(mount, pid) {
  var frozen = false, count = 0, currentTab = 'stream';
  mount.innerHTML =
    '<div class="lp-head"><span class="lp-title">' + escHtml(LIVE_PANE.title) + '</span>' +
    '<div class="lp-tabs">' +
    '<button class="lp-tab active" data-tab="stream">' + escHtml(LIVE_PANE.tabs.stream) + '</button>' +
    '<button class="lp-tab" data-tab="json">' + escHtml(LIVE_PANE.tabs.json) + '</button>' +
    '</div></div>' +
    '<div class="lp-stream" data-role="lp-stream"><div class="lp-cols">' +
    '<span>time</span><span>trial</span><span>event</span><span>detail</span></div></div>' +
    '<pre class="lp-json" data-role="lp-json" hidden></pre>' +
    '<p class="lp-caption">' + escHtml(LIVE_PANE.caption.replace('{{pid}}', pid)) + '</p>';
  var streamEl = mount.querySelector('[data-role="lp-stream"]');
  var jsonEl = mount.querySelector('[data-role="lp-json"]');
  mount.querySelectorAll('.lp-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      currentTab = t.dataset.tab;
      mount.querySelectorAll('.lp-tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      streamEl.hidden = currentTab !== 'stream';
      jsonEl.hidden = currentTab !== 'json';
    });
  });
  return {
    addRow: function (row) {
      if (frozen) return;
      count++;
      streamEl.insertAdjacentHTML('beforeend', renderRowHtml(row));
      streamEl.scrollTop = streamEl.scrollHeight; // follow the tail
    },
    setPayload: function (payload) {
      if (frozen) return;
      jsonEl.textContent = JSON.stringify(payload, null, 2);
    },
    freeze: function () { frozen = true; },
    rowCount: function () { return count; },
  };
}
