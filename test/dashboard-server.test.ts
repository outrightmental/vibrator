import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import { DashboardServer } from "../src/dashboard-server.js";
import { globalEventEmitter } from "../src/event-emitter.js";
import type { DashboardEvent } from "../src/event-emitter.js";

const TEST_PORT = 19_876;

function httpGet(url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on("error", reject);
  });
}

function collectWsMessages(ws: WebSocket, afterOpenMs: number): Promise<DashboardEvent[]> {
  const received: DashboardEvent[] = [];
  ws.on("message", (data: Buffer) => {
    received.push(JSON.parse(data.toString()) as DashboardEvent);
  });
  return new Promise((resolve) => {
    ws.once("open", () => setTimeout(() => resolve(received), afterOpenMs));
    ws.once("error", () => resolve(received));
  });
}

// ── GET /api/state ────────────────────────────────────────────────────────────

test("GET /api/state returns cached events as JSON after emissions", async (t) => {
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

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/api/state`);
  assert.equal(res.status, 200);
  assert.ok(res.headers["content-type"]?.includes("application/json"), "should be JSON");

  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const types = data.cachedEvents.map((e) => e.type);
  assert.ok(types.includes("lifecycle-update"), "should include lifecycle-update");
  assert.ok(types.includes("snapshot-update"), "should include snapshot-update");
  assert.ok(types.includes("action-start"), "should include action-start");
});

// ── GET /api/health ───────────────────────────────────────────────────────────

test("GET /api/health returns 200 with ok:true", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 1,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 1}/api/health`);
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body) as { ok: boolean; version: string };
  assert.equal(data.ok, true);
  assert.ok(typeof data.version === "string" && data.version.length > 0, "version should be a non-empty string");
});

// ── GET / ─────────────────────────────────────────────────────────────────────

test("GET / serves index.html containing bundle script tag", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 2,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 2}/`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('/assets/bundle.js'), "index.html should reference /assets/bundle.js");
});

// ── WS /api/ws ────────────────────────────────────────────────────────────────

test("WS /api/ws delivers emitted events as JSON", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 3,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 3}/api/ws`);
  const messagesPromise = collectWsMessages(ws, 100);

  await new Promise<void>((resolve) => ws.once("open", resolve));
  globalEventEmitter.emit("lifecycle-update", { pairs: [] });
  globalEventEmitter.emit("snapshot-update", { issueCount: 0, prCount: 0, sessionCount: 1, issues: [], pullRequests: [] });

  const messages = await messagesPromise;
  ws.close();

  const types = messages.map((m) => m.type);
  assert.ok(types.includes("lifecycle-update"), "should receive lifecycle-update live");
  assert.ok(types.includes("snapshot-update"), "should receive snapshot-update live");
});

test("WS upgrade to non-/api/ws path is rejected", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 8,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  await assert.rejects(
    async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 8}/wrong-path`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        ws.once("close", () => reject(new Error("closed")));
      });
    },
    "upgrade to wrong path should be rejected"
  );
});

// ── Cache replacement tests (via /api/state) ──────────────────────────────────

test("DashboardServer replaces cylinder cache on iteration-start", async (t) => {
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
    type: "self-review",
    issueNumber: 5,
    description: "reviewing",
  });
  globalEventEmitter.emit("iteration-start", {
    engineIndex: 0,
    iterationNumber: 3,
    maxConcurrency: 2,
  });

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 4}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const cylinderMessages = data.cachedEvents.filter(
    (m) => m.type === "action-start" || m.type === "iteration-start",
  );
  assert.equal(cylinderMessages.length, 1, "only one cylinder-0 event should be cached");
  assert.equal(cylinderMessages[0]?.type, "iteration-start", "iteration-start should replace action-start");
});

test("DashboardServer replaces cylinder cache on engine-shutdown", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 5,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  globalEventEmitter.emit("iteration-start", {
    engineIndex: 1,
    iterationNumber: 2,
    maxConcurrency: 2,
  });
  globalEventEmitter.emit("engine-shutdown", { engineIndex: 1 });

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 5}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const cylinderMessages = data.cachedEvents.filter(
    (m) => m.type === "iteration-start" || m.type === "engine-shutdown",
  );
  assert.equal(cylinderMessages.length, 1, "only one cylinder-1 event should be cached");
  assert.equal(cylinderMessages[0]?.type, "engine-shutdown", "engine-shutdown should replace iteration-start");
});

test("DashboardServer replaces cylinder cache on engine-idle", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 6,
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

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 6}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const cylinderMessages = data.cachedEvents.filter((m) => m.type === "action-start" || m.type === "engine-idle");
  assert.equal(cylinderMessages.length, 1, "only one cylinder-0 event should be cached");
  assert.equal(cylinderMessages[0]?.type, "engine-idle", "engine-idle should replace action-start");
});

test("DashboardServer caches engine-idle with nextCycleAtMs", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 9,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const nextCycleAtMs = Date.now() + 45000;
  globalEventEmitter.emit("engine-idle", { engineIndex: 1, nextCycleAtMs });

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 9}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const idleMsg = data.cachedEvents.find((m) => m.type === "engine-idle");
  assert.ok(idleMsg !== undefined, "should cache engine-idle");
  assert.equal(idleMsg?.data["engineIndex"], 1);
  assert.equal(idleMsg?.data["nextCycleAtMs"], nextCycleAtMs, "nextCycleAtMs should be preserved");
});

test("DashboardServer caches engine-idle with rateLimitedUntilMs", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 10,
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

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 10}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const idleMsg = data.cachedEvents.find((m) => m.type === "engine-idle");
  assert.ok(idleMsg !== undefined, "should cache engine-idle");
  assert.equal(idleMsg?.data["rateLimitedUntilMs"], rateLimitedUntilMs, "rateLimitedUntilMs should be preserved");
});

test("DashboardServer caches action-start with startedAt for accurate elapsed-time replay", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 11,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const startedAt = Date.now() - 300_000;
  globalEventEmitter.emit("action-start", {
    actionIndex: 1,
    totalActions: 2,
    type: "start-implementation",
    issueNumber: 42,
    description: "implementing #42",
    startedAt,
  });

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 11}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const actionMsg = data.cachedEvents.find((m) => m.type === "action-start");
  assert.ok(actionMsg !== undefined, "should cache action-start");
  assert.equal(actionMsg?.data["startedAt"], startedAt, "startedAt should be preserved");
});

function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

test("DashboardServer injects custom dashboardTitle into served HTML", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 12,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
    dashboardTitle: "My Custom Title",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const html = await fetchHtml(`http://127.0.0.1:${TEST_PORT + 12}/`);
  assert.ok(html.includes("My Custom Title"), "HTML should contain the custom dashboard title");
});

test("DashboardServer defaults to 'Vibrator' when no dashboardTitle is provided", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 13,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  const html = await fetchHtml(`http://127.0.0.1:${TEST_PORT + 13}/`);
  assert.ok(html.includes("Vibrator"), "HTML should contain the default title 'Vibrator'");
});

test("DashboardServer clears cached github-rate-limit on github-rate-limit-cleared", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 14,
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

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 14}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const rateLimitMsg = data.cachedEvents.find((m) => m.type === "github-rate-limit");
  assert.equal(rateLimitMsg, undefined, "cleared cache should not replay stale github-rate-limit event");
});

test("DashboardServer caches and replays shutdown-requested and app-shutdown via /api/state", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 7,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  globalEventEmitter.emit("shutdown-requested", {});
  globalEventEmitter.emit("app-shutdown", {});

  const res = await httpGet(`http://127.0.0.1:${TEST_PORT + 7}/api/state`);
  const data = JSON.parse(res.body) as { cachedEvents: DashboardEvent[] };
  const types = data.cachedEvents.map((e) => e.type);
  assert.ok(types.includes("shutdown-requested"), "should cache shutdown-requested");
  assert.ok(types.includes("app-shutdown"), "should cache app-shutdown");
});

test("DashboardServer broadcasts cylinder-cancel when a client sends cylinder-cancel-request", async (t) => {
  const server = new DashboardServer({
    port: TEST_PORT + 15,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();
  t.after(() => server.close());

  // Observer client: receives broadcasts
  const observer = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 15}/api/ws`);
  const received: DashboardEvent[] = [];
  observer.on("message", (data: Buffer) => {
    received.push(JSON.parse(data.toString()) as DashboardEvent);
  });
  await new Promise<void>((resolve) => observer.once("open", resolve));

  // Sender client: sends a cancel request for engine 1
  const sender = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 15}/api/ws`);
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
