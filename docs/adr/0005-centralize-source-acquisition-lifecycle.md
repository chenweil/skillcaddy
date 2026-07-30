---
status: accepted
---

# Centralize Source acquisition behind one lifecycle

Skillcaddy will route every single Source acquisition through one deep lifecycle module behind the existing `sourceManager` seam. The lifecycle owns plan retention, re-planning, stale-plan enforcement, installed-state and destination collision checks, publication rollback, result projection, and workspace cleanup. Internal preparation adapters retain only source-specific input parsing, identity selection, content inspection and preparation, Source registry projection, and active-content verification.

## Consequences

- Public `sourceManager` functions, plans, results, errors, and CLI behavior remain compatible.
- Every apply re-inspects the request and re-prepares its content; caller mutation cannot rewrite the facts captured by the original plan.
- Local input, Remote Archive, Remote file, and Git acquisition share one publication path and one collision policy.
- The adapter seam remains internal and guarded by import rules; behavior tests exercise acquisition through `sourceManager`.
- Lifecycle invariants are covered once in the acquisition contract tests; source-specific tests remain responsible for adapter parsing, identity, transport, safety, and one re-planning conformance case per source type.
- Source acquisition remains separate from enablement and never executes source-provided setup code.
- Git repository focus and Remote file URL constraints remain owned by their source-specific adapters.
- The lifecycle reserves `.skillcaddy-installing` for publication state and rejects source content that already contains that marker.
