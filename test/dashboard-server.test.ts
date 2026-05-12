import test from "node:test";
import assert from "node:assert/strict";

import { DashboardServer } from "../src/dashboard-server.js";

async function start(): Promise<DashboardServer> {
  const server = new DashboardServer();
  await server.start("127.0.0.1", 0);
  return server;
}

test("DashboardServer serves the index HTML on /", async () => {
  const server = await start();
  try {
    const response = await fetch(server.url());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const body = await response.text();
    assert.match(body, /VIBRATOR/);
    assert.match(body, /<link rel="stylesheet" href="\/styles.css"/);
    assert.match(body, /<script src="\/app.js"/);
  } finally {
    await server.close();
  }
});

test("DashboardServer serves /styles.css and /app.js", async () => {
  const server = await start();
  try {
    const css = await fetch(new URL("/styles.css", server.url()));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /scanlines/);

    const js = await fetch(new URL("/app.js", server.url()));
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.match(await js.text(), /EventSource/);
  } finally {
    await server.close();
  }
});

test("DashboardServer /state returns canonical JSON state with history", async () => {
  const server = await start();
  server.setStartup({
    repo: "octo/widgets",
    repositoryUrl: "https://github.com/octo/widgets",
    mode: ["--once"],
    intervalMs: 1000,
    concurrency: 3,
  });
  try {
    const response = await fetch(new URL("/state", server.url()));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { state: { repo: string }; history: Array<{ type: string }> };
    assert.equal(body.state.repo, "octo/widgets");
    assert.ok(body.history.find((event) => event.type === "startup"));
  } finally {
    await server.close();
  }
});

test("DashboardServer returns 404 for unknown paths", async () => {
  const server = await start();
  try {
    const response = await fetch(new URL("/does-not-exist", server.url()));
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("DashboardServer streams live SSE events to subscribers", async () => {
  const server = await start();
  try {
    const controller = new AbortController();
    const response = await fetch(new URL("/events", server.url()), {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body, "SSE response should have a body");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Read until we have at least one full frame (the priming "state" frame).
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    assert.match(buffer, /event: state/);

    // Wait for SSE registration to settle before publishing the live event
    // — fetch's stream resolves before the server-side `clients.add(...)`
    // necessarily fires in some Node versions.
    for (let i = 0; i < 50 && server.clientCount() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(server.clientCount(), 1);

    server.publish({
      type: "cycle-start",
      iteration: 42,
      timestamp: new Date().toISOString(),
    });

    while (!buffer.includes("event: cycle-start")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    assert.match(buffer, /event: cycle-start/);
    assert.match(buffer, /"iteration":42/);

    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await server.close();
  }
});

test("DashboardServer publish() updates state for cycle and countdown events", async () => {
  const server = await start();
  try {
    const nextCycleAt = new Date(Date.now() + 60000);
    server.setNextCycleAt(nextCycleAt);
    server.publish({
      type: "cycle-start",
      iteration: 1,
      timestamp: new Date().toISOString(),
    });
    server.publish({
      type: "phase",
      iteration: 1,
      phase: "Plan",
      status: "start",
      timestamp: new Date().toISOString(),
    });

    const body = (await (await fetch(new URL("/state", server.url()))).json()) as {
      state: { inCycle: boolean; nextCycleAt: string; currentPhase: string; currentIteration: number };
    };
    assert.equal(body.state.inCycle, true);
    assert.equal(body.state.currentIteration, 1);
    assert.equal(body.state.currentPhase, "Plan");
    assert.equal(body.state.nextCycleAt, nextCycleAt.toISOString());
  } finally {
    await server.close();
  }
});

test("DashboardServer history is capped and replayed on connect", async () => {
  const server = await start();
  try {
    // Push more than MAX_HISTORY events to verify the cap.
    for (let i = 0; i < 600; i++) {
      server.publish({
        type: "log",
        iteration: 1,
        phase: "Plan",
        level: "note",
        indent: 0,
        message: `line ${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    const body = (await (await fetch(new URL("/state", server.url()))).json()) as {
      history: Array<{ message?: string }>;
    };
    assert.ok(body.history.length <= 500, `history length=${body.history.length} exceeds cap`);
    // The oldest entries should have been dropped — the first item is no
    // longer "line 0".
    assert.notEqual(body.history[0]?.message, "line 0");
  } finally {
    await server.close();
  }
});
