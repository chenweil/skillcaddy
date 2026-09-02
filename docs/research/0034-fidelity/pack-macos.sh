#!/usr/bin/env bash
# #34 步骤 1（在 macOS 上跑）。
#
# 造一棵覆盖 #34 全部待验项的代表性源树，用系统 tar 打包成 library image，
# 并记录打包侧事实。
#
# 只在 mktemp 目录里操作，不触碰活跃原件库。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误：这一步必须在 macOS 上运行（当前 $(uname -s)）。" >&2
  echo "Linux 侧请运行 verify-linux.sh。" >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/libimg34-XXXXXX)"
SRC="${WORK}/library"
OUT="${WORK}/out"
mkdir -p "${SRC}" "${OUT}"

echo "工作目录：${WORK}"

# ---------------------------------------------------------------------------
# 代表性源树。每一项都对应 #34 点名要验的一类事实。
# ---------------------------------------------------------------------------
mkdir -p "${SRC}/github/demo-source/skills/alpha"
mkdir -p "${SRC}/github/demo-source/skills/nested/deep/deeper"
mkdir -p "${SRC}/github/demo-source/.git/refs/heads"
mkdir -p "${SRC}/personal/local-source"
mkdir -p "${SRC}/official/archive-source"

# 普通文件与 mode 620/640/644
printf 'alpha skill\n'            > "${SRC}/github/demo-source/skills/alpha/SKILL.md"
printf 'restricted\n'             > "${SRC}/github/demo-source/skills/alpha/private.md"
chmod 640 "${SRC}/github/demo-source/skills/alpha/private.md"

# 可执行 mode 755 与 700
printf '#!/bin/sh\necho hi\n'     > "${SRC}/github/demo-source/skills/alpha/run.sh"
chmod 755 "${SRC}/github/demo-source/skills/alpha/run.sh"
printf '#!/bin/sh\necho secret\n' > "${SRC}/github/demo-source/skills/alpha/owner-only.sh"
chmod 700 "${SRC}/github/demo-source/skills/alpha/owner-only.sh"

# 空目录（cp -r 保不住的东西之一）
mkdir -p "${SRC}/github/demo-source/skills/empty-dir"

# 深层嵌套
printf 'deep\n' > "${SRC}/github/demo-source/skills/nested/deep/deeper/SKILL.md"

# 源内相对软链及其 target —— 地图明确要保的
ln -s ../alpha/SKILL.md "${SRC}/github/demo-source/skills/relative-link.md"
ln -s alpha             "${SRC}/github/demo-source/skills/dir-link"
# 指向更上层但仍在源内
ln -s ../../.git/config "${SRC}/github/demo-source/skills/nested/up-link"

# 死链：库内已知存在（Hermes 有 2 条指向旧库名的死链），导出侧会警告跳过，
# 但保真度测试仍要知道 tar 怎么搬它。
ln -s ./does-not-exist "${SRC}/github/demo-source/skills/dead-link"

# 嵌套 .git —— 543MB 那个决定的最小代表
printf '[core]\n\trepositoryformatversion = 0\n' > "${SRC}/github/demo-source/.git/config"
printf 'ref: refs/heads/main\n'                  > "${SRC}/github/demo-source/.git/HEAD"
printf '0000000000000000000000000000000000000000\n' > "${SRC}/github/demo-source/.git/refs/heads/main"

# 非 ASCII 文件名。macOS 传统上以 NFD 存盘；跨平台后若变成 NFC，
# checksumDirectory 的路径串就变了。这是本次测试最可能爆的一项。
printf 'chinese\n' > "${SRC}/personal/local-source/中文技能.md"
printf 'accent\n'  > "${SRC}/personal/local-source/café.md"

# 特殊但合法的文件名
printf 'space\n'   > "${SRC}/personal/local-source/with space.md"
printf 'dotfile\n' > "${SRC}/personal/local-source/.hidden"

# 空文件
: > "${SRC}/official/archive-source/EMPTY.md"

# 稍大的文件，确认 512 块边界与内容哈希
head -c 100000 /dev/urandom > "${SRC}/official/archive-source/blob.bin"

# registry sidecar 的最小代表
mkdir -p "${SRC}/.skillcaddy/sources/github"
printf '{"schemaVersion":1}\n' > "${SRC}/.skillcaddy/sources/github/demo-source.json"

# xattr：macOS 特有，看它是否跨平台存活
if command -v xattr >/dev/null 2>&1; then
  xattr -w com.skillcaddy.test "libimg34" "${SRC}/github/demo-source/skills/alpha/SKILL.md" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 采集打包侧事实
# ---------------------------------------------------------------------------
echo
echo "== 采集 macOS 打包侧事实 =="
node "${REPO}/docs/research/0034-fidelity/facts.mjs" \
  --root "${SRC}" \
  --out "${OUT}/facts-macos-source.json" \
  --repo "${REPO}" \
  --label "macos-source"

# ---------------------------------------------------------------------------
# 打包。
#
# 地图定的是单个 .tar.gz，而 #25 已验证系统 tar 默认参数即可无损、唯一禁忌是 -h。
# 但当前 lib/libraryImage.js 的 pre-flight 只解析裸 tar，见到 gzip 签名会直接拒收
# （assertUncompressed）。两者都打，让 #35 能拿着实测数据决定用哪种。
#
# 打包侧固定加 --no-mac-metadata --no-xattrs：
# macOS 给每个文件挂 com.apple.provenance，bsdtar 默认把它编成
# LIBARCHIVE.xattr.* PAX 记录，GNU tar 解包时对每个文件报一行
# "Ignoring unknown extended header keyword"。内容无损，但噪音会淹掉真正的错误，
# 且这些 xattr 对 skill 源没有意义。实测两个 flag 都被 bsdtar 接受。
# ---------------------------------------------------------------------------
echo
echo "== 打包 =="
PACK_FLAGS=(--no-mac-metadata --no-xattrs)
tar "${PACK_FLAGS[@]}" -cf  "${OUT}/library-image.tar"    -C "${SRC}" .
tar "${PACK_FLAGS[@]}" -czf "${OUT}/library-image.tar.gz" -C "${SRC}" .
ls -la "${OUT}"/library-image.tar*

# 归档内真实存储的文件名字节。这是判定 unicode 规范化归属的唯一权威：
# 若归档存 NFC 而某侧解出 NFD，责任在那一侧的 tar，不在归档。
echo
echo "== 归档内非 ASCII 条目的真实字节 =="
node "${REPO}/docs/research/0034-fidelity/archive-names.mjs" "${OUT}/library-image.tar" \
  | tee "${OUT}/archive-names.txt"

# 也在 macOS 上原地解包一次，用于分离「tar 的锅」与「跨平台的锅」
echo
echo "== macOS 原地回环解包 =="
ROUND="${WORK}/roundtrip"
mkdir -p "${ROUND}"
tar -xf "${OUT}/library-image.tar" -C "${ROUND}"
node "${REPO}/docs/research/0034-fidelity/facts.mjs" \
  --root "${ROUND}" \
  --out "${OUT}/facts-macos-roundtrip.json" \
  --repo "${REPO}" \
  --label "macos-roundtrip"

echo
echo "=========================================================="
echo "第 1 步完成。"
echo
echo "产物目录：${OUT}"
echo "  library-image.tar"
echo "  library-image.tar.gz"
echo "  facts-macos-source.json"
echo "  facts-macos-roundtrip.json"
echo
echo "下一步：把整个 ${OUT} 送到 Linux 机器，在那里运行"
echo "  ./verify-linux.sh <产物目录> <skillcaddy 仓库路径>"
echo "=========================================================="
echo "${OUT}" > /tmp/libimg34-artifacts
