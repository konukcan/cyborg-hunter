# Changelog

All notable changes to **cyborg-hunter** are documented here. This project follows
[Semantic Versioning](https://semver.org).

## [0.7.0] — 2026-07-14

### Added
- Session replay recorder (`dist/cyborg-hunter-replay.js`, opt-in): captures pointer,
  keys, clipboard, scroll, touch, viewport, and (at the `dom` tier) DOM snapshots +
  mutations. Wire format is jsPsych's `SessionRecording v1` with a `ch_extensions`
  namespace.
- CLI report gains a per-participant replay viewer (scrub bar, cursor trail, event
  markers); `dom`-tier recordings reconstruct the page in a sandboxed iframe.
- Autosave and CLI ingest of replay artifacts, with ownership verification and
  reload-collision handling.
- Guard-honeypot and guard-friction events are captured in the replay stream.

### Changed
- Replay viewer uses a per-trial camera model for cursor/DOM alignment; legacy
  recordings fall back to a clearly-labeled reduced-alignment mode.
- Password inputs are redacted unconditionally in replay capture; clipboard events
  record lengths only, not content.

### Fixed
- `drop` listener was incorrectly gated on the `paste` signal flag.
- Idle-gap and element-trace timers leaked per session instead of being trial-scoped.
- Edge-exit analysis silently found nothing on modern payloads due to a mismatched
  time base.
- Shape-3 (top-level array) ingest dropped outer trial fields and skipped tab-away
  normalization.
- Malformed replay artifacts no longer abort the report; `autoSave()` no longer
  throws on circular/BigInt data.

## [0.6.2] — 2026-07-12

### Fixed
- Cut events now count toward the hard-copy screenout (previously recorded but
  never incremented the session copy count).
- Misconfigured scoring overrides (e.g. a nested typo) now warn instead of
  silently disabling a rule.
- Fullscreen detection is prefix-aware, fixing false violations on Safari <16.4
  and some iOS WebViews.
- Honeypot re-initialization no longer inherits a prior run's violations/state.
- `decoyAnswer: false` per-trial opt-out is now honored (was coerced to `null`).
- A payload with both `trials` and `responses` no longer loses its integrity trials.
- A non-array signal field no longer crashes the report; ingest now coerces and warns.
- A numeric `trialId`/`ruleId` no longer crashes the trajectory renderer.
- `findGuardViolations()` now scans all trials instead of locking onto the first.

### Added
- Warnings for an unresolved `participantIdField`, duplicate participant IDs, an
  unmatched `phaseScope` phase name, and a non-numeric `scoring.softScoreThreshold`.

## [0.6.1] — 2026-07-06

### Added
- `endTrial()` stamps a wall-clock ISO `timestamp` on the trial report.
- Session-level `tabAwayEvents[]` alongside `tabAwaySums`, preserving full timing
  for tab-aways outside `startTrial`/`endTrial`.
- `participantIdField` accepts dot-paths (e.g. `"metadata.sessionId"`).
- `sessionIntegrityPath`, `phaseScope`, and `trajectoryDisplayOrder` config options.
- `showPlatformId` flag (default off) to render a platform ID as a secondary line
  in the HTML report.
- `--config-file` accepted as an alias of `--config`.

### Changed
- `layoutShifts` renamed to `viewportWidthShifts` (old key kept as a deprecated
  alias); the signal measures viewport-width changes, not Web Vitals CLS.
- Viewport-shift logging is debounced (250ms default) instead of firing per
  animation frame.
- Trajectory panels are tinted by phase; `triage.md` carries an explicit Tier column.

### Fixed
- `sessionIntegrityPath` no longer accepts a wrong-shaped object at the resolved
  path, which had silently zeroed downstream signals.

## [0.6.0] — 2026-06-25

No public API was removed. Re-running the report on existing data may shift
triage scores/ordering (sidebar, tab-away, and hard-flag corrections); newly
collected data no longer saves raw per-keystroke timings by default.

### Changed
- Sidebar events are counted as distinct openings, not raw log entries.
- Hard-flag fallback now uses the cumulative session total against the count
  threshold, not per-trial hits.
- Tab-away binning matches the runtime's strict cutoff.
- Triage ranks tier-first (hard → soft → clean), then by score.
- The CLI honors each participant's own saved thresholds instead of generic defaults.

### Added
- Guard-honeypot self-disclosure surfaced in the report (`honeypot_ai_use`,
  `honeypot_ai_report` columns).
- `finalize()` persists the runtime config so the CLI can reconstruct each
  participant's screening settings.

### Privacy
- Raw per-keystroke timings are no longer persisted by default
  (`keystrokeDynamics` toggle); only derived typing speed is kept unless opted in.

### Fixed
- Restored the authoritative session score for two saved formats that had been
  dropped, causing over-flagging.
- Session-timeline offset estimation no longer drifts for legacy participants.

## [0.5.1] and earlier

See the git tags `v0.4.0`, `v0.5.0`, `v0.5.1` for prior releases (no changelog
was kept before 0.6.0).
