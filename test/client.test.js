import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeClient, BridgeRequestError } from "../dist/client.js";

async function controlServer(t, onSubscribe) {
  const home = mkdtempSync(join(tmpdir(), "cbr-sub-"));
  const path = join(home, "s.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", (data) => {
      assert.equal(JSON.parse(data.toString()).op, "subscribe");
      onSubscribe(socket);
    });
  });
  server.listen(path);
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  return new BridgeClient(path);
}

test("subscription preserves notifications sent in the acknowledgement chunk", { timeout: 3000 }, async (t) => {
  const client = await controlServer(t, (socket) => socket.write([
    JSON.stringify({ ok: true, result: { subscribed: true } }),
    JSON.stringify({ notification: "run/stateChanged", record: { runId: "run-question", state: "blocked" } }),
    "",
  ].join("\n")));
  const notifications = [];
  const close = await client.subscribe((event) => notifications.push(event));
  close();
  assert.deepEqual(notifications, [{ type: "runStateChanged", record: { runId: "run-question", state: "blocked" } }]);
});

test("subscription refusal is a daemon response, not an outage", { timeout: 3000 }, async (t) => {
  const client = await controlServer(t, (socket) => socket.end(JSON.stringify({ ok: false, error: "refused" }) + "\n"));
  await assert.rejects(client.subscribe(() => {}), (error) =>
    error instanceof BridgeRequestError && error.unreachable === false && error.message === "refused");
});

test("subscription reports a post-acknowledgement disconnect exactly once", { timeout: 3000 }, async (t) => {
  const client = await controlServer(t, (socket) => socket.end(JSON.stringify({ ok: true }) + "\n"));
  let calls = 0;
  const disconnected = new Promise((resolve) => {
    void client.subscribe(() => {}, 1000, (error) => { calls += 1; resolve(error); });
  });
  const error = await disconnected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(error instanceof BridgeRequestError);
  assert.equal(error.unreachable, true);
  assert.match(error.message, /daemon closed the subscription/);
  assert.equal(calls, 1);
});

test("explicit unsubscribe does not report an outage", { timeout: 3000 }, async (t) => {
  const client = await controlServer(t, (socket) => socket.write(JSON.stringify({ ok: true }) + "\n"));
  const errors = [];
  const close = await client.subscribe(() => {}, 1000, (error) => errors.push(error));
  close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(errors, []);
});

test("malformed subscription data after acknowledgement fails visibly", { timeout: 3000 }, async (t) => {
  const client = await controlServer(t, (socket) => socket.write(JSON.stringify({ ok: true }) + "\n{broken\n"));
  const disconnected = new Promise((resolve) => {
    void client.subscribe(() => {}, 1000, resolve);
  });
  const error = await disconnected;
  assert.ok(error instanceof BridgeRequestError);
  assert.equal(error.unreachable, true);
  assert.match(error.message, /malformed subscription JSON/);
});
