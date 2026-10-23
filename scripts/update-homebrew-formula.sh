#!/usr/bin/env bash
#
# 刷新 Formula/skillcaddy.rb 里的版本号与 sha256。
#
#   bash scripts/update-homebrew-formula.sh [version]
#
# 每次 npm publish 之后跑一次：Homebrew 会拿 sha256 校验下载到的 tarball，
# 版本一更新就必须同步，否则 brew install 会报 checksum mismatch。
#
# 这里下载的是 registry 上已发布的 tarball，而不是本地 npm pack 的产物：
# 只有前者才是用户真正会拿到的那份字节。

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

echo "==> 下载 ${URL}"
if ! curl -fsSL "$URL" -o "$TMP_DIR/skillcaddy-${VERSION}.tgz"; then
  echo "错误：下载失败。确认 ${VERSION} 已经发布到 npm registry。" >&2
  exit 1
fi

SHA256="$(shasum -a 256 "$TMP_DIR/skillcaddy-${VERSION}.tgz" | awk '{print $1}')"
echo "==> sha256 ${SHA256}"

VERSION="$VERSION" SHA256="$SHA256" FORMULA="$FORMULA" python3 - <<'PY'
import os
import re
import pathlib

formula = pathlib.Path(os.environ['FORMULA'])
version = os.environ['VERSION']
sha256 = os.environ['SHA256']
text = formula.read_text()

text, count_version = re.subn(r'^(\s*version\s+)"[^"]+"$', r'\1"%s"' % version, text, count=1, flags=re.M)
text, count_sha = re.subn(r'^(\s*sha256\s+)"[^"]+"$', r'\1"%s"' % sha256, text, count=1, flags=re.M)

if count_version != 1 or count_sha != 1:
    raise SystemExit('错误：Formula/skillcaddy.rb 的结构与预期不符，请手工检查。')

formula.write_text(text)
print('==> 已更新 %s' % formula)
PY
