---
status: accepted
---

# Repair registry state after an external Git fast-forward

Skillcaddy will provide an explicit source CLI repair operation for a
registered Git checkout that was advanced outside Skillcaddy, such as with
`git pull`. The operation adopts the current checkout into the sidecar source
registry; it does not perform source replacement and does not modify the
checkout.

The repair plan is valid only when the checkout is clean, on the registered
ref, uses the registered remote, is at the fetched remote ref, and has advanced
from the registered commit by fast-forward. The current source tree must pass
the normal validation and skill inventory checks. Current-project link impact
uses the same project path contract and breaking authorization as a normal Git
update. An explicit `--yes` applies the registry-only adoption, while
`--allow-breaking` is required when a known current-project link would be
removed or relocated.

Dirty checkouts remain untouched and produce a reminder. Batch update failures
include their stable category and message so a registry collision, transport
failure, or stale plan is actionable without inspecting internal logs.

## Consequences

- Manual `git pull` remains supported without weakening the normal update
  collision checks.
- Registry repair is auditable as a separate command and cannot silently turn
  an arbitrary local checkout into a registered source.
- Source acquisition and Web/TUI enablement boundaries remain unchanged; repair
  is available through the source-management CLI and public `sourceManager`
  seam only.
