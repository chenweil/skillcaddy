---
status: accepted
---

# Self-contained library image portability

The central library is currently tied to the machine on which it was created. Operators need to relocate a working library to another machine (including a fully offline server) and resume normal management there: discovery, upgrade, enablement. A single self-contained `.tar.gz` carries the entire library state so the receiving machine becomes equivalent rather than a partial copy.

This ADR consolidates the library image portability map into one decision record. Each numbered Decision corresponds to a closed wayfinder ticket; cross-references inline. Companion documents: [`CONTEXT.md`](../../CONTEXT.md) (glossary), [`docs/LIBRARY_IMAGE_SPEC.md`](../LIBRARY_IMAGE_SPEC.md) (implementation contract).

## Context

The central library is the single user-visible artifact. As of this ADR the following facts bound the design:

- The registry is already machine-independent: 40 records, all `installPath` relative, no absolute paths in any sidecar field, no `/Users/` leaks under `.skillcaddy/`. ADR 0001's promise holds.
- 12 sources are upstream-less: 11 `legacy-local` (`origin: { kind: 'unknown' }`, only sha256) plus 1 `local` (only a staging-dir name). Their bytes exist only on the producing laptop; any manifest-based scheme necessarily loses them.
- Three leaks of absolute paths live outside the library: `.agents/skills/`, `~/.agents/skills/`, `~/.hermes/skills/`. `~/.hermes/skills/` already contains 2 dead links pointing at the old library name `AISkills`.
- 33 project-level enablements exist as live symlinks in projects not under version control; they have no portable carrier.
- 2 Git sources have non-empty `git status --porcelain` while their content is healthy.
- The CLI surface today is `source add` / `update` / `inspect` / `list` / `migrate`; export and import are new subcommands and do not enter the Web UI.

## Decision 1 — Single `.tar.gz` plus manifest

The library image is one `.tar.gz` plus a `library-image.json` manifest at the archive root as the first entry. The manifest declares:

- `sourceId` and `installPath` enumeration. The manifest does not carry per-source bytes; they live in the archive.
- `commit`, `branch`, `dirty`, `pushed` for the producing repository, so the importer can warn on drift.
- "No X" self-declarations for each pre-flight rejection class (Decision 6).
- A declaration that Git sources rely on `rev-parse HEAD` rather than directory integrity.
- `schemaVersion: 1`.

The manifest is the contract surface for Decision 6's pre-flight assertions. The importer treats manifest declarations as honesty guarantees: it re-verifies every declaration against the actual archive, so a forged manifest cannot bypass pre-flight.

_Avoid_: separate byte carrier + remote manifest (drift window), zip-on-zip, dual-layer packaging, manifest containing per-source sha256 for Git sources (their `.git` makes directory sha256 unstable).

Cross-references: #24 (manifest fields).

## Decision 2 — Carry complete `.git`, symlinks, and mode

The archive carries:

- All 27 nested `.git` directories as full repository state.
- Library-internal relative symlinks including their targets.
- File mode bits including the executable bit.

Rationale:

- The 543MB vs 198MB difference buys offline operability: stripped `.git` requires a successful clone to recover pull, which is the operation that fails on the disconnected server.
- The five known symlinks live inside Git sources, which carry no `integrity` field; their targets are not part of any checksum, so preserving the symlink itself (not the target path) is the correct contract.
- `--no-same-permissions` drops setuid/setgid and applies umask; for skill sources whose modes are `644`, `640`, `755`, umask 022 is a no-op.

Cross-references: #25 (tar fidelity), #26 (`.git` portability).

## Decision 3 — Reuse the acquisition lifecycle for import

Import is a new image acquisition adapter. It does not open a privileged "overwrite everything" path. Each source submission goes through the existing acquisition / upgrade machinery, so:

- Per-source sha256 strict validation reuses `checksumDirectory`.
- Sidecar-conflict semantics reuse the existing "server side wins" rule.
- The collision / breaking replacement rules apply unchanged.

Git sources have no reusable upgrade path (no `integrity` field, only `HEAD`), so import of an existing Git source does not run upgrade; it runs acquisition, which is fully idempotent when the existing source is identical and rejects when it differs.

Cross-references: #28 (import lifecycle, three-phase transaction).

## Decision 4 — Carry global and Hermes enablement; not project-level

The archive carries the user-level enablement records expressed as `{ scope, libraryPath, alias }` triples. Project-level enablements are not carried.

- Global (Agent) and Hermes enablements are user-level and have no other carrier; carrying them lets the receiving machine boot into a usable state.
- Project-level enablements live as live symlinks in projects not under version control. They have no portable carrier and are recreated on the receiving machine.
- `skillcaddy-manager` is a manager concern, not an enablement, and is excluded from the carrier.
- Hermes eligibility violations are classified `ineligible` and not relaxed; `HERMES_ELIGIBLE_SOURCES` stays closed.

The 13 currently-known user-level records are an illustration, not a fixed count. The carrier iterates over the actual registry at export time.

Cross-references: #29 (enablement reconstruction, 5 dispositions).

## Decision 5 — Carry bytes, not just a manifest

The archive carries the source bytes themselves, not a lockfile or rebuild list. 12 upstream-less sources make any manifest-only scheme lossy. The cost is the 543MB / 198MB trade, accepted under Decision 2.

Upstream-less sources retain their type, origin, and bytes across the migration. Sources that already have an upstream continue to update normally. The library image is not an upgrade path for upstream-less sources; if the operator wants to attach provenance to one, that is a separate `source repair` action.

Cross-references: #27 (export refusal + warning), #32 (registry repair path).

## Decision 6 — Safe unpacking boundary

Import relies on the system `tar` binary; no Node-side tar dependency is added. The unpacking guarantee has three layers:

1. **Pre-flight** parses every header and rejects by type and field:
   - Absolute path entries (silent-stripped by tar; only the parser sees them).
   - `..` traversal in any form.
   - Special files (FIFO, char, socket, block device).
   - Contiguous type `7` (silently reinterpreted by tar; only the parser can refuse).
   - Entries hidden after end-of-archive.
   - Symlink-first escape via pre-existing symlinks in staging.
   - Hardlinks pointing outside the library.
   - `setuid` / `setgid` / `1777` mode bits.
2. **Hardened flag allowlist** for GNU tar:
   - Common: `--no-acls --no-xattrs --no-same-permissions --no-same-owner`.
   - GNU-only: `--no-selinux --no-overwrite-dir --delay-directory-restore`.
   - Forbidden: `--absolute-names` / `-P` (demonstrated to write `/etc` when enabled).
3. **Post-flight** verifies the staging root contains only safe inode types and that every `realpath` lies under the staging root.

The empty-staging invariant in `prepareStaging` is load-bearing: it closes the one confirmed escape (GNU tar writes through a pre-existing symlink) without any tar flag.

Cross-references: #33 (research, 17 adversarial fixtures), #35 (classification).

## Decision 7 — Cross-platform guarantee and known local artifact

The cross-platform guarantee is:

- `macos-source` checksum equals `linux-{plain,hardened}` checksum under `checksumDirectory`.
- The hardened flag set does not introduce entry-level drift relative to plain extraction; only mtime differs.

`macos-roundtrip` is **not** required to equal `macos-source`. The deviation is documented: bsdtar on macOS rewrites `café.md` from NFC to NFD on extract to APFS, which is a macOS filesystem convention, not a packing defect. The archive stores NFC bytes; the macOS local roundtrip preserves NFC in the archive but ends up with NFD on disk. Production path (export on macOS, import on Linux) is unaffected.

Diagnostic-only differences (uid, gid, mtime, nlink, mode ordinary bits, xattrs, in-library dead symlinks, the macOS NFD artifact) do not enter `checksumDirectory` and therefore do not block import.

Cross-references: #34 (fidelity measurement), #35.

## Consequences

- The first release cannot rebuild the library from a manifest alone. Operators migrating to a fully offline server must transfer the full `.tar.gz`.
- The 543MB archive is the new portability floor; per-source `.git` stripping is an explicit non-goal of the first release.
- Project-level enablements must be rebuilt on the receiving machine. This is a one-time per project action; the library image does not carry them.
- Web UI does not gain an export or import entry. Web's source management surface is intentionally limited; library image is the same.
- The first release exposes library image operations only through the repo-local CLI; no global `skillcaddy` command, no TUI surface, no JSON output.
- The library image has no built-in encryption, signing, upload, or transfer mechanism. Static encryption and transport security are the operator's responsibility; the archive is created with `0600`.
- Upstream-less sources remain upstream-less. The library image is a snapshot, not an upgrade path for sources without provenance.
- A failed pre-flight at export is a hard stop. A failed pre-flight at import aborts the entire transaction; the server's library state is unchanged.
- `source repair` continues to be the only path to attach provenance to an upstream-less source; it is independent of the library image.