#!/usr/bin/env bash
# Compatibility adapter for registered Git source updates.
#
# Override the target dir with $SKILLCADDY_GITHUB or the first positional arg.
# The optional second positional arg identifies the current project.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_ROOT="${SKILLCADDY_GITHUB:-${1:-$SCRIPT_DIR/../github}}"
PROJECT_ROOT="${SKILLCADDY_PROJECT:-${2:-$PWD}}"

if [ ! -d "$GITHUB_ROOT" ]; then
  echo "github/ directory not found: $GITHUB_ROOT" >&2
  echo "Set SKILLCADDY_GITHUB or pass it as the first arg." >&2
  exit 1
fi

GITHUB_ROOT="$(cd "$GITHUB_ROOT" && pwd)"
LIBRARY_ROOT="$(dirname "$GITHUB_ROOT")"
SKILLCADDY_ROOT="$LIBRARY_ROOT" SKILLCADDY_PROJECT="$PROJECT_ROOT" \
  node "$SCRIPT_DIR/source.js" update-git
