import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import WebSocket from "ws";
import { DashboardServer } from "../src/dashboard-server.js";
import { globalEventEmitter } from "../src/event-emitter.js";
import type { DashboardEvent } from "../src/event-emitter.js";

const TEST_PORT = 19_876;

function collectMessages(ws: WebSocket, afterOpenMs: number): Promise<DashboardEvent[]> {
  const received: DashboardEvent[] = [];
  ws.on("message", (data: Buffer) => {
    received.push(JSON.parse(data.toString()) as DashboardEvent);
  });
  return new Promise((resolve) => {
    ws.once("open", () => setTimeout(() => resolve(received), afterOpenMs));
    ws.once("error", () => resolve(received));
  });
}

test("DashboardServer replays cached state to a newly connected client", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  globalEventEmitter.emit("lifecycle-update", {
    pairs: [{ issue: { number: 7, title: "Fix bug", state: "open" }, prPhase: "active", colorIndex: 1 }],
  });
  globalEventEmitter.emit("snapshot-update", {
    issueCount: 3,
    prCount: 1,
    sessionCount: 2,
    issues: [{ number: 7, title: "Fix bug", state: "open" }],
    pullRequests: [],
  });
  globalEventEmitter.emit("action-start", {
    actionIndex: 1,
    totalActions: 4,
    type: "start-implementation",
    issueNumber: 7,
    description: "implementing #7",
  });

  // Attach message listener before the connection opens so nothing is missed
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const types = messages.map((m) => m.type);
  assert.ok(types.includes("lifecycle-update"), "should replay lifecycle-update");
  assert.ok(types.includes("snapshot-update"), "should replay snapshot-update");
  assert.ok(types.includes("action-start"), "should replay action-start");
});

test("DashboardServer replaces cylinder cache on iteration-start", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 1,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  // action-start for cylinder 0, then iteration-start supersedes it in the cache
  globalEventEmitter.emit("action-start", {
    actionIndex: 1,
    totalActions: 2,
    type: "self-review",
    issueNumber: 5,
    description: "reviewing",
  });
  globalEventEmitter.emit("iteration-start", {
    engineIndex: 0,
    iterationNumber: 3,
    maxConcurrency: 2,
  });

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 1}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const cylinderMessages = messages.filter(
    (m) => m.type === "action-start" || m.type === "iteration-start",
  );
  assert.equal(cylinderMessages.length, 1, "only one cylinder-0 event should be cached");
  const cylinderMsg = cylinderMessages[0];
  assert.ok(cylinderMsg !== undefined, "expected a cylinder message");
  assert.equal(
    cylinderMsg.type,
    "iteration-start",
    "iteration-start should replace action-start in cache",
  );
});

test("DashboardServer replaces cylinder cache on engine-shutdown", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 2,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  // iteration-start for cylinder 1, then engine-shutdown supersedes it in the cache
  globalEventEmitter.emit("iteration-start", {
    engineIndex: 1,
    iterationNumber: 2,
    maxConcurrency: 2,
  });
  globalEventEmitter.emit("engine-shutdown", { engineIndex: 1 });

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 2}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const cylinderMessages = messages.filter(
    (m) => m.type === "iteration-start" || m.type === "engine-shutdown",
  );
  assert.equal(cylinderMessages.length, 1, "only one cylinder-1 event should be cached");
  assert.equal(cylinderMessages[0]?.type, "engine-shutdown", "engine-shutdown should replace iteration-start in cache");
});

test("DashboardServer replaces cylinder cache on engine-idle", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 4,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  globalEventEmitter.emit("action-start", {
    actionIndex: 1,
    totalActions: 2,
    type: "start-implementation",
    issueNumber: 9,
    description: "implementing #9",
  });
  globalEventEmitter.emit("engine-idle", {
    engineIndex: 0,
    reason: "nothing to do this cycle",
  });

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 4}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const cylinderMessages = messages.filter((m) => m.type === "action-start" || m.type === "engine-idle");
  assert.equal(cylinderMessages.length, 1, "only one cylinder-0 event should be cached");
  assert.equal(cylinderMessages[0]?.type, "engine-idle", "engine-idle should replace action-start in cache");
});

test("DashboardServer caches engine-idle with nextCycleAtMs", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 5,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const nextCycleAtMs = Date.now() + 45000;
  globalEventEmitter.emit("engine-idle", {
    engineIndex: 1,
    nextCycleAtMs,
  });

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 5}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const idleMsg = messages.find((m) => m.type === "engine-idle");
  assert.ok(idleMsg !== undefined, "should replay engine-idle");
  assert.equal(idleMsg?.data.engineIndex, 1);
  assert.equal(idleMsg?.data.nextCycleAtMs, nextCycleAtMs, "nextCycleAtMs should be preserved in cache");
});

test("DashboardServer caches engine-idle with rateLimitedUntilMs", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 6,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const rateLimitedUntilMs = Date.now() + 900_000;
  globalEventEmitter.emit("engine-idle", {
    engineIndex: 0,
    nextCycleAtMs: Date.now() + 30000,
    rateLimitedUntilMs,
  });

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 6}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const idleMsg = messages.find((m) => m.type === "engine-idle");
  assert.ok(idleMsg !== undefined, "should replay engine-idle");
  assert.equal(idleMsg?.data.rateLimitedUntilMs, rateLimitedUntilMs, "rateLimitedUntilMs should be preserved in cache");
});

test("DashboardServer caches action-start with startedAt for accurate elapsed-time replay", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 7,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const startedAt = Date.now() - 300_000; // simulates action started 5 minutes ago
  globalEventEmitter.emit("action-start", {
    actionIndex: 1,
    totalActions: 2,
    type: "start-implementation",
    issueNumber: 42,
    description: "implementing #42",
    startedAt,
  });

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 7}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const actionMsg = messages.find((m) => m.type === "action-start");
  assert.ok(actionMsg !== undefined, "should replay action-start");
  assert.equal(actionMsg?.data.startedAt, startedAt, "startedAt should be preserved in cache for accurate elapsed-time display");
});

test("DashboardServer clears cached github-rate-limit on github-rate-limit-cleared", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 8,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  globalEventEmitter.emit("github-rate-limit", {
    kind: "secondary",
    api: "rest",
    blockedUntilMs: Date.now() + 60_000,
    waitMs: 60_000,
    message: "limited",
    attempt: 1,
  });
  globalEventEmitter.emit("github-rate-limit-cleared", {});

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 8}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const rateLimitMsg = messages.find((m) => m.type === "github-rate-limit");
  assert.equal(rateLimitMsg, undefined, "cleared cache should not replay stale github-rate-limit event");
});

function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
  });
}

test("DashboardServer uses custom dashboardTitle in generated HTML", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 8,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
    dashboardTitle: "My Custom Title",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const html = await fetchHtml(`http://127.0.0.1:${TEST_PORT + 8}/`);
  assert.ok(html.includes("My Custom Title"), "HTML should contain the custom dashboard title");
});

test("DashboardServer defaults to repository name when no dashboardTitle is provided", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 9,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const html = await fetchHtml(`http://127.0.0.1:${TEST_PORT + 9}/`);
  assert.ok(html.includes("repo"), "HTML should contain the default repository title");
});

test("DashboardServer caches and replays shutdown-requested and app-shutdown", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 3,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  globalEventEmitter.emit("shutdown-requested", {});
  globalEventEmitter.emit("app-shutdown", {});

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 3}`);
  const messages = await collectMessages(ws, 150);
  ws.close();

  const types = messages.map((m) => m.type);
  assert.ok(types.includes("shutdown-requested"), "should replay shutdown-requested");
  assert.ok(types.includes("app-shutdown"), "should replay app-shutdown");
});

test("DashboardServer broadcasts cylinder-cancel when a client sends cylinder-cancel-request", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 10,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  // Observer client: receives broadcasts
  const observer = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 10}`);
  const received: DashboardEvent[] = [];
  observer.on("message", (data: Buffer) => {
    received.push(JSON.parse(data.toString()) as DashboardEvent);
  });
  await new Promise<void>((resolve) => observer.once("open", resolve));

  // Sender client: sends a cancel request for engine 1
  const sender = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 10}`);
  await new Promise<void>((resolve) => sender.once("open", resolve));
  sender.send(JSON.stringify({ type: "cylinder-cancel-request", engineIndex: 1 }));

  // Wait for the broadcast to arrive
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  observer.close();
  sender.close();

  const cancelMsg = received.find((m) => m.type === "cylinder-cancel");
  assert.ok(cancelMsg !== undefined, "observer should receive cylinder-cancel broadcast");
  assert.equal(cancelMsg?.data.engineIndex, 1, "cylinder-cancel should carry the correct engineIndex");
});
