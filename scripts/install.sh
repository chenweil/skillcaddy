#!/usr/bin/env bash
#
# Skillcaddy 一键安装脚本。
#
#   curl -fsSL https://raw.githubusercontent.com/chenweil/skillcaddy/main/scripts/install.sh | bash
#
# 做的事情只有两件：确认 Node.js 版本够用，然后 npm install -g skillcaddy。
# 原件库不装在安装目录里 —— 默认落在 ~/.skillcaddy/library，
# 这样重装或升级工具都不会动到已装好的 skill（见 ADR-0012）。
#
# 可选参数：
#   --prefix <dir>   安装到自定义 npm prefix（默认用 npm 的全局 prefix）
#   --version <ver>  安装指定版本，例如 --version 0.26.4
#   --help           显示本帮助

set -euo pipefail

PACKAGE_NAME="skillcaddy"
MIN_NODE_MAJOR=20
NPM_PREFIX=""
NPM_VERSION="latest"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：install.sh [--prefix <dir>] [--version <ver>]

  --prefix <dir>   安装到自定义 npm prefix
  --version <ver>  安装指定版本（默认 latest）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      NPM_PREFIX="${2:-}"
      [ -n "$NPM_PREFIX" ] || fail "--prefix 需要一个目录"
      shift 2
      ;;
    --prefix=*)
      NPM_PREFIX="${1#--prefix=}"
      [ -n "$NPM_PREFIX" ] || fail "--prefix 需要一个目录"
      shift
      ;;
    --version)
      NPM_VERSION="${2:-}"
      [ -n "$NPM_VERSION" ] || fail "--version 需要一个版本号"
      shift 2
      ;;
    --version=*)
      NPM_VERSION="${1#--version=}"
      [ -n "$NPM_VERSION" ] || fail "--version 需要一个版本号"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '未知参数：%s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v node >/dev/null 2>&1 || fail "未找到 node。Skillcaddy 需要 Node.js >= ${MIN_NODE_MAJOR}，请先安装：https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fail "当前 Node.js 版本是 $(node -v)，Skillcaddy 需要 >= ${MIN_NODE_MAJOR}"
fi

command -v npm >/dev/null 2>&1 || fail "未找到 npm。请安装 Node.js（含 npm）：https://nodejs.org"

log "==> 安装 ${PACKAGE_NAME}@${NPM_VERSION}"

if [ -n "$NPM_PREFIX" ]; then
  npm install --global --prefix "$NPM_PREFIX" "${PACKAGE_NAME}@${NPM_VERSION}"
else
  npm install --global "${PACKAGE_NAME}@${NPM_VERSION}"
fi

if command -v skillcaddy >/dev/null 2>&1; then
  COMMAND_PATH="$(command -v skillcaddy)"
else
  COMMAND_PATH="skillcaddy"
fi

log "==> 安装完成：${COMMAND_PATH}"
log ""
log "下一步："
log "  skillcaddy            进入当前项目的 TUI"
log "  skillcaddy start      启动 Web 管理器"
log "  npx skillcaddy        免安装直接运行"
log ""
log "原件库默认位于 ~/.skillcaddy/library，与安装目录无关；"
log "用 SKILLCADDY_ROOT 或 --root 可以指向别的原件库。"
