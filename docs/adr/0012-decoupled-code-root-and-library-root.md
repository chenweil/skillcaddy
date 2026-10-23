---
status: accepted
---

# Decouple the code root from the library root, and distribute Skillcaddy as a package

## Context

Until now Skillcaddy had exactly one root directory. The clone you installed
was simultaneously the place the code ran from and the place the central
library lived in: the four source buckets, the source registry, and the skill
metadata sidecars were all derived from the same `rootDir` value that also
located `package.json`, `server.js`, the bundled `skills/` bucket, and the
collection setup contracts. The result was a single, tidy mental model and a
hard constraint: **the library can only exist where the code happens to
live.**

That constraint blocks the two capabilities Skillcaddy most needs next.

- **One-shot installation.** A `npx skillcaddy` run resolves to
  `~/.npm/_npx/<hash>/node_modules/skillcaddy`. A library placed there is
  written into npm's package cache: it is not part of the published artifact,
  it is pruned by cache maintenance, and it silently disappears for every user
  who does not have a clone. The same problem applies to a Homebrew Cellar
  directory, which a `brew upgrade` may replace outright.
- **Multi-device sync.** Moving a library between machines needs a location
  that does not depend on how the tool was installed. The library image
  (ADR-0011) already carries the bytes; what it lacked was a stable target
  location.

The coupling was also visible in the seams between subsystems. `lib/sourcePolicy.js`
validated a skill path against four library buckets *and* the repository
`skills/` bucket at the same time; `lib/skillMetadata.js` derived a sidecar
path from the source folder that policy returned; `lib/collectionSetup.js`
looked up setup contracts next to the library it was describing; and
`lib/webManager.js` started a server from the same directory it treated as
the library.

Two existing decisions are in tension with this change and are addressed
explicitly below:

- **ADR-0007** states that "Skillcaddy is not published or downloaded as a
  global npm package" and that "Web lifecycle commands use the clone that
  provides the executable". The first clause forbids the distribution form
  this ADR enables; the second clause encoded the single-root assumption.
- **ADR-0011** requires the library image manifest to carry the producing
  repository's `commit`, `branch`, `dirty`, and `pushed`, and the exporter
  refuses to produce an archive unless the library root is a clean, pushed
  git repository. That precondition assumed the library root is a checkout.

Companion documents: [`CONTEXT.md`](../../CONTEXT.md) (glossary — now defines
**Code root** and **Library root**), [`docs/adr/0007-clone-backed-cli-and-web-lifecycle.md`](0007-clone-backed-cli-and-web-lifecycle.md),
[`docs/adr/0011-self-contained-library-image-portability.md`](0011-self-contained-library-image-portability.md).

## Decision 1 — Two roots, resolved independently

Skillcaddy resolves two roots instead of one.

- The **code root** is the directory that holds the running code and the
  artifacts that ship with it: `package.json`, `server.js`, the bundled
  `skills/` bucket, and the collection setup contracts under
  `collection-metadata/`.
- The **library root** is the directory that holds the central library: the
  `official` / `github` / `personal` / `archived` source buckets, the source
  registry under `.skillcaddy/sources`, and the skill metadata sidecars under
  `.skillcaddy/metadata`.

Every module that needs one root takes it explicitly. Modules that need both
take a roots object (`{ libraryRoot, codeRoot }`). A single string still
means "both roots are this directory", so the historical single-root call
shape remains valid and is used wherever the two roots genuinely coincide.

_Avoid_: One root, data directory, config directory, `--data-dir`

## Decision 2 — Library root resolution order

The library root is resolved in this order:

1. an explicit library root supplied by the caller (`--root`, or the resolved
   value handed to an embedded API);
2. the `SKILLCADDY_ROOT` environment variable — the same variable the
   existing `pull-github.sh` and `cron-sync-update-git.sh` scripts already
   use, so those scripts keep working unchanged;
3. the code root, when the code root is a git checkout;
4. the user-level library directory, `~/.skillcaddy/library`.

Rule 3 is what keeps this change from breaking anyone. A clone-based user
already has a populated library inside the checkout; it stays exactly where it
is, and no skill disappears. Every non-checkout distribution form — an `npx`
one-shot run, an npm global install, a package manager prefix — lands on the
user-level library directory, which is stable across upgrades and independent
of how the tool was installed.

The user-level library directory deliberately keeps the library's internal
layout (`<libraryRoot>/{official,github,personal,archived}` and
`<libraryRoot>/.skillcaddy/{sources,metadata}`) identical to the checkout
layout, so a library image exported from one location imports into the other
without conversion.

## Decision 3 — Which root owns which artifact

| Artifact | Root |
| --- | --- |
| `official/`, `github/`, `personal/`, `archived/` | library |
| `.skillcaddy/sources` (source registry) | library |
| `.skillcaddy/metadata` (skill metadata sidecars) | library |
| `package.json`, `server.js`, `public/` | code |
| `skills/` (bundled skills bucket, source `local`) | code |
| `collection-metadata/` (collection setup contracts) | code |
| `lib/`, `scripts/` | code |

Two consequences are worth stating because they are not obvious:

- A skill that comes from the bundled `skills/` bucket keeps its metadata
  sidecar **in the library root**. Metadata travels with the library image
  (ADR-0011), so sidecars must not live next to the code that a reinstall
  replaces.
- The bundled `skills/` bucket is visible regardless of where the library
  lives. The bundled skills belong to the distribution, not to the library.

## Decision 4 — Publish and distribute as a package

Skillcaddy is published to the npm registry as `skillcaddy`, with `bin` entry
points for the CLI and the TUI, and is installable through Homebrew. The
supported installation forms are:

- `npx skillcaddy` — a one-shot run with no installation step;
- `npm install -g skillcaddy` — a persistent global command;
- `brew install skillcaddy` — a package manager install with upgrade support;
- a git clone — the original form, still fully supported.

**This supersedes the ADR-0007 clause "Skillcaddy is not published or
downloaded as a global npm package."** ADR-0007 is amended, not rewritten: it
remains the record of why the clone-backed executable was introduced, and the
clause above is the only part it loses. Its other clauses — the ownership
boundary on Web lifecycle, the read-only `-a` analysis, the explicit project
context required by `-u` — are unaffected.

Publishing to npm and the Homebrew tap requires the maintainer's own
credentials; the repository-side change is that the package becomes
publishable (`files`, `bin`, no `private` flag) and that the install scripts
and formula are kept in the repository.

## Decision 5 — Web lifecycle no longer requires one root

ADR-0007's rule that "Web lifecycle commands use the clone that provides the
executable" existed because the server derived both its code location and its
library location from one directory. With two roots, the constraint is
unnecessary: the CLI starts `server.js` from the code root and passes the
resolved library root to the server through `SKILLCADDY_ROOT`. The server
therefore observes the same library the CLI does, even when `--root` points
somewhere else.

The CLI still refuses to run Web lifecycle commands against a *different code
root* than the one providing the executable — that boundary protects the
running server, not the library.

## Decision 6 — The library image producer gains an explicit mode

ADR-0011's manifest carries the producing repository's `commit`, `branch`,
`dirty`, and `pushed` so the importer can warn on drift. That only makes
sense when the library root is a repository. With the library root decoupled,
it usually is not.

The manifest's `producer` field therefore gains an explicit `mode`:

- `mode: "repository"` — the library root is a git repository; `commit` and
  `branch` are strings, and the exporter keeps ADR-0011's clean-and-pushed
  precondition.
- `mode: "no-repository"` — the library root is a plain directory; `commit`
  and `branch` are `null`, and the repository-state check is skipped with a
  reported warning instead of blocking the export.

The importer accepts both shapes and validates them with the same strictness
as the rest of the manifest. The archive format, the member list, and
`schemaVersion: 1` are unchanged; only the `producer` object's shape is
widened.

## Consequences

- Existing clone-based installs are unaffected: the library stays in the
  checkout, `--root` keeps pointing at the central library, and no skill
  disappears.
- The library acquires a home that survives reinstalling the tool, which is
  the precondition for continuous multi-device synchronization on top of the
  library image.
- The `--root` flag now means "the library root" everywhere, including Web
  lifecycle commands, which previously rejected it.
- A user who installs the packaged form and also keeps a clone ends up with
  two libraries unless they point one at the other with `SKILLCADDY_ROOT`.
  This is visible in `skillcaddy` output, which reports both roots.
- The metadata sidecar for a bundled skill lives in the library root, so a
  reinstall of the tool does not discard notes and tags.
- The library image exporter no longer requires the library root to be a git
  repository; drift detection for a plain library root relies on the archive
  content checksums instead of the repository state.
