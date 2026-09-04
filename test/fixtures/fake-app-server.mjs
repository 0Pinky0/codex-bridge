#!/usr/bin/env node
/**
 * A stand-in for `codex app-server --stdio`.
 *
 * The daemon's most important behaviour -- routing a server-initiated request
 * to a run, parking it, and releasing it on an answer -- can only be exercised
 * by a peer that actually sends one. Asserting against the real `codex` would
 * make these tests depend on a model's choices; asserting against nothing would
 * leave the daemon's own wiring untested. So this speaks the protocol and takes
 * its orders from the prompt text:
 *
 *   ok:<text>     complete the turn with <text> as the final answer
 *   approve:<cmd> send an exec approval request, then complete or fail on it
 *   hang          start the turn and never finish it
 *   crash         exit the process mid-turn
 */

let buffer = "";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

let nextId = 1000;
const pending = new Map();

/**
 * Thread state, persisted when FAKE_APP_SERVER_STATE names a file.
 *
 * The real App Server keeps threads on disk, which is what makes a resume work
 * after a restart. A fake that forgot its threads on exit would make the
 * across-a-restart resume test pass or fail for reasons that have nothing to do
 * with the bridge.
 */
const STATE_PATH = process.env.FAKE_APP_SERVER_STATE ?? null;
const threads = new Map(loadThreads());

function loadThreads() {
  if (!STATE_PATH || !existsSync(STATE_PATH)) return [];
  try {
    return Object.entries(JSON.parse(readFileSync(STATE_PATH, "utf8")));
  } catch {
    return [];
  }
}

function persistThreads() {
  if (!STATE_PATH) return;
  writeFileSync(STATE_PATH, JSON.stringify(Object.fromEntries(threads)), "utf8");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function completeTurn(threadId, status, text) {
  const thread = threads.get(threadId);
  if (!thread || thread.done) return;
  thread.done = true;
  notify("turn/completed", {
    threadId,
    turn: {
      id: thread.turnId,
      status,
      items: text ? [{ type: "agentMessage", phase: "final_answer", text }] : [],
      error: status === "failed" ? { message: "fake failure" } : null,
    },
  });
}

function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    // A response to one of our server-initiated requests.
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.error ? { error: message.error } : { result: message.result });
    }
    return;
  }

  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      reply(id, { userAgent: "fake-app-server/0", platformOs: "test" });
      return;
    case "thread/start": {
      const threadId = `thread-${process.pid}-${nextId++}`;
      threads.set(threadId, { turnId: null, done: true });
      persistThreads();
      reply(id, { thread: { id: threadId } });
      return;
    }
    case "thread/resume": {
      const threadId = params.threadId;
      if (!threads.has(threadId)) {
        // An unknown thread is an error, not a silent new thread: a resume that
        // quietly started fresh would lose the history it was asked to keep.
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown thread ${threadId}` } });
        return;
      }
      const thread = threads.get(threadId);
      thread.resumed = (thread.resumed ?? 0) + 1;
      persistThreads();
      reply(id, { thread: { id: threadId } });
      return;
    }
    case "turn/start": {
      const threadId = params.threadId;
      const turnId = `turn-${nextId++}`;
      threads.set(threadId, { ...(threads.get(threadId) ?? {}), turnId, done: false });
      persistThreads();
      reply(id, { turnId });
      notify("turn/started", { threadId, turn: { id: turnId } });
      void runTurn(threadId, String(params.input?.[0]?.text ?? ""));
      return;
    }
    case "turn/interrupt": {
      reply(id, {});
      completeTurn(params.threadId, "interrupted", null);
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

async function runTurn(threadId, prompt) {
  if (prompt.startsWith("ok:")) {
    completeTurn(threadId, "completed", prompt.slice(3));
    return;
  }
  if (prompt === "hang") return;
  if (prompt === "crash") {
    process.exit(3);
  }
  if (prompt.startsWith("approve:")) {
    const id = nextId++;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    send({
      jsonrpc: "2.0",
      id,
      method: "item/commandExecution/requestApproval",
      params: { threadId, command: ["/bin/bash", "-lc", prompt.slice(8)], isBlocking: true },
    });
    const outcome = await answer;
    if (outcome.error) {
      completeTurn(threadId, "failed", null);
      return;
    }
    const decision = outcome.result?.decision;
    const accepted = decision === "accept" || decision === "acceptForSession";
    completeTurn(threadId, accepted ? "completed" : "failed", accepted ? "approved and ran" : null);
    return;
  }
  completeTurn(threadId, "completed", `echo: ${prompt}`);
}
