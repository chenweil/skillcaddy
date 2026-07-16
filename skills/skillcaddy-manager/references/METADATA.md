# Skillcaddy Metadata

Use this reference for notes, tags, `autoEnable`, legacy migration, and batch Chinese note generation.

## Storage Contract

`SKILL.md` is the agent-facing execution contract. Skillcaddy catalog metadata is human-facing and lives at:

```text
.skillcaddy/metadata/<source>/<relative-skill-path>/skillcaddy.json
```

Legacy `<skill-dir>/skillcaddy.json` is read only for compatibility in v0.14.x. Runtime fallback ends in v0.15.0; the migration command remains through v0.15.x and is removed in v0.16.0. New writes use the API or sidecar path, especially for GitHub-backed sources.

Supported shape:

```json
{
  "note": "简短、面向用户的用途说明。",
  "tags": ["Developer Tools", "Productivity"],
  "autoEnable": true
}
```

Apply these rules:

- Describe what the skill helps with; keep trigger logic in `SKILL.md`.
- Use 1-4 broad, reusable product-style tags.
- Preserve existing tags and `autoEnable` unless the request changes them or they are demonstrably wrong.
- Set `autoEnable: false` for deprecated, risky, heavyweight, or highly situational skills that should be skipped by collection-level enablement.
- Keep external GitHub clones clean; never add catalog metadata inside them.

## Write Metadata

Prefer the API:

```bash
curl -sS -X POST http://127.0.0.1:4173/api/skill-metadata \
  -H 'Content-Type: application/json' \
  -d '{"skillPath":"/path/to/skill","note":"简短说明","tags":["Developer Tools"],"autoEnable":true}'
```

Run the mutation gate from `SKILL.md`, then rescan `/api/state`. Complete when the response and rescan show the intended sidecar values and unrelated fields are unchanged.

## Migrate Legacy Metadata

Preview first, then obtain explicit confirmation before applying:

```bash
npm run migrate:metadata
npm run migrate:metadata -- --yes
```

Migration writes equivalent sidecar metadata and retains the legacy file for rollback. Complete when a rescan uses the sidecar and no source metadata was removed.

## Batch Chinese Notes

Run commands from the Skillcaddy repository root. The script performs filesystem and API operations; the agent supplies the Chinese notes.

```bash
# 1. Produce a manifest bound to this library root.
node skills/skillcaddy-manager/scripts/translate-skill-notes.cjs list --project=. > /tmp/skill-note-manifest.json

# 2. Fill each manifest entry's note; retain schemaVersion and libraryRoot.

# 3. Preflight without writes.
node skills/skillcaddy-manager/scripts/translate-skill-notes.cjs apply /tmp/skill-note-manifest.json --project=.

# 4. Apply only after reviewing the preflight.
node skills/skillcaddy-manager/scripts/translate-skill-notes.cjs apply /tmp/skill-note-manifest.json --project=. --yes
```

Generate one short Chinese sentence per note. Leave `tags` and `autoEnable` unset to preserve their current values. Existing notes remain protected; use `--force-rewrite` only after explicit confirmation. The manifest's `schemaVersion` and `libraryRoot` must remain unchanged.

If the API is unavailable, start `npm start`. Complete when preflight validates every entry before the first write, the applied count matches the intended manifest entries, and `/api/state` returns the new sidecar notes.
