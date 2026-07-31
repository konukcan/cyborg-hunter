// demo/plot-adapter.js
// Browser-side serialization of the pure plot cores: same drawing code the
// CLI runs, canvases from document.createElement (or an injected factory in
// tests), PNGs as data URIs for renderIndexHtml's imageSources opt. Each
// core may return null (skips participants without enough data) — passed
// through so the report omits that plot's <img>.
// NOTE: browser output approximates CLI PNGs (fonts/antialiasing differ) —
// report copy says "the same plots, drawn in your browser"; never claim
// pixel identity.
// Factory shape: makePlotAdapter(cores) is pure (node-testable against src
// cores); the default export lazy-imports ./preview-core.js (the esbuild
// bundle) so the browser gets the same code the CLI runs.

var domCache = {}; // canvas reuse across playground re-runs (spec §7.4)
function domFactory(w, h) {
  var key = w + 'x' + h;
  if (!domCache[key]) domCache[key] = document.createElement('canvas');
  domCache[key].width = w; domCache[key].height = h; // resizing also clears
  return domCache[key];
}

export function makePlotAdapter(cores) {
  async function run(draw, factory) {
    try {
      var canvas = await draw(factory);
      return canvas ? canvas.toDataURL('image/png') : null;
    } catch (err) {
      console.warn('cyborg-hunter demo: plot skipped', err);
      return null;
    }
  }
  return {
    renderPlotDataUris: async function (participant, triageEntry, config, createCanvas) {
      var factory = createCanvas || domFactory;
      return {
        typingProfile:   await run(function (cc) { return cores.drawTypingProfile(participant, config, cc); }, factory),
        sessionTimeline: await run(function (cc) { return cores.drawSessionTimeline(participant, config, cc); }, factory),
        trajectories:    await run(function (cc) { return cores.drawTrajectoryGrid(participant, triageEntry, config, cc); }, factory),
      };
    },
  };
}

export async function defaultPlotAdapter() {
  var core = await import('./preview-core.js');
  return makePlotAdapter(core);
}
