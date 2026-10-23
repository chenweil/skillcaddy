#!/usr/bin/env bash
#
# 刷新 Formula/skillcaddy.rb 里的版本号与 sha256。
#
#   bash scripts/update-homebrew-formula.sh [version]
#
# 每次 npm publish 之后跑一次：Homebrew 会拿 sha256 校验下载到的 tarball，
# 版本一更新就必须同步，否则 brew install 会报 checksum mismatch。
#
# 两个坑：
#   1. npm 的 dist.shasum 是 **sha1**，不是 sha256。Homebrew 的 sha256 要自己算。
#   2. 刚发布的 tarball 在 CDN 上可能返回 404（负缓存），加一个 query 参数
#      绕过去再试。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORMULA="$REPO_ROOT/Formula/skillcaddy.rb"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
fi

URL="https://registry.npmjs.org/skillcaddy/-/skillcaddy-${VERSION}.tgz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# registry 上这个版本的权威信息：dist.shasum 是 sha1，用来交叉校验我们下到的字节。
REGISTRY_SHA1="$(npm view "skillcaddy@${VERSION}" dist.shasum 2>/dev/null || true)"
if [ -z "$REGISTRY_SHA1" ]; then
  echo "错误：registry 上还没有 skillcaddy@${VERSION}。" >&2
  exit 1
fi

echo "==> 下载 ${URL}"
DOWNLOADED=""
for attempt in 1 2 3 4 5; do
  SUFFIX=""
  [ "$attempt" -gt 1 ] && SUFFIX="?cachebust=${attempt}-$(date +%s)"
  if curl -fsSL "${URL}${SUFFIX}" -o "$TMP_DIR/skillcaddy-${VERSION}.tgz"; then
    DOWNLOADED="$TMP_DIR/skillcaddy-${VERSION}.tgz"
    break
  fi
  echo "    第 ${attempt} 次下载失败，重试…"
  sleep 5
done

if [ -z "$DOWNLOADED" ]; then
  echo "错误：下载失败。确认 ${VERSION} 已经发布到 npm registry。" >&2
  exit 1
fi

ACTUAL_SHA1="$(shasum "$DOWNLOADED" | awk '{print $1}')"
if [ "$ACTUAL_SHA1" != "$REGISTRY_SHA1" ]; then
  echo "错误：下载到的字节与 registry 声明的 sha1 不一致（${ACTUAL_SHA1} != ${REGISTRY_SHA1}）。" >&2
  exit 1
fi

SHA256="$(shasum -a 256 "$DOWNLOADED" | awk '{print $1}')"
echo "==> sha1 ${ACTUAL_SHA1}（与 registry 一致）"
echo "==> sha256 ${SHA256}"

VERSION="$VERSION" SHA256="$SHA256" FORMULA="$FORMULA" python3 - <<'PY'
import os
import re
import pathlib

formula = pathlib.Path(os.environ['FORMULA'])
version = os.environ['VERSION']
sha256 = os.environ['SHA256']
text = formula.read_text()

# URL 里的版本号写死（Homebrew 要求 url 声明在 version 之前，插值会拿到空串），
# 所以这里要同时改写 URL、version 与 sha256 三处，并检查它们一致。
text, count_url = re.subn(
    r'^(  url "https://registry\.npmjs\.org/skillcaddy/-/skillcaddy-)[^"]+(\.tgz")$',
    r'\g<1>%s\g<2>' % version,
    text,
    count=1,
    flags=re.M,
)
text, count_version = re.subn(r'^(  version )"[^"]+"$', r'\1"%s"' % version, text, count=1, flags=re.M)
text, count_sha = re.subn(r'^(  sha256 )"[^"]+"$', r'\1"%s"' % sha256, text, count=1, flags=re.M)

if count_url != 1 or count_version != 1 or count_sha != 1:
    raise SystemExit('错误：Formula/skillcaddy.rb 的结构与预期不符，请手工检查。')

if ('skillcaddy-%s.tgz' % version) not in text:
    raise SystemExit('错误：URL 与 version 不一致。')

formula.write_text(text)
print('==> 已更新 %s' % formula)
PY
