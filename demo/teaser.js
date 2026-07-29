// demo/teaser.js
// Welcome-step ASIDE (step 1): a small scrub player for the pre-recorded
// teaser session (demo/assets/teaser-recording.json) plus the honeypot
// agent-trace annotated list (demo/assets/agent-trace.json). Lazy-loaded by
// demo.js's goTo() only when the welcome step renders. The full replay
// viewer (src/cli/renderers/replay-viewer.client.js) is overkill for a
// 30s clip — this reuses buildViewerModel via preview-core.js (same lazy
// import as demo/results.js) for the wire->trial-relative-ms conversion,
// then draws a plain cursor dot + event ticker + play/pause + progress bar
// off the flattened timeline. Both mount points start `hidden` (steps.js);
// on any failure here they just stay hidden, leaving the static description
// already in steps.js's welcome copy as the fallback — never a half-built
// player.

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lays trials back-to-back by duration into one session-absolute timeline.
// Real inter-trial gaps aren't preserved — an approximation that's fine for
// a scrub teaser that isn't claiming frame-accurate replay. The implicit
// '__session__' trial (src/replay/recorder.js: events captured while no
// real trial is open) is excluded — it's anchored to session start rather
// than appended after the real trials, so folding it in here would badly
// overlap the timeline instead of extending it.
function flattenTimeline(model) {
  var events = [];
  var offset = 0;
  model.trials.forEach(function (trial) {
    if (trial.id === '__session__') return;
    trial.events.forEach(function (e) {
      events.push(Object.assign({}, e, { tAbs: offset + e.t }));
    });
    offset += trial.durMs;
  });
  return { events: events, totalMs: offset };
}

function labelFor(e) {
  if (e.kind === 'mousemove') return 'mouse move';
  if (e.kind === 'paste') return 'paste';
  if (e.kind === 'blur') return 'tab away';
  if (e.kind === 'focus') return 'tab back';
  if (e.kind === 'keydown' || e.kind === 'keyup' || e.kind === 'input') return 'typing';
  if (e.kind === 'click' || e.kind === 'mousedown' || e.kind === 'mouseup') return 'click';
  if (e.kind === 'scroll') return 'scroll';
  return e.kind || 'event';
}

function mountPlayer(el, model) {
  var timeline = flattenTimeline(model);
  var cursorEvents = timeline.events.filter(function (e) { return typeof e.cx === 'number'; });
  if (timeline.totalMs <= 0 || cursorEvents.length === 0) return;

  el.innerHTML =
    '<div class="teaser-stage"><div class="teaser-dot"></div><p class="teaser-ticker" data-role="ticker">ready</p></div>' +
    '<div class="teaser-controls"><button class="btn" data-action="teaser-play" type="button">Play</button>' +
    '<input type="range" min="0" max="1000" value="0" data-role="teaser-scrub"></div>';
  el.hidden = false;

  var stage = el.querySelector('.teaser-stage');
  var dot = el.querySelector('.teaser-dot');
  var ticker = el.querySelector('[data-role="ticker"]');
  var scrub = el.querySelector('[data-role="teaser-scrub"]');
  var playBtn = el.querySelector('[data-action="teaser-play"]');
  var srcW = (model.viewport && model.viewport.width) || 1280;
  var srcH = (model.viewport && model.viewport.height) || 800;

  function paintAt(ms) {
    var current = null;
    var tickText = null;
    for (var i = 0; i < timeline.events.length && timeline.events[i].tAbs <= ms; i++) {
      tickText = labelFor(timeline.events[i]);
      if (typeof timeline.events[i].cx === 'number') current = timeline.events[i];
    }
    if (current) {
      dot.style.left = Math.max(0, Math.min(1, current.cx / srcW)) * stage.clientWidth + 'px';
      dot.style.top = Math.max(0, Math.min(1, current.cy / srcH)) * stage.clientHeight + 'px';
    }
    ticker.textContent = tickText || 'ready';
    scrub.value = String(Math.round((ms / timeline.totalMs) * 1000));
  }

  var playing = false;
  var elapsedMs = 0;
  var lastFrame = null;
  function tick(now) {
    if (!playing) return;
    if (lastFrame != null) elapsedMs += now - lastFrame;
    lastFrame = now;
    if (elapsedMs >= timeline.totalMs) {
      elapsedMs = timeline.totalMs;
      playing = false;
      playBtn.textContent = 'Play';
    }
    paintAt(elapsedMs);
    if (playing) requestAnimationFrame(tick);
  }

  playBtn.addEventListener('click', function () {
    playing = !playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
      if (elapsedMs >= timeline.totalMs) elapsedMs = 0;
      lastFrame = null;
      requestAnimationFrame(tick);
    }
  });
  scrub.addEventListener('input', function () {
    playing = false;
    playBtn.textContent = 'Play';
    elapsedMs = (Number(scrub.value) / 1000) * timeline.totalMs;
    paintAt(elapsedMs);
  });

  paintAt(0);
}

function mountTrace(el, trace) {
  if (!trace || !Array.isArray(trace.annotations) || trace.annotations.length === 0) return;
  el.innerHTML =
    '<p class="teaser-trace-label">honeypot catch — annotated</p><ul>' +
    trace.annotations.map(function (a) {
      return '<li><span class="t">' + (a.t / 1000).toFixed(1) + 's</span>' + escHtml(a.label) + '</li>';
    }).join('') + '</ul>';
  el.hidden = false;
}

export function mountTeaser(playerEl, traceEl) {
  if (!playerEl && !traceEl) return;
  Promise.all([
    import('./preview-core.js'),
    fetch('./assets/teaser-recording.json').then(function (r) { return r.json(); }),
    fetch('./assets/agent-trace.json').then(function (r) { return r.json(); }).catch(function () { return null; }),
  ]).then(function (loaded) {
    var core = loaded[0];
    var recording = loaded[1];
    var trace = loaded[2];
    if (playerEl) mountPlayer(playerEl, core.buildViewerModel(recording));
    if (traceEl) mountTrace(traceEl, trace);
  }).catch(function (err) {
    console.warn('cyborg-hunter demo: teaser unavailable, showing the static description only', err);
  });
}
