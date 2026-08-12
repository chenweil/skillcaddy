---
status: accepted
---

# Support explicit project and global skill enablement

Skillcaddy will support two explicit enablement scopes: project enablement for one project and global enablement for the user's shared Agent environment. Global enablement writes only the shared `.agents/skills` directory; it does not create a global Claude Code mirror. Project and global links may coexist, with project links taking precedence when an Agent applies both. Every mutation fails closed on unmanaged entries or alias conflicts, and global cleanup may remove only links whose targets can be proven to belong to the current Skillcaddy source root.

CLI, TUI, Web, and the shared API will expose the same scope contract. Collection enablement accepts either scope and reports each candidate independently; setup readiness remains project-scoped and global enablement never runs or requires project setup. Source upgrades inspect global links in addition to the explicitly supplied current project, block breaking replacements through the existing `--allow-breaking` authorization, and leave authorized-but-affected links in place as reported broken links rather than guessing a replacement.

## Consequences

- The global state is the shared Agent directory only; global Claude Code content is outside this enablement scope.
- Global operations do not require a project path, while project operations continue to require one and never infer a global mutation from a missing path.
- Existing global links from another source root remain visible but are read-only conflicts; a matching target is an unchanged result.
- Symlink creation remains the only enablement representation. Permission or platform failures are reported rather than converted into copies or another link type.
