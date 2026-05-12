# vibrator

**Turn a GitHub issue queue into a self-driving vibe-coding factory.**

`vibrator` is a tiny TypeScript orchestrator that keeps Copilot coding agents
moving: it chooses the next issue, assigns it to Copilot, watches the pull
request, requests Copilot review, routes fixes back through the agent, writes a
final PR description, and squash-merges when the loop is clean.

It is for developers who want the fun part of vibe coding — expressing intent
and reviewing outcomes — without babysitting every agent handoff.

## Why this exists

Modern coding agents are powerful, but they still need a conductor. Someone has
to decide what starts next, avoid overloading the repo with parallel work,
notice blocked tasks, ask for review, send comments back for fixes, preserve
closing references, and merge the finished work.

`vibrator` makes that conductor programmable.

Give your repository a prioritized issue backlog and run the loop. The project
becomes a living assembly line:

```text
issues → Copilot implementation → PR → Copilot review → fixes → final description → squash merge
```

## What it does

On every iteration, `vibrator`:

1. Loads open GitHub issues, open pull requests, pending workflow approvals, and
   local agent-session state.
2. Builds a dependency-aware work plan from issue age plus relationships like
   `blocked by #123`, `depends on #123`, and `blocks #123`.
3. Enforces a configurable concurrency limit so the repo does not get flooded
   with half-finished agent work.
4. Assigns eligible issues to the Copilot coding agent.
5. Tracks implementation sessions until Copilot opens linked pull requests.
6. Requests Copilot pull-request review and counts unresolved review threads.
7. Sends PRs with review comments back to Copilot for fixes, then requests
   another review.
8. Detects merge conflicts and asks Copilot to resolve them before continuing.
9. Generates a polished final PR description with the local `copilot` CLI.
10. Preserves or appends issue-closing references and squash-merges the PR.

The result is not "AI writes code once." It is a full SDLC loop for agentic
repositories.

## The big idea

`vibrator` treats GitHub as the source of truth and agents as workers in a
state machine:

- **Issues are intent.** Write clear issues and dependencies; the loop decides
  when they are safe to start.
- **Pull requests are work cells.** Each PR moves through review, fix,
  re-review, final-description, and merge phases.
- **Local session state is memory.** A small persisted session store prevents
  duplicate nudges and lets each loop pick up where the last one stopped.
- **Humans stay in control.** You still own the backlog, repository settings,
  branch protections, CI, and review standards.

See the deeper docs:

- [Design overview](docs/DESIGN.md)
- [Agent loop and PR lifecycle](docs/AGENT_LOOP.md)

## Quick start

Install dependencies:

```bash
npm install
```

Copy the environment template:

```bash
cp .env.example .env
```

Set at least:

```env
GITHUB_TOKEN=your_github_token_here
GITHUB_REPOSITORY=owner/repo
```

Run a safe one-shot preview:

```bash
npm run build
npm start -- owner/repo --dry-run --once
```

Run the real loop:

```bash
npm start -- owner/repo
```

The repository slug can be omitted from the CLI when `GITHUB_REPOSITORY` is set.

## Requirements

- Node.js 18+
- A GitHub token with access to the target repository
- Copilot coding agent enabled for the target repository
- GitHub CLI (`gh`) available for final squash merges and PR checkout flows
- Copilot CLI (`copilot`) available locally for final PR description generation

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Yes | - | Token used for GitHub REST and GraphQL calls. |
| `GITHUB_REPOSITORY` | No | - | Default `owner/repo` when the CLI argument is omitted. |
| `MAX_CONCURRENCY` | No | `3` | Maximum active work items across open PRs and in-flight implementations. |
| `LOOP_INTERVAL_MS` | No | `60000` | Delay between loop iterations. |
| `SESSION_TIMEOUT_MS` | No | `21600000` | Marks still-active sessions failed after 6 hours by default. |
| `VIBRATOR_SESSION_STORE_PATH` | No | platform cache path | Path for persisted local agent-session state. |

## Issue language the loop understands

Use normal GitHub issues, plus lightweight relationship phrases:

```markdown
blocked by #12
depends on #12
blocks #34
```

`vibrator` will not start an issue while any referenced blocker remains open.
Older eligible issues start first, up to `MAX_CONCURRENCY`.
- `GITHUB_TOKEN` (required): GitHub token for repository access.
- `GITHUB_REPOSITORY` (optional): default repository slug (`owner/repo`).
- `MAX_CONCURRENCY` (optional): maximum concurrent work items, default `3`.
- `LOOP_INTERVAL_MS` (optional): loop interval in milliseconds, default `60000`.
- `SESSION_TIMEOUT_MS` (optional): mark still-active local sessions as failed after this many milliseconds, default `21600000` (6 hours).
- `COPILOT_ACKNOWLEDGE_TIMEOUT_MS` (optional): fail an active Copilot-summoning session (assignment, address-review-comments comment, resolve-conflicts comment) when no acknowledgment signal — a Copilot start/finish timeline event or an eyes reaction on the prompt comment — appears within this many milliseconds of the session starting. Default `600000` (10 minutes). On failure the orchestrator unassigns + re-assigns Copilot on the next iteration before re-summoning.
- `VIBRATOR_SESSION_STORE_PATH` (optional): path for persisted local agent-session state.

## Development

```bash
npm test
npm run build
```

## Status

This project is intentionally small and sharp: a local orchestrator, a GitHub
client, a session store, and a planning engine. It is early infrastructure for
people who want to run software projects as agentic systems instead of manually
copying prompts between tabs.
