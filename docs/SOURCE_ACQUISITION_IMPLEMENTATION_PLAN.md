# Managed Source Acquisition Implementation Plan

## Outcome

Add a safe, scriptable way to acquire and update Skillcaddy sources without manually cloning or copying them into source directories.

The first release provides:

```bash
npm run source -- list
npm run source -- inspect <source-id>
npm run source -- add <input>
npm run source -- update <source-id> [input]
npm run source -- migrate
npm run source -- migrate --yes
```

`<input>` may be:

- an HTTPS or SSH Git repository URL;
- a GitHub repository subdirectory URL;
- a public HTTP(S) ZIP URL;
- a local ZIP file; or
- a local directory.

The same core operations serve the CLI and `skillcaddy-manager`. Web and TUI controls are deferred.

## Non-goals

The first release does not:

- enable downloaded skills unless the user separately requests enablement;
- execute setup hooks, scripts, or any other acquired code;
- infer setup requirements from `SKILL.md`;
- remove installed sources;
- discover the latest version of an Archive source;
- compare Archive version numbers;
- retain replaced Archive versions or backups;
- support tar, tar.gz, tgz, rar, 7z, or npm packages;
- persist Archive authentication headers, cookies, tokens, or signed URL parameters;
- add Web or TUI acquisition controls;
- install a global `skillcaddy` executable; or
- move existing source directories into a new layout.

## Domain boundaries

The canonical vocabulary is in [`CONTEXT.md`](../CONTEXT.md).

The load-bearing separation is:

```text
input
  -> acquisition plan
  -> staged source
  -> safety and skill validation
  -> source registry + central library

central library skill
  -> existing enablement plan
  -> project symlink

enabled skill
  -> source-provided runtime preflight
```

Acquisition owns central-library content and source provenance. Existing project actions own symlink enablement. A skill owns its runtime credential and dependency checks. None of these layers silently performs another layer's work.

## Source identity and placement

### Canonical identity

`sourceId` is stable and independent of the physical install directory.

New sources use these defaults:

| Input | Source bucket | Default identity and path |
| --- | --- | --- |
| Git URL | `github` | repository name; use repository owner as namespace on collision |
| Remote ZIP | `official` | package name; use registrable download domain as namespace on collision |
| Local ZIP or directory | `personal` | local basename; require an explicit namespace on collision |

`archived/` is never a new-install target. `skills/` remains reserved for skills shipped with Skillcaddy.

For Archive collisions, derive the namespace from the registrable domain using Public Suffix List semantics. For example, `app-dl.ima.qq.com` yields `qq.com`, not the full hostname. `--namespace` may override the inferred value. A download host is provenance, not proof of authorship.

### Existing paths

Existing paths remain unchanged even when they do not match the new convention:

```json
{
  "sourceId": "github/mattpocock/skills",
  "installPath": "github/mattpocock"
}
```

The registry and update code must use `installPath`; they must not derive a physical path from `sourceId`.

### GitHub subdirectory URLs

A URL such as:

```text
https://github.com/example/skills/tree/main/skills/monitoring
```

acquires the complete repository. The branch and subdirectory become an optional source focus used to validate and prioritize the requested skills in output. The first release does not use sparse checkout.

## Source registry

Source records live outside acquired content:

```text
.skillcaddy/sources/<source-id>.json
```

For example:

```text
.skillcaddy/sources/github/mattpocock/skills.json
.skillcaddy/sources/official/ima-skills.json
```

The versioned schema must contain only facts owned by source management:

```json
{
  "schemaVersion": 1,
  "sourceId": "official/ima-skills",
  "bucket": "official",
  "type": "archive",
  "installPath": "official/ima-skills",
  "origin": {
    "kind": "https",
    "display": "https://app-dl.ima.qq.com/skills/ima-skills-1.1.8.zip"
  },
  "integrity": {
    "algorithm": "sha256",
    "value": "<hex>"
  },
  "skills": [
    "ima-skill",
    "ima-skill/notes",
    "ima-skill/knowledge-base"
  ]
}
```

Git records additionally retain the sanitized remote URL, tracked ref, and installed commit. Local imports retain only the original basename and content checksum, not an absolute path.

Registry invariants:

- never store credentials, embedded passwords, cookies, authorization headers, URL fragments, or sensitive query parameters;
- never write registry data inside a third-party checkout or extracted package;
- validate `schemaVersion`, `sourceId`, `installPath`, type-specific origin, integrity, and skill paths on every read;
- reject paths outside the central-library root;
- write records atomically; and
- treat a destination collision without matching source identity as a conflict, never as an update.

## Core module shape

Keep one public source-management module as the owned entry surface:

```js
listSources(context)
inspectSource(context, sourceId)
planAddSource(context, request)
applyAddSource(context, plan)
planUpdateSource(context, request)
applyUpdateSource(context, plan)
planSourceMigration(context)
applySourceMigration(context, plan)
```

`context` supplies the Skillcaddy root and optional current project path. Request objects carry parsed CLI intent; they do not expose transport or filesystem internals.

Suggested internal ownership:

- `lib/sourceManager.js` — orchestration, identities, collisions, plans, and public results;
- `lib/sourceRegistry.js` — schema validation and atomic sidecar reads/writes;
- `lib/sourceStaging.js` — Git/local/HTTP input staging and resource limits;
- `lib/sourceValidation.js` — archive safety, discovered skills, checksums, and breaking-path comparison;
- `scripts/source.js` — argument parsing, terminal rendering, confirmation, and exit codes.

Only `sourceManager.js` is imported by the CLI and Manager-facing adapters. Internal modules remain replaceable. If the implementation stays small, combine internal files rather than creating empty abstractions; split when responsibilities or file size make ownership unclear.

## Input handling

### Git

- Accept normal HTTPS and SSH Git URLs.
- Reuse the user's existing Git credential helper or SSH agent.
- Never accept or store a Skillcaddy-managed token.
- Clone the complete repository and its default branch unless an explicit GitHub branch link selects another branch.
- Keep Git update behavior fast-forward-only.
- Reject or skip a dirty worktree during update; never stash, reset, or overwrite it.
- Sanitize credentials from remotes before displaying or recording them.

### Remote ZIP

- Accept only HTTP and HTTPS.
- Follow at most five redirects, and reject redirects to other protocols.
- Identify ZIP content using its file signature; a `.zip` URL suffix is not required or sufficient.
- Stream downloads while enforcing the byte and time limits.
- Persist a sanitized provenance URL without fragments or sensitive query parameters.
- A temporary signed URL may be used for the current download but its signature must not be written to the registry or logs.

### Local ZIP and directory

- Copy content into the central library; never link back to Downloads or another original location.
- Do not persist the absolute input path.
- Apply the same ZIP and skill validation used for remote Archives.
- For a local directory, reject escaping symlinks. Preserve only relative symlinks whose resolved target stays inside the imported root.

## Archive safety limits

Use these first-release defaults:

| Limit | Value |
| --- | ---: |
| Remote ZIP download | 100 MiB |
| Expanded content | 500 MiB |
| Archive entries | 10,000 |
| Individual file | 100 MiB |
| Directory depth | 30 |
| HTTP redirects | 5 |
| Connection timeout | 15 seconds |
| Complete download timeout | 120 seconds |

Safety rules:

- count streamed download bytes rather than trusting `Content-Length`;
- count actual extracted bytes rather than trusting ZIP headers;
- reject absolute paths, drive-letter paths, NULs, `..` traversal, and any destination escape;
- reject ZIP symlink entries in the first release;
- reject special files;
- ignore `__MACOSX/`, `.DS_Store`, and AppleDouble `._*` entries;
- enforce all limits as hard failures; and
- do not provide `--no-limit` in the first release.

## Skill validation

Installation requires at least one discoverable skill.

Block acquisition when:

- no `SKILL.md` exists;
- a discovered `SKILL.md` is empty, unreadable, or not a regular file;
- a discovered skill escapes the staged source root; or
- a source safety rule fails.

Install with warnings when:

- frontmatter is absent;
- `description` is absent;
- frontmatter contains unknown fields; or
- a non-security formatting validator reports a quality issue.

The result separates valid skills, warnings, and blocked entries. This preserves compatibility with the current scanner, which accepts a plain `SKILL.md`, while making quality limitations visible.

Acquisition never executes a validator or source script from the staged package.

## Add and update semantics

### Add

`source add` only creates a new source.

- The same registered identity with identical content returns `already-installed` successfully.
- The same identity with different content directs the caller to `source update`.
- A destination collision without matching identity stops and requests a namespace or another explicit resolution.
- An explicit user request to install authorizes a new add; an Agent does not ask for redundant confirmation after a successful plan.
- Interactive CLI use displays the plan and confirms unless `--yes` is present.

### Update

`source update` only changes an existing registered source.

Git updates fetch and fast-forward the tracked branch. Archive and Local updates require a new URL, ZIP, or directory input and do not compare or infer versions.

Before any update, compare the old and staged sets of relative skill paths:

```text
unchanged
added
removed-or-relocated
```

Removed or relocated paths are a breaking source replacement. If the optional current project contains a link to an affected path, stop unless `--allow-breaking` was explicitly authorized. If no affected link is known, allow the update but report removed paths and warn that unregistered projects may still contain links.

The existing `npm run pull:github` becomes a compatibility entry that delegates to the unified Git update path. Batch Git update keeps the current summary categories: updated, current, dirty, failed, and breaking.

## Replacement transaction

Archive and Local replacement follows this order:

1. Acquire into a unique staging directory under a writable temporary root.
2. Validate safety, resource limits, identity, checksum, and discovered skills.
3. Compare skill paths and enforce the breaking-change rule.
4. Write the new registry record to a staged file.
5. Rename the active source to transaction-local rollback space.
6. Rename the staged source into the stable `installPath`.
7. Atomically publish the registry record.
8. Remove the replaced content before reporting success.

If steps 5–7 fail, restore the previous source and registry before returning failure. Transaction-local rollback space exists only during the operation and is not a retained backup. After success, only the new source remains.

Project symlinks remain valid when their target relative paths still exist because `installPath` is stable.

## Existing-source migration

Migration is explicit:

```bash
npm run source -- migrate
npm run source -- migrate --yes
```

The default command is read-only and returns a plan.

- Git directories with an `origin` are assigned a canonical Git identity while retaining their current `installPath`.
- Non-Git source entries become `legacy-local` with unknown origin, a checksum, and discovered skill paths.
- Ambiguous remotes, duplicate identities, nested repository conflicts, and unsafe paths remain unresolved and are reported.
- Applying the migration writes only `.skillcaddy/sources/`; it never moves content or edits project links.
- Read-only commands such as `source list` never create registry records as a side effect.

## Setup and enablement

Acquisition does not imply enablement.

- A request to download or add changes only the central library.
- A request to enable uses an already acquired skill and the existing symlink plan.
- A request that explicitly includes both intents may run both plans in order.

Setup status never blocks enablement. A declared setup contract may produce a non-blocking reminder. A source without a recognized setup contract is `unknown`, enables normally, and produces no generic reminder.

Source-provided runtime preflight remains authoritative for proprietary requirements such as IMA credentials. Skillcaddy does not duplicate or infer those instructions from prose.

## Manager integration

Update `skillcaddy-manager` so natural-language requests route through state and source registry:

```text
state
  -> identify acquisition intent and optional enablement intent
  -> inspect registry
  -> choose add or update
  -> plan
  -> act when authorized
  -> rescan and verify
```

Examples:

- “下载这个 skill” runs acquisition only.
- “启用 IMA knowledge-base” runs enablement only and requires an existing source.
- “下载并启用到当前项目” runs acquisition, rescans, resolves the requested skill, then runs the existing enablement plan.
- “安装这个新版 URL” routes to update when registry identity already exists.

The Manager must show full source and skill identities when matching is ambiguous. It must never turn a mere directory collision into replacement authority.

## Delivery phases

### Phase 1 — Registry and read-only discovery

Changes:

- add the registry schema and path containment checks;
- implement `list`, `inspect`, and migration planning;
- identify existing Git sources from sanitized `origin`; and
- represent non-Git entries as `legacy-local`.

Checks:

- schema fixtures accept every supported source type and reject unsafe paths or unsupported versions;
- migration fixtures cover current non-canonical paths such as `github/mattpocock`;
- read-only commands leave the working tree and registry unchanged.

Done when existing libraries can be described without moving or modifying them.

### Phase 2 — Local acquisition

Changes:

- add local directory and local ZIP staging;
- enforce archive limits and safety checks;
- discover and validate skills;
- implement add planning, collision handling, and atomic installation; and
- record checksums and skill paths.

Checks:

- fixture ZIPs cover traversal, absolute paths, symlinks, special files, excessive entries, excessive expanded size, wrapper directories, and macOS junk;
- a local directory import does not depend on its original path after success;
- identical repeated adds are no-ops;
- a non-identical identity collision does not overwrite.

Done when a local ZIP or directory can be safely added to `personal/` and rediscovered by existing state scanning.

### Phase 3 — Network acquisition

Changes:

- add Git HTTPS/SSH cloning;
- normalize GitHub repository and tree URLs;
- add streaming HTTP(S) ZIP download;
- enforce redirect and timeout policy; and
- sanitize displayed and persisted provenance.

Checks:

- use local Git repositories and a local HTTP test server; tests must not require public network access;
- cover default branches, explicit branches, dirty repositories, redirects, misleading extensions, truncated downloads, timeouts, and sensitive query removal;
- verify that credentials never appear in snapshots, registry fixtures, or error output.

Done when Git and remote ZIP sources use the same add plan and registry contract as local inputs.

### Phase 4 — Unified safe updates

Changes:

- implement Git fetch and fast-forward update;
- implement Archive and Local staged replacement;
- compare skill paths;
- enforce `--allow-breaking`;
- preserve stable install paths; and
- delegate `pull:github` to the unified updater.

Checks:

- updates preserve current project links when skill paths remain stable;
- breaking updates stop when an affected current-project link exists;
- download or validation failure leaves source content and registry unchanged;
- a simulated swap failure restores the old source;
- successful replacement leaves no backup; and
- dirty Git worktrees remain untouched.

Done when both Git and Archive updates have the same observable safety contract.

### Phase 5 — Manager and documentation

Changes:

- document source commands in English and Chinese READMEs;
- update `skillcaddy-manager` routing and operations references;
- add examples for add-only, enable-only, combined intent, replacement, and migration; and
- document deferred capabilities and recovery guidance.

Checks:

- Manager examples map to actual command syntax;
- a fresh state scan sees newly acquired skills;
- acquisition alone creates no project symlink;
- combined intent creates only the explicitly selected links; and
- documentation does not claim Web, TUI, global-binary, removal, or automatic-latest support.

Done when another project with the globally installed Manager skill can perform the workflow without manual source-directory placement.

## Test strategy

Use Node's built-in test runner and existing repository conventions.

Required test groups:

- source ID, namespace, registrable-domain, and collision normalization;
- registry schema, atomic writes, sanitization, and path containment;
- Git URL and GitHub focus parsing;
- ZIP signature detection and every archive safety limit;
- skill discovery with blocking errors versus quality warnings;
- add idempotency and collision refusal;
- update skill-path comparison and breaking-link authorization;
- transaction rollback and successful no-backup cleanup;
- legacy migration planning and application;
- CLI parsing, exit codes, confirmation, and `--yes`; and
- Manager routing between acquisition and enablement.

Verification commands:

```bash
npm test
npm run lint
git diff --check
```

Network-facing tests must use deterministic local fixtures. A final optional manual smoke test may use the public IMA ZIP, but it is not part of the repeatable test suite.

## Exit codes and reporting

Use stable categories so Agents do not parse prose:

| Exit | Meaning |
| ---: | --- |
| `0` | success, including an identical already-installed no-op |
| `1` | acquisition, validation, Git, filesystem, or registry failure |
| `2` | invalid CLI usage |
| `3` | unresolved identity or destination collision |
| `4` | breaking replacement requires explicit authorization |

Human output leads with the outcome and includes:

- source ID and install path;
- input type and sanitized provenance;
- valid skill count and full relative paths;
- warnings and blocked entries;
- checksum or Git commit;
- added and removed skill paths for updates; and
- the exact next command when user action is required.

Machine-readable JSON output is deferred unless Manager integration proves that stable exit codes and direct module calls are insufficient.

## Stop conditions

Stop implementation and request a decision if:

- a source cannot be assigned one unambiguous identity without guessing;
- a destination exists but registry/origin cannot prove it is the same source;
- safe replacement cannot preserve or restore the active source on failure;
- a requested authenticated Archive flow would require persisting a secret;
- a supported input requires executing acquired code to inspect or install it;
- current project links would break without explicit authorization; or
- implementation would require moving existing source directories.

## Acceptance checklist

- [ ] All five CLI commands use one source-management core.
- [ ] Existing source paths and project links remain unchanged after migration.
- [ ] Registry records contain no credentials, signed parameters, or local absolute paths.
- [ ] Git, remote ZIP, local ZIP, and local directory inputs are supported.
- [ ] ZIP and local imports cannot escape their staging or install roots.
- [ ] At least one valid `SKILL.md` is required; quality-only issues remain warnings.
- [ ] Acquisition never executes source code, performs setup, or enables a skill implicitly.
- [ ] Add is idempotent and never overwrites a collision.
- [ ] Git and Archive updates compare skill paths and protect known project links.
- [ ] Failed updates preserve the active source and registry.
- [ ] Successful Archive replacement leaves only the new copy.
- [ ] Manager routes add versus update from registry state and keeps enablement separate.
- [ ] Repeatable tests pass without external network access.
- [ ] English and Chinese documentation match the implemented behavior.
