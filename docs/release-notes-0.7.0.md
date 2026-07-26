# Release notes — cyborg-hunter 0.7.0

*Released 2026-07-14; this page also covers the 0.6.2 patch (2026-07-12), so it is the complete delta from 0.6.1. The full change list is in [CHANGELOG.md](../CHANGELOG.md). This page summarizes what changes in **collected data**, **configuration**, and **reports**.*

## TL;DR

- **From 0.6.1:** the headline feature — session replay — is entirely opt-in; nothing changes for studies that don't load the recorder. The CLI upgrade is worth taking regardless: several crash-on-malformed-payload paths now warn and continue, and four new misconfiguration warnings catch silent setup errors.
- **Re-running the report on existing data can shift some verdicts.** Three corrections change what the CLI reads out of already-collected data: cut events now count toward the hard-copy screenout, edge-exit analysis works again on modern payloads (it had been silently finding nothing due to a mismatched time base), and Shape-3 (top-level array) payloads keep their outer trial fields. A participant's tier can change where those signals were load-bearing; the 0.7.0 numbers are the corrected ones.

## Session replay (the 0.7.0 feature)

An optional recorder (`dist/cyborg-hunter-replay.js`) captures pointer, keys, clipboard, scroll, touch, and viewport events — and, at the `dom` tier, DOM snapshots plus mutations — so a flagged session can be reviewed visually instead of adjudicated from counts alone. Recordings use jsPsych's `SessionRecording v1` wire format with a `ch_extensions` namespace.

What ships around it:

- **A per-participant replay viewer in the CLI report** (scrub bar, cursor trail, event markers). `dom`-tier recordings reconstruct the page in a sandboxed iframe.
- **Autosave and CLI ingest of replay artifacts**, with ownership verification and reload-collision handling. Malformed artifacts are skipped with a warning; they no longer abort the report.
- **Guard-honeypot and guard-friction events appear in the replay stream**, so deterrence violations can be watched in context.
- **A per-trial camera model** keeps cursor and DOM aligned; on `dom`-tier recordings the cursor is verified per interaction, and any click that can't be confirmed draws an explicit uncertain marker instead of a wrong one. Recordings made before this guarantee existed replay under a clearly-labeled reduced-alignment banner.
- **Privacy defaults:** password inputs are redacted unconditionally; clipboard events record lengths only, never content. Field-level redaction is controlled by `redactSelector`; the full privacy model is in [using-cyborg-hunter.md](using-cyborg-hunter.md).

Integration is one more extension (jsPsych) or one `attach()` call (standalone); see the [README](../README.md#session-replay) for the wiring and [known-issues.md](known-issues.md) for the feature's documented limitations.

## What changes on re-run over existing data (0.6.2 + 0.7.0)

- **Cut events count toward the hard-copy screenout.** They were recorded but never incremented the session copy count, under-flagging participants who cut rather than copy.
- **Edge-exit analysis works on modern payloads again.** A mismatched time base had it silently finding nothing; reports may now show edge-exit events that were absent before.
- **Shape-3 (top-level array) payloads keep their outer trial fields** and get tab-away normalization.
- **`findGuardViolations()` scans all trials** instead of locking onto the first (latent for the shipped producer, live for merged or per-trial producers).
- **Robustness:** a payload with both `trials` and `responses` keeps its integrity trials; a non-array signal field is coerced with a warning instead of crashing; a numeric `trialId`/`ruleId` no longer crashes the trajectory renderer.

## What changes for newly collected data

- **The `drop` listener is no longer gated on the `paste` signal flag** — drag-and-drop events are captured even when paste monitoring is configured off.
- **Idle-gap and element-trace timers are trial-scoped** instead of leaking per session.
- **Fullscreen detection is prefix-aware** (0.6.2), removing false guard violations on Safari <16.4 and some iOS WebViews.
- **Honeypot re-initialization starts clean** (0.6.2) — a prior run's violations/state are no longer inherited, and the `decoyAnswer: false` per-trial opt-out is honored.

## New warnings (0.6.2)

The CLI now warns on an unresolved `participantIdField`, duplicate participant IDs, an unmatched `phaseScope` phase name, and a non-numeric `scoring.softScoreThreshold`. Misconfigured scoring overrides (e.g. a nested typo) warn instead of silently disabling a rule.

## Known limitations

The replay feature's deliberate limitations (non-body capture roots, ID-less input resolution, and others) are documented in [known-issues.md](known-issues.md).
