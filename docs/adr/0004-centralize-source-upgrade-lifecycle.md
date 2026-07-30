---
status: accepted
---

# Centralize source upgrades behind one lifecycle

Skillcaddy will route every single Source upgrade through one deep lifecycle module behind the existing `sourceManager` seam. The module owns planning, re-planning, stale-plan enforcement, skill-change and current-project-link impact, Source registry and result projection, explicit commit phases, rollback, and cleanup; internal preparation adapters only inspect and prepare Local input, Remote Archive, Remote file, or Git candidates, while directory replacement and Git fast-forward remain distinct publication implementations.

## Consequences

- Public `sourceManager` functions, plans, results, errors, and CLI behavior remain compatible.
- A process-local plan remains replayable, but every apply creates a fresh execution, re-plans, and re-prepares; the original plan fingerprint prevents caller mutation from bypassing stale-plan checks.
- The adapter seam remains internal, and behavior tests continue through `sourceManager`.
- Git batch update remains a separate workflow that invokes the single-source lifecycle.
- Migration proceeds one path at a time: Local input, Remote Archive, Remote file, then Git, with no runtime feature flag or dual execution for a migrated path.
