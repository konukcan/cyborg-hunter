#!/usr/bin/env bash
# One-command post-interaction step for the manual smoke test.
#
# Takes the directory where you moved the two files the demo page downloaded
# (a "<PID>.json" participant file and a "<PID>-replay-<epoch>.json" replay
# file), runs the real CLI report over them (which auto-detects and attaches
# the replay artifact), and prints the file:// URLs to open.
#
# Usage: smoke/process.sh [data-dir]     (default: smoke/inbox)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="${1:-$SCRIPT_DIR/inbox}"

DATA_DIR="$(cd "$DATA_DIR" 2>/dev/null && pwd)" || DATA_DIR=""
if [ ! -d "$DATA_DIR" ]; then
  echo "Data directory not found: $DATA_DIR" >&2
  echo "Usage: smoke/process.sh [data-dir]   (default: smoke/inbox — create it and move your two downloaded files there)" >&2
  exit 1
fi

PARTICIPANT_FILE="$(find "$DATA_DIR" -maxdepth 1 -name '*.json' ! -name '*-replay-*' | head -1)"
if [ -z "$PARTICIPANT_FILE" ]; then
  echo "No participant file found in $DATA_DIR (looking for a *.json file that is not a *-replay-*.json)." >&2
  exit 1
fi

REPLAY_FILE="$(find "$DATA_DIR" -maxdepth 1 -name '*-replay-*.json' | head -1)"
if [ -z "$REPLAY_FILE" ]; then
  echo "Warning: no *-replay-*.json file found in $DATA_DIR — the report will generate without a replay viewer." >&2
fi

REPORT_DIR="$DATA_DIR/report"
echo "Participant file: $PARTICIPANT_FILE"
[ -n "$REPLAY_FILE" ] && echo "Replay file:      $REPLAY_FILE"
echo "Running: node bin/cyborg-hunter.js report --data $DATA_DIR --output $REPORT_DIR"
echo

# Run from inside DATA_DIR (not the repo root) so the CLI's cwd-based config
# lookup doesn't pick up this repo's own cyborg-hunter.config.json (which is
# configured for a real study's data shape, not the smoke-test demo's).
( cd "$DATA_DIR" && node "$REPO_ROOT/bin/cyborg-hunter.js" report --data "$DATA_DIR" --output "$REPORT_DIR" )

echo
echo "Done. Open in a browser:"
echo "  file://$REPORT_DIR/index.html"
echo
echo "On the participant's row, click 'Load replay' to open the replay viewer inline."
