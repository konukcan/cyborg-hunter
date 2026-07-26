# CLI Reference
What a successful run looks like — the HTML report for the bundled three-participant synthetic dataset ([worked-example.md](worked-example.md)):

![HTML report: tier-sorted participant list on the left; per-signal counts, score breakdown, paste evidence, and typing profile for the selected participant.](assets/report-example.png)

## Commands

### `cyborg-hunter report`

Generate the integrity report from a directory of participant data files.

```bash
cyborg-hunter report [options]
```

Running `cyborg-hunter` with no subcommand defaults to `report`.

**Options:**

| Flag | Description |
|---|---|
| `--config <path>` / `--config-file <path>` | Config file path (default: `./cyborg-hunter.config.json`) |
| `--data <path>` / `--data-dir <path>` | Override `dataDir` |
| `--output <path>` / `--output-dir <path>` | Override `outputDir` |
| `--participant-id-field <name>` | Override `participantIdField` (e.g. `subject_ID` for jsPsych; dot-paths like `metadata.sessionId` supported) |
| `--file-pattern <glob>` | Override `filePattern` |
| `--integrity-field <name>` | Override `integrityField` |
| `--session-integrity-path <path>` | Dotted path to the session-level integrity object (e.g. `payload.cyborgHunter`) |
| `--participant <id>` | Filter to a single participant |
| `--no-visuals` | Skip image generation (no `canvas` package required) |

Unknown flags exit with an error rather than silently falling back to whatever config file is in cwd (fixed in v0.3.0).

### `cyborg-hunter init`

Generate a starter config file in the current directory.

```bash
cyborg-hunter init
```

Refuses to overwrite an existing `cyborg-hunter.config.json`.

### Replay artifacts

`<pid>-replay-<epoch>.json[.gz]` files are picked up automatically from
`dataDir` (or `replayDir` when set) and rendered as per-participant
**Session replay** sections. Ownership is verified against the recording's
embedded `participant_id`; corrupt artifacts are reported, never fatal;
`report` prints the total size of emitted `replay/` assets.

## Output structure

```
cyborg-hunter-report/
├── index.html           # landing page (open this)
├── summary.csv          # one row per participant, every signal as a column
├── triage.md            # ranked markdown table with a one-line "why flagged"
├── event-log.csv        # chronological events (copy/paste/drop/synthetic/tabAway)
├── extensions.csv       # AI-extension + sidebar detections, one row per participant × detection
└── images/              # canvas-rendered visuals (skipped if canvas missing)
    ├── trajectories_<participantId>.png      # per-trial mouse paths
    ├── session_timeline_<participantId>.png  # session-wide tab-away / sidebar / guard timeline
    └── typing_profile_<participantId>.png    # per-trial typing-speed distributions
```

## Output files

### `index.html`

Self-contained landing page:

- Dashboard with hard/soft/clean participant counts
- Sortable triage table (click a column header to sort)
- Per-participant detail sections with linked images and signal summaries

Images are linked from `images/`, not base64-embedded — keeps the HTML readable and the page lightweight.

### `summary.csv`

One row per participant:

| Column | Description |
|---|---|
| `participantId` | Participant identifier |
| `trialCount` | Number of monitored trials |
| `triageScore` | Combined triage score (see [Triage scoring](#triage-scoring) below) |
| `hardTriggered` | `YES` / `no` — did any hard signal fire |
| `triageReason` | One-line summary of why this participant ranked where they did |
| `totalPasteEvents` | Total paste events across all trials |
| `totalCopyEvents` | Total copy events across all trials |
| `totalTabAways` | Total tab-away events |
| `meanTypingSpeed` | Mean chars/sec across trials |
| `meanMouseEvents` | Mean mouse events per trial |
| `totalSoftScore` | Accumulated soft score |
| `sidebar_event_count` | Sidebar-gap detections (session-level) |
| `ai_extensions` | AI-extension selectors matched (semicolon-joined) |
| `keyboard_shortcut_count` | DevTools-hotkey presses (Ctrl/Cmd+Shift+I/J/C, F12) |
| `layout_shift_count` | Layout-compression events |
| `zoom_change_count` | Inferred zoom level changes |
| `dev_tools_event_count` | Reserved column; currently always 0 (DevTools-open is recorded under `keyboard_shortcut_count`) |
| `authoritative_soft_score` | Soft score from `getSessionReport()` (preferred over the per-trial sum) |
| `honeypot_ai_use` | Three states: `YES` = participant ticked the visible-bait "I used AI" checkbox; `no` = the honeypot was present but the box was left unticked (negative evidence); empty = the honeypot extension wasn't used for this participant at all |
| `honeypot_ai_report` | Free-text the participant typed into the honeypot's "what did you use?" box (empty if none) |
| ... | (See the actual file for the full column set; the schema may grow.) |

> Note: the early per-participant columns are camelCase (`totalPasteEvents`, …)
> while the session-derived columns are snake_case (`sidebar_event_count`, …).
> The header names above match the emitted CSV exactly.

### `triage.md`

Ranked markdown table sorted **tier-first** (hard-triggered, then soft-flagged, then
clean), and by triage score (descending) within each tier. Hard-triggered
participants always lead the list even when a soft-only participant has a higher
numeric score, so the "start here" review order surfaces the most actionable cases
first.

```
| Rank | Participant | Tier | Score | Reason |
|------|-------------|------|-------|--------|
| 1    | P023        | HARD | 17    | 3 paste events; 2 tab-aways ≥10s; ChatGPT detected |
| 2    | P045        | soft | 9     | 3 sidebar events; fast typing on 4 trials |
```

The Tier column (added 0.6.1) shows the library's screening verdict
(`HARD` / `soft` / `clean`), the same classification behind the console's
hard/soft/clean counts. Score is the CLI ranking heuristic described under
[Triage scoring](#triage-scoring): it orders rows within a tier and is not
the library soft score.

(`P023`'s score is 3 paste × 5 + 2 tab-away × 1 = 17; the "ChatGPT detected"
note is shown in the reason but no longer contributes to the score — see
[Triage scoring](#triage-scoring). `P023` leads because it is hard-triggered, not
because of its score.) Designed to be readable as plain text or pasted into a
Slack/Notion review.

### `event-log.csv`

Every clipboard, drop, synthetic-insertion, and tab-away event in chronological order:

| Column | Description |
|---|---|
| `participantId` | Who |
| `trialId` | Which trial |
| `eventType` | `paste`, `copy`, `drop`, `synthetic`, or `tabAway` |
| `timestamp` | When (session-absolute `performance.now()` ms — same scale across all rows) |
| `duration_ms` | Populated for `tabAway` (the duration); empty for instantaneous events |
| `text` | Pasted/dropped text if available; for `tabAway` carries the trigger type (`windowBlur`, `visibilityChange`, etc.) |

### `images/trajectories_*.png`, `session_timeline_*.png`, `typing_profile_*.png`

Per-participant visualizations rendered with `node-canvas`. Trajectory panels show the mouse path with start/end markers, click events, tab-away markers placed at trial-relative timing, and (when window-position data is present) a nested screen → window outline showing where the browser was on the user's display. Panels are ordered chronologically by rule by default (`trajectoryDisplayOrder` picks `"rule"` / `"time"` / `"insertion"`) and tinted by phase — peach gallery, purple typing/query, blue classification, grey re-query — matching the session-timeline strip. Plots are zoom-aware: if the participant adjusted CSS-level browser zoom, mouse coords are scaled to the outline correctly. The session timeline lays tab-away, sidebar, layout-shift, and guard-friction events on one session-wide time axis with phase bands.

If `canvas` is unavailable (Cairo not installed), images are skipped with platform-specific install hints. Text outputs still render.

## Triage scoring

The triage **score** is a deliberately small, transparent sum of four signals
(policy fixed 2026-06-01). It is *not* the library's soft score — it is a
ranking heuristic computed by the CLI in `src/cli/analyzers/triage.js`:

| Component | Contribution |
|---|---|
| Paste events | `× 5` |
| Copy events | `× 5` |
| Sidebar events (open cycles) | `× 3` (uncapped) |
| Tab-aways longer than the participant's tab-away threshold (medium + long bins; 3s by default, 5s for strict) | `× 1` |

No other signal affects the score. Hard-trigger status, AI-extension detections,
keyboard shortcuts, layout shifts, zoom changes, edge-exit patterns, synthetic
insertions, and foreign inputs are all still surfaced — in the per-participant
detail panes and the one-line triage reason — but they **do not** change the
number. (Earlier versions added a `+100` hard-trigger term and several other
bonuses; those were removed.)

**Hard-triggered participants are surfaced by ordering, not by the score.** The
ranked list (both `triage.md` and the HTML index's default "Tier" sort) sorts
tier-first — hard-triggered, then soft-flagged, then clean — and by score within
each tier. So a hard-triggered participant always appears above soft-only ones
even when its four-term score is lower.

- **Soft-flag threshold:** a participant is soft-flagged when
  `(authoritative soft score from getSessionReport() ?? summed per-trial soft
  score) ≥ the preset's `softScoreThreshold`` (6 for `standard`).

### Decision categories

The dashboard groups participants three ways:

- **Hard-flagged** (any hard signal fired) — count thresholds crossed; review the pasted text in `event-log.csv`.
- **Soft-flagged** (soft score ≥ preset threshold) — multiple behavioral indicators; check trajectories and the session timeline for patterns.
- **Clean** (soft score below threshold, no hard signals) — spot-check a sample for calibration.

### How to read the report

The tool produces evidence, not verdicts. Practical heuristics:

1. **Hard signals — read the pasted text.** A pasted block of AI prose looks different from copied notes from the participant's own document.
2. **Tab-aways — check the durations.** Brief flickers are often benign (system notifications, accidental Cmd-Tab). 30s+ tab-aways during a response are harder to explain away.
3. **Extensions — installed ≠ used.** A participant having Sider installed in Chrome doesn't prove they used it during your study.
4. **Edge-exits — look for a pattern.** A consistent right-edge-exit-then-tab-away is more telling than a single edge-exit.
5. **Compare against a clean baseline.** Pick a few participants with low scores and look at their trajectories side-by-side. The tool's job is to surface ANOMALIES; you decide what's normal for your population.
