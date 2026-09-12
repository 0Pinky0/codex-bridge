import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BridgeClient } from "../dist/client.js";
import { BridgeDaemon } from "../dist/daemon.js";
import { EXIT } from "../dist/outcome.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_APP_SERVER = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
let cliSocketCounter = 0;

function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function withDaemon(fn, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "cbr-cli-home-"));
  const socketPath = join(tmpdir(), `cbr-cli-${process.pid}-${cliSocketCounter++}.sock`);
  const daemon = new BridgeDaemon({ home, socketPath, codexPath: FAKE_APP_SERVER, ...options });
  await daemon.start();
  const client = new BridgeClient(socketPath);
  try {
    await fn(client, socketPath);
  } finally {
    daemon.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("watch returns promptly with exit 0 for an already-completed run", async () => {
  await withDaemon(async (client, socketPath) => {
    const { runId } = await client.send({ op: "dispatch", cwd: process.cwd(), prompt: "ok:done" });
    await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);

    const result = await runCli(["watch", runId, "--socket", socketPath]);
    assert.equal(result.signal, null);
    assert.equal(result.code, EXIT.OK);
    assert.equal(JSON.parse(result.stdout).state, "completed");
    assert.match(result.stderr, /run .* completed/);
  });
});

test("watch exits 10 and never describes a blocked run as success", async () => {
  await withDaemon(async (client, socketPath) => {
    const { runId } = await client.send({ op: "dispatch", cwd: process.cwd(), prompt: "approve:touch marker" });
    const blocked = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
    assert.equal(blocked.state, "blocked");

    const result = await runCli(["watch", runId, "--socket", socketPath]);
    assert.equal(result.code, EXIT.BLOCKED);
    assert.equal(JSON.parse(result.stdout).state, "blocked");
    assert.match(result.stderr, /BLOCKED and needs a human answer/);
    assert.doesNotMatch(result.stderr, /success|completed/i);
  });
});

test("watch survives a bounded window and exits when the run later settles", async () => {
  await withDaemon(async (client, socketPath) => {
    const { runId } = await client.send({ op: "dispatch", cwd: process.cwd(), prompt: "hang" });
    const startedAt = Date.now();
    const watching = runCli(["watch", runId, "--timeout", "1", "--socket", socketPath]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await client.send({ op: "interrupt", runId });

    const result = await watching;
    assert.ok(Date.now() - startedAt >= 1000, "watch must cross the daemon's minimum bounded window");
    assert.equal(result.code, EXIT.INTERRUPTED);
    assert.equal(JSON.parse(result.stdout).state, "interrupted");
    assert.match(result.stderr, /was interrupted/);
  });
});

test("watch survives daemon stop/start and reports the orphaned run", async () => {
  const home = mkdtempSync(join(tmpdir(), "cbr-watch-restart-home-"));
  const socketPath = join(tmpdir(), `cbr-watch-restart-${process.pid}-${Date.now()}.sock`);
  const env = {
    ...process.env,
    CODEX_BRIDGE_HOME: home,
    CODEX_BRIDGE_SOCKET: socketPath,
    CODEX_BIN: FAKE_APP_SERVER,
    FAKE_APP_SERVER_STATE: join(home, "fake-threads.json"),
  };
  const daemon = spawn(process.execPath, [CLI, "daemon", "--foreground"], {
    env,
    stdio: "ignore",
  });
  const client = new BridgeClient(socketPath);
  try {
    const deadline = Date.now() + 5000;
    while (!(await client.isRunning()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await client.isRunning(), true, "isolated daemon did not start");
    const { runId } = await client.send({ op: "dispatch", cwd: process.cwd(), prompt: "hang" });
    assert.equal((await client.send({ op: "status", runId })).state, "running");

    const watching = runCli([
      "watch", runId, "--timeout", "1000", "--retry-unreachable", "5000", "--socket", socketPath,
    ], env);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = await runCli(["daemon", "stop", "--socket", socketPath], env);
    assert.equal(stopped.code, EXIT.OK);
    const daemonExit = await new Promise((resolve) =>
      daemon.once("close", (code, signal) => resolve({ code, signal })),
    );
    assert.deepEqual(daemonExit, { code: EXIT.OK, signal: null });

    const started = await runCli(["daemon", "start", "--socket", socketPath], env);
    assert.equal(started.code, EXIT.OK, started.stderr);
    const result = await watching;
    assert.equal(result.code, EXIT.FAILED, result.stderr);
    assert.notEqual(result.code, EXIT.UNREACHABLE);
    const record = JSON.parse(result.stdout);
    assert.equal(record.state, "failed");
    assert.match(record.error, /orphaned/);
    assert.match(record.error, new RegExp(`resume ${runId}`));
    assert.match(result.stderr, /failed: orphaned/);
    const events = await client.send({ op: "events", runId, since: 0, limit: 200 });
    assert.ok(events.some((event) => event.method === "bridge/orphaned"));
  } finally {
    if (await client.isRunning()) {
      await runCli(["daemon", "stop", "--socket", socketPath], env);
      const deadline = Date.now() + 5000;
      while (await client.isRunning() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(await client.isRunning(), false, "restarted test daemon did not stop");
    }
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("watch exits 14 after the unreachable retry window and reports its duration", async () => {
  const socketPath = join(tmpdir(), `cbr-watch-absent-${process.pid}-${Date.now()}.sock`);
  const startedAt = Date.now();
  const result = await runCli([
    "watch", "run-anything", "--retry-unreachable", "150", "--socket", socketPath,
  ]);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.code, EXIT.UNREACHABLE);
  assert.notEqual(result.code, EXIT.OK);
  assert.ok(elapsedMs >= 120, `retry ended too early after ${elapsedMs}ms`);
  assert.match(result.stderr, /after retrying for \d+ms \(limit: 150ms\)/);
});

test("watch does not retry a daemon refusal for an unknown run", async () => {
  await withDaemon(async (_client, socketPath) => {
    const startedAt = Date.now();
    const result = await runCli([
      "watch", "run-does-not-exist", "--retry-unreachable", "5000", "--socket", socketPath,
    ]);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.stderr, /unknown run 'run-does-not-exist'/);
    assert.ok(elapsedMs < 1000, `daemon refusal was not prompt (${elapsedMs}ms)`);
  });
});

test("--retry-unreachable 0 restores immediate exit 14", async () => {
  const socketPath = join(tmpdir(), `cbr-watch-no-retry-${process.pid}-${Date.now()}.sock`);
  const startedAt = Date.now();
  const result = await runCli([
    "watch", "run-anything", "--retry-unreachable", "0", "--socket", socketPath,
  ]);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.code, EXIT.UNREACHABLE);
  assert.ok(elapsedMs < 1000, `disabled retry was not immediate (${elapsedMs}ms)`);
  assert.doesNotMatch(result.stderr, /after retrying/);
});

test("daemon stop can explicitly target and clean up a custom socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "cbr-custom-home-"));
  const socketPath = join(tmpdir(), `cbr-custom-${process.pid}-${Date.now()}.sock`);
  const env = {
    ...process.env,
    CODEX_BRIDGE_HOME: home,
    CODEX_BRIDGE_SOCKET: socketPath,
    CODEX_BIN: FAKE_APP_SERVER,
  };
  const daemon = spawn(process.execPath, [CLI, "daemon", "--foreground"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const client = new BridgeClient(socketPath);
  try {
    const deadline = Date.now() + 5000;
    while (!(await client.isRunning()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await client.isRunning(), true, "custom-socket daemon did not start");

    const result = await runCli(["daemon", "stop", "--socket", socketPath], env);
    assert.equal(result.code, EXIT.OK);
    assert.deepEqual(JSON.parse(result.stdout), { stopping: true });
    const exit = await new Promise((resolve) => daemon.once("close", (code, signal) => resolve({ code, signal })));
    assert.deepEqual(exit, { code: EXIT.OK, signal: null });
    assert.equal(await client.isRunning(), false);
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("watch returns promptly with the stalled exit code", async () => {
  await withDaemon(async (client, socketPath) => {
    const { runId } = await client.send({ op: "dispatch", cwd: process.cwd(), prompt: "hang" });
    const startedAt = Date.now();
    const safetyInterrupt = setTimeout(() => {
      void client.send({ op: "interrupt", runId }).catch(() => {});
    }, 600);
    const result = await runCli(["watch", runId, "--timeout", "1000", "--socket", socketPath]);
    clearTimeout(safetyInterrupt);
    assert.equal(result.code, EXIT.STALLED, result.stderr);
    assert.ok(Date.now() - startedAt < 500, "watch did not wake promptly on the stall");
    assert.equal(JSON.parse(result.stdout).state, "stalled");
    assert.match(result.stderr, /STALLED/);
    assert.doesNotMatch(result.stderr, /success|completed/i);
  }, { stallTimeoutMs: 80 });
});

test("watch --all exits with the blocked run summary as its first line", async () => {
  await withDaemon(async (client, socketPath) => {
    const { runId } = await client.send({ op: "dispatch", cwd: process.cwd(), prompt: "approve:touch marker" });
    const blocked = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
    assert.equal(blocked.state, "blocked");
    const result = await runCli(["watch", "--all", "--socket", socketPath]);
    assert.equal(result.code, EXIT.BLOCKED);
    assert.match(result.stdout.split("\n", 1)[0], new RegExp(`^run ${runId} is BLOCKED`));
    assert.equal(JSON.parse(result.stdout.split("\n").slice(1).join("\n")).runId, runId);
  });
});

test("watch --all returns the heartbeat code when enabled", async () => {
  await withDaemon(async (client, socketPath) => {
    await client.send({ op: "dispatch", cwd: process.cwd(), prompt: "hang" });
    const result = await runCli(["watch", "--all", "--heartbeat", "80", "--socket", socketPath]);
    assert.equal(result.code, EXIT.HEARTBEAT);
    assert.match(result.stdout, /HEARTBEAT/);
  });
});

test("watch --all reports no in-flight runs with the heartbeat code", async () => {
  await withDaemon(async (_client, socketPath) => {
    const result = await runCli(["watch", "--all", "--socket", socketPath]);
    assert.equal(result.code, EXIT.HEARTBEAT);
    assert.match(result.stdout.split("\n", 1)[0], /no in-flight runs/);
    assert.doesNotMatch(result.stdout, /completed/);
  });
});
