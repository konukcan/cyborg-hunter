// demo/replay-host.js
// Walkthrough item 12's fix: the visitor's own replay renders in a SEPARATE
// same-origin viewer-host iframe, a sibling of the report iframe in the
// demo's top document — not nested inside it (results.js no longer passes
// inlineReplayModels to the report renderer; see buildReportHtml).
//
// Root cause this works around (Codex-confirmed): the report iframe is
// sandbox="allow-scripts" (opaque origin, deliberately — see results.js's
// swapIframe docblock). replay-viewer.client.js's inner DOM-reconstruction
// iframe (sandbox="allow-same-origin", no allow-scripts) needs same-origin
// contentDocument access to rebuild the recorded page; nesting it two
// sandboxes deep forced it opaque too, so reconstruction froze at the first
// frame (mouse/keycast overlays, drawn in the OUTER document, still worked).
// This host keeps the report's own sandbox untouched — zero security
// tradeoff there — and gives the replay its own one-level-deep frame
// instead, so ITS inner reconstruction frame stays same-origin.
//
// Safety: this host's sandbox is "allow-scripts allow-same-origin", but the
// ONLY script it ever runs is our own first-party replay-viewer.client.js
// (fetched from this same origin, not visitor-controlled). The visitor's
// recorded DOM never executes here — it's rebuilt one level deeper, inside
// the viewer's OWN reconstruction iframe, which stays allow-same-origin
// WITHOUT allow-scripts plus a script-blocking CSP (see
// replay-viewer.client.js's srcdocCsp/buildSrcdoc) — a pasted <script> still
// never runs, same guarantee the CLI report's own nested replay relies on.

// .replay-* rules, copied verbatim from src/cli/renderers/html-index-core.js's
// report <style> block (grep .replay- there for the source of truth — no
// build-time extraction step touches this Blob-embedded document, so this
// copy is kept in sync by hand). Selectors reference --surface/--ink/--dim/
// --line/--bg/--hard, resolved below to concrete values, NOT the CLI
// report's own palette — see ROOT_CSS.
var REPLAY_RULES_CSS = `
.replay-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.replay-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px;
                background: var(--ink); color: var(--surface); }
.replay-badge[data-tier="trace"] { background: var(--surface); color: var(--ink);
                border: 1px solid var(--line); }
.replay-stage { position: relative; overflow: hidden; background: var(--surface);
                border: 1px solid var(--line); border-radius: 4px; }
.replay-frame { position: absolute; top: 0; left: 0; border: 0; }
.replay-overlay { position: absolute; top: 0; left: 0; pointer-events: none; }
.replay-neutral { background: #e8e6e0; }
.replay-neutral-label { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
                        color: var(--dim); font-size: 13px; }
.replay-lane { display: block; margin-top: 6px; border-radius: 2px; }
.replay-scrub { display: block; margin: 2px 0 4px; }
.replay-ticker { font: 12px/1.3 ui-monospace, SFMono-Regular, 'IBM Plex Mono', monospace;
                 color: var(--dim); font-variant-numeric: tabular-nums;
                 height: 1.4em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.replay-note { font-size: 12px; color: var(--dim); }
.replay-warn { color: var(--hard); }
.replay-play, .replay-load-btn, .replay-css-btn, .replay-trial-select, .replay-speed {
  padding: 4px 10px; border: 1px solid var(--line); background: var(--surface);
  color: var(--ink); border-radius: 4px; cursor: pointer; font-size: 13px; }
.replay-play:hover, .replay-load-btn:hover, .replay-css-btn:hover { background: var(--bg); }
.replay-play:disabled, .replay-load-btn:disabled { opacity: 0.6; cursor: default; }
.replay-css-btn { font-size: 12px; padding: 2px 8px; }
.replay-clock { font: 12px/1.3 ui-monospace, SFMono-Regular, 'IBM Plex Mono', monospace;
                font-variant-numeric: tabular-nums; }
.replay-keycast { position: absolute; left: 0; right: 0; bottom: 0; display: flex;
                gap: 4px; padding: 5px 6px; pointer-events: none; flex-wrap: wrap-reverse; }
.replay-key-chip { font: 11px/1.2 ui-monospace, SFMono-Regular, 'IBM Plex Mono', monospace;
                background: rgba(0,0,0,0.72); color: #fff; padding: 2px 7px;
                border-radius: 3px; white-space: nowrap; }
.replay-key-chip--redacted { background: rgba(0,0,0,0.5); font-style: italic; }
`;

// Concrete values for the vars REPLAY_RULES_CSS references, copied from
// demo.css's OWN tokens (--panel/--ground/--ink/--dim/--line/--hard) rather
// than the CLI report's beige palette — this is a fully separate Blob
// document with no access to demo.css's cascade, so the host maps onto the
// results screen's actual card chrome by value, not by reference. Mapping:
// --bg<-demo --ground, --surface<-demo --panel, everything else same name.
var ROOT_CSS = `
:root{ --bg:#F6F8FA; --surface:#FFFFFF; --ink:#1B232C; --dim:#5F6B77; --line:#E6EBF0; --hard:#C62828; }
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; background:var(--surface); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
body{ padding:16px; }
#ch-replay-mount{ width:100%; }
`;

// Same intent as buildSrcdoc's own `</` guard (replay-viewer.client.js):
// embedding arbitrary text inside an inline <script> must neutralize any
// `</script`-like sequence so the HTML parser can't close the tag early.
// Narrower than buildSrcdoc's bare `<\//g` on purpose — that pattern is safe
// for CSS text, but replayClientSrc is JS SOURCE, not data, and it contains
// its own `/</g` regex literal (attrEscape's `<` -> `&lt;` rule); a bare
// `</` replace there strips that regex's closing delimiter and throws
// "Invalid regular expression: missing /" (found by driving this live).
// Matching `</script` case-insensitively is the actual HTML-parser hazard
// (that's the only sequence that closes a <script> tag early) and leaves
// every other `</` in the source — regex literals included — untouched.
// Applied to BOTH the inlined client source (defensive; it's a static
// first-party file) and the JSON-encoded model (load-bearing: the model
// carries visitor-typed/pasted text).
function escapeScriptClose(s) {
  return String(s).replace(/<\/script/gi, '<\\/script');
}

// Pure: the host document's full HTML. DOM-free — see
// tests/demo/replay-host.test.js.
export function buildReplayHostHtml(replayModel, replayClientSrc) {
  var clientScript = escapeScriptClose(replayClientSrc || '');
  var modelJson = escapeScriptClose(JSON.stringify(replayModel));
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>' + ROOT_CSS + REPLAY_RULES_CSS + '</style>' +
    '</head><body>' +
    '<div id="ch-replay-mount"></div>' +
    '<script>' + clientScript + '</script>' +
    '<script>window.initChReplayViewer(document.getElementById(\'ch-replay-mount\'), ' + modelJson + ');</script>' +
    '</body></html>'
  );
}

// Builds + appends the "Session replay" card (heading + hint + host iframe)
// as the last child of `container` — a sibling of the report iframe, which
// swapIframe() also appends directly to `container`. Idempotent: a second
// call is a no-op while a host iframe is already mounted, so a caller never
// needs to track whether it already ran.
export function mountReplayHost(container, replayModel, replayClientSrc) {
  if (!container || container.querySelector('iframe.replay-host-frame')) return null;
  var section = document.createElement('div');
  section.className = 'replay-host-card';
  section.innerHTML =
    '<h3>Session replay</h3>' +
    '<p class="hint">Your own recorded session, reconstructed from the same data behind the ' +
    'report above. The report you build locally with the CLI embeds this same replay inline, ' +
    'inside the report page.</p>';
  var iframe = document.createElement('iframe');
  iframe.className = 'replay-host-frame';
  // allow-scripts allow-same-origin: see the docblock above for why this is
  // safe (only our own client script runs here; the recorded DOM stays
  // sandboxed one level deeper, inside the viewer's own reconstruction
  // frame).
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.title = 'Your session replay';
  section.appendChild(iframe);
  container.appendChild(section);
  iframe.src = URL.createObjectURL(new Blob(
    [buildReplayHostHtml(replayModel, replayClientSrc)], { type: 'text/html' }));
  return iframe;
}

// Revokes the host's Blob URL and removes the whole "Session replay" card.
// The viewer client (replay-viewer.client.js) runs a RAF loop + a
// ResizeObserver and exposes no destroy() — removing the iframe from the
// document discards its browsing context (the browser stops both loops for
// us), but the Blob URL survives that and must be revoked explicitly or it
// leaks for the rest of the tab's lifetime. Safe to call whether or not a
// host is currently mounted (no-op if `.replay-host-card` isn't found), and
// safe to call on an already-detached `root` (a card removed from the live
// document by an unrelated innerHTML replacement still has a live `iframe`
// reference with its `src` intact).
export function teardownReplayHost(root) {
  if (!root) return;
  var card = root.querySelector('.replay-host-card');
  if (!card) return;
  var iframe = card.querySelector('iframe.replay-host-frame');
  if (iframe && iframe.src) URL.revokeObjectURL(iframe.src);
  card.remove();
}
