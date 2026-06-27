#!/usr/bin/env bash
# Pull every repo under github/. These are third-party libraries, so we use
# --ff-only to never create merge commits locally, and skip dirty worktrees
# instead of clobbering local edits.
#
# Override the target dir with $SKILLCADDY_GITHUB or the first positional arg.
# Defaults to ../github relative to this script.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${SKILLCADDY_GITHUB:-${1:-$SCRIPT_DIR/../github}}"

if [ ! -d "$ROOT" ]; then
  echo "github/ directory not found: $ROOT" >&2
  echo "Set SKILLCADDY_GITHUB or pass it as the first arg." >&2
  exit 1
fi

ROOT="$(cd "$ROOT" && pwd)"

pulled=0
up_to_date=0
dirty=0
no_git=0
failed=0

for dir in "$ROOT"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")

  if [ ! -d "$dir/.git" ]; then
    no_git=$((no_git + 1))
    continue
  fi

  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    printf "[skip] %-32s dirty working tree\n" "$name"
    dirty=$((dirty + 1))
    continue
  fi

  output=$(git -C "$dir" pull --ff-only 2>&1)
  status=$?

  if [ "$status" -eq 0 ]; then
    if printf "%s" "$output" | grep -q "Already up to date"; then
      printf "[ok]   %-32s up to date\n" "$name"
      up_to_date=$((up_to_date + 1))
    else
      printf "[ok]   %-32s pulled\n" "$name"
      printf "%s\n" "$output" | sed 's/^/      /'
      pulled=$((pulled + 1))
    fi
  else
    printf "[fail] %-32s\n" "$name"
    printf "%s\n" "$output" | sed 's/^/      /'
    failed=$((failed + 1))
  fi
done

echo
echo "github/ summary: pulled=$pulled  up-to-date=$up_to_date  dirty=$dirty  no-git=$no_git  failed=$failed"

[ "$failed" -eq 0 ]