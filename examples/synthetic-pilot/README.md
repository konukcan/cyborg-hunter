# synthetic-pilot

A three-participant synthetic dataset for trying out `cyborg-hunter report` without collecting data first. One participant per triage tier: clean, soft-flagged, hard-flagged.

**No real participants are behind these files.** `generate-fixture.mjs` hand-authors every number; the data is shaped exactly like what the jsPsych extension saves (v0.6.1), so the full pipeline runs on it.

```bash
cd examples/synthetic-pilot
cyborg-hunter report
open report/index.html
```

The walkthrough that interprets every output file: [docs/worked-example.md](../../docs/worked-example.md).

To regenerate the CSVs after editing the generator: `node generate-fixture.mjs`.
