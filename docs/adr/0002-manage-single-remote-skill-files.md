---
status: accepted
---

# Manage single remote SKILL.md files as registered sources

Skillcaddy will support a `Remote file source` acquired from a stable HTTP(S) URL whose path ends in `/SKILL.md`. It is a distinct source type rather than a partial Git source: callers must provide `--name`, remote files install under `official/<name>/`, and the source registry retains the sanitized reusable URL plus SHA-256 integrity. `add` never overwrites an existing source; `update` re-downloads the registered URL, or an explicitly supplied replacement URL, and transactionally replaces the installed file only after validation succeeds.

## Consequences

- The first release acquires exactly one `SKILL.md`; it does not follow relative references or extract repository directories.
- Repository URLs, GitHub blob URLs, signed URLs, credential-bearing URLs, query-bearing URLs, and paths not ending in `/SKILL.md` are not Remote file inputs.
- Remote files have a default download limit of 1 MiB and reuse the existing redirect and timeout protections.
- Updates are explicit per source through `source update`; Remote files are not included in `update-git` and gain no batch updater in the first release.
- Skills requiring companion files continue to use a ZIP Archive, Local source, or complete Git source.
