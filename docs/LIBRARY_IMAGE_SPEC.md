# Library Image Implementation Spec

## Outcome

Add a safe, scriptable way to relocate a working Skillcaddy central library to another machine — including a fully offline server — and resume normal management there.

The first release provides:

```bash
npm run source -- image export <image.tar.gz>
npm run source -- image import <image.tar.gz>
npm run source -- image import <image.tar.gz> --dry-run
npm run source -- image import <image.tar.gz> --yes
```

The library image is one `.tar.gz` plus a `library-image.json` manifest at the archive root as the first entry. The receiving machine becomes equivalent to the producing machine: same sources installed, same registry records, same user-level enablements.

The same image operation is callable only through the repo-local CLI in this release. Web UI, TUI, JSON output, and a global `skillcaddy` executable are out of scope.

## Non-goals

The first release does not:

- enable project-level skills (33 known project enablements are recreated by the user after import);
- rebuild the library from a manifest alone (12 upstream-less sources make that lossy);
- strip per-source `.git` directories (the 543MB archive is the portability floor);
- attach provenance to upstream-less sources (`source repair` remains the separate path);
- export or import via the Web UI, TUI, or a global `skillcaddy` command;
- encrypt, sign, upload, or transfer the archive (`0600` is the only built-in protection);
- compare or upgrade upstream-less sources during export;
- retain replaced archive versions or backups;
- support formats other than `.tar.gz` (no `.zip`, no plain `.tar`, no `.tgz`);
- add Web source acquisition, replacement, or removal controls;
- add TUI source replacement or removal controls;
- install a global `skillcaddy` executable; or
- move existing source directories into a new layout.

## Domain boundaries

The canonical vocabulary is in [`CONTEXT.md`](../CONTEXT.md). The terms that the rest of this spec relies on are:

- **Library image**: the single `.tar.gz` plus its manifest.
- **Upstream-less source**: a source with no fetchable provenance.
- **Source registry**: the sidecar records under `.skillcaddy/sources/`.
- **Checksum directory**: the per-source directory hash used as the import-side validation gate; it counts path strings, entry types, file contents, and symlink targets, and does not count mtime, mode, owner, or xattrs.

The implementation seam is the new module `lib/libraryImage.js`. All safety responsibilities belong here; the calling code in `sourceManager` is a thin adapter.

## Image format

A library image is a single `.tar.gz` produced by the system `tar` with `--no-mac-metadata --no-xattrs` (or the equivalent for non-Darwin) and the hardened flag allowlist (see [Export workflow](#export-workflow)). The archive has one logical structure:

```
library-image.json       ← manifest, must be the first entry of the archive
official/                ← bucket contents
github/
personal/
archived/
.skillcaddy/             ← registry sidecars
```

The archive root contains every byte the central library contains, with three deliberate exceptions:

- The producing machine's repository working files (e.g., project code, `collection-metadata/`) are not in the library image; they are recovered by `git clone` on the receiving machine.
- Project-level enablements are not in the library image; they are recreated after import.
- `node_modules`, build outputs, and any other producer-side artifacts are not in the library image.

### Manifest schema

`library-image.json` is the manifest. It is the first archive entry by path. It uses `schemaVersion: 1`. Its fields are:

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | integer `1` | Bumped only on a breaking schema change. |
| `producer` | object | `{ commit, branch, dirty, pushed }` from `git rev-parse HEAD`, `git symbolic-ref HEAD`, `git status --porcelain`, and `git log @{u}.. --oneline`. |
| `sources` | array | One entry per registered source: `{ sourceId, installPath }`. No per-source bytes; no per-source sha256 for Git sources (their nested `.git` makes directory sha256 unstable). |
| `enablement` | array | One entry per carried enablement: `{ scope: 'global' \| 'hermes', libraryPath, alias }`. Project-level enablements are absent by design. |
| `declarations` | object | "No X" self-declarations for every pre-flight rejection class (see [Rejection / diagnostic / silent classification](#rejection--diagnostic--silent-classification)). The importer re-verifies each one against the archive; declarations are honesty guarantees, not trust. |
| `gitSourceMode` | object | `{ mode: 'rev-parse-head-only', noIntegrityBaseline: true }`. Documented so the importer does not look for a directory integrity hash. |

The manifest records no absolute path. `producer.commit`, `producer.branch`, etc. are relative strings. `installPath` is already relative by ADR 0001.

## Export workflow

Export has six preflight checks plus one post-pack drift gate. Any failure is a hard stop with `SourceAcquisitionError('source-safety', message)` (or `'export-blocked'`, see CLI section for error categories); the archive is never produced.

The six preflight checks run in this order:

1. **`.skillcaddy-installing` marker**: any source bearing the marker is silently invisible to `readSourceRecords`; export must reject rather than skip, otherwise the source disappears from the image.
2. **`.skillcaddy/staging/` residue**: any leftover staging directory under `.skillcaddy/` indicates an interrupted transaction; reject with a recovery pointer.
3. **Unregistered directories inside buckets**: any directory under `official/`, `github/`, `personal/`, `archived/` with no matching registry record is rejected. Buckets are not free-form drop zones.
4. **Missing registered directories**: any record whose `installPath` does not exist on disk is rejected.
5. **Drift in registered integrity**: for non-Git sources whose current `checksumDirectory` differs from the registered `integrity` baseline, reject. (Git sources are exempt: they are not byte-stable.)
6. **Repository state**: uncommitted changes (`git status --porcelain` non-empty) and unpushed commits (`git log @{u}.. --oneline` non-empty) are rejected, not warned. The producing machine must be in a publishable state.

Two diagnostics run alongside:

- **In-library dead symlinks**: each is reported and recorded but not removed. The archive keeps the bytes.
- **Repository dirty at post-pack**: the post-pack drift gate re-reads the library after packing. Any change to source bytes between preflight and post-pack deletes the produced archive and exits non-zero.

A seventh post-pack check verifies that `archiveBytes(tar) == archiveBytes(sha256-of-pack)` for the produced `.tar.gz`. This is the "drift gate" referenced in the ticket.

Tar command for the registry:

```
tar --no-mac-metadata --no-xattrs \
    --no-acls --no-xattrs --no-same-permissions --no-same-owner \
    --no-selinux --no-overwrite-dir --delay-directory-restore \
    -czf <image.tar.gz> \
    -C <library-root> .
```

The packing root is `<library-root>`, so the archive root is the bucket-and-sidecar layout above. The manifest is written into the staging dir before `tar` runs, so it lands as the first entry by virtue of being the first directory entry tar encounters.

The archive is created with `0600`. The producer prints the absolute path on success and exits 0.

## Import workflow

Import is a three-phase transaction. Any failure aborts the entire transaction; the receiving machine's library state is unchanged.

### Phase 1 — Unpack and verify outside the library

1. Open the archive with `tar` and the hardened flag allowlist (no `-P` ever).
2. Stream-parse every entry header through pre-flight (Decision 6 of ADR 0011). Reject on any failure.
3. Unpack into `.skillcaddy/staging/` (must be on the same filesystem as the library root; `rename` requires it).
4. Run the post-flight checks: every inode in staging must be `file` or `directory`; every `realpath` must lie under the staging root; every hardlink's `nlink` must equal 1 (or its `linkPath` must lie inside staging).
5. Run `checksumDirectory` on each staged source and compare against the manifest's per-source entries. Any mismatch is a hard failure.
6. For Git sources, `cd <staged>/<source>; git rev-parse HEAD` and compare against the manifest's git record. (Manifest will carry this as part of `declarations.gitSourceMode.headRecords[].`)

If Phase 1 fails, the staging dir is recursively removed and the operation exits non-zero. The library is untouched.

### Phase 2 — Per-source submission

For each registered source in the manifest, in dependency-safe order (sources with no dependents first):

1. If the source does not exist on the receiver: run the acquisition adapter against the staged copy. This becomes the fifth acquisition input type, alongside Git, Archive, Remote file, Local directory. Result: source exists with the manifest's `sourceId` and `installPath`.
2. If the source exists and is byte-identical (same `checksumDirectory`): skip silently.
3. If the source exists and differs: reject the entire import. No partial commit. The staging dir is preserved for debugging; the library is untouched.

Sidecar (`.skillcaddy/sources/<id>.json`) collisions: receiver's sidecar wins. The manifest's sidecar is logged as a not-applied record. This rule preserves the receiver's autonomy on previously modified sidecars.

After all sources are submitted, run `updateSkillMetadata` (which `assertDirectory`-requires the source dir to be in place) for each.

A failure in Phase 2 stops at the failing source, preserves the staging dir, and reports three lists: committed, uncommitted, unattempted. The user re-runs the same command to resume from the unattempted list.

### Phase 3 — Enablement and sidecars

Once all sources are submitted:

1. For each manifest enablement triple, run the symlink reconstruction plan (next section).
2. Write the manifest's repository `producer` field into `.skillcaddy/library-image-import.json` as a provenance breadcrumb. This is not a registry field; it is metadata.

If Phase 3 fails partially, the partial state stays (committed sources are kept); the user re-runs to retry enablement.

## Rejection / diagnostic / silent classification

Every entry-level and metadata-level deviation has one of three classifications. The classification drives both pre-flight behavior and report reporting.

### Reject

Pre-flight fails the entire import (or export). The user must fix and retry.

- Absolute path entries
- `..` traversal (any flavor)
- FIFO, char device, socket, block device
- Contiguous type `7`
- Entries hidden after end-of-archive marker
- Symlink-first escape via pre-existing symlinks in staging
- Hardlinks pointing outside the library
- `setuid` / `setgid` / `1777` mode bits

### Diagnose

Recorded in the import report. Does not block import.

- uid / gid drift
- mtime drift
- nlink differences
- Mode ordinary-bit differences (e.g., 755 vs 0644)
- xattr differences (macOS-only `com.apple.*` keys)
- In-library dead symlinks
- The macOS local roundtrip NFC → NFD artifact (`café.md`)

### Silent

Not reported. No check, no record.

- Internal archive metadata (PAX extensions, GNU extended headers)
- Manifest's own `declarations` keys that match the archive's actual contents

## Symlink reconstruction

The carrier is `{ scope, libraryPath, alias }` triples. The reconstruction runs after all sources are submitted, so `updateSkillMetadata` has its directories.

For each triple:

1. Compute `target = ${HOME}/<scope-specific-root>/<alias>` (or the Hermes-specific layout).
2. Decide `disposition`:
   - `create` — target does not exist; create the symlink.
   - `unchanged` — target exists, is a symlink, points to `libraryPath`, has the right scope.
   - `conflict` — target exists, points elsewhere:
     - `other-target` if it is a symlink with a different target;
     - `not-a-symlink` if it is a regular file or directory.
   - `unsatisfiable` — `libraryPath` is no longer present in the library.
   - `ineligible` — the source is no longer Hermes-eligible (e.g., user has retired the source).
3. Apply only `create` and `unchanged`. The other three dispositions are reported and skipped; the manifest never rewrites the receiver's filesystem.

The plan covers only what the manifest claims; existing receiver-side links that the manifest does not claim are not visited, not touched, not reported. Reconstruction is a fill-in, not a sync.

Alias collisions: never auto-rename. The receiver decides.

Stale handling:

- If `$HOME` has changed since export, the plan is recomputed at apply time. A triple whose `target` would land outside the receiver's current `$HOME` is rejected for that triple (not the whole plan) with `unsatisfiable`.
- If a scope directory has changed identity (e.g., from `~/.hermes/skills/` to a new path), the entire plan is rejected — that's a different machine layout, not drift.

Hermes eligibility is unchanged; `HERMES_ELIGIBLE_SOURCES` stays closed.

## CLI surface

Subcommand: `npm run source -- image <export|import> <path>`.

### `image export <path>`

Required argument: `<path>` is the destination `.tar.gz` path. No overwrite; if the file exists, exit 1 with `export-blocked`.

Behavior:

- Runs the six preflight checks and the post-pack drift gate.
- Writes the archive atomically with `0600`.
- Reports per-check status on stderr.
- Prints the absolute archive path on stdout.

Exit codes:

- `0` — archive produced.
- `1` — `export-blocked` (one of the seven checks failed). The error message names the failing check and points at the recovery action.
- `2` — argument error.
- `3` — filesystem error (out of space, permission denied).
- `4` — reserved for future breaking-replacement authorization (currently unused).

### `image import <path>`

Required argument: `<path>` is the source `.tar.gz` path. Optional flags:

- `--dry-run` — produce the import plan and the per-source submit report, do not commit.
- `--yes` — skip the confirm prompt.

Behavior:

- Phase 1: unpack + verify outside the library. On failure, exit 1 and remove staging.
- Phase 2: per-source submit. On failure, exit 1 with three lists (committed, uncommitted, unattempted). Staging is preserved for debugging.
- Phase 3: enablement + sidecar breadcrumb.

Exit codes:

- `0` — import complete.
- `1` — `source-safety` (pre-flight failed) or `source-validation` (per-source sha256 mismatch) or `collision` (existing source differs).
- `2` — argument error.
- `3` — filesystem error.
- `4` — reserved for breaking-replacement authorization (currently unused).

### Error shapes

All export / import errors are `SourceAcquisitionError` instances with the existing categories. New categories:

- `export-blocked` — one of the seven export checks failed.
- `image-preflight-failed` — Phase 1 pre-flight found a reject-class entry.
- `image-staging-verify-failed` — Phase 1 post-flight found a realpath or inode-type violation.
- `image-source-mismatch` — Phase 2 found an existing source with different bytes.

Recovery pointers go in the message body; no new fields.

### Reporting

Both commands print a structured human-readable report on stderr:

- Each preflight check: pass / fail / warn.
- Each Phase 1 verdict.
- Each source's per-source disposition in Phase 2.
- Each enablement's `disposition` from the symlink reconstruction.

JSON output is out of scope for this release.

## Acceptance checklist

The first release ships when all of the following are true.

### Export

- [ ] Six preflight checks each have a positive test (clean library) and a negative test (each check fails in a known way).
- [ ] `.skillcaddy-installing` marker triggers reject, not skip.
- [ ] `.skillcaddy/staging/` residue triggers reject with recovery pointer.
- [ ] Unregistered bucket directory triggers reject.
- [ ] Missing registered directory triggers reject.
- [ ] Non-Git integrity drift triggers reject.
- [ ] Git sources exempt from integrity drift check (no spurious reject).
- [ ] Dirty working tree triggers reject.
- [ ] Unpushed commits trigger reject.
- [ ] Post-pack drift gate deletes the archive on drift.
- [ ] Archive is `0600` on disk.
- [ ] No overwrite of an existing archive path.
- [ ] Manifest is the first archive entry.
- [ ] Manifest's `schemaVersion` is `1`.
- [ ] Manifest contains every registered source's `{ sourceId, installPath }`.
- [ ] Manifest contains the user-level enablement triples (currently 13 known, but iterate at runtime).
- [ ] Manifest contains producer `{ commit, branch, dirty, pushed }`.
- [ ] Manifest's `declarations` enumerate every reject-class item.
- [ ] Manifest's `gitSourceMode.noIntegrityBaseline` is `true`.

### Import

- [ ] Pre-flight rejects every reject-class item from a 17-fixture suite (the #33 research fixtures).
- [ ] Hardened flag set is applied for GNU tar; the three GNU-only flags are passed; `--absolute-names` is never passed (test asserts absence).
- [ ] `--absolute-names` enabled in the test harness produces a refused archive, not an `/etc` write.
- [ ] Empty-staging invariant is in force; pre-existing symlinks in staging cannot enable symlink-first escape.
- [ ] `checksumDirectory` matches per-source on Phase 1 success.
- [ ] `git rev-parse HEAD` matches per Git source.
- [ ] On Phase 1 failure: staging removed, library unchanged.
- [ ] On Phase 2 per-source failure: three lists printed (committed, uncommitted, unattempted); staging preserved; library partial state matches the committed list.
- [ ] On Phase 2 success: all sources present with manifest's `sourceId` and `installPath`.
- [ ] Sidecar collision keeps receiver's sidecar; manifest's sidecar logged.
- [ ] Symlink reconstruction runs only `create` / `unchanged` dispositions; the other three are reported.
- [ ] Alias collision never auto-renames.
- [ ] `$HOME` recomputed at apply time; stale triple reported `unsatisfiable`, plan continues.
- [ ] Scope directory change rejects the entire plan (different machine layout).
- [ ] Herme eligibility boundary unchanged; `HERMES_ELIGIBLE_SOURCES` not modified.
- [ ] `skillcaddy-manager` enablements not carried; not recreated.

### Cross-platform

- [ ] `macos-source` checksum equals `linux-{plain,hardened}` checksum under `checksumDirectory`.
- [ ] Hardened flag set does not introduce entry-level drift relative to plain extraction.
- [ ] `macos-roundtrip` deviation is documented in `docs/research/0034-fidelity/` (already shipped via #34).

### Operational

- [ ] CLI subcommands are `image export` and `image import`.
- [ ] Exit codes are 0 / 1 / 2 / 3 / 4 across both subcommands.
- [ ] Errors are `SourceAcquisitionError` with categories: `export-blocked`, `image-preflight-failed`, `image-staging-verify-failed`, `image-source-mismatch`, plus the existing categories.
- [ ] No Web UI entry point for export or import.
- [ ] No TUI entry point for export or import.
- [ ] No global `skillcaddy` executable.
- [ ] No JSON output for either subcommand.

## Stop conditions

The first release is gated on:

1. All [Acceptance checklist](#acceptance-checklist) items passing on macOS (Darwin, bsdtar) and Linux (Debian 13 / Ubuntu 24.04, GNU tar 1.35).
2. The `0034-fidelity` measurement remaining green against this spec's "Cross-platform" section. Any drift in cross-platform checksum is a hard block.
3. The `0033-safe-library-image-unpacking` research's 17 adversarial fixtures all triggering the matching reject-class behavior.

No export / import operation ships before all three hold.