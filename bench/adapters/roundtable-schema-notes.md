# Roundtable API — Schema Notes (for adapter author)

Developer-facing reference for the Roundtable adapter (Task 2.5 of the v0.1
bench). For the writeup-ready feature comparison see
`bench/docs/feature-comparison.md`; this file is just the wire-level shape and
mapping plan.

## 1. Status / provenance

- **Captured:** 2026-05-13, session run with `scenario=schema-discovery&guards=none&runId=schema-discovery-002`
- **rt.js bundle version:** 19,677 bytes, served 2026-05-13 (see caveats §9)
- **Fixtures:**
  - `bench/adapters/tests/fixtures/rt-sample.json` — 63 events from `/v1/sessions/{id}/events`
  - `bench/adapters/tests/fixtures/rt-report-sample.json` — full report from `/v1/sessions/{id}/report`
- **Redaction:** session_id, user_id replaced with `"REDACTED"` at every depth (both snake_case and camelCase). No UUIDs, IPs, user-agents, or API keys remain. Verified with `grep -E "[0-9a-f]{8}-[0-9a-f]{4}..." → no matches`.

## 2. Endpoints surveyed

| Endpoint | Purpose |
|---|---|
| `GET /v1/users/{userId}/sessions` | List sessions for a user (used by harness to look up the most recent session by tag). |
| `GET /v1/sessions/{id}/events` | Raw event log captured by rt.js for one session. |
| `GET /v1/sessions/{id}/report` | Scored rollup — biometric + device checks, risk_score, recommended_action, and (deprecated) `user_logs`. |

## 3. `/events` response shape

```json
{
  "session_id": "<uuid>",
  "event_count": 63,
  "events": [
    { "action": "<prose string>", "user_time": "5/13/2026, 8:01:53 PM", "unix_timestamp": 1778727713027 }
  ]
}
```

- `unix_timestamp` is **milliseconds** since epoch (13 digits). Adapter should subtract `events[0].unix_timestamp` to get `t_ms` relative to session start.
- `user_time` is a localized string — discard, do not parse.
- `action` is **free-form prose**, not a structured event type. See §4.

## 4. Event vocabulary observed

Six distinct action patterns appear in the schema-discovery fixture. All examples below are verbatim from `rt-sample.json`.

### `User navigated to <url>`
Page-load / navigation event. URL is the full path+querystring.

> `"User navigated to /bench/harness/?scenario=schema-discovery&guards=none&runId=schema-discovery-002&skip-voice=1"`

### `User clicked "<button text>"`
Click on any focusable element. Button text is in **escaped double quotes** and may contain literal `\n` newlines if the element spans multiple lines (e.g., a slider with stacked labels).

> `"User clicked \"Next >\""`
> `"User clicked \"Not at all confident\nSomewhat\nVery confident\""`
> `"User clicked \"😐 Neutral\""` — emoji preserved

Quirk: the multi-line case means a naive regex like `User clicked "([^"]+)"` works (the inner `\n` is a literal newline, not a `\"`), but anything line-oriented will mis-split.

### `User edited #<form-element-id>`
Form input editing. Granularity is **per edit-burst, not per keystroke** — typing a 5-word answer in one go produces one event, not 25.

> `"User edited #jspsych-survey-text-response-0"`

Quirk: the same field id can repeat (e.g., the user revisits response-0 later), so the event is "the user touched this field" rather than "this field's value is now X". The actual text content is **not transmitted** — only the element id. This is a real loss-of-fidelity signal for the comparison writeup.

### `User submitted <form-id>`
Form submit (no `#` prefix on the id, unlike `edited`).

> `"User submitted jspsych-survey-text-form"`
> `"User submitted jspsych-survey-multi-choice_form"`

### `Page became hidden` / `Page became visible`
Visibility API events (tab-away start / end). Verbatim strings — no payload.

> `"Page became hidden"` (t = session+6s in fixture)
> `"Page became visible"` (t = session+34s — i.e., 28s of tab-away)

## 5. `/report` response shape

```json
{
  "session_id": "<uuid>",
  "user_id": "<string>",
  "tags": ["guards:none", "runId:schema-discovery-002", "scenario:schema-discovery"],
  "risk_score": 15,
  "risk_explanation": "All device signals look legitimate, but ...",
  "recommended_action": "Auto-accept",
  "user_logs": [ /* same shape as /events.events — DEPRECATED but still returned */ ],
  "biometric_checks": { /* 7 keys, see §6 */ },
  "device_checks":    { /* 6 keys, see §6 */ }
}
```

- `user_logs` is a full duplicate of `/events.events`. The adapter should ignore it and pull from `/events` directly. If we ever drop the second HTTP call to save round-trips, this is the fallback — but for v0.1 keep both calls separate so a future API change doesn't silently break ingestion.
- `risk_score` is an integer 0–100. `recommended_action` is one of (observed): `Auto-accept`, `Review`, `Auto-reject` (need to confirm — only `Auto-accept` in this fixture).
- `tags` are passed in by the harness via the rt.js init call and round-tripped here. Useful for joining a Roundtable report back to a bench `runId`.

## 6. `biometric_checks` and `device_checks`

All 13 checks return strict `"Detected"` / `"Not detected"` **strings**, not booleans. The adapter must use string equality, e.g. `=== 'Detected'`, not truthiness.

### biometric_checks (7)
| Key | One-liner |
|---|---|
| `agent_behavior` | ML model output flagging agentic browser / automation patterns (opaque — only un-documented heuristic). |
| `programmatic_typing` | Keystroke timing too uniform / lacking natural jitter. |
| `teleporting_mouse` | Mouse jumps without interpolation (warp from A to B). |
| `jump_scrolling` | Scroll deltas inconsistent with human wheel/trackpad input. |
| `center_clicks` | Clicks land in suspiciously perfect element centers. |
| `no_corrections` | No backspaces in any text input across the session. |
| `all_pasted` | Every text response was pasted (strict-all, not any — see caveats §9). |

### device_checks (6)
| Key | One-liner |
|---|---|
| `bot` | Headless browser / known-bot UA fingerprint. |
| `virtual_machine` | VM-host fingerprint. |
| `software_renderer` | WebGL renderer is software (SwiftShader, llvmpipe) — common in automation. |
| `tor` | Exit-node IP match. |
| `vpn` | Commercial VPN IP range. |
| `location_spoofing` | IP geolocation mismatches Timezone/locale. |

## 7. Mapping guide for the adapter (Task 2.5)

Suggested mapping from RT action-string patterns to `CommonEvent.type`:

| RT action prefix | CommonEvent.type | Notes |
|---|---|---|
| `User clicked "<text>"` | `click` | Extract button text into `payload.action` (keep `\n` literal). |
| `User edited #<id>` | `typing_burst` | **Low fidelity** — RT only sees per-edit. Mark `payload.fidelity = 'low'` so downstream consumers know not to compute keystroke statistics. Put the element id in `payload.fieldId`. |
| `User submitted <id>` | `other` | Not in current enum. Put `payload.action = 'submit'`, `payload.formId = <id>`. **Design question:** promote to a first-class `submit` type in v0.2? |
| `Page became hidden` | `tab_away` | No payload needed. |
| `Page became visible` | `tab_return` | No payload needed. |
| `User navigated to <url>` | `viewport_change` | Loose fit. **Design question:** add a `navigation` type in v0.2? For now put url in `payload.url`. |
| anything unrecognized | `other` | Preserve the **full raw action string** in `payload.rawAction` for audit. Do not silently drop. |

## 8. Session-level checks → `CommonEvent`

Fold the entire `/report` into a single synthetic event so the rest of the bench
pipeline (replay-quality, scoring, plotting) sees a uniform event stream and
doesn't need a special "session report" code path.

```js
{
  t_ms: 0,                     // or session-end timestamp; t=0 keeps it before any real event
  type: 'session_flags',       // added to schema.json enum in this phase
  source: 'roundtable',
  trialId: null,
  payload: {
    biometric_checks: { agent_behavior: 'Not detected', /* ...all 7 */ },
    device_checks:    { bot: 'Not detected', /* ...all 6 */ },
    risk_score: 15,
    recommended_action: 'Auto-accept',
    risk_explanation: '...'    // optional, useful for the writeup
  }
}
```

The `session_flags` enum value is added in this commit and exercised in
`bench/adapters/tests/schema.test.js`.

## 9. Caveats

1. **rt.js bundle is a moving target.** This analysis is valid for the
   19,677-byte bundle served on 2026-05-13. If the action prose changes (e.g.
   RT starts emitting `User typed #...` instead of `User edited #...`), the
   adapter's pattern-match table will silently route those to `other`. Mitigate
   by alerting on a high `other`-rate in the adapter's own self-checks.
2. **`all_pasted` is strict-all, not any.** A participant who pastes one of three
   text answers will *not* trip this check. Verification email to RT pending —
   if they confirm, update this note and consider deriving our own
   `any_paste` boolean from the `paste` events that the underlying rt.js
   collects but doesn't surface in the public events array. (Unconfirmed
   whether `paste` is even captured server-side.)
3. **`agent_behavior` is opaque.** It's an ML model output. The other 12 checks
   are documented heuristics with semi-obvious operationalizations (timing
   jitter, click position, etc.); `agent_behavior` could be doing anything from
   simple UA-string matching to a transformer over the event stream. Treat it
   as a black-box signal in any comparison plot.
