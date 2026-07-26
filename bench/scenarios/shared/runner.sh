#!/usr/bin/env bash
#
# runner.sh — scaffold a scenario run directory and print the harness URL.
#
# Usage: ./runner.sh <scenario> <guards> <operator>
#   <guards> must be one of: none | friction | full
#
# This script does NOT operate the browser. It creates the run directory,
# writes a manifest-entry.txt the operator can later append to
# bench/runs/manifest.csv, and prints the URL to open plus next-step
# instructions.

set -euo pipefail

usage() {
    echo "Usage: $0 <scenario> <guards> <operator>" >&2
    echo "  <guards> must be one of: none | friction | full" >&2
}

# --- Arg validation ---------------------------------------------------------

if [ "$#" -ne 3 ]; then
    usage
    exit 1
fi

SCENARIO="$1"
GUARDS="$2"
OPERATOR="$3"

if [ -z "$SCENARIO" ] || [ -z "$GUARDS" ] || [ -z "$OPERATOR" ]; then
    usage
    exit 1
fi

case "$GUARDS" in
    none|friction|full) ;;
    *)
        echo "Error: <guards> must be one of: none | friction | full (got '$GUARDS')" >&2
        exit 1
        ;;
esac

# --- Path setup -------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
RUN_ID="${SCENARIO}--${GUARDS}--${TIMESTAMP}"
RUN_DIR="${SCRIPT_DIR}/../../runs/${RUN_ID}"

mkdir -p "$RUN_DIR"

# --- Manifest entry ---------------------------------------------------------

MANIFEST_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
MANIFEST_FILE="${RUN_DIR}/manifest-entry.txt"

{
    echo "operator=${OPERATOR}"
    echo "date=${MANIFEST_DATE}"
    echo "runId=${RUN_ID}"
    echo "scenario=${SCENARIO}"
    echo "guards=${GUARDS}"
} > "$MANIFEST_FILE"

# --- Output -----------------------------------------------------------------

HARNESS_URL="http://localhost:8080/bench/harness/?scenario=${SCENARIO}&guards=${GUARDS}&runId=${RUN_ID}"

echo "runId=${RUN_ID}"
echo "runDir=${RUN_DIR}"
echo "harnessUrl=${HARNESS_URL}"
echo ""
echo "Next steps:"
echo "  1. Open the URL above in your browser."
echo "  2. Complete the harness."
echo "  3. After the CSV downloads, move it to: ${RUN_DIR}/"
echo "  4. Then run ./fetch-rt.sh ${RUN_ID} to fetch Roundtable events."
echo ""
echo "Manifest entry written to: ${MANIFEST_FILE}"
echo "(copy-paste its contents into bench/runs/manifest.csv when ready)"
