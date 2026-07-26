#!/usr/bin/env bash
#
# capture-rt-schema.sh — Phase 2.0 schema-discovery helper.
#
# Pulls the events JSON for a Roundtable session, writes a raw copy
# (gitignored) plus a redacted copy (committable fixture), and appends a
# stub section to bench/adapters/roundtable-schema-notes.md summarising
# what was observed. The redacted fixture is what we design the RT adapter
# against; the schema-notes file is where the operator records their
# interpretation of the field semantics.
#
# Usage:
#   ROUNDTABLE_API_TOKEN=... ./capture-rt-schema.sh <session-id> [output-name]
#
# <session-id>   The RT session ID from https://accounts.roundtable.ai
#                (after running the manual bench session through the harness).
# [output-name]  Optional fixture stem. Defaults to "rt-sample".
#                Produces:
#                  bench/adapters/tests/fixtures/<stem>-raw.json   (gitignored)
#                  bench/adapters/tests/fixtures/<stem>.json       (redacted)
#
# Exit codes:
#   0 success
#   1 bad/missing args, missing env var, missing jq
#   2 HTTP error from Roundtable

set -euo pipefail

# --- Arg + env validation ---------------------------------------------------

usage() {
    cat >&2 <<'EOF'
Usage: ROUNDTABLE_API_TOKEN=... ./capture-rt-schema.sh <session-id> [output-name]

  <session-id>   Roundtable session ID (from the RT dashboard).
  [output-name]  Optional fixture stem (default: "rt-sample").

Environment:
  ROUNDTABLE_API_TOKEN  Required. RT API bearer token (separate from the site key).
                        Find it in the RT dashboard under
                        Settings -> API Access (or similar).
EOF
}

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
    echo "Error: missing <session-id>." >&2
    usage
    exit 1
fi

SESSION_ID="$1"
OUTPUT_NAME="${2:-rt-sample}"

if [ -z "${ROUNDTABLE_API_TOKEN:-}" ]; then
    cat >&2 <<'EOF'
Error: ROUNDTABLE_API_TOKEN is not set.

Set ROUNDTABLE_API_TOKEN=<token> in your shell before running this script.
The API token is separate from the site key (which lives in
bench/config.local.js) and is found in the RT dashboard under
Settings -> API Access (or similar). If you cannot find it, contact RT
support.

Example:
  export ROUNDTABLE_API_TOKEN='rt_api_xxx...'
  ./capture-rt-schema.sh <session-id>
EOF
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not found on PATH. Install via 'brew install jq'." >&2
    exit 1
fi

# --- Path setup -------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURE_DIR="${BENCH_DIR}/adapters/tests/fixtures"
SCHEMA_NOTES="${BENCH_DIR}/adapters/roundtable-schema-notes.md"

mkdir -p "$FIXTURE_DIR"

RAW_FILE="${FIXTURE_DIR}/${OUTPUT_NAME}-raw.json"
REDACTED_FILE="${FIXTURE_DIR}/${OUTPUT_NAME}.json"

# --- Fetch events from RT ---------------------------------------------------

RT_URL="https://api.roundtable.ai/v1/sessions/${SESSION_ID}/events"
echo "==> Fetching events from Roundtable"
echo "    URL: ${RT_URL}"

# Use -w to capture HTTP status alongside body. Write body to temp first so
# we can inspect it before deciding to keep it as the raw fixture.
TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT

HTTP_STATUS="$(
    curl -sS \
        -H "Authorization: Bearer ${ROUNDTABLE_API_TOKEN}" \
        -H "Accept: application/json" \
        -o "$TMP_BODY" \
        -w "%{http_code}" \
        "$RT_URL"
)"

if [ -z "$HTTP_STATUS" ]; then
    echo "Error: curl returned no HTTP status (network failure?)." >&2
    exit 2
fi

case "$HTTP_STATUS" in
    2*) ;;
    *)
        echo "Error: HTTP ${HTTP_STATUS} from Roundtable." >&2
        echo "First 500 chars of response body:" >&2
        head -c 500 "$TMP_BODY" >&2 || true
        echo >&2
        exit 2
        ;;
esac

# Sanity-check that the body parses as JSON before we save it.
if ! jq -e . "$TMP_BODY" >/dev/null 2>&1; then
    echo "Error: response body is not valid JSON. First 500 chars:" >&2
    head -c 500 "$TMP_BODY" >&2 || true
    echo >&2
    exit 2
fi

mv "$TMP_BODY" "$RAW_FILE"
trap - EXIT
echo "==> Raw body saved to ${RAW_FILE} (gitignored)"

# --- Redact secrets + PII ---------------------------------------------------

# walk/1 hits every object recursively. We blank field VALUES (not the keys)
# for two buckets:
#   secrets: site_key, siteKey, api_key, apiKey, apiToken, token
#   PII:     session_id, sessionId, user_id, userId, ip, ipAddress,
#            user_agent, userAgent
#
# Preserves event types, timestamps, payload shapes, etc. — everything we
# need to design the adapter against.
REDACT_FILTER='
def redact_keys($keys):
  walk(
    if type == "object" then
      with_entries(
        if (.key | IN($keys[])) then .value = "REDACTED" else . end
      )
    else . end
  );
redact_keys([
  "site_key","siteKey","api_key","apiKey","apiToken","token",
  "session_id","sessionId","user_id","userId",
  "ip","ipAddress","user_agent","userAgent"
])
'

jq "$REDACT_FILTER" "$RAW_FILE" > "$REDACTED_FILE"
echo "==> Redacted fixture saved to ${REDACTED_FILE} (committable)"

# --- Auto-detect discriminator + summarise ----------------------------------

# Locate the events array. Roundtable's API likely returns either a bare
# array or an object with an `events` field; try both.
EVENT_PATH="$(
    jq -r '
        if type == "array" then "."
        elif (.events? | type) == "array" then ".events"
        elif (.data? | type) == "array" then ".data"
        else "unknown" end
    ' "$REDACTED_FILE"
)"

if [ "$EVENT_PATH" = "unknown" ]; then
    echo "Warning: could not auto-detect events array. Top-level keys:" >&2
    jq -r 'keys[]?' "$REDACTED_FILE" >&2 || true
    EVENT_COUNT=0
else
    EVENT_COUNT="$(jq "${EVENT_PATH} | length" "$REDACTED_FILE")"
fi

# Auto-detect the discriminator field. Candidates in order of likelihood.
DISCRIMINATOR=""
if [ "$EVENT_PATH" != "unknown" ] && [ "$EVENT_COUNT" -gt 0 ]; then
    for CAND in event_type eventType type event name kind; do
        HAS="$(jq --arg k "$CAND" "[${EVENT_PATH}[]? | has(\$k)] | all" "$REDACTED_FILE" 2>/dev/null || echo "false")"
        if [ "$HAS" = "true" ]; then
            DISCRIMINATOR="$CAND"
            break
        fi
    done
fi

if [ -n "$DISCRIMINATOR" ]; then
    DISTINCT_TYPES="$(jq -r --arg k "$DISCRIMINATOR" "[${EVENT_PATH}[] | .[\$k]] | unique | .[]" "$REDACTED_FILE" 2>/dev/null || true)"
else
    DISTINCT_TYPES=""
fi

# Flattened top-level key inventory: union of keys appearing on any event.
if [ "$EVENT_PATH" != "unknown" ] && [ "$EVENT_COUNT" -gt 0 ]; then
    FIELD_INVENTORY="$(jq -r "[${EVENT_PATH}[] | keys[]] | unique | .[]" "$REDACTED_FILE")"
else
    FIELD_INVENTORY=""
fi

echo ""
echo "==> Summary"
echo "    Events in response:  ${EVENT_COUNT}"
echo "    Discriminator field: ${DISCRIMINATOR:-<none detected>}"
echo "    Distinct event types:"
if [ -n "$DISTINCT_TYPES" ]; then
    echo "$DISTINCT_TYPES" | sed 's/^/      - /'
else
    echo "      (none — inspect ${REDACTED_FILE} manually)"
fi
echo "    Raw fixture:      ${RAW_FILE}"
echo "    Redacted fixture: ${REDACTED_FILE}"

# --- Append stub to schema-notes --------------------------------------------

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [ ! -f "$SCHEMA_NOTES" ]; then
    cat > "$SCHEMA_NOTES" <<'EOF'
# Roundtable schema notes

Living doc capturing what we have learned about the Roundtable session-events
JSON shape, populated by `bench/scenarios/shared/capture-rt-schema.sh`. Each
captured session appends a new stub section; the operator fills in the
"Schema interpretation" subsection by inspecting the redacted fixture.

The goal is to map RT's event shape onto the CommonEvent contract in
`bench/adapters/schema.json` so we can write `bench/adapters/rt-adapter.js`.

---

EOF
fi

{
    echo "## Session captured ${NOW}"
    echo ""
    echo "- Raw fixture: \`adapters/tests/fixtures/${OUTPUT_NAME}-raw.json\` (gitignored)"
    echo "- Redacted fixture: \`adapters/tests/fixtures/${OUTPUT_NAME}.json\`"
    echo "- Event count: ${EVENT_COUNT}"
    echo "- Events array path: \`${EVENT_PATH}\`"
    echo "- Discriminator field: \`${DISCRIMINATOR:-<none detected>}\`"
    echo ""
    echo "### Distinct event types"
    echo ""
    if [ -n "$DISTINCT_TYPES" ]; then
        echo "$DISTINCT_TYPES" | sed 's/^/- `/; s/$/`/'
    else
        echo "_(none auto-detected — inspect fixture manually)_"
    fi
    echo ""
    echo "### Top-level field inventory (union across all events)"
    echo ""
    if [ -n "$FIELD_INVENTORY" ]; then
        echo "$FIELD_INVENTORY" | sed 's/^/- `/; s/$/`/'
    else
        echo "_(no events found — inspect fixture manually)_"
    fi
    echo ""
    echo "### Schema interpretation"
    echo ""
    echo "_Operator: fill in once you have inspected the fixture. For each event"
    echo "type observed, describe what RT means by it, which fields carry the"
    echo "discriminator vs. payload data, and how it should map to a"
    echo "CommonEvent \`type\` value in \`bench/adapters/schema.json\`._"
    echo ""
    echo "---"
    echo ""
} >> "$SCHEMA_NOTES"

echo "    Schema notes appended: ${SCHEMA_NOTES}"
echo ""
echo "Next: inspect ${REDACTED_FILE} and fill in the 'Schema interpretation'"
echo "section in ${SCHEMA_NOTES}."
