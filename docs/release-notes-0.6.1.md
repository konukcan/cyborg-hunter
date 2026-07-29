# Release notes — cyborg-hunter 0.6.1

*0.6.1 is not the current release; for the current line (0.7.x, the session-replay feature) see [release-notes-0.7.0.md](release-notes-0.7.0.md).*

*Released 2026-07-06. The complete change list is in [CHANGELOG.md](../CHANGELOG.md). This page summarizes what changes in **collected data**, **configuration**, and **reports**.*

## TL;DR

- **From 0.6.0:** drop-in. Re-running `cyborg-hunter report` on already-collected data produces the same scores and triage ordering as 0.6.0. A golden regression suite freezes the full ingest → summary → triage pipeline output across the upgrade. 0.6.1 adds better session timelines for newly collected data, several new config knobs, and a fix for one silent-misconfiguration bug.
- **From 0.5.x:** read [Upgrading from 0.5.x](#upgrading-from-05x). Triage scores and ordering on existing data will shift, because 0.6.0 fixed over- and under-counting. Newly collected data no longer saves raw per-keystroke timings by default.

## What changes for newly collected data (0.6.0 → 0.6.1)

These changes affect the browser library, so they apply to sessions recorded with 0.6.1. The CLI reads previously collected data exactly as before.

**Trial reports now carry a wall-clock `timestamp`.** `endTrial()` stamps an ISO 8601 timestamp on every trial report. Renderers use it to anchor per-rule phase bands. Before 0.6.1, when the app layer didn't stamp its own timestamp, those anchors were `NaN` and phase bands could be misplaced. When the app does stamp a trial timestamp, the library's stamp shadows it during ingest; both are trial-end wall-clocks and agree to within milliseconds.

**Off-trial tab-aways keep full timing.** Tab-aways outside `startTrial`/`endTrial` (consent, tutorial, comprehension checks) used to collapse to a bare duration in `tabAwaySums`. The session report now also keeps a timestamped `tabAwayEvents[]` with `{start, duration_ms, type, timestamp}`, so the session timeline can place them instead of only counting them. Pre-0.6.1 payloads still render; the timeline footer counts their off-trial events as unplaceable.

**`layoutShifts` is now `viewportWidthShifts`.** The signal measures viewport-width changes (a ResizeObserver on `<html>`, 20 px threshold). It never measured Web-Vitals cumulative layout shift, and the old name suggested it did. Session reports carry both keys with identical content. `layoutShifts` is a deprecated alias slated for removal in the next major version: downstream pipelines that read it keep working today and should plan to migrate. The CLI's `layout_shift_count` CSV column keeps its name so downstream parsers keep working.

**Viewport-shift logging is debounced.** One resize gesture now logs one event carrying the net old→new change (250 ms quiet period, `viewportShiftDebounceMs`), instead of 5+ per-frame events per drag. Expect lower raw viewport-shift counts in newly collected data.

## New CLI config knobs (all optional)

| Knob | What it does |
|---|---|
| `participantIdField` dot-paths | `"metadata.sessionId"` now walks nested objects. Plain names keep the historical top-level → `metadata` fallback; a literal flat key containing a dot wins over the dotted walk. |
| `sessionIntegrityPath` (+ `--session-integrity-path`) | Dotted path (e.g. `"payload.cyborgHunter"`) checked before the four built-in session-integrity locations, for pipelines that nest `getSessionReport()` output somewhere non-standard. Falls through to the built-ins when it resolves to nothing, or to something that isn't a session report (see the bug fix below). |
| `phaseScope` | `{"include": [...]}` / `{"exclude": [...]}` restricts which trial phases feed summary/triage scores, honoring pre-registered phase scoping. Scoped verdicts re-derive hard and soft flags from the scoped trials; ambient session signals (sidebar, shortcuts, viewport shifts, zoom) stay session-wide; renderers still show the full session. See [interpreting-signals.md](interpreting-signals.md#phase-scoping) before using this. |
| `trajectoryDisplayOrder` | Trajectory panels default to chronological-by-rule (`"rule"`); `"time"` and `"insertion"` (the pre-0.6.1 raw order) are available. |
| `showPlatformId` / `platformIdField` | Off by default. When on, renders the platform (Prolific/MTurk) ID as a secondary line in the HTML participant detail header. Off by default because reports circulate more freely than raw data, and the platform ID is what re-identifies a participant. |
| `--config-file` | Accepted as an alias of `--config`. |

## What changes in the report output

- **Trajectory panels are tinted by phase** (peach gallery, purple typing/post-gallery-query, blue classification, grey end-requery), matching the session-timeline strip. A third legend line documents the mapping.
- **`triage.md` has an explicit Tier column** (`HARD` / `soft` / `clean`, the library's screening verdict) replacing the boolean Hard column. Its header now states that Score is the CLI's ranking heuristic, a different number from the library soft score. The two are untangled in [interpreting-signals.md](interpreting-signals.md#two-scores-three-tiers).
- **The session-timeline lane "Layout shifts" is renamed "Viewport shifts"** (legend and HTML labels likewise). The `layout_shift_count` CSV column and the "N layout shifts" triage-reason wording are unchanged so downstream parsers keep working; both read `viewportWidthShifts` and fall back to the legacy key.

## Bug fix worth knowing about

**`sessionIntegrityPath` no longer accepts a wrong-shaped object.** Before 0.6.1, pointing `sessionIntegrityPath` at a near-miss path (e.g. `"metadata"` instead of `"metadata.integritySession"`) accepted the wrong object, zeroed every downstream session signal (tab-aways, hard/soft score, and the rest), and suppressed the "No session-level integrity data" warning. A HARD-triage participant could render as clean with no indication anything was wrong. 0.6.1 checks the resolved value for at least one recognizable session-report key (`tabAwaySums`, `hardScore`, `softScore`, `anyHardTriggered`, `trialsCompleted`) before accepting it; otherwise the built-in conventions run, with the warning intact. Configs that already used this knob with a correct path on 0.6.0 see no change.

## Upgrading from 0.5.x

This upgrade crosses two releases; 0.6.0 is the one with behavioral consequences.

**Re-running the report on existing data will shift triage scores and ordering.** 0.6.0 corrected several counting errors:

- Sidebar events are counted as distinct openings (a state machine collapses the runtime's separate `opened`/`closed` log entries), so sidebar-heavy participants are no longer over-scored.
- A single below-threshold hard-signal hit no longer fabricates a hard flag when the saved session score is absent.
- Tab-away binning matches the runtime's strict `>` cutoff, and the CLI honors each participant's own saved thresholds (soft-score cutoff, tab-away cutoff, typing-speed cutoff) instead of generic defaults.
- Triage ranks tier-first (hard → soft → clean), then by score within a tier.

A study triaged on 0.5.x and re-run on 0.6.1 will see participants move. The 0.6.x numbers are the corrected ones.

**Newly collected data no longer saves raw per-keystroke timings by default.** The `keystrokeDynamics` toggle (off by default in `permissive` and `standard`) now gates persistence: only the derived `charsPerSec` is kept unless persistence is opted into via `signals.keystrokeDynamics` or `collectForPostHoc.fullKeystrokeTimestamps`. The typing-speed signal is unaffected. Analysis pipelines that consumed raw `editTimestamps` need that opt-in.

**`finalize()` now persists the runtime config** (preset and effective thresholds) in `integritySession`. The CLI uses it to reconstruct each participant's screening settings. Data collected on 0.5.x lacks this, and the CLI falls back to defaults for those participants.

**Honeypot self-disclosure is surfaced** in `summary.csv` (`honeypot_ai_use`, `honeypot_ai_report`) and in the triage reason, when the guard-honeypot extension is in use.

## Deprecations

| Deprecated | Replacement | Removal |
|---|---|---|
| `layoutShifts` session-report key | `viewportWidthShifts` (both currently written, identical content) | next major version |

## Version stamps in the data

The library stamps `cyborgHunterVersion` into every participant's data, so version mixing within a study is visible directly in the data (the CLI does not warn about it automatically). Mixing 0.6.0 and 0.6.1 participants in one report is safe; 0.6.1-only fields stay empty for the older sessions.
