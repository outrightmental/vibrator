import test from "node:test";
import assert from "node:assert/strict";
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
