# Design overview

`vibrator` is an orchestration loop for repositories that use Copilot coding
agents as implementation workers. Its job is not to replace project judgment;
its job is to remove the repetitive coordination work between intent,
implementation, review, fixup, description, and merge.

## Product thesis

Agentic coding gets interesting when a repository can keep moving after a human
has written the backlog. A single prompt can produce a patch, but a useful
software project needs an operating system:

- choose the next safe item,
- respect dependencies,
- limit parallel work,
- notice when an agent has produced a PR,
- ask for review,
- route review feedback back to the agent,
- detect conflicts,
- produce a reviewable final description,
- merge only when the loop is complete.

`vibrator` makes that operating system explicit and inspectable.

## Design goals

1. **GitHub-native control plane**: Issues, pull requests, assignees, review
   threads, checks, and merge state remain the primary coordination surface.
2. **Small local brain**: The orchestrator persists only session metadata needed
   to avoid duplicate work and understand the current phase of each item.
3. **Dependency-aware backlog flow**: Issue ordering starts with age, then
   filters out blocked work using plain-English dependency phrases.
4. **Bounded autonomy**: `MAX_CONCURRENCY` prevents uncontrolled agent fan-out.
5. **Review-first completion**: Work is not done when a PR appears; it must pass
   through Copilot review and any required fix loop.
6. **Clean final merge artifact**: The final PR body and squash commit body are
   generated from the branch context and preserve closing references.

## Non-goals

- Replacing GitHub project management.
- Replacing human product direction.
- Bypassing branch protection, required checks, or repository policy.
- Maintaining a central server. `vibrator` is designed as a local or scheduled
  process that can be stopped and restarted.
- Inventing a custom workflow language. It intentionally leans on issue text,
  PR metadata, GitHub APIs, `gh`, and `copilot`.

## Architecture

```text
                ┌──────────────────────────────┐
                │          GitHub repo          │
                │ issues · PRs · reviews · CI   │
                └──────────────┬───────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                         vibrator                             │
│                                                              │
│  load snapshot  →  reconcile sessions  →  build plan         │
│        │                    │                 │              │
│        ▼                    ▼                 ▼              │
│  GitHubClient       FileSessionStore      orchestrator       │
│        │                    │                 │              │
│        └────────────────────┴─────────┬───────┘              │
│                                       ▼                      │
│                               execute actions                │
└───────────────────────────────────────┬──────────────────────┘
                                        │
         ┌──────────────────────────────┴─────────────────────┐
         ▼                                                    ▼
 Copilot coding agent                              local Copilot CLI
 issue implementation · review fixes              final PR description
```

### Core modules

- `src/index.ts` parses configuration, prints operator-friendly status, loads
  snapshots, reconciles sessions, builds plans, and executes actions.
- `src/orchestrator.ts` contains the pure planning rules: dependency parsing,
  issue eligibility, PR phase selection, and final body closing-reference logic.
- `src/actions.ts` translates planned actions into GitHub API calls, session
  records, Copilot review requests, comments, description generation, and merge.
- `src/github.ts` wraps GitHub REST, GraphQL, workflow approval, Copilot
  assignment, Copilot review requests, review-thread resolution, and merging.
- `src/reconcile.ts` observes external state changes and marks sessions
  completed or stale.
- `src/session-store.ts` persists session state in a local JSON file.
- `src/local-copilot.ts` checks out PR branches and asks the local `copilot` CLI
  to produce final pull-request descriptions.

## Data model

The orchestrator works from a `RepositorySnapshot`:

- open issues,
- open pull requests,
- locally persisted agent sessions.

An `AgentSession` records the phase, status, linked issue or PR, timestamps, and
small phase-specific result values such as the head SHA observed before a fix
request. This is enough to answer questions like:

- Did Copilot already start work on this issue?
- Did a PR appear for that implementation session?
- Did the PR head SHA change after fix instructions?
- Did a review happen after the review request?
- Was a final description already generated?

## Planning model

Planning is deterministic:

1. Sort open issues and PRs by creation time.
2. Build a blocked-issue index from `blocked by`, `depends on`, and `blocks`.
3. Plan PR work first, because open PRs already consume repository attention.
4. Count active PRs plus in-flight implementation sessions.
5. Use remaining concurrency for the oldest eligible unblocked issues.

This keeps the system conservative. Existing work is shepherded before new work
starts.

## Action model

Planned actions are intentionally high level:

- `start-implementation`
- `request-review`
- `address-review-comments`
- `resolve-conflicts`
- `write-final-description`
- `merge-pull-request`

Each action is idempotence-aware through session state. A later iteration can
observe what changed and move to the next phase instead of repeating the same
nudge.

## Safety and operator control

- Use `--dry-run --once` to inspect the plan without mutating GitHub.
- Keep `MAX_CONCURRENCY` low until the repository's issue quality and CI signal
  are trustworthy.
- Use branch protection and required checks as the final safety net.
- Keep issues small enough for agentic implementation and review.
- Use explicit dependency phrases when order matters.

## Why the final-description step matters

Agent-generated PRs often start with sparse or placeholder descriptions. Before
merge, `vibrator` checks out the PR branch, asks the local `copilot` CLI to read
the commits and diff, and uses the result as both the final PR body and squash
commit body. Closing references are preserved or appended so GitHub issue
automation still works.

That turns every merged unit into a useful historical artifact instead of a
trail of "Copilot did a thing" placeholders.
