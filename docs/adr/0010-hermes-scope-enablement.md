---
status: accepted
---

# Support independent Hermes skill enablement

Skillcaddy adds a third explicit enablement scope, `hermes`, which creates a direct symlink to an eligible acquired skill under the fixed `~/.hermes/skills/` directory. Hermes enablement is independent of project `.agents/skills`, global `~/.agents/skills`, and project Claude Code synchronization: project/global commands never imply Hermes changes, and disabling one scope never removes another scope's link.

`official`, `github`, and `personal` sources are Hermes-eligible; bundled repository skills and `archived` sources remain outside this scope. Hermes does not follow `HERMES_HOME`, and no configuration preset automatically changes project or global behavior.

Hermes mutations remain symlink-only and fail closed on ordinary entries, conflicting links, or links whose targets cannot be proven to belong to the current Skillcaddy source root. A same-target link is unchanged. Source upgrade and Git registry-repair planning inspect Hermes links alongside project and global links, so an affected Hermes link requires the existing breaking-change authorization.

The shared state adds a `hermes` projection while retaining `enabled`, `global`, and `claude` for compatibility. Collection enablement, Manager workflows, CLI, TUI, Web, and the API use the same explicit scope contract; project setup guidance applies only to project enablement.
