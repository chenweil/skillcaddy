---
status: accepted
---

# Recognize common skill-source repository layouts

Skillcaddy will discover skills from a bounded set of source-relative layouts so existing repositories can be registered without being reorganized. A source may expose a root `SKILL.md`, skills within four directory levels below `skills/` or `skill/`, or skills in direct child directories. When `skills/` contains recognized skills, that standard collection is authoritative and fallback layouts are ignored.

## Consequences

- Directory segments named `docs`, `references`, or `tests` are support content and are not treated as skill identities.
- Discovery remains bounded and does not become an arbitrary recursive `SKILL.md` search.
- The same discovery policy is used by migration, staged-source validation, updates, and runtime scanning.
- A registered skill path that moves outside the recognized layouts, including into an excluded support directory, is classified as removed or relocated during update and follows the existing breaking-replacement safety path.
