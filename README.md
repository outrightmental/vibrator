# vibrator

Orchestrator for agentic vibe coding.

## What it does

`vibrator` is a Node.js + TypeScript loop that authenticates to GitHub, inspects a repository's open issues and pull requests, and keeps autonomous SDLC work moving forward.

On each loop it:

1. Loads open issues, open pull requests, and local agent-session state.
2. Infers issue ordering from issue age, while respecting `blocked by #123`, `depends on #123`, and `blocks #123` relationships in issue bodies.
3. Enforces a configurable maximum concurrency (defaults to `3`).
4. Assigns the next eligible issues to Copilot by posting GitHub comments.
5. Watches linked pull requests through a review/fix/re-review loop.
6. Requests a final PR description, appends `Closes #<issue>`, and squash merges the pull request when the review loop is done.

## Usage

```bash
npm install
npm run build
GITHUB_TOKEN=... npm start -- owner/repo --dry-run --once
```

### Environment variables

- `GITHUB_TOKEN` (required): GitHub token for repository access.
- `GITHUB_REPOSITORY` (optional): default repository slug (`owner/repo`).
- `MAX_CONCURRENCY` (optional): maximum concurrent work items, default `3`.
- `LOOP_INTERVAL_MS` (optional): loop interval in milliseconds, default `60000`.
- `VIBRATOR_SESSION_STORE_PATH` (optional): path for persisted local agent-session state.

## Development

```bash
npm test
npm run build
```
