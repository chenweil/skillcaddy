# Skillcaddy Recommendation Branch

Use this branch only for recommendation requests. Recommendation is analysis-first: observed state selects the mode; static catalog data supplies candidates.

## Sources of Truth

- `/api/state?projectPath=...`: current library, project enablement, globals, metadata, and advice.
- `featured-skills.json`: modes, signals, scenarios, candidates, and recommendation limit.
- `skill-platforms.json`: discovery platforms.
- `scripts/view-recommendations.cjs`: deterministic catalog views.
- `scripts/check-conflicts.cjs`: comparable name, description, tag, and capability profiles for agent review.
- `scripts/check-global-skills.cjs`: global skill scan.

Do not duplicate candidate lists or conflict policy in prose; read the current JSON for each recommendation run.

## Steps

1. Read `/api/state` and inspect repository skills, enabled aliases, globals, notes/tags, source distribution, and advice.
   - Complete when the current capability footprint and likely overlap candidates are observable.
2. Classify one mode from `featured-skills.json`:
   - `discovery`: the library is empty or the use case is unclear;
   - `starter`: the project or request provides a clear scenario;
   - `gap-based`: an existing mixed library has an identifiable missing category.
   - Complete when one mode is justified by specific state signals.
3. Read only the matching scenario/category data. Compare each candidate with installed collections using names, descriptions, tags, and contained skills. Treat similarity output as evidence for agent judgment, never as an automatic conflict verdict.
   - Complete when each likely overlap has concrete shared terms or capabilities and has been classified as complementary, redundant, or uncertain.
4. Recommend no more than the catalog's `maxRecommendations`. Bind every item to an observed gap or scenario and avoid same-shape additions.
   - Complete when removing any item would leave a stated need uncovered and every item explains why it fits now.

## Deterministic Views

```bash
node skills/skillcaddy-manager/scripts/view-recommendations.cjs onboarding
node skills/skillcaddy-manager/scripts/view-recommendations.cjs workflows
node skills/skillcaddy-manager/scripts/view-recommendations.cjs scenario new-project
node skills/skillcaddy-manager/scripts/view-recommendations.cjs category development
node skills/skillcaddy-manager/scripts/view-recommendations.cjs platforms
node skills/skillcaddy-manager/scripts/check-conflicts.cjs <collection> --against <installed-id,installed-id>
node skills/skillcaddy-manager/scripts/check-global-skills.cjs
```

Use `onboarding` for an empty library. A code repository alone is a weak signal; prefer discovery until the request, existing skills, or project contents establish a development workflow need.

## Output

Use a compact table:

| Recommendation | Mode | Observed fit | Overlap evidence/status | Next action |
|---|---|---|---|---|

Distinguish recommendation from installation. Apply the mutation gate in `SKILL.md` before enabling anything. Recommendation is complete when the state evidence, selected mode, candidate rationale, exclusions, and next action are all explicit.
