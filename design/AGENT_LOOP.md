# Agent loop and PR lifecycle

This document describes the end-to-end loop that `vibrator` runs against
a GitHub repository, with Claude (the `claude` CLI / Claude Code) as the
worker for every coding-agent step.

## Mental model

Think of `vibrator` as a scheduler plus shepherd:

```text
schedule issue work → run Claude locally → open PR → review → fix → review → describe → merge
```

Every pass through the loop is allowed to make progress. Every step
is synchronous — vibrator waits for Claude to finish before moving on.
That means sessions only ever sit in `in_progress` state inside a single
iteration;
on the next iteration they will be either completed (the agent finished
and the session was recorded) or failed (the previous process crashed
mid-action).

## Loop phases

### 1. Approve pending workflow runs

The loop first checks recent workflow runs for states that indicate
maintainer approval is needed. When possible, it approves them through
GitHub's workflow approval endpoint; when approval is not applicable,
it reports the reason and continues.

### 2. Load repository snapshot

The snapshot includes:

- open issues,
- open pull requests,
- PR merge-conflict status,
- PR-linked issue references from GitHub and PR text,
- PR review state on the current head (clean / unresolved comments),
- PR status-check rollup,
- local agent sessions.

### 3. Reconcile sessions

Every Claude action runs synchronously, so any `in_progress` session
observed at the start of an iteration is a leftover from a previous
vibrator process that crashed mid-action. The reconciler marks each
such session as `failed` so the planner can re-plan its work cleanly.

### 4. Build a plan

The planner prefers shepherding existing PRs before starting more
issues. That keeps the repository from accumulating unfinished work.

For issues, the planner:

- sorts bugs first, then by creation time,
- excludes issues already represented by open PRs or active sessions,
- excludes issues blocked by open blockers,
- starts only as many as fit inside `MAX_CONCURRENCY`.

### 5. Execute actions

In dry-run mode, execution is skipped after printing the plan. In
normal mode, actions call GitHub, `gh`, `git`, and the local `claude`
CLI as needed. Each action records a completed session at the end.

## Pull-request lifecycle

```text
start-implementation
        │
        ▼
Claude implements locally · vibrator opens the PR
        │
        ▼
review-pull-request (Claude)
        │
        ├── inline comments ──► address-review-comments (Claude) ──► review again
        │
        ├── merge conflicts ─► resolve-conflicts (Claude) ──► review again
        │
        ├── failing checks ──► address-failing-checks (Claude) ─► review again
        │
        ▼
clean review on current head
        │
        ▼
write-final-description (Claude)
        │
        ▼
update PR body + squash merge
```

## Dependency syntax

`vibrator` reads dependency hints directly from issue bodies:

- `blocked by #123`
- `depends on #123`
- `blocks #456`

The first two forms mark the current issue as blocked by another
issue. The `blocks` form marks the referenced issue as blocked by the
current issue.

Only open blockers prevent scheduling. Once a blocker closes, the
dependent issue becomes eligible on the next loop.

## Closing-reference behavior

The loop collects issue references from:

- GitHub's linked closing issues,
- PR titles and bodies with phrases such as `fixes #123`, `closes #123`,
  `resolves #123`, `implements #123`, and `for #123`.

Before merge, missing closing references are appended to the final PR
body so GitHub can close the intended issues after the squash merge.
If the initial squash merge fails only because GitHub requires an
administrator bypass for the base branch policy, the loop retries with
`gh pr merge --admin`.

## Recommended operating style

- Keep issues crisp, scoped, and independently mergeable.
- Put real acceptance criteria in issue bodies.
- Use dependency phrases instead of relying on issue order alone.
- Start with `--dry-run --once` and a low `MAX_CONCURRENCY`.
- Let branch protection and CI define the normal merge gate; admin
  bypass remains an explicit GitHub-controlled fallback.
- Treat the generated final description as the permanent change record.

## Failure modes to watch

- **`claude` CLI not found / not authenticated**: install Claude Code
  and run `claude login` to authenticate with your Claude Code subscription.
- **`gh` CLI not authenticated for the repo**: vibrator relies on `gh`
  to clone the repo and check out PR branches. Run `gh auth login`.
- **No PR appears after start-implementation**: check the iteration
  log — vibrator opens the PR itself via the REST API after Claude
  pushes, so an error from either step will surface in the action log.
- **Review loop repeats**: inspect the unresolved review threads
  vibrator is asking Claude to address; the planner only advances
  once a clean (zero-inline-comment) review is recorded against the
  current head SHA.
- **Final description fails**: confirm `gh`, `git`, and `claude` are
  installed and authenticated locally.
- **Too much parallel work**: lower `MAX_CONCURRENCY`.
