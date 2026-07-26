#!/usr/bin/env bash
#
# check-public-hygiene.sh — public-tree hygiene gate.
#
# Fails (exit 1) if any tracked file contains a banned token. Banned tokens are
# personal or internal-process leakage that must never ship in the public tree:
# personal machine paths and Pages URLs, study-specific participant identifiers,
# and internal review vocabulary (Sol / Fable / pack / C-prime / red-team).
#
# NOTE on Prolific/MTurk: the bare platform names are NOT banned — they are the
# legitimate crowdsourcing platforms this tool supports, and deliberate
# package.json / CITATION keywords. Only the study-specific identifier forms
# (PROLIFIC_PID env var, Prolific completionCode) are treated as leakage.
#
# Likewise github.com/konukcan/... (the public repo URL) is fine; only the
# personal Pages host konukcan.github.io is banned.
#
# Runs from anywhere in the repo. Scans tracked files only (git grep).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Each entry is an extended-regex (ERE) banned token. Case is encoded in the
# pattern where it matters (e.g. C-prime must stay upper-case to avoid matching
# "specific primer"); word boundaries (\b) guard common English substrings.
patterns=(
  'konukcan\.github\.io'   # personal GitHub Pages host
  '/Users/cankonuk'        # personal machine path
  'PROLIFIC_PID'           # study-specific participant identifier
  'completionCode'         # Prolific study completion code
  '\b[Pp]ledge\b'          # internal honor-pledge study term
  '\b[Ff]able\b'           # internal codename (also covers fable-window)
  '[Ss]ol[ -][0-9]'        # internal review vocab: "Sol 5", "sol-5", "Sol 20"
  '[Ss]ol review'          # internal review vocab
  'ch-sol-loop'            # internal review-loop label
  'C′'                     # internal design label "C-prime" (U+2032 prime)
  'C.?prime'               # internal design label, spelled out
  'pack[ -][0-9]'          # internal iteration label: "pack 26", "pack-30"
  'se-study'               # internal study name
  'SE study'               # internal study name (spaced form)
  'SE-native'              # internal shorthand
  '[Ss]elf-explanation'    # internal paradigm / repo name
  'SEAudio'                # internal component name
  '[Rr]ule-gallery'        # internal paradigm name
  '[Cc]ard-games'          # private repo name
  '\bstudy3\b'             # internal study name
  'study-3'                # internal study name
  'design-decisions'       # deleted internal design-rationale doc
  'adversarial break'      # internal red-team vocab
)

fail=0
self='scripts/check-public-hygiene.sh'  # this file lists the tokens; don't scan it
for pat in "${patterns[@]}"; do
  # -I skips binary files; -n adds line numbers; -E extended regex.
  if hits=$(git grep -I -nE "$pat" -- ":(exclude)$self" 2>/dev/null); then
    echo "BANNED TOKEN /$pat/:"
    printf '%s\n' "$hits" | sed 's/^/  /'
    echo
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAIL: public-hygiene gate found banned tokens above." >&2
  exit 1
fi

echo "OK: no banned tokens in tracked files."
