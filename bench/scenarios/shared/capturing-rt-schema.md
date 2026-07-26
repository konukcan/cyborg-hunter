# Capturing a Roundtable schema sample

One-time helper for capturing a real Roundtable events payload so the
adapter (`bench/adapters/roundtable-adapter.js`) can be designed against the
actual shape, rather than the docs.

## Prereqs

1. **Site key**: `bench/config.local.js` must exist with a real RT site key.
   If it does not, copy the template: `cp bench/config.example.js bench/config.local.js`
   and paste your key.

2. **API token**: separate from the site key. Set it in your shell:
   ```sh
   export ROUNDTABLE_API_TOKEN='rt_api_xxxxxxxxxx'
   ```
   Find it in the RT dashboard under Settings -> API Access (or "Developer
   Access"). If you cannot find it, contact RT support — the docs are
   unclear about the exact menu label.

3. **`jq`**: required for the redactor. Install via `brew install jq` if
   missing.

## Walkthrough

1. **Start the harness** from the bench worktree root:
   ```sh
   python3 -m http.server 8080
   ```

2. **Open the harness** in a browser:
   ```
   http://localhost:8080/bench/harness/?scenario=schema-discovery&guards=full&runId=schema-discovery-001
   ```

3. **Complete the timeline manually**, deliberately exercising varied
   behaviors so RT logs as many event types as possible. At minimum:
   - At least one paste.
   - At least one copy.
   - Several tab-aways of different durations (short and long).
   - Some mouse movement across the page.
   - Some scrolling.

   Goal: maximize event-type coverage so the captured schema covers as
   much surface as possible.

4. **Find the session ID**. After the harness completes (CSV downloads
   locally), open <https://accounts.roundtable.ai> in another tab. Filter
   by date/time, or look for the `user_id` matching the `runId`
   (`timeline.js` passes the runId as both `data-user-id` and inside
   `data-tags`). Copy the session ID.

5. **Run the helper** from the bench root:
   ```sh
   ./bench/scenarios/shared/capture-rt-schema.sh <session-id>
   ```
   Optional second arg overrides the fixture stem (default `rt-sample`):
   ```sh
   ./bench/scenarios/shared/capture-rt-schema.sh <session-id> rt-sample-v2
   ```

6. **Inspect the outputs**:
   - `bench/adapters/tests/fixtures/rt-sample.json` — redacted, committable.
   - `bench/adapters/tests/fixtures/rt-sample-raw.json` — raw, gitignored.
   - `bench/adapters/roundtable-schema-notes.md` — appended stub.

7. **Fill in the schema interpretation**. Open the schema-notes file and
   complete the "Schema interpretation" section for the new entry:
   for each event type observed, describe what RT means by it, which
   fields carry the discriminator vs. payload data, and how it should map
   to a CommonEvent `type` value in `bench/adapters/schema.json`.

8. **Commit**:
   ```sh
   git add bench/adapters/tests/fixtures/rt-sample.json \
           bench/adapters/roundtable-schema-notes.md
   git commit -m "bench: capture RT schema (fixture + notes)"
   ```
   The raw fixture stays gitignored — defense in depth, since the
   redactor is best-effort and a real RT response may carry secrets in
   field names we did not anticipate.

## Troubleshooting

- **`Error: ROUNDTABLE_API_TOKEN is not set.`** — see Prereq #2.
- **`HTTP 401` / `403`** — token wrong or expired. Refresh from the RT
  dashboard.
- **`HTTP 404`** — session ID wrong, or the session has not finished
  ingesting on RT's side. Wait a minute and retry.
- **No events / empty array** — confirm the harness actually loaded RT
  (open the browser console during the session; you should see RT init
  logs). Check that the site key in `bench/config.local.js` is real.
- **Empty distinct-types list** — the discriminator auto-detect did not
  find a known field. Inspect `rt-sample.json` manually; update the
  schema-notes entry with the correct field name.
