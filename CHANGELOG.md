# Changelog

All notable changes to **cyborg-hunter** are documented here. This project follows
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Changed
- `collectForPostHoc.rawMouseTrack` now defaults to **true**: the raw mouse
  track (`mouseTrack`) ships in every trial report, so the CLI's trajectory
  panels are populated out of the box. Set it to `false` to keep only the
  derived `mouseMetrics`. Rationale: adding CH to an experiment is already
  the decision to collect behavioural traces, and the off-by-default gate
  made the panels read "no mouse data" for anyone who never found the
  toggle.
- The SessionRecording v2 validator moved from the test tree into shipped
  code (`src/shared/schema-v2-validator.js`); the converter CLI no longer
  needs a repo checkout to strict-validate its output.

### Fixed
- Replay ingest (A3 review round): foreign v2 artifacts whose filename
  happens to match CH's `-replay-<epoch>` pattern no longer vanish; jsPsych
  v1 recordings are recognised by `schema_version`, so malformed ones reach
  the converter's remedy message; gzip is detected by magic bytes as well
  as suffix; unreadable candidates in an explicit `replayDir` are reported;
  converted recordings are strict-validated in memory and attach with a
  warning naming the malformed fields; converter exceptions that are not
  declared refusals are reported as internal failures instead of being
  blamed on the file.

### Docs
- Local testing in `autoSave.mode: 'download'`: Chromium-based browsers
  block the second automatic download (the CSV after the replay, or vice
  versa); use Firefox/Safari or allow automatic downloads for localhost.
  Remote (`datapipe`) saves are unaffected.

## [0.7.5] — 2026-08-05

### Added
- `GuardFriction.exitFullscreen()`: prefix-aware counterpart to
  `requestFullscreen()`; a no-op when not fullscreen and while the guard is
  armed (call it after `stop()`).

### Changed
- Live demo: the report screen now leaves fullscreen through the plugin, and
  the live-session record gained a per-trial tab rail (`All` first) that
  filters the stream to one trial at a time.

## [0.7.4] — 2026-08-04

### Changed
- Repository moved to a GitHub organization: the canonical repo is now
  https://github.com/cyborg-hunter/cyborg-hunter and the live demo lives at
  https://cyborg-hunter.github.io/cyborg-hunter/. The old repo URL and git
  remotes redirect permanently; the old demo URL does not (GitHub Pages
  never redirects). All package links, the CLI's crash-footer issue URL,
  the demo's GitHub links, and citation metadata now point at the org.
  No functional changes.

## [0.7.3] — 2026-08-04

### Added
- `report` now nudges about newer releases: a zero-dependency check against
  the npm registry's `latest` dist-tag prints a short update notice after the
  report summary. At most one registry request per day (cache file in
  `~/.cache/cyborg-hunter/`), silent on any network failure, skipped under
  `CI` or `NO_UPDATE_NOTIFIER`, and CLI-only — the browser library still
  makes no network requests of its own.
- `report` prints an offline staleness note when ingested sessions were
  collected with a different library version than the CLI (payloads stamp
  `libraryVersion`). This catches the case the registry check can't: an
  experiment still serving an old bundle to participants.

## [0.7.2] — 2026-07-29

### Added
- Replay viewer: a keycast overlay at the bottom of the stage shows keys as
  they're pressed (chips appear on keydown, fade after keyup), including a
  redacted chip for keystrokes captured with `keys:'full'` inside a
  redacted field. Recordings made with `keys:'off'` show no keycast, since
  there's no key data to show.
- Replay viewer: the buffer-cap notice is now an expandable explanation
  (was a one-line chip) covering what `maxEventsPerTrial`/`maxCharsPerTrial`
  actually cap (per trial, not the whole session), what happens when a
  trial crosses one, and that both are configurable. Mirrored in
  `docs/using-cyborg-hunter.md`'s configuration table.
- Replay viewer: continuous whole-session playback, default on. Pressing
  play now rolls through every trial in the recording as one continuous
  video instead of stopping at each trial boundary; a "pause at trial
  boundaries" toggle restores the previous per-trial-stop behavior. A
  "Trial k of N" indicator tracks position across the session.

### Changed
- Internal refactor, no behavior change: the report index renderer and its
  three plot renderers (session-timeline, trajectories, typing-profile) are
  each split into a pure core (string- or canvas-returning) plus a thin fs
  wrapper; `buildViewerModel` and `getByPath` moved to pure shared modules.
  `renderIndexHtml` also gained optional demo-mode opts (`imageSources`,
  `inlineReplayModels`) for inline image/replay embedding, with a hash-sync
  guard for the opaque-origin iframe the demo renders reports inside. Together
  these let the live demo render reports and plots directly in the browser;
  default (CLI) output is byte-identical.
- The live demo (https://konukcan.github.io/cyborg-hunter/) was remodeled
  into a 13-step guided tour; not part of the npm package.

### Fixed
- Raw mouse coordinates were persisted in every trial report regardless of the
  documented off-by-default `collectForPostHoc.rawMouseTrack` toggle. Reports
  now omit the raw track unless the toggle is enabled, in which case it
  persists as `mouseTrack` (ingest maps it back to `mouseEvents`); the derived
  `mouseMetrics` signal is unaffected either way.

## [0.7.1] — 2026-07-29

### Fixed
- The npm package now includes `dist/` — 0.7.0 shipped without it, so every
  documented unpkg/script-tag URL returned 404.
- `cyborg-hunter --version` prints the version instead of "Unknown command".

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
