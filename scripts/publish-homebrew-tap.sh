#!/usr/bin/env bash
#
# 把 Formula/skillcaddy.rb 同步到 Homebrew tap 仓库并推送。
#
#   bash scripts/publish-homebrew-tap.sh
#
# 前提：对应的版本已经发布到 npm（否则 checksum 拿不到）。
# 流程：先刷新 version + sha256，再 brew style 过一遍，然后复制进 tap 仓库提交推送。
#
# 可选环境变量：
#   TAP_REPO   tap 仓库，默认 chenweil/homebrew-tap
#   TAP_DIR    tap 的本地 clone 目录，默认临时目录（用完即删）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORMULA_SRC="$REPO_ROOT/Formula/skillcaddy.rb"
TAP_REPO="${TAP_REPO:-chenweil/homebrew-tap}"

if ! command -v brew >/dev/null 2>&1; then
  echo "错误：需要 brew 才能做 style 检查。" >&2
  exit 1
fi

echo "==> 刷新 formula 的 version 与 sha256"
bash "$REPO_ROOT/scripts/update-homebrew-formula.sh"

echo "==> brew style 检查"
brew style "$FORMULA_SRC"

TEMP_DIR=""
if [ -n "${TAP_DIR:-}" ]; then
  CLONE_DIR="$TAP_DIR"
else
  TEMP_DIR="$(mktemp -d)"
  CLONE_DIR="$TEMP_DIR/homebrew-tap"
  git clone --quiet --depth 1 "https://github.com/${TAP_REPO}" "$CLONE_DIR"
fi
trap '[ -n "$TEMP_DIR" ] && rm -rf "$TEMP_DIR"' EXIT

if [ -n "$(git -C "$CLONE_DIR" status --short)" ]; then
  echo "错误：tap 本地目录有未提交改动，先处理掉再跑。" >&2
  exit 1
fi

cp "$FORMULA_SRC" "$CLONE_DIR/Formula/skillcaddy.rb"

if git -C "$CLONE_DIR" diff --quiet; then
  echo "==> tap 里的 formula 已经是最新，无需提交。"
  exit 0
fi

VERSION="$(grep -oE '^  version "[^"]+"' "$FORMULA_SRC" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
git -C "$CLONE_DIR" add Formula/skillcaddy.rb
git -C "$CLONE_DIR" commit -q -m "chore: update skillcaddy formula to ${VERSION}"
git -C "$CLONE_DIR" push -q origin HEAD:main 2>&1 | grep -v "credential storage lock" || true

echo "==> 已推送 ${TAP_REPO}（skillcaddy ${VERSION}）"
echo "    brew update && brew upgrade chenweil/tap/skillcaddy"
