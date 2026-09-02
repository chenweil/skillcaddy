#!/usr/bin/env bash
# #34 步骤 2（在 Linux 上跑，GNU tar）。
#
# 解包 macOS 产出的 library image，采集解包侧事实。
# 不做比对判断 —— 比对交给 compare.mjs，这样同一份事实可以反复复核。
set -euo pipefail

ARTIFACTS="${1:-}"
REPO="${2:-}"

if [[ -z "${ARTIFACTS}" || -z "${REPO}" ]]; then
  echo "用法：verify-linux.sh <产物目录> <skillcaddy 仓库路径>" >&2
  exit 2
fi

ARTIFACTS="$(cd "${ARTIFACTS}" && pwd)"
REPO="$(cd "${REPO}" && pwd)"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "错误：这一步必须在 Linux 上运行（当前 $(uname -s)）。" >&2
  exit 2
fi

if [[ ! -f "${ARTIFACTS}/library-image.tar" ]]; then
  echo "错误：${ARTIFACTS}/library-image.tar 不存在。" >&2
  exit 2
fi

# facts.mjs 需要 Node 20+（与仓库 engines 一致）。先查，别让解包都做完了才报错。
if ! command -v node >/dev/null 2>&1; then
  echo "错误：本机没有 node。facts.mjs 需要 Node 20+。" >&2
  exit 2
fi

# getfattr 缺失时 facts.mjs 会把 xattr 记为 unavailable，而不是误报为无 xattr。
# 这里只提醒，不强制：xattr 不进 checksumDirectory，不影响主结论。
if ! command -v getfattr >/dev/null 2>&1; then
  echo "提醒：未找到 getfattr（attr 包），xattr 一列将记为 unavailable。"
  echo "      如需这项诊断数据：apt-get install attr / dnf install attr。"
  echo
fi

WORK="$(mktemp -d /tmp/libimg34-linux-XXXXXX)"
echo "工作目录：${WORK}"
echo "GNU tar：$(tar --version | head -1)"
echo

# 两种 flag 组合各解一次：
#   plain    —— 不加任何 flag，作为基线
#   hardened —— #33 建议的完整集合，确认硬化不损保真度
#
# #33 已在 GNU tar 1.35 上验证过这三个 GNU-only flag 可用。
HARDENED=(
  --no-acls
  --no-xattrs
  --no-same-permissions
  --no-same-owner
  --no-selinux
  --no-overwrite-dir
  --delay-directory-restore
)

for variant in plain hardened; do
  target="${WORK}/${variant}"
  mkdir -p "${target}"
  echo "== 解包（${variant}）=="
  if [[ "${variant}" == "plain" ]]; then
    tar -xf "${ARTIFACTS}/library-image.tar" -C "${target}"
  else
    tar "${HARDENED[@]}" -xf "${ARTIFACTS}/library-image.tar" -C "${target}"
  fi
  node "${REPO}/docs/research/0034-fidelity/facts.mjs" \
    --root "${target}" \
    --out "${ARTIFACTS}/facts-linux-${variant}.json" \
    --repo "${REPO}" \
    --label "linux-${variant}"
done

# root 与非 root 的 mode 行为不同（GNU tar 的 --no-same-permissions
# 文档写明是 "default for ordinary users"），所以身份必须记录在案。
echo
echo "运行身份：uid=$(id -u) gid=$(id -g) umask=$(umask)"
if [[ "$(id -u)" == "0" ]]; then
  echo "注意：以 root 运行。GNU tar 默认恢复归档内 owner 与完整 mode，"
  echo "      与普通用户的默认行为不同。若目标服务器以非 root 导入，"
  echo "      请另外以普通用户重跑一次。"
fi

echo
echo "=========================================================="
echo "第 2 步完成。产物："
echo "  ${ARTIFACTS}/facts-linux-plain.json"
echo "  ${ARTIFACTS}/facts-linux-hardened.json"
echo
echo "下一步（任一平台均可）："
echo "  node compare.mjs ${ARTIFACTS} > report.md"
echo "=========================================================="
