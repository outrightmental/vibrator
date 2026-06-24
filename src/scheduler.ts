import type { OrchestratorAction } from "./types.js";

/**
 * Shared-pool scheduling primitives.
 *
 * Vibrator runs a single global pool of `max_concurrency` engine cylinders that
 * roam across every configured project. Each project additionally declares its
 * own concurrency cap — the maximum number of those shared cylinders that may
 * work that project at any one time. These pure helpers encode the claim
 * accounting that enforces both limits; `index.ts` drives them with live
 * GitHub snapshots, and they are unit-tested in isolation.
 */

/**
 * Stable key for the *resource* an action operates on (an issue or a PR),
 * deliberately NOT the action type — so two cylinders can never run different
 * actions against the same PR concurrently.
 */
export function actionResourceKey(action: OrchestratorAction): string {
  if (action.type === "start-implementation") {
    return `issue:${action.issueNumber}`;
  }
  return `pr:${action.pullRequestNumber}`;
}

/**
 * Claim key namespaced by project. The same issue/PR number can exist in two
 * repositories; the repo prefix keeps their claims distinct and lets us count,
 * per project, how many of the shared cylinders are busy on it.
 */
export function repoActionKey(repoKey: string, action: OrchestratorAction): string {
  return `${repoKey} ${actionResourceKey(action)}`;
}

/** Number of currently-claimed actions belonging to a given project. */
export function claimsForRepo(claimedActions: ReadonlySet<string>, repoKey: string): number {
  const prefix = `${repoKey} `;
  let count = 0;
  for (const key of claimedActions) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
}

/**
 * Issue numbers with a currently-claimed `start-implementation` action for a
 * given project. Used to keep in-flight implementations rendering as "planning"
 * in that project's lifecycle pane even after the planner drops the issue.
 */
export function claimedImplementationIssueNumbers(
  claimedActions: ReadonlySet<string>,
  repoKey: string,
): Set<number> {
  const prefix = `${repoKey} issue:`;
  const issueNumbers = new Set<number>();
  for (const key of claimedActions) {
    if (key.startsWith(prefix)) {
      const n = Number.parseInt(key.slice(prefix.length), 10);
      if (!Number.isNaN(n)) issueNumbers.add(n);
    }
  }
  return issueNumbers;
}

/**
 * Try to claim the first not-yet-claimed action from a project's plan, provided
 * the project is still below its concurrency cap. Mutates `claimedActions` by
 * adding the chosen key and returns the claimed action, or null when the
 * project is at its cap or has no unclaimed actions.
 *
 * Callers iterate projects in configured order and stop at the first claim, so
 * earlier projects are preferred and no project ever exceeds its cap.
 */
export function tryClaimFromPlan(
  repoKey: string,
  cap: number,
  actions: readonly OrchestratorAction[],
  claimedActions: Set<string>,
): OrchestratorAction | null {
  if (claimsForRepo(claimedActions, repoKey) >= cap) {
    return null;
  }
  for (const action of actions) {
    const key = repoActionKey(repoKey, action);
    if (!claimedActions.has(key)) {
      claimedActions.add(key);
      return action;
    }
  }
  return null;
}
