#!/usr/bin/env bash
# scripts/build-test-report.sh — generate a cyborg-hunter HTML triage report
# from a single test-mode CSV captured via copy(jsPsych.data.get().csv()).
#
# Usage:
#   1. Run the test-mode experiment in the browser.
#   2. At the [TEST MODE] finished screen, paste this in devtools:
#        copy(jsPsych.data.get().csv())
#   3. Paste the clipboard into a file under test-data/:
#        pbpaste > test-data/manual-run-$(date +%s).csv
#   4. ./scripts/build-test-report.sh
#
# The report opens automatically in your browser.
#
# Why a separate script: cyborg-hunter's CLI expects a config + a data
# directory. This wrapper does the boilerplate so you can iterate fast.

set -euo pipefail

CYBORG="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CYBORG"

DATA_DIR="$CYBORG/test-data"
OUT_DIR="$CYBORG/test-data/report"
CONFIG="$CYBORG/test-data/cyborg-hunter.config.json"

mkdir -p "$DATA_DIR"

# Find any CSV in the data dir
shopt -s nullglob
CSVS=("$DATA_DIR"/*.csv)
if [ ${#CSVS[@]} -eq 0 ]; then
  echo "❌ No CSVs found in $DATA_DIR"
  echo ""
  echo "After running the test experiment, do one of:"
  echo "  (a) In devtools: copy(jsPsych.data.get().csv())"
  echo "      Then: pbpaste > $DATA_DIR/manual-run-\$(date +%s).csv"
  echo ""
  echo "  (b) In devtools: jsPsych.data.get().localSave('csv', 'manual-run.csv')"
  echo "      Then move the downloaded file into $DATA_DIR/"
  exit 1
fi

echo "Found ${#CSVS[@]} CSV(s) in $DATA_DIR:"
for f in "${CSVS[@]}"; do
  echo "  - $(basename "$f") ($(wc -l < "$f" | tr -d ' ') lines)"
done
echo ""

# Generate config if missing
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<EOF
{
  "dataDir": "$DATA_DIR",
  "filePattern": "*.csv",
  "outputDir": "$OUT_DIR",
  "participantIdField": "subject_ID"
}
EOF
  echo "Created config at $CONFIG"
fi

# Run the report
echo "Building report → $OUT_DIR"
node "$CYBORG/bin/cyborg-hunter.js" report --config "$CONFIG"

# Open it
if [ -f "$OUT_DIR/index.html" ]; then
  echo ""
  echo "✓ Report ready: $OUT_DIR/index.html"
  open "$OUT_DIR/index.html"
else
  echo "⚠ Report directory exists but index.html missing — check stdout above"
fi
