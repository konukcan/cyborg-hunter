# Roundtable PoH vs. Cyborg-Hunter — Feature Comparison

> **Status:** Living document. Progressively enriched as benchmark runs complete. Last updated `2026-05-13`.
> **Scope:** Roundtable Proof-of-Human (rt.js bundle served from CDN, `new-api.roundtable.ai`) versus Cyborg-Hunter v0.4.0-post-merge (detection + guard-friction + guard-honeypot extensions).
> **Audience:** Researchers deploying integrity monitoring in online behavioral experiments; tool builders in the integrity space.

---

## 1. The two-question split

Comparing integrity tools requires asking two questions, not one:

1. **What does each tool capture from the browser?** (Client-side instrumentation — the *input* surface.)
2. **What does each tool expose back to the researcher?** (API surface — the *output* what you can actually see and act on.)

Conflating these makes the comparison wrong. Both tools instrument roughly the same DOM events and `navigator.*` APIs; they differ sharply in what they expose. RT compresses everything into a closed-model verdict plus a small set of session-level booleans. CH ships the raw event stream plus a configurable triage layer.

---

## 2. Architectural positioning

### Cyborg-Hunter (3-layer integrity stack)

| Layer | What it does | Output |
|---|---|---|
| **Detection** (`extension-cyborg-hunter`) | Passive observation: paste, copy, drop, tab-away, mouse trajectories, typing rhythm, sidebar detection, AI extension scan, idle gaps, foreign input | Per-trial integrity object + session rollup attached to jsPsych trial CSV; `cyborg-hunter` CLI then produces `event-log.csv` (chronological, per-event) plus summary CSV, triage MD, and HTML index |
| **Deterrence** (`extension-guard-friction`) | Active enforcement: fullscreen requirement, sidebar blocking, content-scrambling overlay on violations, AI-refusal DOM prose, tamper detection (300ms re-apply) | Violation log attached to trial data: `guard_assistance_violations_session` JSON column |
| **Active baiting** (`extension-guard-honeypot`) | Hidden + visible bait fields with LLM-baiting `aria-label`s; targets sidebar-LLMs and agentic browsers (Browser Use / Operator / Computer Use) | `ai_use_session` boolean + `ai_report_session` breadcrumb log columns |

### Roundtable Proof-of-Human (1-layer detection + ML)

| Component | What it does | Output |
|---|---|---|
| **rt.js script** | Captures DOM events, keystroke timings, mouse/pointer positions, scroll, focus changes, fingerprints (WebGL + navigator) — all sent to `new-api.roundtable.ai` | None directly; data goes server-side |
| **Server-side processing** | Runs proprietary `agent_behavior` ML model + 13 rule-based checks against the raw input stream | Returned via API: `risk_score` (0-100), `risk_explanation` (prose), `recommended_action`, `biometric_checks` (7 booleans), `device_checks` (6 booleans), `user_logs` / `events` (prose narrative) |

**Key architectural difference:** CH ships event-level data the researcher can audit; RT ships model verdicts the researcher must trust. Both observe similar amounts; the asymmetry is in disclosure, not capture.

---

## 3. Client-side capture surface (verified by source inspection)

This section is **empirically verified** by reading `extension-cyborg-hunter.js` source and the live `rt.js` bundle. Audit performed 2026-05-13. If RT updates the CDN bundle, this section may go stale — see §8.

### Roundtable rt.js (19.7 KB bundle)

DOM event listeners installed:

| Event | Count of listeners |
|---|---|
| `visibilitychange` | 2 |
| `pointerdown`, `pointermove` | 2, 1 |
| `input` | 2 |
| `touchstart`, `touchmove`, `touchend` | 1 each |
| `keydown`, `keyup` | 1 each |
| `click`, `change`, `submit` | 1 each |
| `focusin`, `focusout`, `focus`, `blur` | 1 each |
| `compositionstart`, `compositionupdate`, `compositionend` | 1 each (IME / autocomplete) |
| `selectionchange` | 1 |
| `scroll`, `wheel` | 1 each |
| `resize`, `orientationchange`, `popstate`, `pagehide`, `DOMContentLoaded`, `voiceschanged` | 1 each |

Additional capture mechanisms:
- `navigator.*` reads at session start: `userAgent`, `platform`, `deviceMemory`, `hardwareConcurrency`, `languages`, `plugins`, `geolocation`, `mediaDevices`
- WebGL / canvas fingerprint (one-time)
- `navigator.clipboard` access (gated on permission; otherwise inferred from `selectionchange` + `input`)
- `MutationObserver` (DOM mutation observation, scope unverified)

Capture mechanisms **NOT** present in rt.js:
- ❌ No `addEventListener('paste'|'copy'|'cut')` — RT does **not** directly observe clipboard events. Paste behavior must be inferred from `input` event timing patterns.
- ❌ No service workers, web workers, or shared workers
- ❌ No WebSocket / EventSource (no server-push channel)
- ❌ No DOM-prototype monkey-patching (`Object.defineProperty`, `Reflect.defineProperty`, `Element.prototype.X = ...`)
- ❌ No iframe injection (no second capture context)
- ❌ No dynamic `import()`, `eval()`, or injected `<script>` tags

**Verdict:** rt.js is a self-contained, single-bundle capture script. Its DOM listeners + `navigator.*` probes + WebGL fingerprint are the complete set of inputs Roundtable can collect client-side. What happens server-side (further models, cross-session joins, retention) is opaque.

### Cyborg-Hunter (vendored at commit `bb9ca1c`)

DOM event listeners installed (via `extension-cyborg-hunter.js` + `extension-guard-friction.js` + `extension-guard-honeypot.js`):

| Event | Source layer | Purpose |
|---|---|---|
| `paste`, `copy`, `drop` | detection | Direct clipboard observation |
| `visibilitychange`, `blur`, `focus` | detection + friction | Tab-away / focus loss tracking + violation enforcement |
| `pointermove` (20Hz polling) | detection | Mouse trajectory + path-efficiency metrics |
| `keydown`, `keyup`, `input`, `keypress` | detection | Typing speed, keyboard shortcuts, synthetic insertion |
| `resize` | detection | Window geometry, sidebar (`innerWidth_delta`) heuristic |
| `fullscreenchange` | friction | Fullscreen-exit violation |
| `click`, `focus`, `input` on bait fields | honeypot | AI-use detection |

Additional capture mechanisms:
- `document.activeElement` polling (foreign-input detection)
- `MutationObserver` (synthetic insertion detection, content-scrambling)
- DOM scan for known AI-extension content scripts (e.g., Monica, Merlin)
- Window position polling
- Zoom inference (DPR + viewport delta)
- Tamper interval (300ms): re-applies friction protections if externally removed

**Verdict:** CH's three-layer stack captures a comparable surface to RT for behavioral signals, but adds active deterrence (friction) and active baiting (honeypot) that RT does not have.

---

## 4. Exposed signals — what each tool gives back

### Roundtable PoH

**`GET /v1/sessions/{id}/report`** returns:

```jsonc
{
  "risk_score": 0-100,            // numeric overall risk
  "risk_explanation": "...",      // prose explanation
  "recommended_action": "Auto-accept" | "Review" | "Block",
  "tags": [...],                  // user-supplied tags
  "biometric_checks": {           // 7 booleans, all "Detected" | "Not detected"
    "agent_behavior":      ...,   //   ML model verdict (catch-all)
    "programmatic_typing": ...,   //   regular typing cadence
    "teleporting_mouse":   ...,   //   mouse jumps without trajectory
    "jump_scrolling":      ...,   //   discontinuous scroll
    "center_clicks":       ...,   //   centered clicks (bot signature)
    "no_corrections":      ...,   //   zero backspaces (anti-human signal)
    "all_pasted":          ...    //   ALL text responses pasted (strict-all)
  },
  "device_checks": {              // 6 booleans
    "bot":                ...,    //   headless browser signature
    "virtual_machine":    ...,
    "software_renderer":  ...,
    "tor":                ...,
    "vpn":                ...,
    "location_spoofing":  ...
  },
  "user_logs": [...]              // prose narrative of user actions (DEPRECATED;
                                  // use /events endpoint, identical content)
}
```

**`GET /v1/sessions/{id}/events`** returns chronological prose actions:

```jsonc
{
  "session_id": "...",
  "event_count": 63,
  "events": [
    { "action": "User navigated to /...", "user_time": "...", "unix_timestamp": ... },
    { "action": "Page became hidden",     "user_time": "...", "unix_timestamp": ... },
    { "action": "User clicked \"Next >\"", "user_time": "...", "unix_timestamp": ... },
    { "action": "User edited #...",       "user_time": "...", "unix_timestamp": ... },
    { "action": "User submitted ...",     "user_time": "...", "unix_timestamp": ... }
  ]
}
```

**Vocabulary observed empirically** in `events`:
- `User navigated to <url>`
- `User clicked "<button text>"` (37 of 63 events in our schema-discovery run)
- `User edited #<form-element-id>` (granularity: per-edit, not per-keystroke)
- `User submitted <form-id>`
- `Page became hidden` / `Page became visible`

**No paste, copy, mouse-movement, scroll, or sub-page focus events in the exposed stream.** RT instruments these (per rt.js audit) but does not expose them via the public API.

### Cyborg-Hunter

`cyborg-hunter` CLI ingests jsPsych trial CSVs (with attached integrity columns) and produces:

| Output | Format | Granularity |
|---|---|---|
| `summary.csv` | wide-table per-participant CSV | Per-session aggregates: counts, scores, flags |
| `event-log.csv` | long-table chronological CSV | **Per-event with real `timestamp` (ms)**: `eventType ∈ {paste, copy, drop, tabAway, synthetic, ...}`, `duration_ms`, `text` |
| `triage.md` | markdown table | Ranked list of suspicious participants with one-line "why flagged" |
| `images/` | PNG files | Per-participant mouse trajectories, tab-away timelines, typing-speed profiles |
| `index.html` | rendered HTML | Browsable triage report |

**Per-trial columns attached by the CH extension** (raw jsPsych output, before CLI):
- `integrity` — JSON blob with per-event detail
- `integrityScore`, `integrityPasteCount`, `integrityCopyCount`, `integrityDropCount`, `integrityAnyHardTriggered`, `integritySoftScore`
- `integritySession` — JSON: pasteCount, copyCount, dropCount, sidebarEvents, keyboardShortcuts, windowPositions, zoomChanges, devToolsEvents, layoutShifts
- `ai_use_session`, `ai_report_session` (when honeypot loaded)
- `guard_assistance_violations_session` (when friction loaded)

---

## 5. Signal-by-signal feature matrix

Columns:
- **CH captures** — does CH's instrumentation observe this?
- **CH exposes** — does it surface in CH's CLI output?
- **RT captures** — does rt.js observe this?
- **RT exposes** — does the public API return this?

Legend: ✓ = yes / ✗ = no / ◐ = partial / inferred / aggregate-only / 🔒 = closed-source heuristic.

### Behavioral signals (browser-side observation)

| Signal | CH captures | CH exposes | RT captures | RT exposes |
|---|---|---|---|---|
| Paste events (count + content) | ✓ direct (`paste` listener) | ✓ per-event in `event-log.csv` + content in `text` | ◐ inferred from `input` timing patterns | ◐ via `all_pasted` strict-aggregate only |
| Copy events | ✓ direct (`copy` listener) | ✓ per-event count + count column | ◐ inferred from `selectionchange` + `input` | ✗ not exposed |
| Drag-and-drop | ✓ direct (`drop` listener) | ✓ per-event count (hard signal) | ✗ no `drop` listener | ✗ — |
| Tab-away (visibility loss) | ✓ direct (`visibilitychange`) | ✓ per-event with duration buckets (short / medium / long) | ✓ direct (`visibilitychange`) | ✓ via `events` as `Page became hidden` / `Page became visible` with timestamps |
| Sub-page focus changes (element-level) | ◐ used internally for foreign-input | ✓ in `integritySession.foreignInputs` | ✓ direct (`focusin`/`focusout`) | ✗ not exposed |
| Typing speed (chars/sec) | ✓ derived from `keydown`/`keyup` | ✓ `meanTypingSpeed`, `trialsWithFastTyping` columns | ✓ derived from `keydown`/`keyup`/`input` | ◐ via `programmatic_typing` ML model verdict |
| Backspace / correction patterns | ✓ via `keydown` Backspace events | ◐ implicit in typing analysis | ✓ via `keydown`/`input` | ◐ via `no_corrections` boolean |
| Synthetic insertion (text without keystrokes) | ✓ via `MutationObserver` + `input` cross-check | ✓ per-trial count, session total | ✗ no MutationObserver-based check verified | ✗ — |
| Idle gaps in input | ✓ derived from event sparsity | ✓ `totalIdleGaps` column | ✓ derivable from timestamps server-side | ✗ not exposed |
| Foreign input (input outside experiment container) | ✓ via `document.activeElement` polling | ✓ in `integritySession` | ✗ not verified in rt.js | ✗ — |
| Mouse trajectory (raw positions) | ✓ 20 Hz polling | ✓ per-participant trajectory image + path-efficiency metric | ✓ via `pointermove` listener | ◐ via `teleporting_mouse` heuristic boolean |
| Scroll behavior | ◐ partial (resize-based heuristic) | ✗ no dedicated scroll column | ✓ via `scroll` + `wheel` listeners | ◐ via `jump_scrolling` boolean |
| Touch gestures (mobile/tablet) | ✗ desktop-focused | ✗ — | ✓ via `touchstart`/`touchmove`/`touchend` | ◐ via biometric checks aggregate |
| Centered-click pattern (bot signature) | ✗ | ✗ — | ◐ derived from `click` + position | ◐ via `center_clicks` boolean |
| Window/viewport geometry | ✓ polling + `resize` | ✓ `windowPositions` JSON in session rollup | ✓ via `resize` listener | ✗ not exposed (used for `device_checks`) |
| Sidebar opened (window-width delta) | ✓ `innerWidth_delta` heuristic | ✓ `sidebar_event_count` column | ◐ derivable from `resize` events | ✗ not exposed |
| AI extension content scripts | ✓ DOM scan for known selectors (Monica, Merlin, etc.) | ✓ `ai_extensions` column | ✗ not verified | ✗ — |
| Browser sidebar (Chrome Gemini, Edge Copilot) | ◐ via `innerWidth_delta` (catches generic sidebars) | ◐ as a sidebar event, not named extension | ✗ not verified | ✗ — |
| Keyboard shortcuts (Cmd+Tab, Cmd+T, ⌘+L) | ✓ specific shortcuts tracked | ✓ `keyboard_shortcut_count` column | ✓ via `keydown` listener | ✗ not exposed |
| Dev tools open/close | ✓ heuristic (timing/console-style detection) | ✓ `dev_tools_event_count` column | ◐ unclear whether RT detects | ✗ not exposed |
| Layout shift (potential injection) | ✓ via observer | ✓ `layout_shift_count` column | ✗ not verified | ✗ — |
| Zoom changes | ✓ DPR + viewport inference | ✓ `zoom_change_count` column | ◐ derivable | ✗ not exposed |
| IME / autocomplete composition | ✗ not tracked | ✗ — | ✓ via `compositionstart`/`update`/`end` | ✗ not exposed |

### Device / network signals

| Signal | CH captures | CH exposes | RT captures | RT exposes |
|---|---|---|---|---|
| User agent | ✗ not collected | ✗ — | ✓ `navigator.userAgent` | ◐ via `bot` + `device_checks` |
| Platform | ✗ | ✗ — | ✓ `navigator.platform` | ◐ |
| Hardware concurrency, deviceMemory | ✗ | ✗ — | ✓ `navigator.hardwareConcurrency`, `.deviceMemory` | ◐ via `device_checks` |
| Languages / plugins | ✗ | ✗ — | ✓ `navigator.languages`, `.plugins` | ◐ |
| WebGL / canvas fingerprint | ✗ | ✗ — | ✓ one-time at session start | ◐ via `software_renderer` boolean |
| IP-based geolocation | ✗ | ✗ — | ✓ server-side (from request IP) | ✓ via `location_spoofing` boolean |
| Browser-reported geolocation | ✗ | ✗ — | ✓ via `navigator.geolocation` (gated on permission) | ✓ used in `location_spoofing` cross-check |
| Headless browser detection (Selenium / Playwright / Puppeteer) | ✗ | ✗ — | ✓ multi-signal fingerprint | ✓ via `bot` boolean |
| Virtual machine detection | ✗ | ✗ — | ✓ rendering / timing signatures | ✓ via `virtual_machine` boolean |
| VPN / Tor / datacenter network origin | ✗ | ✗ — | ✓ server-side IP analysis | ✓ via `vpn`, `tor` booleans |

### Active interventions (CH-only)

| Signal | CH captures | CH exposes | RT captures | RT exposes |
|---|---|---|---|---|
| Fullscreen enforcement (entry trial + violation overlay) | ✓ guard-friction | ✓ `guard_violation_fullscreen` events | ✗ no enforcement layer | ✗ — |
| Sidebar blocking + content scrambling on violation | ✓ guard-friction | ✓ violation events with reason | ✗ | ✗ — |
| AI-refusal DOM prose (cooperative LLM refusal) | ✓ guard-friction | ◐ implicit in DOM (LLMs that read aria-labels see "refuse this") | ✗ | ✗ — |
| Tamper detection (300ms re-apply) | ✓ guard-friction | ✓ `tamper_detected` events | ✗ | ✗ — |
| Hidden honeypot field (LLM-baiting `aria-label`) | ✓ guard-honeypot | ✓ `ai_use_session` + `ai_report_session` | ✗ | ✗ — |
| Visible bait surfaces (4×4 px transparent, baits agentic browsers) | ✓ guard-honeypot | ✓ via `ai_use_session` (catches Browser Use / Operator) | ✗ | ✗ — |

### Architectural / researcher experience

| Property | CH | RT |
|---|---|---|
| Per-trial integration (jsPsych extension) | ✓ | ✗ session-level only |
| Raw event-level export | ✓ `event-log.csv` with `eventType, timestamp, duration_ms, text` | ◐ via `/events`, prose-action only, no structured event types |
| Risk score / verdict | ◐ via `softScore` + `hardScore` (configurable thresholds) | ✓ via `risk_score` 0-100 + `recommended_action` + ML model verdict |
| Source code | ✓ open (MIT) | ✗ closed (proprietary ML model + server-side processing) |
| Configurable thresholds | ✓ via `preset: permissive \| standard \| strict` + per-signal config | ✗ thresholds opaque; only the model verdict is returned |
| Customizable detection logic | ✓ — fork CH | ✗ |
| Self-hosted | ✓ — runs entirely client-side + local CLI | ✗ — depends on `new-api.roundtable.ai` |
| Per-participant evidence (replay/audit) | ✓ — operator can inspect every flagged event | ◐ — only the prose action log + booleans + risk_score |

---

## 5.5 Empirical side-by-side from a full run

A complete human smoke-test run through the bench harness. Both tools captured the same session. RT API + CH local CSV both available. This section enumerates **everything each tool actually produced** for this single run.

### Scope of accessible data per tool, this run

| | **Cyborg-Hunter** | **Roundtable PoH** |
|---|---|---|
| Data sources accessible | 1 (local CSV via `localSave`; same content uploaded to OSF via DataPipe POST in deployed `on_finish`) | 2 API endpoints — `/v1/sessions/{id}/report` + `/v1/sessions/{id}/events`. 15 other speculative endpoints probed (`/raw`, `/telemetry`, `/biometrics`, `/trace`, `/replay`, `/fingerprint`, etc.) all returned HTTP 404. |
| Granularity model | Per-trial integrity blob + per-session rollup (on last trial row) | Session-only; no per-trial demarcation anywhere |
| Total structured data points | ~250+ (77 window samples, 64 layout shifts, 39 timestamped events across categories, plus per-trial integrity for 16 trials) | ~152 (39 events × 3 fields + 17 report fields + 6 device + 7 biometric) |
| Timestamp format | ms since experiment start (session-relative) | unix epoch ms (absolute) + ISO user-time string |
| Continuous-stream events | Yes (20Hz mouse polling, window-position polling, layout-shift observer) | No — events are discrete user actions only (clicks, edits, submits, page-visibility) |

### Behavior-by-behavior comparison

What each tool exposed for behaviors the participant actually performed during this run:

| Behavior (run truth) | CH (file/field, granularity) | RT (file/field, granularity) | Differential |
|---|---|---|---|
| **Paste events (×2 deliberate)** | `integrity.pasteEvents` per-trial JSON with timestamps + content. Summed in `integrityPasteCount: 2` and `integritySession.pasteCount: 2`. Hard-flag fires: `integrityAnyHardTriggered: true` | NOT in events stream. Aggregate-only via `report.biometric_checks.all_pasted: "Not detected"` (strict-all flag, didn't trigger because not every text field was pasted) | **CH wins decisively** — per-event timing + content + threshold flag |
| **Copy events (×11)** | `integrity.copyEvents` per-trial + `integritySession.copyCount: 11`. Soft-score contribution | NOT exposed at all. rt.js does internally listen to `selectionchange` per bundle audit, but no copy field surfaces in either endpoint | **CH only** |
| **Fullscreen exit (×1 deliberate, 14s duration)** | `guard_assistance_violations_session[0]`: `{reason: "not_fullscreen", start: 11375.6, end: 25429.6, duration: 14054}` — ms-precise | 1 `Page became hidden` event in events stream. CH labels it specifically as fullscreen violation; RT lumps with general tab-away as visibility-change | **Both capture, semantic-precision differs** — CH knows it's specifically fullscreen, RT lumps with visibility |
| **Window-blurred events (×2, totals ~18s)** | `guard_assistance_violations_session[1-2]` — 2 entries with reason `window_blurred`, exact start/end ms | NOT in events stream — defocus-without-visibility-change is below RT's exposed event vocabulary | **CH only** |
| **Typing speed (3 samples, max 107 chars/sec)** | `integritySession.charsPerSec: [107, ...]` — per-burst sampled rates. Per-trial typing-burst data inside `integrity` blobs | NOT exposed. rt.js internally instruments `keydown`/`keyup`/`input`; result surfaces only as `biometric_checks.programmatic_typing: "Not detected"` (closed-model verdict) | **CH only at event level; RT only as verdict** |
| **Mouse positions (77 polled samples)** | `integritySession.windowPositions: [77 entries]` each with x, y, w, h, iw, ih, sw, sh, dpr, vvScale, t. Plus per-trial mouse-trajectory inside trial-level integrity | NOT in events. rt.js instruments `pointermove` internally; verdict in `biometric_checks.teleporting_mouse: "Not detected"` | **CH only at sample level; RT only as verdict** |
| **Layout shifts (×64)** | `integritySession.layoutShifts: [64 entries]` each with oldWidth, newWidth, delta, t | NOT exposed. rt.js has `resize` listener, doesn't surface per-resize events | **CH only** |
| **Sidebar events (×3 opened/closed)** | `integritySession.sidebarEvents: [3 entries]` each with type, method=innerWidth_delta, deltaIW=2013, innerWidth, baselineIW, t | NOT exposed | **CH only** |
| **Tab-away events (×4)** | `integritySession.tabAwaySums: [4]` durations in ms | 1 `Page became hidden` in events stream. CH counts 4 distinct focus losses; RT logs only 1 visibility transition | **CH wins** — finer-grained focus-loss categorization |
| **Form submits (×2: describe-card + demographics)** | Embedded in per-trial data (`response` field + integrity per-trial) | 2× `User submitted jspsych-survey-text-form` in events. RT has form-ID; CH has response content | **Both capture, similar granularity** |
| **Button clicks (Next/Continue/Enter/Exit)** | NOT directly tracked as discrete events (CH doesn't instrument generic clicks). Implicit only in `trial.rt` jsPsych response-time | 18× `User clicked "<button text>"` in events — preserves button text verbatim | **RT wins for clicks** — one of the few rows where RT exposes more event-level info |
| **Text edits per field (×17)** | NOT discretized as separate events. Whole response stored as `response` JSON per survey-text trial | 17× `User edited #jspsych-survey-text-response-N` in events — granular per-edit (no content; no per-keystroke) | **RT wins for edit timing**; tells you when fields were edited (not what was typed) |
| **Audio recording (spoken "describe this card")** | `audio_base64` column on recording trial row — full base64-encoded audio + `duration_ms`, `mic_permission_granted`, `mime_type`, `error: null` | No audio data anywhere in the API | **CH only** — audio is outside RT's surface entirely |
| **Honeypot bait outcome** | `ai_use_session: false` (correct, you're human) | NOT a concept | **CH only** (active baiting is CH's exclusive layer) |
| **Risk verdict / score** | Not a concept — CH gives `softScore: 21`, `hardScore.paste: triggered`, `anyHardTriggered: true`, configurable thresholds; you compute the verdict | `risk_score: 0`, `recommended_action: "Auto-accept"`, `risk_explanation` prose | **RT wins** — CH ships evidence; RT ships verdict |
| **Device/network checks (VPN/Tor/VM/headless/location-spoof)** | NOT instrumented; CH is browser-DOM-level only | 6 boolean device checks (all "Not detected" for you) | **RT only** — RT's documented exclusive territory |
| **ML "agent_behavior" classifier** | NOT a concept — CH is rule-based + thresholds | `biometric_checks.agent_behavior: "Not detected"` | **RT only** |

### Timing-precision side-by-side

| | CH | RT |
|---|---|---|
| Smallest observed inter-event delta in this run | sub-50ms inside `windowPositions` (20Hz polling cadence) | Hundreds of ms (events stream is human-action-paced; consecutive events typically 200ms+ apart) |
| Mouse-trajectory sample rate | 20Hz polled, ms-precision per sample | Not exposed |
| Continuous-stream coverage | Yes for mouse + window position + layout shifts | None |

### Per-trial vs per-session

| | CH | RT |
|---|---|---|
| Has a "what happened on trial N" concept? | **Yes** — every CSV row is one trial, with `integrity` JSON covering only that trial's events | **No** — events stream is one flat session-level list; no `trialId` or per-trial demarcation |
| Session rollup | Yes on the last trial row: `integritySession`, `integrityScore`, `ai_use_session`, `ai_report_session`, `guard_assistance_violations_session` | The whole API IS session-rollup; that's the only granularity RT offers |
| Can you ask "what did the participant do during the rule-naming trial specifically"? | Yes, directly | No — would require time-correlation of RT events against externally-known trial boundaries |

### Headline empirical takeaway from `human-smoke-001`

CH produced **~250 structured data points** for a 504-second session; RT produced **~152**. For most behavioral signals (paste, copy, mouse, sidebar, layout, tab-away), CH exposes per-event detail; RT exposes session-aggregated booleans or nothing. RT has the edge on three rows: device/network checks (CH doesn't instrument at all), per-button-text clicks (CH doesn't instrument generically), per-field edit timing (CH stores response content but not per-edit timing). The **architectural difference is event-level disclosure vs. model-verdict disclosure**, validated empirically.

A single human run pasting twice produced:
- CH: hard-flag triggered + soft-score 21 + 2 paste events with timestamps + full integrity blob
- RT: risk_score 0, all 7 biometric checks "Not detected", recommended action "Auto-accept"

Same underlying behavior, different verdicts. CH's verdict reflects "this participant pasted, which crosses a configurable threshold" (true). RT's verdict reflects "this participant's biometric patterns look human" (also true; pasting is a human behavior). **Neither is wrong**; they're answering different questions. This is the single most useful demonstration of the disclosure-spectrum framing from §6.

---

## 6. Architectural takeaway

The bench's core empirical finding is **not** that one tool captures more than the other. Both instrument substantially the same browser surface. The difference is in **what each tool chooses to disclose**:

- **CH discloses everything as raw events.** The researcher sees what the participant actually did. Triage scores are computable but auditable. False positives can be investigated.
- **RT discloses model verdicts and a high-level action narrative.** The researcher sees what RT's model concluded. The underlying signal is opaque.

For research on cognitive experiments where **understanding *why* a participant was flagged matters**, CH's evidence-first design wins. For high-volume commercial screening where **risk_score + auto-accept/review/block is the action**, RT's verdict-first design wins. They're not competing products; they occupy different points on the disclosure/automation spectrum.

The bench's writeup should frame this clearly — and avoid the "CH catches more" framing, which is structurally misleading.

---

## 7. Benchmark scoreboard (progressively enriched)

Fill in one row per benchmark run as scenarios are executed. Each row is a single `(scenario, guards)` cell × one operator's run.

### Run registry

Findings from the v0.1 pilot runs, summarized here since the run data itself doesn't ship with this repo (rows below are cleared to the public template):

- A schema-discovery run using deliberate paste/copy/tab-away behavior produced a CH hard-flag (paste threshold crossed) against an RT low-risk score with a single biometric flag. That mismatch is an early sign the two tools disagree on what counts as suspicious.
- An 8-run sweep of automated browser-agent variants (naive, prompt-jailbreak, DOM-filter, and combined, each with guards on and off) showed RT's ML-based `agent_behavior` flag firing on every run, with risk scores consistently in the "Auto-reject" range. The one partial exception was the jailbreak-prompt variant without guards: it produced a lower risk score and silenced RT's `programmatic_typing` flag, suggesting prompt-based evasion can partially humanize typing signals without defeating the model outright.
- CH's honeypot bait did not fire on any browser-agent variant tested in this harness, while CH's friction layer logged one violation per guarded run. Bait effectiveness appears to depend on how DOM-rich the host experiment is: sparse jsPsych trial layouts give bots less surface to stumble onto the bait fields.

| Run ID | Scenario | Guards | Operator | Date | RT session ID (truncated) | Notes |
|---|---|---|---|---|---|---|
| `bot-playwright-none-001` | bot-playwright | none | — | — | — | _pending_ |
| `bot-playwright-friction-001` | bot-playwright | friction | — | — | — | _pending_ |
| `bot-playwright-full-001` | bot-playwright | full | — | — | — | _pending_ |
| `cyborg-paste-none-001` | cyborg-paste | none | — | — | — | _pending_ |
| `cyborg-paste-friction-001` | cyborg-paste | friction | — | — | — | _pending_ |
| `cyborg-paste-full-001` | cyborg-paste | full | — | — | — | _pending_ |
| `cyborg-no-paste-none-001` | cyborg-no-paste | none | — | — | — | _pending_ |
| `cyborg-no-paste-friction-001` | cyborg-no-paste | friction | — | — | — | _pending_ |
| `cyborg-no-paste-full-001` | cyborg-no-paste | full | — | — | — | _pending_ |
| `clean-human-none-001` | clean-human | none | — | — | — | _pending_ |
| `clean-human-full-001` | clean-human | full | — | — | — | _pending_ |

### Per-signal detection — schema-discovery-002 (baseline reference)

Run shape: deliberate human run on 2026-05-13. 15 jsPsych trials (replay-test suite + rule-naming, voice skipped). Ground-truth behaviors exercised: 4 pastes, 12 copies, 4 tab-aways (short + long), mouse movement, scroll, no clipboard "all pasted" pattern (mix of typed + pasted across fields).

| Behavior intended | CH detected | RT detected | Note |
|---|---|---|---|
| Paste events (4) | ✓ `pasteCount=4`, hardScore triggered | ✗ `all_pasted: Not detected` (mixed-input session) | Real capability gap |
| Copy events (12) | ✓ `copyCount=12` | ✗ not exposed | RT captures via selection internally but doesn't expose |
| Tab-away (4 events) | ✓ in `integritySession` | ✓ 4 `Page became hidden/visible` events in `/events` | Both have it |
| Mouse movement | ✓ trajectory captured | ✓ but only exposed as `teleporting_mouse: Not detected` | Both detect; RT only as verdict |
| Scroll | ✗ not directly tracked | ◐ captured internally; `jump_scrolling: Not detected` | RT slight edge in detection layer |
| No-backspaces correction pattern | ✗ not flagged directly | ✓ `no_corrections: Detected` → risk_score 15 | RT's only positive signal; mild false-positive |
| Click events | ✗ not granularly tracked | ✓ 37 `User clicked "..."` events | RT's primary action surface |
| Headless / VPN / VM | n/a (human) | ✓ all `Not detected` | RT correctly identifies human network/device |
| Honeypot bait (n/a, `guards=none`) | n/a | n/a | Phase 3 with `guards=full` will exercise this |
| Friction violations (n/a) | n/a | n/a | Phase 3 with `guards=friction\|full` |

**Aggregate scores:**
- CH: `softScore = 11`, `hardScore.paste.triggered = true`, `anyHardTriggered = true`
- RT: `risk_score = 15`, `recommended_action = Auto-accept`, single biometric flag (`no_corrections`)

Both tools rated this run roughly accurately given the deliberate behaviors: CH hard-flagged because of explicit paste threshold violation; RT soft-flagged on a behavioral micro-signal with a low confidence.

---

## 8. Audit caveats

1. **rt.js can change.** Roundtable serves rt.js fresh from their CDN on each page load. The capture-surface audit in §3 is valid for the 19,677-byte bundle served on **2026-05-13**. If RT updates the bundle, this document may go stale. For reproducibility of the benchmark, we should vendor rt.js into `bench/vendor/roundtable/` and pin to a known checksum. (Tradeoff: vendored copy can't get model improvements over time.) **Pending decision.**
2. **Server-side processing is opaque.** rt.js's only outbound destination is `new-api.roundtable.ai`. What Roundtable does with the captured data on their servers — additional models, cross-session joins, retention, retraining — is unverifiable client-side. Our claims are bounded to **inputs and exposed outputs**, not to internal processing.
3. **`all_pasted` strict-all interpretation.** Per RT's docs ("Detects when all text responses were pasted rather than typed") and confirmed empirically: `all_pasted` is a session-level all-or-nothing aggregate, not a per-event paste counter. A cyborg who pastes the cognitive work but types demographics defeats this flag cleanly. **Verification email to RT pending.**
4. **CH's signal column names may evolve.** CH is pre-1.0 and the integrity column schema in jsPsych trial CSVs is subject to change between minor versions. The adapter layer should track the current vendored CH commit (`bench/vendor/COMMIT`) and update mappings when CH's `event-log.csv` schema changes.
5. **One scenario per cell minimum.** v0.1 commits to `N=3` runs per scenario/guards cell. Single-run findings are anecdotal; differential conclusions require the full factorial.

---

## 9. How to extend this document

When a new benchmark run completes, append:

1. A row to the **Run registry** table (§7) with the run ID, scenario/guards, operator, date, redacted session ID, and a one-line note.
2. A new **Per-signal detection** table (or merge into a multi-run table once we have enough data — TBD format).
3. Any **new findings about RT's or CH's behavior** that change Section 5 (the feature matrix). If we discover a new RT capability or a CH miss, update §5 and note the change in §10.

If the rt.js bundle changes (§8 caveat 1), re-run the audit in §3 with the new bundle and bump the "Last updated" date at the top.

---

## See also

- `bench/pipeline/taxonomy.json` — canonical behavior taxonomy used by the matrix builder
- `bench/adapters/schema.json` — `CommonEvent` schema for normalized event streams
- `bench/adapters/roundtable-schema-notes.md` — detailed RT events schema notes
