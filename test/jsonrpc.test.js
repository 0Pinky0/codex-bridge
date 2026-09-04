import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { JsonRpcPeer } from "../dist/jsonrpc.js";

/** Wire a peer to two pipes and collect everything it writes, line by line. */
function makePeer(handlers = {}) {
  const inbound = new PassThrough(); // what the "server" sends us
  const outbound = new PassThrough(); // what the peer writes back
  const written = [];
  outbound.setEncoding("utf8");
  outbound.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) written.push(JSON.parse(line));
    }
  });
  const peer = new JsonRpcPeer(inbound, outbound, handlers);
  const send = (message) => inbound.write(JSON.stringify(message) + "\n");
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { peer, send, written, settle };
}

test("a request is matched to its response by id", async () => {
  const { peer, send, written } = makePeer();
  const promise = peer.request("thread/start", { cwd: "/tmp" });
  assert.equal(written.length, 1);
  assert.equal(written[0].method, "thread/start");
  assert.deepEqual(written[0].params, { cwd: "/tmp" });
  send({ jsonrpc: "2.0", id: written[0].id, result: { threadId: "t-1" } });
  assert.deepEqual(await promise, { threadId: "t-1" });
});

test("a JSON-RPC error rejects with its code intact", async () => {
  const { peer, send, written } = makePeer();
  const promise = peer.request("turn/start");
  send({ jsonrpc: "2.0", id: written[0].id, error: { code: -32602, message: "bad params" } });
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, -32602);
    assert.equal(error.message, "bad params");
    return true;
  });
});

test("notifications are delivered without an id", async () => {
  const seen = [];
  const { send, settle } = makePeer({ onNotification: (method, params) => seen.push([method, params]) });
  send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t-1" } });
  await settle();
  assert.deepEqual(seen, [["turn/completed", { threadId: "t-1" }]]);
});

test("a server-initiated request is answered, not treated as a notification", async () => {
  const { send, written, settle } = makePeer({
    onRequest: async (method, params, id) => {
      assert.equal(method, "item/commandExecution/requestApproval");
      assert.equal(id, 99);
      assert.deepEqual(params, { command: "ls" });
      return { decision: "accept" };
    },
  });
  send({ jsonrpc: "2.0", id: 99, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
  await settle();
  await settle();
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], { jsonrpc: "2.0", id: 99, result: { decision: "accept" } });
});

test("with no handler an inbound request gets an error, never silence", async () => {
  // Silence here would hang the turn forever, which from the outside is
  // indistinguishable from a long-running task -- the exact failure this tool
  // was built to eliminate.
  const { send, written, settle } = makePeer();
  send({ jsonrpc: "2.0", id: 5, method: "item/tool/requestUserInput", params: {} });
  await settle();
  assert.equal(written.length, 1);
  assert.equal(written[0].id, 5);
  assert.equal(written[0].error.code, -32601);
});

test("a throwing handler produces a JSON-RPC error response", async () => {
  const { send, written, settle } = makePeer({
    onRequest: async () => {
      throw new Error("cannot satisfy this");
    },
  });
  send({ jsonrpc: "2.0", id: 6, method: "attestation/generate" });
  await settle();
  await settle();
  assert.equal(written[0].error.message, "cannot satisfy this");
});

test("an unparseable line is reported, not silently skipped", async () => {
  const errors = [];
  const seen = [];
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  new JsonRpcPeer(inbound, outbound, {
    onTransportError: (error) => errors.push(error.message),
    onNotification: (method) => seen.push(method),
  });
  inbound.write("this is not json\n");
  // The peer must survive the bad line and keep processing the stream.
  inbound.write('{"jsonrpc":"2.0","method":"turn/started"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unparseable JSON-RPC line/);
  assert.deepEqual(seen, ["turn/started"]);
});

test("a message split across chunks is reassembled", async () => {
  const seen = [];
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  new JsonRpcPeer(inbound, outbound, { onNotification: (method) => seen.push(method) });
  inbound.write('{"jsonrpc":"2.0","method":"turn/');
  inbound.write('started"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["turn/started"]);
});

test("closing rejects every in-flight request", async () => {
  const { peer } = makePeer();
  const promise = peer.request("thread/start");
  peer.close("app server closed");
  await assert.rejects(promise, /app server closed/);
  assert.equal(peer.closed, true);
});
