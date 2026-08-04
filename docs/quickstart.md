# Quickstart

From zero to a triage report, for a jsPsych 7 experiment.

**Not using jsPsych?** The analysis half of this page (steps 1 and 5–7) applies to any browser experiment unchanged. Only the collection half is jsPsych-specific: in place of steps 2–4, load `cyborg-hunter.min.js`, call `CyborgHunter.init({ participantId, preset })`, bracket your task with `startSession()` / `startTrial()` / `endTrial()`, and save `getSessionReport()` alongside your data — the complete wiring is in [using-cyborg-hunter.md → Standalone usage](using-cyborg-hunter.md#standalone-non-jspsych-usage). Then rejoin at step 5.

**You need:** a jsPsych 7 experiment, Node.js ≥ 18 on the machine where you'll analyze data, and a way to save each participant's data to a file (CSV or JSON). You almost certainly have all three already.

## 1. Install the CLI

```bash
npm install -g cyborg-hunter
cyborg-hunter --version
```

The CLI runs on your machine after data collection. Nothing about it touches the participant's browser.

## 2. Add two scripts to your experiment page

In your experiment HTML, after jsPsych itself and before your own `script.js`:

```html
<script src="https://unpkg.com/cyborg-hunter@0.7.3/dist/cyborg-hunter.min.js"></script>
<script src="https://unpkg.com/cyborg-hunter@0.7.3/dist/extension-cyborg-hunter.js"></script>
```

Order matters: the extension references `window.CyborgHunter`, which the first file defines. Pin the version for production studies (as above), or copy both files from `dist/` into your project and serve them yourself.

## 3. Wire the extension into jsPsych

Three rules, each a common failure point:

**(a) The participant ID must exist before `initJsPsych`.** The extension reads it at initialize time, before any trial runs.

```javascript
let subject = { id: Math.random().toString(36).slice(2, 12) };  // or your own ID source

const jsPsych = initJsPsych({
  extensions: [
    { type: jsPsychCyborgHunter, params: { participantId: subject.id, preset: 'standard' } }
  ],
  on_finish: function () {
    jsPsych.extensions['cyborg-hunter'].finalize();   // (b) — see below
    jsPsych.data.get().localSave('csv', 'data-' + subject.id + '.csv');
  }
});
```

**(b) Call `finalize()` before the data is saved.** `finalize()` attaches the session-level report (`integritySession`, `integrityScore`) to the data. Skip it and the CLI will warn "No session-level integrity data" and lose the authoritative session score.

> **If you save with DataPipe (`jsPsychPipe`) or any save-as-a-trial plugin, `on_finish` is too late**: the save trial snapshots the data before `on_finish` runs. Put the `finalize()` calls inside the save trial's `data_string` callback instead. Full explanation and two working patterns: [using-cyborg-hunter.md § 3](using-cyborg-hunter.md#3-call-finalize-before-saving).

**(c) Opt your trials in.** jsPsych extensions only fire for trials that list them. The one-liner that covers the whole timeline:

```javascript
// After all timeline.push() calls, just before jsPsych.run:
timeline.forEach(t => {
  t.extensions = (t.extensions || []).concat([{ type: jsPsychCyborgHunter }]);
});
jsPsych.run(timeline);
```

## 4. Smoke-test before launching

Run the experiment locally, click through it, save the file:

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

Open the saved CSV and check three things:

1. Trial rows have `integrityPasteCount`, `integritySoftScore`, `cyborgHunterVersion` columns.
2. Each monitored row's `integrity` cell holds a JSON object (`pasteEvents`, `tabAwayEvents`, ...).
3. The **last** row has non-empty `integritySession` and `integrityScore` cells. If not, revisit step 3(b).

While testing, paste something into a response box and switch tabs for a few seconds; you'll see those events in the report in step 6 and know the wiring works end-to-end.

## 5. Collect data

Run your study as usual. Put every participant's saved file in one directory, e.g. `./data/`.

## 6. Generate the report

```bash
cd <your-study-dir>
cyborg-hunter init          # writes a starter cyborg-hunter.config.json
```

Edit the config to match your data. For jsPsych CSV output the usual working config is:

```json
{
  "dataDir": "./data",
  "filePattern": "*.csv",
  "participantIdField": "subject_ID",
  "outputDir": "./cyborg-hunter-report"
}
```

`participantIdField` is the column holding your participant ID: `subject_ID` for many jsPsych setups, but check your own CSV header. Then:

```bash
cyborg-hunter report
open cyborg-hunter-report/index.html
```

The console prints hard/soft/clean counts and any ingest warnings. Take warnings seriously on the first run; the common ones are a wrong `participantIdField` or a missing `finalize()`.

If image rendering complains about the optional `canvas` package, add `--no-visuals` to get the text outputs (`summary.csv`, `triage.md`, `event-log.csv`) without plots, or install Cairo per the printed hints.

## 7. Read the report

Start with `triage.md`: participants ranked tier-first (HARD, then soft, then clean), each with a one-line reason. Review hard-flagged participants first, and read what they pasted in `event-log.csv` before deciding anything. The tool produces evidence, not verdicts.

Two pages take you the rest of the way:

- [worked-example.md](worked-example.md) — a full run on a bundled synthetic dataset, with the outputs interpreted line by line.
- [interpreting-signals.md](interpreting-signals.md) — what the scores and tiers mean, and the three most common misreadings.

## Where to go deeper

| Topic | Page |
|---|---|
| Per-trial params, standalone usage, save-plugin pitfalls | [using-cyborg-hunter.md](using-cyborg-hunter.md) |
| Every signal, every threshold, per preset | [signals-reference.md](signals-reference.md) |
| Every config field and CLI flag | [configuration.md](configuration.md) |
| Output file formats | [cli-reference.md](cli-reference.md) |
| Deterrence add-ons (guard-friction, guard-honeypot) | [README](../README.md) and [signals-reference.md](signals-reference.md) |
