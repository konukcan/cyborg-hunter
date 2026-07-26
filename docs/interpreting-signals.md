# Interpreting the signals

The report surfaces evidence; you make the exclusion decisions. This page covers the three places where readers most often misread that evidence: the two different "scores", the viewport-width-shift signal, and phase scoping. Thresholds and per-preset values live in [signals-reference.md](signals-reference.md); this page is about meaning.

## Two scores, three tiers

Cyborg-hunter computes **two unrelated numbers**, and conflating them is the most common misreading of the report.

| | Library soft score | CLI triage score |
|---|---|---|
| Computed | in the participant's browser, during the study | on your machine, at report time |
| Formula | weighted sum of soft events (copy, tab-away, fast typing, sidebar, DevTools, foreign input), with per-trial caps | `5×paste + 5×copy + 3×sidebar + 1×tab-away` (tab-aways longer than the participant's cutoff) |
| Compared against | the preset's `softScoreThreshold` (6 for `standard`) | nothing; it only orders rows |
| Purpose | screening verdict: is this participant soft-flagged? | review ordering within a tier |
| Where you see it | `authoritative_soft_score` in `summary.csv` | the `Score` column in `triage.md` |

The **tier** (`HARD` / `soft` / `clean`) is the screening verdict:

- **HARD** — a hard signal (paste, drop, or copy-in-strict) reached its count threshold. Count-based, no weighting: with the standard preset, the second paste makes a participant HARD no matter what else happened.
- **soft** — no hard trigger, but the library soft score reached its threshold.
- **clean** — neither.

`triage.md` sorts tier-first, then by triage score within a tier. Three consequences worth internalizing:

1. **A HARD participant can rank above a soft participant with a higher score.** In the bundled [worked example](worked-example.md), the HARD row scores 18 and the soft row below it scores 21. That ordering is intentional: hard evidence (something crossed a count threshold) outranks any accumulation of soft evidence. Don't re-sort by score.
2. **The triage score is blind to most signals.** Synthetic insertions, AI-extension detections, keyboard shortcuts, viewport shifts, zoom changes, and foreign inputs appear in the reason column but add zero to the score. A participant with "1015 synthetic insertions" and no clipboard/tab-away/sidebar activity scores 0. If a diagnostic signal matters for your study, filter `summary.csv` on its column; don't expect the ranking to do it.
3. **Thresholds are per-participant.** Since 0.6.0 the library saves each participant's effective config, and the CLI scores each participant against their *own* saved cutoffs (tab-away duration, typing speed, soft threshold). Two participants with identical behavior can bin differently if they ran under different presets. The bin labels in the triage reason ("≤5s / 5–10s" for a strict-preset participant) reflect this.

A useful mental model: **the tier decides *whether* to review someone, the triage score decides *in what order*, and neither decides *what you conclude*.** For hard flags, read the pasted text in `event-log.csv`; for soft flags, look at the session timeline and trajectories before judging.

## Viewport-width shifts

**What it measures:** the `viewportWidthShifts` signal records changes in the viewport's width, via a ResizeObserver on `<html>` with a 20 px threshold. Since 0.6.1 the events are debounced (250 ms quiet period), so one resize gesture logs one event with the net old→new change.

**What it is not:** Web-Vitals "layout shift" (CLS). The signal was named `layoutShifts` before 0.6.1 and that name suggested content-jump instrumentation; it never measured that. The session report currently carries both keys with identical content (`layoutShifts` is a deprecated alias), and the CSV column is still called `layout_shift_count` so existing pipelines keep parsing.

**How to read it:** a viewport-width shift means *the usable width changed*: the participant resized the window, docked something, or a sidebar-style panel opened or closed. That makes it a **diagnostic** signal, useful context but never scored, because window resizing is ordinary behavior. The scored sibling is the **sidebar** signal (`sidebarGap`), which uses different evidence (the `outerWidth − innerWidth` gap and layout compression) specific to a panel eating space *inside* the window. In practice:

- Viewport shifts alone, without sidebar events: usually the participant adjusting their window. The clean participant in the worked example has exactly this pattern.
- Sidebar events (they score 3× in triage and weigh into the soft score) corroborated by viewport shifts around the same timestamps: consistent with a browser AI panel opening. Check the session timeline, where both lanes share one time axis.
- Counts on pre-0.6.1 data run higher for the same behavior, because un-debounced dragging logged one event per frame. Don't compare raw counts across library versions.

## Phase scoping

Studies sometimes pre-register that integrity screening counts only certain experiment phases (e.g. "signals during the classification phase only"). The `phaseScope` config option enforces that in the report:

```json
{ "phaseScope": { "include": ["classification"] } }
{ "phaseScope": { "exclude": ["gallery", "post_gallery_query", "end_requery"] } }
```

`include` (when non-empty) keeps only the listed phases; `exclude` then removes its phases. Phases are whatever your experiment wrote into each trial's `phase` field (a per-trial extension param).

What a scope does and does not change:

- **Scoped:** per-trial signal counts (paste, copy, drop, tab-away, typing, soft score), and the hard/soft *flags*, which are re-derived from the scoped trials rather than read from the whole-session saved score. A participant whose only pastes happened during an excluded practice phase is not hard-flagged.
- **Not scoped:** ambient session signals that have no phase attribution (sidebar events, keyboard shortcuts, viewport shifts, zoom changes). These stay session-wide because the library records them outside any trial.
- **Not scoped:** the renderers. Timelines and trajectory grids still show the full session, so you can see what happened in excluded phases even though it doesn't count.

Two footguns:

1. **Trials without a `phase` field count as `"default"`.** An `include` list that doesn't contain `"default"` silently drops those trials from scoring. If your data has unlabeled trials, scope with `exclude`.
2. **Scoping changes flags, so decide it before you look.** Running unscoped, peeking at the tiers, then adding a scope that de-flags participants is the analysis-degrees-of-freedom problem pre-registration exists to prevent. Set `phaseScope` to match your pre-registration text and keep it fixed.

## Signals that never score

Collected-but-unscored signals, and what they're for:

| Signal | Why it's diagnostic-only |
|---|---|
| Synthetic insertions | Text appearing without keystrokes catches automation, but also autofill and some IMEs/dictation. High counts flag *review*, not exclusion. |
| AI-extension detections | Installed ≠ used. A participant with Sider in Chrome may never have opened it during your study. |
| Idle gaps | Long pauses have many causes. Context for tab-away patterns. |
| Mouse metrics | Path efficiency and speed variance support bot detection, but need baselines from your own population. |
| Zoom changes, window geometry | Environment context for reading the trajectory plots. |

The `honeypot_ai_use` column (if you run the guard-honeypot extension) is three-state: `YES` means the participant ticked the visible bait "I used AI" checkbox, `no` means the bait was shown and left unticked, and empty means the honeypot wasn't active for that participant. Only `YES` is evidence; don't read `no` as exoneration or empty as `no`.

## Deciding what to do

1. Review HARD participants first, and read their `event-log.csv` text before excluding anyone. Pasted AI prose reads differently from a pasted note-to-self.
2. For soft flags, open the session timeline. A cluster of long tab-aways during response trials tells a different story than scattered flickers.
3. Calibrate against your own clean participants. Pull up two or three low-score trajectory grids side-by-side with a flagged one; the tool surfaces anomalies relative to nothing, you supply the baseline.
4. Pre-register your exclusion rule (which tiers, which thresholds, which phases) and let the report execute it, rather than deciding per-participant after seeing the data.

Related: [signals-reference.md](signals-reference.md) for every threshold, [cli-reference.md](cli-reference.md#triage-scoring) for the scoring implementation notes, [README § What it doesn't detect](../README.md#what-it-doesnt-detect) for the honest limits.
