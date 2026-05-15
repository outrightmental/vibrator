import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";

import {
  GitHubClient,
  isVibratorReview,
  VIBRATOR_REVIEW_MARKER,
} from "../src/github.js";

function captureStderr(t: test.TestContext): { output: () => string } {
  let stderrOutput = "";
  const stderrWriteMock = t.mock.method(
    process.stderr,
    "write",
    (chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  );
  t.after(() => {
    stderrWriteMock.mock.restore();
  });
  return {
    output: () => stderrOutput,
  };
}

test("isVibratorReview returns true when the review body carries the marker", () => {
  assert.equal(
    isVibratorReview(`${VIBRATOR_REVIEW_MARKER}\n\nLooks good.`),
    true,
  );
});

test("isVibratorReview returns false for reviews from other sources", () => {
  assert.equal(isVibratorReview("LGTM"), false);
  assert.equal(isVibratorReview(null), false);
  assert.equal(isVibratorReview(undefined), false);
});

test("squashMergePullRequest retries with --admin when branch policy blocks merge", async (t) => {
  const stderr = captureStderr(t);
  const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  let mergeAttempts = 0;

  const spawnMock = t.mock.method(
    childProcess,
    "spawn",
    (command: string, args: readonly string[]) => {
      spawnCalls.push({ command, args });

      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        if (args[1] === "ready") {
          child.emit("close", 0);
          return;
        }

        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          child.stderr.emit(
            "data",
            "X Pull request outrightmental/readtheroom#160 is not mergeable: the base branch policy prohibits the merge.\n" +
              "To use administrator privileges to immediately merge the pull request, add the `--admin` flag.\n",
          );
          child.emit("close", 1);
          return;
        }

        child.emit("close", 0);
      });

      return child;
    },
  );

  t.after(() => {
    spawnMock.mock.restore();
  });

  const client = new GitHubClient({
    owner: "outrightmental",
    repo: "readtheroom",
    token: "token",
  });

  await client.squashMergePullRequest(160, "Subject", "Body");

  assert.equal(spawnCalls.length, 3);
  assert.deepEqual(spawnCalls[1]?.args, [
    "pr",
    "merge",
    "160",
    "--squash",
    "--subject",
    "Subject",
    "--body",
    "Body",
    "--repo",
    "outrightmental/readtheroom",
  ]);
  assert.deepEqual(spawnCalls[2]?.args, [
    "pr",
    "merge",
    "160",
    "--squash",
    "--subject",
    "Subject",
    "--body",
    "Body",
    "--repo",
    "outrightmental/readtheroom",
    "--admin",
  ]);
  assert.match(stderr.output(), /base branch policy prohibits the merge/);
});

test("squashMergePullRequest does not retry unrelated gh merge failures", async (t) => {
  const stderr = captureStderr(t);
  const spawnMock = t.mock.method(
    childProcess,
    "spawn",
    (_command: string, args: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        if (args[1] === "ready") {
          child.emit("close", 0);
          return;
        }

        child.stderr.emit("data", "network failure\n");
        child.emit("close", 1);
      });

      return child;
    },
  );

  t.after(() => {
    spawnMock.mock.restore();
  });

  const client = new GitHubClient({
    owner: "outrightmental",
    repo: "readtheroom",
    token: "token",
  });

  await assert.rejects(
    client.squashMergePullRequest(160, "Subject", "Body"),
    /non-zero status 1/,
  );
  assert.match(stderr.output(), /network failure/);
});
