# Homebrew formula for Skillcaddy.
#
# The published package on npm is the artifact this formula installs. The
# library itself never lives in the Cellar: Skillcaddy keeps the central
# library in `~/.skillcaddy/library`, so `brew upgrade` cannot touch it
# (see docs/adr/0012-decoupled-code-root-and-library-root.md).
#
# After every `npm publish`, refresh the checksum and push the tap with:
#
#   bash scripts/update-homebrew-formula.sh   # version + sha256
#   bash scripts/publish-homebrew-tap.sh      # copy into the tap and push
#
# The version is written into the URL literally rather than interpolated:
# Homebrew's component order requires `url` to be declared before `version`,
# so `#{version}` would interpolate an empty value at class-body evaluation
# time. `scripts/update-homebrew-formula.sh` rewrites the URL, the version and
# the checksum together, and fails if they disagree.
class Skillcaddy < Formula
  desc "Local skill source library with project, global, and Hermes symlink scopes"
  homepage "https://github.com/chenweil/skillcaddy"
  url "https://registry.npmjs.org/skillcaddy/-/skillcaddy-0.27.0.tgz"
  version "0.27.0"
  sha256 "06b881cdffb09f016e46f544b554ebfeb167d5be78dd04728aa9b48f3db52748"
  license "MIT"

  head "https://github.com/chenweil/skillcaddy.git", branch: "main"

  depends_on "node"

  def install
    # Homebrew 已经把上面那个 tarball 下载、校验 sha256 并解包到 build 目录，
    # 这里直接在该目录里安装：装的就是校验过的那份字节。
    # `cached_location` 在新版 Homebrew 里已从 Formula 移除，所以不能从缓存路径取包。
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/skillcaddy --version")
  end
end
