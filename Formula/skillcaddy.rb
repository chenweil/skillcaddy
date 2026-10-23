# Homebrew formula for Skillcaddy.
#
# The published package on npm is the artifact this formula installs. The
# library itself never lives in the Cellar: Skillcaddy keeps the central
# library in `~/.skillcaddy/library`, so `brew upgrade` cannot touch it
# (see docs/adr/0012-decoupled-code-root-and-library-root.md).
#
# After every `npm publish`, refresh the checksum with:
#
#   bash scripts/update-homebrew-formula.sh
#
# The checksum below is computed from the published npm tarball, so it is
# only valid once the matching version exists on the registry.
class Skillcaddy < Formula
  desc "Local skill source library with project, global, and Hermes symlink scopes"
  homepage "https://github.com/chenweil/skillcaddy"
  url "https://registry.npmjs.org/skillcaddy/-/skillcaddy-#{version}.tgz"
  version "0.27.0"
  sha256 "06b881cdffb09f016e46f544b554ebfeb167d5be78dd04728aa9b48f3db52748"
  license "MIT"

  head "https://github.com/chenweil/skillcaddy.git", branch: "main"

  depends_on "node"

  def install
    if build.head?
      system "npm", "install", *std_npm_args, "."
    else
      system "npm", "install", *std_npm_args, cached_location/"skillcaddy-#{version}.tgz"
    end
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/skillcaddy --version")
  end
end
