# AGENTS.md

Rules for agents (and people) working on implish. Project details are
in [CLAUDE.md](CLAUDE.md) and [README.md](README.md).

## Root-cause rule

For every review finding (automated or human):

- Fix the **root cause**, not the instance.
- List the **neighboring cases** of the same class in the PR body.
- **Add tests** for them before you push.
- Never push red.

## Branches and pull requests

- Cut each branch from the latest `main`. PRs target `main`.
- Open a **draft** PR early, as soon as there is a first commit,
  with `Fixes #N` in the body for the issue it closes.
- Use the PR template: report the test command and pass counts.

## Who does what

- Workers don't merge, don't deploy, and don't resolve review threads.
- Only Michal merges to `main`. implish.org is deployed by hand.
