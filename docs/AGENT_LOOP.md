# Agent loop and PR lifecycle

This document describes the end-to-end loop that `vibrator` runs against a
GitHub repository.

## Mental model

Think of `vibrator` as a scheduler plus shepherd:

```text
schedule issue work → wait for PR → review → fix → review → describe → merge
```

Every pass through the loop is allowed to make progress, but it does not assume
agents respond instantly. Instead, it records sessions, exits or sleeps, then
observes GitHub again on the next iteration.

## Loop phases

### 1. Approve pending workflow runs

The loop first checks recent workflow runs for states that indicate maintainer
approval is needed. When possible, it approves them through GitHub's workflow
approval endpoint; when approval is not applicable, it reports the reason and
continues.

### 2. Load repository snapshot

The snapshot includes:

- open issues,
- open pull requests,
- PR merge-conflict status,
- PR-linked issue references from GitHub and PR text,
- Copilot review state on each PR head,
- local agent sessions.

### 3. Reconcile sessions

Reconciliation compares local sessions against GitHub:

- An implementation session completes when a linked PR appears.
- A review session completes when a later PR review exists.
- A review-fix or conflict-resolution session completes when the PR head SHA
  changes.
- A final-description session completes when the PR body changes.
- Stale implementation sessions fail if the issue closes or Copilot is no
  longer assigned.
- Old active sessions can time out through `SESSION_TIMEOUT_MS`.

### 4. Build a plan

The planner prefers shepherding existing PRs before starting more issues. That
keeps the repository from accumulating unfinished work.

For issues, the planner:

- sorts by creation time,
- excludes issues already represented by open PRs or active sessions,
- excludes issues blocked by open blockers,
- starts only as many as fit inside `MAX_CONCURRENCY`.

### 5. Execute actions

In dry-run mode, execution is skipped after printing the plan. In normal mode,
actions call GitHub, `gh`, and the local `copilot` CLI as needed.

## Pull-request lifecycle

```text
implementation session
        │
        ▼
linked PR appears
        │
        ▼
request Copilot review
        │
        ├── unresolved review comments ──► ask Copilot to fix ──► request review again
        │
        ├── merge conflicts ─────────────► ask Copilot to resolve ─► request review again
        │
        ▼
clean review
        │
        ▼
generate final description
        │
        ▼
update PR body + squash merge
```

## Dependency syntax

`vibrator` reads dependency hints directly from issue bodies:

- `blocked by #123`
- `depends on #123`
- `blocks #456`

The first two forms mark the current issue as blocked by another issue. The
`blocks` form marks the referenced issue as blocked by the current issue.

Only open blockers prevent scheduling. Once the blocker closes, the dependent
issue can become eligible on the next loop.

## Closing-reference behavior

The loop collects issue references from:

- GitHub's linked closing issues,
- PR titles and bodies with phrases such as `fixes #123`, `closes #123`,
  `resolves #123`, `implements #123`, and `for #123`.

Before merge, missing closing references are appended to the final PR body so
GitHub can close the intended issues after the squash merge.

## Recommended operating style

- Keep issues crisp, scoped, and independently mergeable.
- Put real acceptance criteria in issue bodies.
- Use dependency phrases instead of relying on issue order alone.
- Start with `--dry-run --once` and a low `MAX_CONCURRENCY`.
- Let branch protection and CI define the hard merge gate.
- Treat the generated final description as the permanent change record.

## Failure modes to watch

- **Copilot is unavailable as an assignee**: enable the Copilot coding agent for
  the repository and check token access.
- **No linked PR appears**: make sure Copilot remains assigned and that the issue
  has enough context to implement.
- **Review loop repeats**: inspect unresolved review threads and branch updates.
- **Final description fails**: confirm `gh` and `copilot` are installed and
  authenticated locally.
- **Too much parallel work**: lower `MAX_CONCURRENCY`.
