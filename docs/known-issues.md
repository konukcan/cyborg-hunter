# Known Issues

Issues we've identified but not yet fixed. Filed here rather than dropped in commit messages so they're easy to find and revisit.

## Session replay (0.7.0 feature)

The items below are known limitations of the replay feature, kept open deliberately.

### Viewer for the replay resolves mutation paths against `document.body`, not the capture root

**Symptom:** `src/cli/renderers/replay-viewer.client.js` `applyMutation()` resolves each patch path from `doc.body`, but capture paths (`capture-dom.js` `nodePath`) are relative to the configured `root`. With the default `root` (document.body) this works — the serialized `<body>` collapses when re-inserted, aligning the root's children with the viewer body's children. With a **non-body root** (e.g. `root: '#experiment'`), the serialized root element becomes a child of the viewer body, so every path is shifted one level and mutations apply to the wrong node — the replay diverges from what the participant saw.

**Fix (deferred — format-level):** make capture and viewer agree on the root anchor. Cleanest is to serialize the root's *children* (innerHTML semantics) for `initial_dom` so the viewer body holds exactly the root-relative children for both cases; alternatively record the root path in the model and anchor `resolvePath` there. Deferred because it changes the recording format and touches the DOM-snapshot tests + guard-violation snapshots.

**Severity:** Major for studies that set a non-body capture root; the default is unaffected.

### ID-less input elements are resolved by first tag match in the viewer

**Symptom:** An input/textarea with no `id` is described only by tag name in the trace (`capture-trace.js`, `describeEl`); the viewer selects the first element of that tag (`replay-viewer.client.js`). Typing into the second of two ID-less textareas updates the first textarea in the replay.

**Fix (deferred):** capture an nth-of-type index or a child-index path for ID-less targets, and resolve it in the viewer. Minor fidelity issue; most experiment fields carry ids.

**Severity:** Minor.

## Client-side authority limits (inherent, not patchable)

### The guard-friction stop token is not a security boundary

**Symptom:** `GuardFriction.start()` returns a 256-bit stop token and stashes it on `window._guardFrictionToken` (non-enumerable). A participant who reads the (public, npm-published) source can run `GuardFriction.stop(window._guardFrictionToken)` to cleanly tear down monitoring. After the stop, leaving fullscreen or opening a sidebar produces no new violations, and because `stop()` also clears the tamper interval, no tamper marker is recorded. The early stop is indistinguishable from the legitimate end-of-session `finalize()` stop.

**Why it can't be fixed by hiding the token better:** the property name is in the shipped source, and `GuardFriction` is itself on `window`; a non-enumerable property is trivially readable by name. Any client-side secret is readable by client-side code. The token only stops accidental/naive calls, not a motivated cheater.

**Improvement worth considering (not a fix):** make an early stop *observable* rather than trying to prevent it — e.g. record the guard's active-state per trial (so a stopped guard shows as "guard inactive" instead of "no violations"), or emit a distinct marker into the honeypot log when `stop()` runs while trials are still ongoing. That converts a silent bypass into a visible one without pretending the token is a lock.

**Severity:** Bounded by design. The active guard raises the cost of evasion (friction) and the honeypot bait surfaces provide an independent, non-listener detection path; neither depends on the token being secret.

## Signal-layer edge cases

### Core sidebar detection is blind to a sidebar opened before `startSession()`

(Same class as the guard-extension entry "Sidebar opened before fullscreen entry is not detected," but for the core `browser.js` signal.)

**Symptom:** `attachBrowserSignals()` captures `_baselineIW = window.innerWidth` (and the ResizeObserver's `baselineWidth = document.documentElement.clientWidth`) at `startSession()`. If an AI browser sidebar is already open at that moment, the shrunk viewport is baked into the baseline, so `sidebarEvents` and `viewportWidthShifts` stay empty for the whole session — the sidebar contributes no soft score.

**Root cause:** sidebar detection is a *delta-from-baseline* detector with no absolute expected-width reference. It can only see a sidebar that opens (or closes) after the baseline is captured.

**Why it isn't patched here:** the obvious absolute check (`screen.availWidth - innerWidth > threshold`) is unreliable across multi-monitor and OS-scaled configurations and across browser zoom (the guard extension deliberately dropped exactly this comparison for that reason — see `extension-guard-friction.js:499-507`). A robust fix would capture a pre-experiment baseline before any sidebar could be open, which is an experiment-flow change, not a library-internal one.

**Severity:** Medium for a participant who opens the sidebar before the experiment loads and never resizes it. Partially covered by the foreign-input and AI-extension-DOM signals if the participant interacts with an extension-based assistant.

### An open tab-away is lost if the participant never returns

**Symptom:** `focus.js` records a tab-away only on `_onReturn()`. If a participant switches away (blur / tab hidden) during a trial and the trial ends while they are still away — or they never return before the session finalizes or navigates away — the event is absent from both the trial report and `getSessionReport()` (`tabAwayEvents=[]`, `tabAwaySums=[]`). A tab-away that spans a trial boundary is also attributed to whichever trial is active at *return* time, not the trial it began in.

**Root cause:** the leave sets a pending start; only the matching return materializes the `{start, duration_ms, type, timestamp}` record. There is no flush of an in-progress interval at `endTrial()` / `getSessionReport()`, and a true navigation-away exit gives no return event at all.

**Partial remediation (deferred, would change emitted data → a future minor version):** flush any pending tab-away at `endTrial()` and `getSessionReport()` as a partial-duration event (kept open so the eventual return can finalize it), and add a `pagehide`/`visibilitychange→hidden` handler that records the open interval before unload. The abrupt-navigation case is only recoverable if the adopter's save path runs on unload; the trial-end/never-return-before-finalize case is fully recoverable and is the higher-value half.

**Severity:** Medium, and a genuine evasion vector: leave during a trial to consult an assistant, return after the trial has advanced, and the tab-away is misattributed or invisible.

### `charsPerSec` counts input *events*, not characters

**Symptom:** `computeTypingSpeed()` uses `editTimestamps.length` (one entry per `input` event) as the character count, so the "chars per second" metric is really *edits* per second. For normal keystroke-by-keystroke typing the two coincide, but a single `input` event that inserts a long string counts as one "char." An automation that sets a long answer via one `input` event (paired with one `keydown` inside `syntheticGapMs` so the synthetic-insertion detector also stays quiet) produces `editTimestamps.length` of 1, so `computeTypingSpeed` returns `null` and no typing-speed signal fires — while also leaving `pasteEvents` and `syntheticInsertions` empty.

**Why the naming isn't simply renamed:** the metric works for its intended job (flag implausibly fast human typing); burst insertions are meant to be caught by the paste and synthetic-insertion detectors, not the speed metric. The evasion above is the sharper issue and is a known limitation of the synthetic-insertion heuristic: pairing a real `keydown` with the programmatic `input` defeats the keydown-gap test. Closing it requires deeper input-provenance fingerprinting (e.g. `isTrusted`, cadence entropy) rather than a rename.

**Severity:** Low-to-medium. Requires DOM-automation authority (the adversarial-participant threat model), and is one of several signals such an adversary can suppress (see the client-side-authority limits above).

## CLI ingest / analysis

### Malformed `tabAwaySums` values are coerced with `Number(d) || 0`

**Symptom:** `computeTabAwayCounts()` (`src/cli/analyzers/summary.js`) maps the session-level `tabAwaySums` array with `Number(d) || 0`. A non-numeric string (`"12000ms"`) becomes `NaN → 0` and is mislabeled as a flicker; `null` becomes a fabricated 0-duration event; `"Infinity"` passes through and poisons `totalTabAwayDuration_ms`. So `tabAwaySums = ["12000ms", null, "Infinity"]` yields `totalTabAways=3`, one long, one flicker, and an infinite total.

**Why it isn't patched here:** `tabAwaySums` is produced by the library as `Math.round(duration)` — always finite numbers — so this only bites on hand-edited or corrupted payloads, and the fix (filter to `Number.isFinite`, drop non-finite entries) changes the tab-away *count* semantics, which existing cohorts' pinned pipeline output depends on. A future minor version can filter non-finite durations behind the same versioned-behavior rule the cut-counting fix used.

**Severity:** Minor. Producer-controlled; affects only malformed session payloads.

### Shape-3 (top-level array) participants ingest as "unknown", so their replay artifacts never attach

**Symptom:** For a Shape-3 payload (a top-level JSON array of trials), `extractIntegrityData` resolves the participant id against the raw value itself (`getByPath(raw, pidField)` then `raw.metadata`), and an array carries neither, so every Shape-3 participant lands under `"unknown"` (with the 0.6.2 unresolved-id warning). Consequences: `attachReplayArtifacts` searches for `unknown-replay-<epoch>.json` and never finds the participant's real artifact (e.g. `P3-replay-<epoch>.json`), and `--participant P3` filters the participant out entirely.

**Why it isn't patched here:** resolving the id from the trial rows (e.g. first row's `pidField`, or the integrity sub-object's `participantId`) is a small, testable change for a future minor version; it alters how existing Shape-3 cohorts key their outputs, so it needs the versioned-behavior treatment.

**Severity:** Medium for Shape-3 adopters using replay or `--participant`. Shape-1 cohorts (a `{ trials: [...] }` wrapper object — what the jsPsych extension saves) and Shape-2 cohorts (a legacy `{ responses: [...] }` layout) are unaffected.

## Guard / friction

### Sidebar opened before fullscreen entry is not detected

**Symptom:** A participant who opens a browser sidebar (Chrome Gemini, Edge Copilot, docked DevTools, reading panes, etc.) *before* clicking "Enter fullscreen and continue" on the entry trial does not get a `sidebar_open` violation, even though the sidebar remains visible alongside the experiment for the rest of the session. They are caught by the `window_blurred` check the moment they click into the sidebar — but if they only read from it (no focus shift), they are never flagged by the sidebar check at all.

**Root cause:** Baseline capture in `extension-guard-friction.js:567-587` runs once `fullscreenchange` fires:

```javascript
state.baselineWidth = window.innerWidth * dpr;
```

If a sidebar is already open at that moment, `window.innerWidth` already reflects the shrunk viewport. The "baseline" silently bakes in the sidebar's compression. Subsequent `check()` calls compare current innerWidth against that already-compressed baseline, find no delta, and pass the sidebar test.

The sidebar check (`extension-guard-friction.js:487-498`) only triggers on a shrink *relative to baseline* — it has no notion of an absolute "expected viewport size."

**Why it follows from the model's logic:** The DPR-stable baseline approach (`innerWidth × devicePixelRatio`) is designed to be invariant under browser zoom, which is correct. It assumes the comparison reference (baseline) was captured in a "clean" no-sidebar state. The fullscreen-entry event is the only opportunity to capture that reference, and at that moment the sidebar may already be open.

**Possible remediations** (not yet implemented, ranked by robustness):

1. **Capture pre-fullscreen baseline.** In the entry trial's `on_finish`, snapshot `window.innerWidth` *before* calling `requestFullscreen()`, then compare to the post-fullscreen value. A non-trivial shrink (or no growth into fullscreen) implies a sidebar was already eating space. Most robust because it doesn't rely on `screen.availWidth` reliability.
2. **Pre-entry sidebar check via `screen.availWidth`.** Compute `screen.availWidth - innerWidth` at the moment the user clicks "Enter fullscreen." If > 80 CSS px, refuse entry with a "please close any sidebars first" message. Has the `availWidth` reliability caveat (multi-monitor + scaled-OS configs can produce surprising values).
3. **Continuous `availWidth` sanity check.** After baseline capture, also assert `baseline_css_px > screen.availWidth - 80px`. If not, treat baseline as poisoned and re-baseline. Lower confidence — `availWidth` doesn't always match what you'd expect.

**Severity:** Medium. Defeated by the `window_blurred` check the moment the participant interacts with the sidebar. Concerning for participants who use the sidebar in read-only mode (e.g., an LLM analyzing screenshots they take separately, or a sidebar that streams content without requiring focus).

**Worth noting alongside this:** The visible bait surfaces (`extension-guard-honeypot.js:191-226`) provide an independent detection path for agentic browsers that fill DOM elements regardless of fullscreen / focus state. The sidebar-detection gap doesn't subvert the bait surfaces.