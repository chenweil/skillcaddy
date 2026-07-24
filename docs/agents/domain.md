# Domain Docs

This is a single-context repository.

## Before exploring

Read:

- `CONTEXT.md`
- relevant ADRs under `docs/adr/`

If either is absent, proceed silently. Domain-modeling skills create these files lazily when terms or decisions are resolved.

## Use the glossary

Use canonical terms from `CONTEXT.md` in issue titles, specifications, tests, hypotheses, and implementation documents. Avoid synonyms explicitly rejected by the glossary.

If a required concept is absent, reconsider whether it belongs to the domain or record the gap for `/domain-modeling`.

## ADR conflicts

Surface any conflict with an existing ADR explicitly instead of silently overriding it.
