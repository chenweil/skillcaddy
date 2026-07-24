# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create issues with `gh issue create`.
- Read issues and comments with `gh issue view <number> --comments`.
- List issues with `gh issue list`, including labels and comments when required.
- Comment with `gh issue comment`.
- Apply or remove labels with `gh issue edit`.
- Close issues with `gh issue close`.
- Infer the repository from the current Git remote.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve ambiguous references before operating on them.

## Skill operations

- “Publish to the issue tracker” means creating a GitHub issue.
- “Fetch the relevant ticket” means reading the issue body, labels, and comments.
- Apply the configured `ready-for-agent` label to agent-ready specs and tickets.

## Blocking relationships

Use GitHub native issue dependencies where available. Otherwise, record:

`Blocked by: #<issue>, #<issue>`

A ticket is ready only when every blocking issue is closed.
