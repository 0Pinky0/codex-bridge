import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, subscribeMcpToRunStates } from "../dist/mcp.js";

/**
 * The MCP surface has no exit codes, so the blocked/completed distinction has
 * to survive in the payload itself. These tests pin that: a run parked on a
 * question must be unmistakable both to a caller that reads only the prose and
 * to one that reads only the structured content.
 */

/** A stand-in for the daemon: records what was sent, replies with a script. */
function fakeClient(handler) {
  const sent = [];
  return {
    sent,
    async ensureDaemon() {
      return false;
    },
    async send(request, timeoutMs) {
      sent.push({ request, timeoutMs });
      return handler(request);
    },
  };
}

function record(overrides = {}) {
  return {
    runId: "run-test",
    threadId: "thread-1",
    turnId: "turn-1",
    state: "completed",
    cwd: "/repo",
    model: null,
    sandbox: null,
    approvalPolicy: null,
    policy: {},
    createdAtMs: 1,
    updatedAtMs: 2,
    finalMessage: null,
    proseQuestionHint: false,
    error: null,
    pending: [],
    eventCount: 3,
    ...overrides,
  };
}

const BLOCKED = record({
  state: "blocked",
  pending: [
    {
      requestId: 0,
      method: "item/commandExecution/requestApproval",
      kind: "exec",
      summary: "run: /bin/bash -lc 'rm -rf build'",
      isBlocking: true,
      params: {},
      createdAtMs: 1,
    },
  ],
});

async function connect(handler) {
  const client = new Client({ name: "test", version: "0" });
  const server = createMcpServer({ client: fakeClient(handler), entrypoint: "/dev/null" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("daemon state events are forwarded through the SDK logging notification API", async () => {
  let forward;
  const inner = fakeClient(() => ({}));
  inner.subscribe = async (handler) => {
    forward = handler;
    return () => {};
  };
  const client = new Client({ name: "test", version: "0" });
  const server = createMcpServer({ client: inner, entrypoint: "/dev/null" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const received = new Promise((resolve) => {
    client.setNotificationHandler(LoggingMessageNotificationSchema, resolve);
  });
  await Promise.all([server.connect(b), client.connect(a)]);
  await subscribeMcpToRunStates({ client: inner, entrypoint: "/dev/null" }, server);

  forward({ type: "runStateChanged", record: { runId: "run-push", state: "blocked" } });
  const notification = await received;
  assert.equal(notification.method, "notifications/message");
  assert.equal(notification.params.level, "notice");
  assert.equal(notification.params.data.type, "runStateChanged");
  assert.equal(notification.params.data.record.state, "blocked");
  await client.close();
});

test("every bridge operation is reachable as a tool", async () => {
  const client = await connect(() => ({}));
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "codex_answer",
    "codex_dispatch",
    "codex_events",
    "codex_interrupt",
    "codex_list",
    "codex_resume",
    "codex_status",
    "codex_wait",
  ]);
  await client.close();
});

test("a blocked run is unmistakable in both the text and the structure", async () => {
  const client = await connect(() => BLOCKED);
  const result = await client.callTool({ name: "codex_status", arguments: { runId: "run-test" } });

  assert.match(result.content[0].text, /BLOCKED and needs a human answer/);
  assert.match(result.content[0].text, /rm -rf build/);
  assert.equal(result.structuredContent.needsHuman, true);
  assert.equal(result.structuredContent.state, "blocked");
  // The same code the CLI would exit with, so the two surfaces cannot disagree.
  assert.equal(result.structuredContent.exitCode, 10);
  await client.close();
});

test("a completed run reports needsHuman false and carries the final message", async () => {
  const client = await connect(() => record({ finalMessage: "refactor done" }));
  const result = await client.callTool({ name: "codex_status", arguments: { runId: "run-test" } });
  assert.equal(result.structuredContent.needsHuman, false);
  assert.equal(result.structuredContent.exitCode, 0);
  assert.match(result.content[0].text, /refactor done/);
  await client.close();
});

test("a prose-question advisory is structured and textual without fabricating blocked", async () => {
  const client = await connect(() =>
    record({ finalMessage: "Please confirm the next step.", proseQuestionHint: true }),
  );
  const result = await client.callTool({ name: "codex_status", arguments: { runId: "run-test" } });
  assert.equal(result.structuredContent.state, "completed");
  assert.equal(result.structuredContent.needsHuman, false);
  assert.equal(result.structuredContent.proseQuestionHint, true);
  assert.equal(result.structuredContent.exitCode, 0);
  assert.match(result.content[0].text.split("\n")[0], /ADVISORY/);
  await client.close();
});

test("a wait that times out is reported as unfinished, never as a completion", async () => {
  // The daemon's bounded wait returns the record as-is when the window elapses.
  const client = await connect(() => record({ state: "running" }));
  const result = await client.callTool({ name: "codex_wait", arguments: { runId: "run-test" } });

  assert.equal(result.structuredContent.timedOut, true);
  assert.equal(result.structuredContent.state, "running");
  assert.equal(result.structuredContent.exitCode, 11);
  assert.equal(result.structuredContent.needsHuman, false);
  assert.match(result.content[0].text, /has NOT finished/);
  assert.match(result.content[0].text, /call codex_wait again/i);
  await client.close();
});

test("a wait that settles is not marked as timed out", async () => {
  for (const state of ["completed", "failed", "interrupted", "blocked"]) {
    const client = await connect(() => record({ state, error: "boom" }));
    const result = await client.callTool({ name: "codex_wait", arguments: { runId: "run-test" } });
    assert.equal(result.structuredContent.timedOut, false, state);
    await client.close();
  }
});

test("wait is bounded, and the socket timeout outlives the daemon's own", async () => {
  const inner = fakeClient(() => record({ state: "running" }));
  const client = new Client({ name: "test", version: "0" });
  const server = createMcpServer({ client: inner, entrypoint: "/dev/null" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  await client.callTool({ name: "codex_wait", arguments: { runId: "run-test" } });
  const [{ request, timeoutMs }] = inner.sent;
  assert.equal(request.op, "wait");
  assert.equal(request.timeoutMs, 60000, "an unbounded wait would surface as a transport error");
  // If the socket gave up first we could only report "something went wrong",
  // instead of the run state that is the whole point of the call.
  assert.ok(timeoutMs > request.timeoutMs, `socket timeout ${timeoutMs} must exceed the daemon wait`);
  await client.close();
});

test("a wait longer than the cap is refused rather than silently shortened", async () => {
  const client = await connect(() => record());
  const result = await client.callTool({
    name: "codex_wait",
    arguments: { runId: "run-test", timeoutMs: 999_999 },
  });
  assert.equal(result.isError, true);
  await client.close();
});

test("dispatch forwards the policy and does not invent a default", async () => {
  const inner = fakeClient(() => ({ runId: "run-new", threadId: "t" }));
  const client = new Client({ name: "test", version: "0" });
  const server = createMcpServer({ client: inner, entrypoint: "/dev/null" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  await client.callTool({
    name: "codex_dispatch",
    arguments: { cwd: "/repo", prompt: "go", policy: { exec: "approve" } },
  });
  assert.deepEqual(inner.sent[0].request.policy, { exec: "approve" });

  await client.callTool({ name: "codex_dispatch", arguments: { cwd: "/repo", prompt: "go" } });
  assert.deepEqual(inner.sent[1].request.policy, {}, "an unset policy must mean ask, not approve");
  await client.close();
});

test("a policy naming a kind the bridge cannot satisfy is rejected at the boundary", async () => {
  const client = await connect(() => ({ runId: "r", threadId: "t" }));
  const result = await client.callTool({
    name: "codex_dispatch",
    arguments: { cwd: "/repo", prompt: "go", policy: { internal: "approve" } },
  });
  assert.equal(result.isError, true);
  await client.close();
});

test("dispatch without wait does not pretend to know the outcome", async () => {
  const client = await connect(() => ({ runId: "run-new", threadId: "t" }));
  const result = await client.callTool({
    name: "codex_dispatch",
    arguments: { cwd: "/repo", prompt: "go" },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.runId, "run-new");
  assert.equal(payload.state, undefined, "a started run has no outcome yet");
  assert.match(payload.note, /poll with codex_status or codex_wait/);
  await client.close();
});

test("resume reports the run it actually continued under", async () => {
  const inner = fakeClient(() => ({ runId: "run-fresh", resumedFrom: "run-old" }));
  const client = new Client({ name: "test", version: "0" });
  const server = createMcpServer({ client: inner, entrypoint: "/dev/null" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  const result = await client.callTool({
    name: "codex_resume",
    arguments: { runId: "run-old", prompt: "keep going", newRun: true },
  });
  assert.equal(inner.sent[0].request.op, "resume");
  assert.equal(inner.sent[0].request.newRun, true);
  assert.equal(JSON.parse(result.content[0].text).runId, "run-fresh");
  await client.close();
});

test("list surfaces how many runs are waiting on a human", async () => {
  const client = await connect(() => [BLOCKED, record({ runId: "run-done" })]);
  const result = await client.callTool({ name: "codex_list", arguments: {} });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.blockedCount, 1);
  assert.equal(payload.runs.length, 2);
  assert.equal(payload.runs[0].needsHuman, true);
  assert.equal(payload.runs[0].pending[0].summary, "run: /bin/bash -lc 'rm -rf build'");
  await client.close();
});

test("a daemon-side failure becomes a tool error, not a fabricated success", async () => {
  const client = await connect(() => {
    throw new Error("no parked interaction '9' on this run; outstanding: 0");
  });
  const result = await client.callTool({
    name: "codex_answer",
    arguments: { runId: "run-test", requestId: 9, answer: "accept" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no parked interaction/);
  await client.close();
});

test("a numeric requestId reaches the daemon in the form it keys parked requests by", async () => {
  const inner = fakeClient(() => ({ answered: "0", remaining: 0 }));
  const client = new Client({ name: "test", version: "0" });
  const server = createMcpServer({ client: inner, entrypoint: "/dev/null" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  await client.callTool({
    name: "codex_answer",
    arguments: { runId: "run-test", requestId: 0, answer: "accept" },
  });
  assert.equal(inner.sent[0].request.requestId, "0");
  await client.close();
});
