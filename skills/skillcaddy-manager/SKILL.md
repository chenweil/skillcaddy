---
name: skillcaddy-manager
description: Manage Skillcaddy project skills. Use when Codex needs to list available skills from a Skillcaddy library, inspect project/global skills, explain loadable skills, enable or disable one skill or a whole source/collection, update GitHub-backed skills, initialize or audit a project skill setup, check health, detect unmanaged skills, broken links, duplicate names, global/project conflicts, or symlink boundary issues.
---

# Skillcaddy Manager

## Recommendations System

This skill includes a built-in recommendation system:

```
skills/skillcaddy-manager/
├── references/                 # Data and documentation
│   ├── featured-skills.json    # Recommended skills data + conflict config
│   ├── skill-platforms.json    # External skill platforms reference
│   └── RECOMMENDATION_GUIDE.md # Full recommendation strategy guide
└── scripts/                    # Utility scripts
    ├── view-recommendations.cjs
    ├── check-conflicts.cjs
    ├── check-global-skills.cjs
    └── version-manager.cjs
```

### When to Use Recommendations

1. **User asks for skill recommendations** → Read `/api/state` first, then read `references/featured-skills.json`
2. **User asks "推荐一些库"** → Start from `scripts/view-recommendations.cjs onboarding` unless the scenario is already clear
3. **Detecting potential conflicts** → Use `scripts/check-conflicts.cjs`
4. **Detecting global skills** → Use `scripts/check-global-skills.cjs`
5. **Checking version sync** → Use `scripts/version-manager.cjs check`

### Core Recommendation Principles

From `references/RECOMMENDATION_GUIDE.md`:

1. **Analyze first**: Inspect existing library, enabled skills, global skills, and current project before recommending
2. **Platform first**: When the library is empty or the scenario is unclear, recommend discovery platforms instead of a fixed starter library
3. **Scenario split**: Recommend mattpocock only for clear development scenarios; do not use it as the default for empty libraries
4. **Gap-based expansion**: When some skills already exist, recommend missing categories rather than another same-shape library
5. **Conflict detection**: mattpocock vs superpowers (choose one)

### Quick Commands

```bash
# View empty-library onboarding
node scripts/view-recommendations.cjs onboarding

# View core workflow recommendations
node scripts/view-recommendations.cjs workflows

# View scenario-based recommendations
node scripts/view-recommendations.cjs scenario new-project

# Detect conflicts
node scripts/check-conflicts.cjs superpowers

# Detect global skills
node scripts/check-global-skills.cjs

# Check version sync
node scripts/version-manager.cjs check
```

### Data Version

The `references/featured-skills.json` version syncs with Skillcaddy main project version. Current: **0.8.0**

### Recommendation Flow

When the user asks for recommendations, follow this order:

1. Read `/api/state?projectPath=...` and inspect:
   - whether the library is empty,
   - which skills are already enabled,
   - which skills exist globally,
   - tags / notes / source distribution,
   - advice such as duplicates or global conflicts.
2. Classify the situation:
   - **Empty library** → recommend discovery platforms first.
   - **Clear development signals** → recommend a development starter, usually `mattpocock-workflow` plus `lencx-control`.
   - **Existing mixed library** → recommend missing categories or quality-control gaps.
3. Keep recommendations to at most 3 items.
4. Explain why each recommendation matches the observed state.

## Core Model

Treat Skillcaddy as a central skill library plus per-project symlink manager.

- Repository-provided skills live under `skills/<skill-name>/`.
- Central sources live under `official/`, `github/`, `personal/`, and `archived/`.
- Project-enabled skills live under `<project>/.agents/skills/`.
- Claude Code compatibility entries live under `<project>/.claude/skills/`.
- Global Codex skills may live under `~/.agents/skills/`.
- Global Claude Code skills may live under `~/.claude/skills/`.
- Enabling or disabling a project skill must only create or remove project symlinks by default.
- Do not delete central skill files unless the user explicitly asks to remove or archive a source skill.
- Do not enable `archived/` skills unless the user explicitly names one.

Prefer the existing Skillcaddy implementation over ad hoc filesystem logic:

- Use `npm start` or `GET /api/state?projectPath=...` for UI/API inspection.
- Treat `http://127.0.0.1:4173` as the fixed default web manager URL.
- Treat `/api/state` as the preferred summary because it returns `skills`, `enabled`, `global`, `claude`, and `advice`.
- Use `POST /api/enable` and `POST /api/disable` when the server is already running.
- Use `POST /api/skill-metadata` or edit `<skill>/skillcaddy.json` when maintaining human-facing notes and tags.
- Use `lib/skillStore.js`, `lib/projectActions.js`, and `lib/claudeStore.js` behavior as the source of truth when editing code.
- Use `npm run pull:github` to update GitHub-backed skill repositories.

## Open Web Manager

When the user asks to open Skillcaddy for the current project:

1. Resolve the project path from the current working directory unless the user provides another path.
2. Start Skillcaddy from the Skillcaddy repository with `npm start`, or reuse an existing running server if the user already has one. This uses the fixed default port `4173`; use `PORT=<other-port> npm start` only when the port is occupied or the user explicitly asks for another port.
3. Open the web UI with the project path encoded in the URL:

```text
http://127.0.0.1:4173/?projectPath=<encoded-project-path>
```

The page reads `projectPath` from the URL, loads that project immediately, records it in browser history, and keeps the URL in sync with the active project.

If manually constructing the URL in shell, encode the path safely. For example:

```bash
node -e "console.log(encodeURIComponent(process.argv[1]))" "/path/to/project"
```

Do not invent a separate file picker workflow for this; pass the path through the URL unless the user specifically asks for a native picker.

## Skill Metadata

Treat `SKILL.md` as the agent-facing execution contract. Treat `skillcaddy.json` as Skillcaddy's human-facing catalog metadata.

Optional metadata file location:

```text
<skill-dir>/skillcaddy.json
```

Supported shape:

```json
{
  "note": "Short human-readable usage note.",
  "tags": ["Developer Tools", "Productivity"],
  "autoEnable": true
}
```

Use metadata this way:

1. Keep `note` short and user-facing. Explain what the skill helps with, not how the trigger matcher works.
2. Keep `tags` broad and reusable. Prefer product-style categories such as `Developer Tools`, `Productivity`, `Creativity`, `Research`, `Writing`, `Data`, `Design`, `Operations`, `Quality`, `Automation`, and `Workflow`.
3. Do not rewrite upstream `SKILL.md` only to improve Skillcaddy browsing.
4. When the user asks to classify, tag, annotate, or make skills easier to browse, update `skillcaddy.json`.
5. When auto-generating metadata, read the `SKILL.md` frontmatter and first useful body sections, then propose or write a concise `note` and 1-4 tags.
6. Use `autoEnable: false` for deprecated, abandoned, risky, heavyweight, or highly situational skills that should not be included by library-level one-click enable. Single-skill manual enable remains allowed.
7. Preserve existing tags and `autoEnable` unless they are clearly wrong or the user asks for a cleanup.
8. If a skill belongs to an external GitHub clone with local changes, show the changed metadata files before committing or pulling.

Use the existing API when possible:

```bash
curl -sS -X POST http://127.0.0.1:4173/api/skill-metadata \
  -H 'Content-Type: application/json' \
  -d '{"skillPath":"/path/to/skill","note":"Short note","tags":["Developer Tools"],"autoEnable":true}'
```

## Safety Rules

Before any operation that changes project state, produce a dry-run style summary:

- Project path that will be modified.
- Skills that will be enabled, disabled, updated, skipped, or left unchanged.
- Source, collection, name, alias, and path for each affected skill.
- Conflicts that require user confirmation.
- Existing `advice` from `/api/state`, especially unmanaged project entries, broken symlinks, duplicate names, and global/project alias conflicts.
- Metadata files that will be created or changed, including `note` and `tags`.

Stop and ask for confirmation when:

- More than one skill matches the user's requested name.
- A target alias already points to a different skill.
- The target project contains a non-symlink entry where a skill alias would be created or removed.
- A GitHub skill repository has uncommitted local changes.
- A request would touch `archived/` without explicitly naming archived skills.
- A request would delete central source files instead of project symlinks.
- `/api/state.advice` reports a warning for the alias being enabled, disabled, or initialized.

Warnings are advisory unless they affect deletion safety. Do not block purely informational duplicate-name or global-shadowing advice, but surface it before changing state.

## Query Skills

When the user asks what skills are available or loadable:

1. Resolve the project path. Use the current working directory unless the user provides a project path.
2. Scan repository skills from `skills/`.
3. Scan central sources: `official/`, `github/`, `personal`, and `archived/`.
4. Scan project-enabled skills: `<project>/.agents/skills/`.
5. Scan global skills: `~/.agents/skills/` and `~/.claude/skills/`.
6. Scan Claude entries if relevant: `<project>/.claude/skills/`.
7. Read `advice` from `/api/state` and present active warnings or recommendations.
8. Present results as available vs enabled vs global, grouped by source and collection.

For each skill, include:

- `source`: `local`, `official`, `github`, `personal`, or `archived`.
- `collection`: the source repository or top-level folder.
- `name`: skill folder name.
- `path`: absolute path.
- `description`: the `description:` value from `SKILL.md` when available.
- `note`: the human-facing `skillcaddy.json` note when available.
- `tags`: the human-facing `skillcaddy.json` tags when available.
- `autoEnable`: whether the skill participates in library-level one-click enable; defaults to `true`.
- `enabled alias`: project alias when already enabled.

When the user asks "agent 还有哪些 skill 可加载", answer from the repository and central sources, then mark which ones are already enabled in the current project, which ones exist globally, and which ones have advice.

## Advice And Conflict Checks

Use `state.advice` whenever available. It is Skillcaddy's project setup review surface.

Important advice types:

- `project-unmanaged-entry`: a non-symlink entry exists under `<project>/.agents/skills/`; do not delete it through Skillcaddy.
- `project-unmanaged-symlink`: a project skill symlink points outside Skillcaddy sources; treat it as externally managed.
- `project-broken-link`: a project skill symlink points to a missing target.
- `global-shadowed-by-project`: a project skill and global skill share the same alias; project-level loading may win depending on the agent.
- `global-alias-conflict`: enabling a source skill would create an alias already present globally.
- `library-duplicate-name`: multiple source skills share the same name; require source/collection disambiguation before enabling.

Use advice this way:

1. Before enabling a skill, check advice for the target alias and report relevant duplicate/global conflicts.
2. Before disabling a skill, check whether the project entry is a symlink and whether it is Skillcaddy-managed.
3. During project initialization, summarize all warning-level advice first, then informational duplicate/global advice.
4. For broken links, suggest cleanup or re-enable only after showing the missing target path.
5. For unmanaged entries, avoid automatic cleanup; ask the user whether they want to leave, move, or manually inspect them.

If `/api/state` is not available, reproduce the minimum check manually:

```text
<project>/.agents/skills       project skills
<project>/.claude/skills       project Claude entries
~/.agents/skills               global Codex skills
~/.claude/skills               global Claude Code skills
```

Compare aliases across project and global scopes. Treat same-alias entries as potential conflicts even when targets differ.

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
3. Read current project state and advice.
4. Decide the alias. Default to the skill folder name unless the user provides an alias.
5. Report global same-alias skill, duplicate source names, broken project links, or unmanaged project entries for that alias.
6. Confirm the target alias does not point to a different skill.
7. Create `<project>/.agents/skills/<alias>` as a directory symlink to the source skill path.
8. Sync Claude compatibility entries with the existing per-skill `.claude/skills/<alias>` symlink behavior.
9. Rescan and report the final enabled state plus remaining advice.

When enabling a source or collection:

1. Expand the request to the matching set of skills.
2. Skip archived skills by default.
3. Skip skills whose metadata has `autoEnable: false` unless the user explicitly names that skill or asks to include disabled-auto-enable skills.
4. Read advice and group it by affected alias.
5. Show the full list before changing anything, including aliases that conflict with project/global skills and skills skipped by `autoEnable: false`.
6. Enable each skill independently and report enabled, unchanged, skipped, failed, and advised items.

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
4. If the symlink target is outside Skillcaddy sources, report that it is unmanaged before removal.
5. Remove only the project symlink.
6. Remove or resync the matching Claude compatibility symlink when needed.
7. Rescan and report the final enabled state.

When disabling a source or collection:

1. Map each enabled symlink target back to a source path.
2. Select only aliases whose target path belongs to the requested source or collection.
3. Exclude non-symlink and unmanaged entries unless the user explicitly confirms a manual cleanup workflow.
4. Show the list before removal. In the Web UI, use the library-level `×` button when the user wants to clean a collection that was bulk-enabled by mistake.
5. Remove project `.agents/skills/<alias>` symlinks and the matching `.claude/skills/<alias>` compatibility entries for that collection.
6. Do not delete source skill directories.

## Initialize Or Audit Project Setup

When the user asks to initialize, prepare, audit, or review a project's skill setup:

1. Resolve the target project path.
2. Read `/api/state?projectPath=<project>`.
3. Summarize:
   - project `.agents/skills` entries,
   - project `.claude/skills` entries,
   - global `~/.agents/skills` and `~/.claude/skills` entries,
   - `advice` grouped by severity.
4. Recommend a minimal action:
   - leave existing unmanaged entries alone,
   - fix broken symlinks,
   - choose a source before enabling duplicate-name skills,
   - rename aliases when global/project conflicts are confusing,
   - sync Claude entries only after project `.agents/skills` looks correct.
5. Do not automatically enable, disable, rename, or clean anything during audit unless the user explicitly asks.

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
- Verify global skill aliases do not unintentionally duplicate project aliases.
- Verify unmanaged project entries are called out before enabling or cleanup.
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
- Present globally.
- Unmanaged or broken in the project.
- Advice requiring confirmation or attention.
- Loadable by Codex through `.agents/skills`.
- Loadable by Claude Code through `.claude/skills`.

End with the verification performed, such as a rescan, API state check, validation command, or server URL.
