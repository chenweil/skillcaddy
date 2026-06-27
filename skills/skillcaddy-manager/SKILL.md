---
name: skillcaddy-manager
description: Manage Skillcaddy project skills. Use when Codex needs to list available skills from a Skillcaddy library, inspect which skills are enabled in the current project, enable or disable one skill or a whole source/collection, update GitHub-backed skills, check skill health, detect symlink conflicts, or explain which skills an agent can load from this repository.
---

# Skillcaddy Manager

## Core Model

Treat Skillcaddy as a central skill library plus per-project symlink manager.

- Repository-provided skills live under `skills/<skill-name>/`.
- Central sources live under `official/`, `github/`, `personal/`, and `archived/`.
- Project-enabled skills live under `<project>/.agents/skills/`.
- Claude Code compatibility entries live under `<project>/.claude/skills/`.
- Enabling or disabling a project skill must only create or remove project symlinks by default.
- Do not delete central skill files unless the user explicitly asks to remove or archive a source skill.
- Do not enable `archived/` skills unless the user explicitly names one.

Prefer the existing Skillcaddy implementation over ad hoc filesystem logic:

- Use `npm start` or `GET /api/state?projectPath=...` for UI/API inspection.
- Use `POST /api/enable` and `POST /api/disable` when the server is already running.
- Use `lib/skillStore.js`, `lib/projectActions.js`, and `lib/claudeStore.js` behavior as the source of truth when editing code.
- Use `npm run pull:github` to update GitHub-backed skill repositories.

## Safety Rules

Before any operation that changes project state, produce a dry-run style summary:

- Project path that will be modified.
- Skills that will be enabled, disabled, updated, skipped, or left unchanged.
- Source, collection, name, alias, and path for each affected skill.
- Conflicts that require user confirmation.

Stop and ask for confirmation when:

- More than one skill matches the user's requested name.
- A target alias already points to a different skill.
- The target project contains a non-symlink entry where a skill alias would be created or removed.
- A GitHub skill repository has uncommitted local changes.
- A request would touch `archived/` without explicitly naming archived skills.
- A request would delete central source files instead of project symlinks.

## Query Skills

When the user asks what skills are available or loadable:

1. Resolve the project path. Use the current working directory unless the user provides a project path.
2. Scan repository skills from `skills/`.
3. Scan central sources: `official/`, `github/`, `personal`, and `archived/`.
4. Scan project-enabled skills: `<project>/.agents/skills/`.
5. Scan Claude entries if relevant: `<project>/.claude/skills/`.
6. Present results as available vs enabled, grouped by source and collection.

For each skill, include:

- `source`: `local`, `official`, `github`, `personal`, or `archived`.
- `collection`: the source repository or top-level folder.
- `name`: skill folder name.
- `path`: absolute path.
- `description`: the `description:` value from `SKILL.md` when available.
- `enabled alias`: project alias when already enabled.

When the user asks "agent 还有哪些 skill 可加载", answer from the repository and central sources, then mark which ones are already enabled in the current project.

## Search And Match

Resolve requested skills in this order:

1. Exact alias or skill name.
2. Exact `source/collection/name` or path-like input.
3. Exact collection name when the user says "某个库".
4. Fuzzy match against skill name, collection, source, and `SKILL.md` description.

If a request matches multiple skills, list candidates and do not choose silently. Include enough identity to disambiguate:

```text
source/collection/name
path
description
```

## Enable Skills

When enabling a single skill:

1. Match the requested skill.
2. Skip `archived/` unless explicitly requested.
3. Decide the alias. Default to the skill folder name unless the user provides an alias.
4. Confirm the target alias does not point to a different skill.
5. Create `<project>/.agents/skills/<alias>` as a directory symlink to the source skill path.
6. Sync Claude compatibility entries with the existing per-skill `.claude/skills/<alias>` symlink behavior.
7. Rescan and report the final enabled state.

When enabling a source or collection:

1. Expand the request to the matching set of skills.
2. Skip archived skills by default.
3. Show the full list before changing anything.
4. Enable each skill independently and report enabled, unchanged, skipped, and failed items.

Use the existing API when possible:

```bash
curl -sS -X POST http://127.0.0.1:4173/api/enable \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"/path/to/project","skillPath":"/path/to/skill","alias":"skill-name"}'
```

If the server is not running, either start it for user-facing testing or use the existing library behavior as the implementation guide.

## Disable Skills

When disabling a single skill:

1. Resolve the project path.
2. Match the enabled alias from `<project>/.agents/skills/`.
3. Refuse to remove non-symlink entries.
4. Remove only the project symlink.
5. Remove or resync the matching Claude compatibility symlink when needed.
6. Rescan and report the final enabled state.

When disabling a source or collection:

1. Map each enabled symlink target back to a source path.
2. Select only aliases whose target path belongs to the requested source or collection.
3. Show the list before removal.
4. Remove project symlinks only; do not delete source skill directories.

Use the existing API when possible:

```bash
curl -sS -X POST http://127.0.0.1:4173/api/disable \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"/path/to/project","alias":"skill-name"}'
```

## Update GitHub Skills

Use this workflow for GitHub-backed skills under `github/`:

1. Confirm the target is under `github/`.
2. Check each target repository for local changes.
3. Skip dirty repositories; do not stash, reset, or overwrite local edits.
4. Pull with fast-forward only.
5. Report pulled, up-to-date, dirty, no-git, and failed counts.

Prefer the repository script:

```bash
npm run pull:github
```

For a single GitHub collection, run the same safety checks manually inside that collection:

```bash
git status --short
git pull --ff-only
```

Network operations may require approval. If network access fails, report that the local state was not changed.

## Health Check

Use health checks before large changes and after suspicious results:

- Verify every repository or central skill directory has `SKILL.md`.
- Verify `SKILL.md` frontmatter has `name` and `description`.
- Verify enabled entries in `.agents/skills` are symlinks unless intentionally managed otherwise.
- Verify symlink targets still exist.
- Verify `.claude/skills` entries point back to `.agents/skills` for enabled skills.
- Flag duplicate names across sources or collections.
- Flag descriptions that are empty or not useful for discovery.

For a skill created or edited in this repository, run:

```bash
python3 /Users/chenweilong/.codex/skills/.system/skill-creator/scripts/quick_validate.py /path/to/skill
```

## Reporting Format

For summaries, prefer a compact table with:

| Action | Skill | Source | Alias | Result | Notes |
|---|---|---|---|---|---|

Always distinguish:

- Available in repository or central library.
- Enabled in the project.
- Loadable by Codex through `.agents/skills`.
- Loadable by Claude Code through `.claude/skills`.

End with the verification performed, such as a rescan, API state check, validation command, or server URL.
