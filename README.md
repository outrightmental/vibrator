# vibrator

**Turn a GitHub issue queue into a self-driving Claude vibe-coding factory.**

`vibrator` is a tiny TypeScript orchestrator that keeps a Claude coding
agent moving: it chooses the next issue, asks Claude to implement it
locally, opens the pull request, asks Claude to review it, routes
review fixes back through Claude, writes a final PR description, and
squash-merges when the loop is clean.

It is for developers who want the fun part of vibe coding — expressing
intent and reviewing outcomes — without babysitting every agent
handoff.

## Why this exists

Modern coding agents are powerful, but they still need a conductor.
Someone has to decide what starts next, avoid overloading the repo with
parallel work, notice blocked tasks, run a review pass, send fixes back
for another round, preserve closing references, and merge the finished
work.

`vibrator` makes that conductor programmable, and it uses Claude
(Anthropic's API, via the `claude` CLI / Claude Code) as the worker for
every coding-agent step.

Give your repository a prioritized issue backlog and run the loop. The
project becomes a living assembly line:

```text
issues → Claude implementation → PR → Claude review → fixes → final description → squash merge
```

## What it does

On every iteration, `vibrator`:

1. Loads open GitHub issues, open pull requests, pending workflow
   approvals, and local agent-session state.
2. Builds a dependency-aware work plan from issue age plus
   relationships like `blocked by #123`, `depends on #123`, and
   `blocks #123`.
3. Enforces a configurable concurrency limit so the repo does not get
   flooded with half-finished work.
4. For each eligible issue, runs Claude locally in a fresh checkout of
   the repo to implement the change and open a pull request.
5. For each open PR with no review yet, asks Claude to review the diff
   and posts an approval (or a request-changes review with inline
   comments) on GitHub.
6. When a review left inline comments, asks Claude to address every
   one, push fixes, and re-review.
7. Detects merge conflicts and asks Claude to resolve them before
   continuing.
8. Detects failing status checks and asks Claude to fix them before
   merging.
9. Generates a polished final PR description with Claude, updates the
   PR body, preserves or appends closing references, and squash-merges.

The result is not "AI writes code once." It is a full SDLC loop for
agentic repositories, powered end-to-end by your Anthropic API key.

## The big idea

`vibrator` treats GitHub as the source of truth and Claude as the
worker behind every action:

- **Issues are intent.** Write clear issues and dependencies; the loop
  decides when they are safe to start.
- **Pull requests are work cells.** Each PR moves through review, fix,
  re-review, final-description, and merge phases.
- **Local session state is memory.** A small persisted session store
  prevents duplicate work and lets each loop pick up where the last
  one stopped.
- **Humans stay in control.** You still own the backlog, repository
  settings, branch protections, CI, and review standards.

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
ANTHROPIC_API_KEY=sk-ant-...
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

The repository slug can be omitted from the CLI when
`GITHUB_REPOSITORY` is set.

## Requirements

- Node.js 18+
- A GitHub token with `contents:write`, `pull_requests:write`, and
  `issues:read` access to the target repository.
- An Anthropic API key with access to Claude Code (set in
  `ANTHROPIC_API_KEY`).
- The `claude` CLI (Claude Code) installed locally and on `PATH`.
- The `gh` CLI installed locally and on `PATH` — used to clone the
  repo, check out PR branches, and perform the final squash merge.
- `git` on `PATH`.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Yes | - | Token used for GitHub REST and GraphQL calls. |
| `ANTHROPIC_API_KEY` | Yes | - | API key the `claude` CLI uses. |
| `GITHUB_REPOSITORY` | No | - | Default `owner/repo` when the CLI argument is omitted. |
| `MAX_CONCURRENCY` | No | `3` | Maximum active work items across open PRs and in-flight implementations. |
| `LOOP_INTERVAL_MS` | No | `60000` | Delay between loop iterations. |
| `VIBRATOR_SESSION_STORE_PATH` | No | `<cwd>/.vibrator/<owner>-<repo>-sessions.json` | Path for persisted local agent-session state. |

## Issue language the loop understands

Use normal GitHub issues, plus lightweight relationship phrases:

```markdown
blocked by #12
depends on #12
blocks #34
```

`vibrator` will not start an issue while any referenced blocker
remains open. Older eligible issues start first, up to
`MAX_CONCURRENCY`. Bug-typed issues (GitHub's native Issue Type) jump
ahead of every other type.

## Development

```bash
npm test
npm run build
```

## Status

This project is intentionally small and sharp: a local orchestrator, a
GitHub client, a session store, a Claude agent client, and a planning
engine. It is early infrastructure for people who want to run software
projects as agentic systems instead of manually copying prompts between
tabs.
