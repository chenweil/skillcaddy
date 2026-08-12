#!/bin/bash
# Hermes cron entrypoint for skillcaddy source update-git.
# Runs the unified Git source updater against all registered Git sources,
# auto-repairs source-collision failures, and prints a compact
# diff-style summary suitable for Telegram delivery.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SKILLCADDY_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
PROJECT="${SKILLCADDY_PROJECT:-${HOME}/playground/hermes}"

cd "${REPO_ROOT}" || {
  echo "ERROR: cannot cd to ${REPO_ROOT}"
  exit 1
}

ts="$(date '+%Y-%m-%d %H:%M:%S %Z')"

echo "=== skillcaddy sync ==="
echo "时间: ${ts}"
echo "项目: ${PROJECT}"
echo

run_update() {
  raw="$(npm run --silent source -- update-git --project "${PROJECT}" 2>&1)"
  update_exit=$?
}

run_update

# Pull the bracketed repo paths into one list per category.
collect() {
  printf '%s\n' "${raw}" \
    | grep -oE '^\[(updated|failed|dirty|current|breaking)\] [^ ]+' \
    | awk -v cat="$1" '$1=="["cat"]" {sub(/^\[[^]]+\] /, ""); print}' \
    | sort -u
}

updated=( $(collect updated) )
failed=(  $(collect failed)  )
dirty=(   $(collect dirty)   )
current=( $(collect current) )
breaking=( $(collect breaking) )

collect_failed_category() {
  printf '%s\n' "${raw}" \
    | awk -v category="$1" '
      /^\[failed\]/ {
        actual=$3
        gsub(/[()]/, "", actual)
        if (actual == category) print $2
      }
    ' \
    | sort -u
}

# Auto-repair source-collision failures (commit record out of sync with local repo).
repair_results=()
collision_failed=( $(collect_failed_category source-collision) )
repaired_count=0
if [[ ${#collision_failed[@]} -gt 0 ]]; then
  while IFS= read -r sid; do
    [[ -z "${sid}" ]] && continue
    repair_out="$(npm run --silent source -- repair "${sid}" --yes --project "${PROJECT}" 2>&1)"
    if printf '%s' "${repair_out}" | grep -q "Outcome: repaired"; then
      new_commit="$(printf '%s' "${repair_out}" | awk '/^commit:/ {print $2; exit}')"
      repair_results+=("repaired ${sid} -> ${new_commit}")
      repaired_count=$((repaired_count + 1))
    else
      repair_outcome="$(printf '%s' "${repair_out}" | awk '/^Outcome:/ {print $2; exit}')"
      repair_results+=("repair-blocked ${sid}${repair_outcome:+ (${repair_outcome})}")
    fi
  done < <(printf '%s\n' "${collision_failed[@]}")
fi

# Re-run update-git to refresh counters after repairs (collisions should be gone).
if [[ ${repaired_count} -gt 0 ]]; then
  echo "--- 修复后复核 ---"
  run_update
  updated=( $(collect updated) )
  failed=(  $(collect failed)  )
  dirty=(   $(collect dirty)   )
  current=( $(collect current) )
  breaking=( $(collect breaking) )
fi

summary=$(printf '%s' "${raw}" | grep -E '^Git source summary:' | tail -n 1 | sed 's/^Git source summary: //')

echo "结果: ${summary:-unknown}"

if [[ ${#updated[@]} -gt 0 ]]; then
  echo "更新 updated (${#updated[@]}):"
  printf '  - %s\n' "${updated[@]}"
fi
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "失败 failed (${#failed[@]}):"
  printf '  - %s\n' "${failed[@]}"
fi
if [[ ${#dirty[@]} -gt 0 ]]; then
  echo "阻塞 dirty (${#dirty[@]}):"
  printf '  - %s\n' "${dirty[@]}"
fi
if [[ ${#breaking[@]} -gt 0 ]]; then
  echo "breaking (${#breaking[@]}):"
  printf '  - %s\n' "${breaking[@]}"
fi
if [[ ${#current[@]} -gt 0 ]]; then
  echo "已最新 current: ${#current[@]} 个"
fi
if [[ ${#repair_results[@]} -gt 0 ]]; then
  echo
  echo "自动修复 (${#repair_results[@]}):"
  printf '  - %s\n' "${repair_results[@]}"
fi
if [[ ${#failed[@]} -gt 0 ]]; then
  echo
  echo "--- failed 详情 ---"
  printf '%s\n' "${raw}" | awk '
    /^\[failed\]/ {cur=$0; getline reason; if (reason ~ /^  reason:/) print cur "\n" reason; cur=""}
  '
fi

if [[ ${update_exit} -ne 0 || ${#failed[@]} -gt 0 ]]; then
  exit 1
fi

exit 0
