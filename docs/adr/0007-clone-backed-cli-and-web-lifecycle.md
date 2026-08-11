---
status: accepted
---

# Expose a clone-backed CLI and local Web lifecycle

Skillcaddy will expose one clone-backed `skillcaddy` executable through the
existing `scripts/tui.js` entry. The entry keeps no-argument TUI behavior and
adds CLI commands for local Web lifecycle management, read-only project
analysis, and the existing safe registered-Git batch update. Global setup is
explicit and uses `npm link`; Skillcaddy is not published or downloaded as a
global npm package.

This decision supersedes the first-release exclusion of a global executable
and Web/TUI controls in ADR-0001. TUI now exposes acquisition-only remote
address entry for complete Git repositories, public HTTP(S) ZIP files, and
stable direct HTTP(S) `/SKILL.md` files through the `sourceManager` lifecycle.
TUI acquisition writes the central library only: it does not create project
links, run setup, or invoke runtime preflight. Web still does not expose source
acquisition, replacement, or removal; TUI source replacement and removal
remain out of scope. Source updates continue to route through the
`sourceManager` lifecycle.

## Consequences

- `start`, `stop`, and `restart` manage only the loopback Web process whose
  ownership can be verified; external processes are never replaced.
- `-a` uses a read-only state scan and does not create source directories,
  enable skills, or write metadata.
- `-u` requires an explicit current project context so a breaking source
  replacement cannot silently skip project-link protection. CLI callers use
  `--project` or the established `SKILLCADDY_PROJECT` environment variable.
- `--root` selects the central library for source and analysis operations;
  Web lifecycle commands use the clone that provides the executable.
- Platforms without a process-ownership probe fail closed for managed Web
  shutdown and restart until a platform-specific probe is provided.
