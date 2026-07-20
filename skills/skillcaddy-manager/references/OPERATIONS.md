# Skillcaddy Operations

Use this reference for discovery, project links, audits, source updates, bootstrap, and Web/TUI access. Start from the core loop in `SKILL.md`.

## State and Identity

Prefer `GET /api/state?projectPath=<encoded-path>`. It returns `skills`, `enabled`, `global`, `claude`, and `advice` in one scan.

For each skill identity, retain:

- `source`, `collection`, `name`, and absolute `path`;
- `description`, human-facing `note`, `tags`, and `autoEnable`;
- project alias, global presence, Claude compatibility, and advice.

Match requests in this order:

1. exact enabled alias or skill name;
2. exact `source/collection/name` or path-like ID;
3. exact collection for a library-level request;
4. fuzzy name, collection, source, and description match.

When multiple results remain, show their full IDs, paths, and descriptions for user selection. Matching is complete only when one target or one explicitly requested collection remains.

## Advice

| Type | Meaning | Required handling |
|---|---|---|
| `project-unmanaged-entry` | Non-symlink under project skills | Leave intact; require explicit manual handling |
| `project-unmanaged-symlink` | Link points outside Skillcaddy sources | Report ownership before removal |
| `project-broken-link` | Target is missing | Show target; offer cleanup or re-enable |
| `global-shadowed-by-project` | Same alias exists globally and in project | Surface precedence risk |
| `global-alias-conflict` | Candidate alias exists globally | Surface before enabling |
| `library-duplicate-name` | Multiple source skills share a name | Use full ID and confirmed alias |
| `legacy-metadata-deprecated` | Metadata still uses legacy storage | Route to `METADATA.md` migration |
| `collection-setup-required` | Enabled skills depend on incomplete required setup | Offer the declared setup skill; do not report the collection ready |
| `collection-setup-recommended` | Enabled skills would benefit from optional setup | Surface without blocking activation |
| `collection-setup-invalid` | The tracked setup contract is invalid | Report the contract path and error; never guess or execute commands |

If the API is unavailable, inspect `<project>/.agents/skills`, `<project>/.claude/skills`, `~/.agents/skills`, and `~/.claude/skills`, then compare aliases and link targets.

## Query Skills

Scan bundled and central sources, project links, globals, Claude links, and advice. Group output by source/collection and mark available, enabled, global, and advised states.

Complete when every returned item can be identified without relying on a bare folder name and the active advice is represented.

## Enable

### Single skill

1. Resolve one source skill and an alias; default the alias to the folder name.
2. Skip `archived/` unless explicitly selected.
3. Run the mutation gate against project/global entries and advice.
4. Prefer:

```bash
curl -sS -X POST http://127.0.0.1:4173/api/enable \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"/path/to/project","skillPath":"/path/to/skill","alias":"skill-name"}'
```

5. Verify `.agents/skills/<alias>` targets the selected source and Claude compatibility matches repository behavior.

Complete when the rescan reports the expected alias and target, with remaining advice stated.

### Source or collection

Expand the collection and request the shared enable plan. Exclude archived skills and skip `autoEnable: false`, except for a setup skill added by the plan because affected skills require it. Before mutation, show every pending setup with its status, missing artifacts, and setup skill.

For interactive setup, offer:

1. enable and continue into setup guidance;
2. enable only and keep the collection marked as pending;
3. cancel.

Activation remains reversible and may proceed without setup, but never report the collection as ready until `state.setups` reports `ready`.

Complete when every candidate is classified as enabled, unchanged, skipped, or failed.

## Collection Setup Lifecycle

`GET /api/state` returns `setups`. The tracked contract under `collection-metadata/` is the policy source; project artifacts are the readiness source. Status meanings:

| Status | Handling |
|---|---|
| `missing` | No required artifacts exist; offer the setup skill |
| `partial` | Some artifacts exist; inspect and resume instead of blindly overwriting |
| `ready` | Required artifacts exist; no setup warning |
| `invalid` | Contract validation failed; report it and do not infer a fallback |

When the user confirms setup in an Agent conversation, invoke the declared `setupSkillId` and follow that skill's own exploration and confirmation process. After it finishes, rescan state and require `ready`. Web or TUI surfaces without an Agent execution channel may only show the setup instruction; they must not claim to have run it.

Setup contracts are declarative and may reference only a setup skill, affected skill IDs, and project-relative artifacts. Never execute shell commands supplied by collection metadata.

## Disable

Resolve enabled aliases from project state. Remove only managed project symlinks and matching Claude compatibility links. A non-symlink or external target goes back through the mutation gate.

Prefer:

```bash
curl -sS -X POST http://127.0.0.1:4173/api/disable \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"/path/to/project","alias":"skill-name"}'
```

For a collection, map enabled targets back to source paths and select only aliases owned by that collection.

Complete when removed aliases are absent, source directories still exist, and unaffected aliases remain unchanged.

## Initialize, Audit, and Health

An audit is read-only unless the user separately authorizes changes. Summarize project links, Claude links, globals, and advice by severity. Recommend the smallest correction: repair broken links, disambiguate duplicate sources, or inspect unmanaged entries.

Health checks verify:

- source skill directories contain `SKILL.md` with usable frontmatter;
- project and Claude links have the expected type and existing target;
- global/project aliases and duplicate source names are surfaced;
- metadata descriptions remain useful for discovery.

For an edited skill, run:

```bash
python3 /Users/chenweilong/.codex/skills/.system/skill-creator/scripts/quick_validate.py /path/to/skill
```

Complete when every discovered anomaly is reported with identity, path, and proposed owner/action.

## Version and GitHub Source Updates

Check recommendation-data version alignment with:

```bash
node skills/skillcaddy-manager/scripts/version-manager.cjs check
```

Use `sync` only when the user requests a version update, then verify the changed version fields before reporting completion.

For sources under `github/`, inspect each repository for local changes. Skip dirty repositories and use fast-forward-only pulls; never stash, reset, or overwrite source edits.

Prefer:

```bash
npm run pull:github
```

Complete when pulled, current, dirty, non-Git, and failed targets are counted and network failures are distinguished from repository failures.

## Bootstrap and Web/TUI

Global manager installation writes to a user-level directory, so obtain approval first. From the repository:

```bash
npm run install:manager
npm run check:manager
```

Installation is complete only when `~/.agents/skills/skillcaddy-manager` is a managed symlink to this bundled skill. Existing files, directories, or links to another target are conflicts.

For Web access, start or reuse `npm start`, encode the target project path, and open:

```text
http://127.0.0.1:4173/?projectPath=<encoded-project-path>
```

Use `PORT=<other-port> npm start` only when `4173` is occupied or the user requests it. The TUI uses the same state model; prefer its browse-first library and skill actions over manual alias entry.

Complete when the manager reports the intended project and a fresh state scan succeeds.
