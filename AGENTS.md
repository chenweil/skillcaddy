DO NOT send optional commentary

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root `CONTEXT.md` and system-wide ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Releasing

Skillcaddy is distributed as the npm package `skillcaddy` and through the
Homebrew tap `chenweil/tap`. The release order matters: **commit and tag
first, publish second**, so the artifact on the registry is traceable to a
commit.

### 1. Prepare the release

Bump `package.json` to the next version, move the `## [Unreleased]` section of
`CHANGELOG.md` into a `## [X.Y.Z] - <date>` section, and commit:

```bash
git commit -am "chore(release): X.Y.Z"
git tag -a vX.Y.Z -m "Release X.Y.Z"
```

### 2. Publish to npm — the maintainer runs this, not the agent

The npm account binds two-factor authentication to a **macOS passkey**, so
there is no TOTP code to request and `npm publish --otp=...` cannot work.
`npm publish` prints a browser authentication URL and waits for the
maintainer to approve it with Touch ID:

```bash
cd /Users/chenweilong/project/skillcaddy && npm publish
```

An agent must not ask the maintainer for a six-digit code: there is none. Ask
the maintainer to run the command, then continue with step 3.

Two follow-ups belong to the same browser-authenticated step:

- The publish flow first creates a placeholder version `0.0.0-stage`. The
  maintainer removes it with `npm unpublish skillcaddy@0.0.0-stage`.
- Verify: `npm view skillcaddy versions` lists exactly the new version, and
  `npx skillcaddy --version` runs it.

### 3. Refresh the Homebrew formula and push the tap

Two commands, in this order:

```bash
bash scripts/update-homebrew-formula.sh   # version + sha256 in Formula/skillcaddy.rb
bash scripts/publish-homebrew-tap.sh      # refresh → brew style → copy into the tap → commit → push
```

`update-homebrew-formula.sh` downloads the published tarball, cross-checks its
sha1 against the registry's own `dist.shasum`, then writes the sha256 into the
formula. `publish-homebrew-tap.sh` runs that, runs `brew style`, and pushes the
result to `chenweil/homebrew-tap`.

Verify the tap afterwards:

```bash
brew update && brew install chenweil/tap/skillcaddy && skillcaddy --version
```

### Release gotchas

- **`dist.shasum` is a sha1, not a sha256.** The Homebrew formula needs the
  sha256, so it must be computed from the downloaded tarball. Never paste the
  value npm prints.
- **A freshly published tarball 404s on the CDN.** The update script retries
  with a cache-busting query string; a plain `curl` of the tarball URL may fail
  while `npm view` still reports the version.
- **The formula URL carries the version literally.** Homebrew requires `url`
  to be declared before `version`, so `#{version}` interpolates an empty value
  at class-body evaluation time. The update script rewrites the URL, the
  version, and the checksum together and fails if they disagree.
- **`cached_location` no longer exists on Formula.** Install from the build
  directory that Homebrew already downloaded and checksum-verified
  (`system "npm", "install", *std_npm_args`).
- **`files` in `package.json` is the packaging boundary.** It keeps the local
  library (which can be gigabytes) out of the tarball. After changing it, run
  `npm pack --dry-run` and check the file count and size.
