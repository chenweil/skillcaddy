---
status: accepted
---

# Manage skill acquisition through a source registry

Skillcaddy will acquire Git repositories, ZIP archives, and local content through one source-management path backed by `.skillcaddy/sources/`. Source identity is independent of the physical install path so existing checkouts and project links remain stable, while new sources gain sanitized provenance, integrity records, safe updates, and collision handling. Acquisition never enables skills or executes source code; enablement remains a separate project-level action.

## Consequences

- Existing source directories are adopted through an explicit dry-run migration and are never moved automatically.
- Git and Archive updates compare discovered skill paths and require explicit authorization before breaking a known project link.
- Archive replacement is staged and validated before the active copy changes; successful replacement retains no backup.
- The first release excludes automatic Archive version discovery, source removal, authenticated Archive storage, non-ZIP archives, Web/TUI controls, and a global executable.
