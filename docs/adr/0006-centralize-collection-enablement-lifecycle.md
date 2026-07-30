---
status: accepted
---

# Centralize Collection enablement behind one lifecycle

Skillcaddy will route Collection enablement planning, project-link application, per-skill outcome classification, and post-execution setup reminder refresh through one deep module shared by Web and TUI. Adapters retain user confirmation and presentation only; partial link failures remain reportable without rolling back successful links, and setup readiness remains non-blocking guidance that never authorizes execution of source-provided setup code.

## Consequences

- Web and TUI use the same target selection, result categories, and reminder refresh behavior.
- Every candidate is reported as enabled, unchanged, skipped, or failed.
- Setup skills may be enabled as project links when the shared plan includes them, but Collection enablement never runs those skills.
- The lifecycle rescans project state after link application so adapters present current setup reminders rather than pre-execution assumptions.
