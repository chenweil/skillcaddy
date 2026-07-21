---
name: skillcaddy-manager
description: Manage Skillcaddy libraries and project skill links. Use for discovery, enable/disable, audits, maintenance, bootstrap, or Web/TUI access.
---

# Skillcaddy Manager

Treat Skillcaddy as a central skill library with project-level symlink activation. Keep one execution loop across every branch: **state -> route -> preflight -> act -> verify**.

## Core Loop

1. Resolve the Skillcaddy repository and target project. Default the project to the current working directory only when the user did not provide one.
   - Complete when both absolute paths are known.
2. For recommendations, audits, or mutations, read `GET /api/state?projectPath=<encoded-path>`. If the server is unavailable, inspect the equivalent paths listed under **Core Model**.
   - Complete when repository, project, global, Claude, metadata, and `advice` state relevant to the request are known.
3. Route to the required branch and load only its reference; load multiple references only when the request combines branches:
   - Discovery, enable/disable, audit, health, GitHub update, bootstrap, Web/TUI: [OPERATIONS.md](references/OPERATIONS.md)
   - Recommendations: [RECOMMENDATION_GUIDE.md](references/RECOMMENDATION_GUIDE.md)
   - Notes, tags, `autoEnable`, migration, batch Chinese notes: [METADATA.md](references/METADATA.md)
   - Complete when the selected branch, target identities, and completion criterion are explicit.
4. For a mutation, apply the **Mutation Gate** before acting. Prefer the existing API, TUI, or repository commands over ad hoc filesystem changes.
   - Complete when the preflight accounts for every affected item and all blocking ownership or alias issues are resolved.
5. Execute the narrowest requested operation, rescan state, and report the observed result.
   - Complete when the post-operation state proves every requested item succeeded, remained unchanged, was skipped, or failed with a stated reason.

## Core Model

| Scope | Location | Role |
|---|---|---|
| Bundled | `skills/<name>/` | Skills shipped by this repository |
| Central | `official/`, `github/`, `personal/`, `archived/` | Source libraries |
| Project | `<project>/.agents/skills/` | Codex-compatible activation symlinks |
| Project Claude | `<project>/.claude/skills/` | Claude compatibility symlinks |
| Global | `~/.agents/skills/`, `~/.claude/skills/` | User-level skills that may conflict or shadow |
| Collection setup | `collection-metadata/<source>/<collection>.json` | Tracked, read-only setup contract and readiness checks |

Preserve these invariants:

- Enable and disable operations create or remove project symlinks; source skill directories remain intact.
- `archived/` skills require an explicit user request.
- GitHub-backed source directories remain free of Skillcaddy metadata; write catalog metadata to the sidecar store.
- Collection activation and project readiness are separate: setup may be missing after links are enabled.
- Interactive setup is never executed silently; obtain confirmation and let the declared setup skill own project edits.
- Repository behavior in `lib/skillStore.js`, `lib/projectActions.js`, and `lib/claudeStore.js` is authoritative when documentation and implementation differ.
- The fixed default Web manager URL is `http://127.0.0.1:4173`.

## Mutation Gate

Before changing state, present a compact preflight containing:

| Action | Skill | Source/collection | Alias | Target path | Advice/result |
|---|---|---|---|---|---|

Account for skills that will be changed, left unchanged, skipped, or rejected. Include relevant `/api/state.advice` and metadata writes.

Require confirmation before proceeding when:

- one request matches multiple skills and the user has not selected one;
- a project alias points to a different target;
- the project entry is not a symlink or is externally managed;
- a GitHub source has uncommitted changes before update;
- the request reaches into `archived/` without naming the archived target;
- the request would delete a source skill rather than a project link;
- an advice item exposes a destructive or ownership ambiguity.
- an affected collection reports missing or partial interactive setup.

Surface informational duplicate-name and global-shadowing advice, but do not block solely on it. Use the full skill ID and a confirmed alias to resolve duplicates.

## Reporting

For summaries, distinguish repository availability, project enablement, global presence, Claude compatibility, and unmanaged or broken state. Prefer:

| Action | Skill | Source | Alias | Result | Notes |
|---|---|---|---|---|---|

End with the verification performed: rescan/API state, validation command, tests, or server URL.
