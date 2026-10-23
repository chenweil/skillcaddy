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
  sha256 "66025914c6da1696f64d6caab421b27a102a53e0cf2aecb282a56ea510374384"
  license "MIT"
  version "0.26.4"

  depends_on "node"

  head "https://github.com/chenweil/skillcaddy.git", branch: "main"

  def install
    args = Language::Node.std_npm_install_args(libexec)
    if build.head?
      system "npm", "install", *args, "."
    else
      system "npm", "install", *args, cached_location/"skillcaddy-#{version}.tgz"
    end
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/skillcaddy --version")
  end
end
