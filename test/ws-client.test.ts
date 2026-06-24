import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { WsClient } from "../src/dashboard/store/ws-client.js";

const BASE_PORT = 19_700;

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test("WsClient: onConnectionChange(true) is called when WebSocket opens", async (t) => {
  const port = BASE_PORT;
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const client = new WsClient(
    `ws://127.0.0.1:${port}`,
    () => {},
    undefined,
    (connected) => { connectionChange = connected; }
  );
  t.after(() => { client.close(); wss.close(); });

  let connectionChange: boolean | null = null;
  client.connect();

  await waitMs(150);

  assert.equal(connectionChange, true, "onConnectionChange should be called with true when WebSocket opens");
});

test("WsClient: onConnectionChange(false) is called when WebSocket closes", async (t) => {
  const port = BASE_PORT + 1;
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const client = new WsClient(
    `ws://127.0.0.1:${port}`,
    () => {},
    undefined,
    (connected) => { states.push(connected); }
  );
  t.after(() => { client.close(); wss.close(); });

  const states: boolean[] = [];
  client.connect();

  await waitMs(150);
  assert.equal(states[0], true, "first change should be true (connected)");

  // Close server to trigger disconnect
  wss.clients.forEach(ws => ws.close());
  await waitMs(150);

  assert.equal(states.at(-1), false, "last change should be false (disconnected)");
});

test("WsClient: onConnectionChange(false) is called when connection is refused", async (t) => {
  const port = BASE_PORT + 2;

  let connectionChange: boolean | null = null;
  const client = new WsClient(
    `ws://127.0.0.1:${port}`,
    () => {},
    undefined,
    (connected) => { connectionChange = connected; }
  );
  t.after(() => client.close());
  client.connect();

  await waitMs(500);

  assert.equal(connectionChange, false, "onConnectionChange should be called with false when connection is refused");
});

test("DashboardStore: connection becomes 'connected' after connectLive WebSocket opens", async (t) => {
  const port = BASE_PORT + 3;
  const { DashboardServer } = await import("../src/dashboard-server.js");

  const server = new DashboardServer({
    port,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();

  // Polyfill fetch to hit the test server instead of location.host
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    return origFetch(`http://127.0.0.1:${port}${path}`, init);
  }) as typeof fetch;

  const { DashboardStore } = await import("../src/dashboard/store/dashboard-store.js");
  const store = new DashboardStore();
  t.after(() => { store.disconnect(); server.close(); globalThis.fetch = origFetch; });

  await store.bootstrap();

  const wsUrl = `ws://127.0.0.1:${port}/api/ws`;
  store.connectLive(wsUrl);

  await waitMs(300);

  assert.equal(store.getState().connection, "connected", "store connection should be 'connected' after WebSocket opens");
});

test("DashboardStore: connection becomes 'disconnected' when WebSocket server closes", async (t) => {
  const port = BASE_PORT + 4;
  const { DashboardServer } = await import("../src/dashboard-server.js");

  const server = new DashboardServer({
    port,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();

  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    return origFetch(`http://127.0.0.1:${port}${path}`, init);
  }) as typeof fetch;

  const { DashboardStore } = await import("../src/dashboard/store/dashboard-store.js");
  const store = new DashboardStore();
  t.after(() => { store.disconnect(); globalThis.fetch = origFetch; });

  await store.bootstrap();

  const wsUrl = `ws://127.0.0.1:${port}/api/ws`;
  store.connectLive(wsUrl);

  await waitMs(300);
  assert.equal(store.getState().connection, "connected");

  // Now close the server and verify disconnection is detected
  server.close();
  await waitMs(500);

  assert.equal(store.getState().connection, "disconnected", "store connection should be 'disconnected' after server closes");
});
