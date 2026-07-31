// demo/rail.js
// Sticky signal-checklist rail. Module-scoped singleton (there is only ever
// one #rail on the page): renderRail() builds the grouped list and remembers
// its rows; light()/acknowledge() then update that remembered state without
// needing the container passed back in each time.

var rowsByKey = {};
var listEl = null;
var awaitingNoteEl = null;

function renderGroupRows(rows, rowClass) {
  return rows.map(function (r) {
    var isAlwaysOn = r.key === 'mousePaths' || r.key === 'replay';
    var cls = isAlwaysOn ? 'always' : (rowClass || '');
    var nText = isAlwaysOn ? 'always on' : '0';
    return '<li data-key="' + r.key + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
      '<span class="lamp"></span><span class="lbl">' + r.label + '</span>' +
      '<span class="n">' + nText + '</span></li>';
  }).join('');
}

/**
 * Builds the grouped checklist inside `container` (#rail). Starts inert
 * ("awaiting your session" — the .check list carries an `awaiting` class)
 * until the first lamp lights, which clears it.
 */
export function renderRail(container, opts) {
  var groups = opts.groups;
  var intro = opts.intro;

  var html = '<h3>Tracked signals</h3>';
  html += '<p class="sub awaiting-note">awaiting your session</p>';
  html += '<p class="sub">' + intro + '</p>';
  html += '<ul class="check awaiting">';
  html += '<li class="hint">Detectors</li>' + renderGroupRows(groups.detectors);
  html += '<li class="hint">Guard</li>' + renderGroupRows(groups.guard, 'guardrow');
  html += '<li class="hint">Recording</li>' + renderGroupRows(groups.recording);
  html += '</ul>';
  container.innerHTML = html;

  rowsByKey = {};
  listEl = container.querySelector('.check');
  awaitingNoteEl = container.querySelector('.awaiting-note');
  container.querySelectorAll('li[data-key]').forEach(function (li) {
    rowsByKey[li.dataset.key] = li;
  });

  return container;
}

/**
 * Lights a row: adds .lit (and .hardlit when opts.hard), updates the count
 * text, and re-triggers the one-shot lamp-pulse animation (remove, force
 * reflow, re-add — the standard way to restart a CSS animation on the same
 * element). Returns the row, or null if renderRail() hasn't run / key is
 * unknown.
 */
export function light(key, count, opts) {
  var row = rowsByKey[key];
  if (!row) return null;

  row.classList.add('lit');
  if (opts && opts.hard) row.classList.add('hardlit');

  var n = row.querySelector('.n');
  if (n) n.textContent = String(count);

  var lamp = row.querySelector('.lamp');
  if (lamp) {
    lamp.classList.remove('lamp-pulse');
    void lamp.offsetWidth; // force reflow so the animation can re-trigger
    lamp.classList.add('lamp-pulse');
  }

  if (listEl) listEl.classList.remove('awaiting');
  if (awaitingNoteEl) awaitingNoteEl.hidden = true;

  return row;
}

/**
 * Injects the inline "✓ detected — <label>" strip into the current step
 * card. Idempotent per step: renderStep() replaces cardEl's innerHTML on
 * every navigation, so a prior strip is already gone by the time a new
 * step's card could receive one; this guard only prevents a second strip
 * within the SAME step's lifetime (e.g. two pastes on one card).
 */
export function acknowledge(cardEl, label) {
  if (!cardEl || cardEl.querySelector('.detected-strip')) {
    return cardEl ? cardEl.querySelector('.detected-strip') : null;
  }
  var strip = document.createElement('p');
  strip.className = 'detected-strip';
  strip.setAttribute('style', 'margin:0 0 14px;font-size:13px;color:var(--clean);');
  strip.textContent = '✓ detected — ' + label;
  cardEl.appendChild(strip);
  return strip;
}
