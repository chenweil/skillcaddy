# Library Synchronization Spec

## Outcome

Add a safe, explicit command-driven layer that keeps two Skillcaddy central libraries aligned over time through a Git remote. This is the "持续同步" half of the library-image portability story from ADR-0011: the image pair moves a whole library once, `sync` keeps it in step across devices.

The first release provides:

```bash
npm run source -- sync status [--repo <owner/name|git-url>]
npm run source -- sync push [--repo <owner/name|git-url>] [--yes]
npm run source -- sync pull [--repo <owner/name|git-url>] [--yes]
```

Sync reuses the ADR-0011 acquisition/validation path byte-for-byte and adds a **merge layer** that decides per source what to move. The merge unit is a source, not a byte diff and not a whole-library archive. Git sources compare HEAD commits by ancestor relationship; non-Git sources compare their registered integrity checksum. Project-level enablements and the `skillcaddy-manager` / bundled `skills/` bucket stay out of sync, matching ADR-0011 Decision 4.

This release is CLI-only (`status` / `push` / `pull`). Web UI, TUI, and JSON output are out of scope.

## Decisions (from issue #41)

- **Remote**: accept any HTTPS or SSH Git URL. `--repo owner/name` resolves to `https://github.com/owner/name.git`; the default is `github.com/<current user>/skillcaddy-library` resolved through `gh auth`. The remote repository is never auto-created.
- **Snapshots**: every successful push/pull first writes `snapshots/<timestamp>/` into the remote, keeping the latest 10 by default (cleanup deletes the oldest).
- **Conflict display**: CLI-only text reports. The conflict version is preserved under `archived/` and the report names the source, conflict type, archived path, and manual action.

## Non-goals

The first release does not:

- run real-time or background sync (no daemon, no system timers);
- move project-level enablements (ADR-0011 Decision 4);
- move `skillcaddy-manager` or the bundled `skills/` bucket (they ship with the program);
- invent a new archive format (sync reuses ADR-0011 payload handling);
- auto-create the remote repository;
- execute or run any fetched source content;
- expose Web/TUI/JSON surfaces;
- replace a source in a non-fast-forward direction.

## Remote layout

A sync remote is a plain Git repository:

```text
<remote>/
├── manifest.json          # per-source state: type, git HEAD | integrity checksum, installPath, enablement
├── sources/<sourceId>.tar.gz  # per-source payload (Git sources carry their nested .git)
└── snapshots/<timestamp>/     # copy of manifest + payloads before each change, for rollback
```

`manifest.json` is the only merge-deciding input. It uses `schemaVersion: 1` and is validated on read; an absent or empty manifest means an empty remote. Per-source `state` is either `{ kind: 'git', value: <head> }` or `{ kind: 'checksum', value: <sha256> }`. `enablement` carries `{ scope: 'global' | 'hermes', libraryPath, alias }` triples; project enablements are absent by design.

## Merge rules

| Situation | Behavior |
|---|---|
| Only one side has the source | No conflict; push publishes it, pull installs it. |
| Both sides equal | No-op. |
| Git source, one side is an ancestor of the other | Fast-forward to the newer side. |
| Git source, divergent | Does not block sync; the remote divergent copy is archived under `archived/` and named in the report. |
| Non-Git source, checksums differ | Does not block sync; the remote copy is archived under `archived/` and named in the report for a human decision. |
| Dirty Git working tree | `local-dirty` is reported and left untouched (commit or clean it first). |

"Conflict does not block" is deliberate: when two devices hold differing versions of the same source, the correct default is that **neither side is lost** — the later sync does not overwrite the earlier one.

`push` moves `local-only` and `local-ahead` sources. `pull` installs `remote-only` and `remote-ahead` sources. On conflict (including `local-dirty`), the remote candidate is unpacked into `archived/` and the report points at it.

## Safety boundary

Sync only moves bytes; it never executes fetched content. The same acquisition guards apply on the receiving side:

- A payload whose integrity baseline does not match is rejected for that source; other sources continue (ADR-0011 partial-submission semantics).
- Git source replacement goes through the fast-forward-only path; a non-fast-forward update is rejected.
- The archive is unpacked through the same hardened staging as a library image, with a bounded generic-archive link/entry validator (`extractGzipLibraryArchive` in `lib/libraryImage.js`).
- Credentials never enter the remote or any file outside the library. Authentication comes from `gh auth token` or the `SKILLCADDY_SYNC_TOKEN` environment variable, and when neither is available the command fails with a nonzero category and an actionable hint — no silent fallback.

## CLI surface and exit categories

- `sync status` — read-only difference report.
- `sync push [--yes]` — preview the report, then apply on confirmation (or with `--yes`).
- `sync pull [--yes]` — preview the report, then apply on confirmation (or with `--yes`).
- `--repo owner/name|git-url` — override the default `github.com/<user>/skillcaddy-library`.

Exit categories are stable: `0` success or identical no-op, `1` sync/general failure, `2` invalid usage, `3` authentication-required. A Git remote error surfaces the remote detail; a missing repository reports a hint to create a private remote or finish authentication.

## Acceptance checklist

- [x] Two independent library roots simulate two devices: `push` then `pull` to a third, and the three sides agree on source bytes, registry records, and user-level enablement triples.
- [x] No source content is silently overwritten; divergent and checksum conflicts each have a clear report and a recoverable `archived/` copy.
- [x] Without authentication, `sync push` / `sync pull` return a nonzero exit code and an actionable hint and produce no remote write.
- [x] The merge algorithm (fast-forward / same / divergent / checksum conflict) is unit-tested against a local bare Git remote with no real network.
- [x] Network loss does not affect the rest of `skillcaddy`; a failed sync leaves no half-applied state (reusing existing staging cleanup).
- [x] Project-level enablements still stay out of sync (ADR-0011 Decision 4).