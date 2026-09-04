import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { AppServer } from "./appserver.js";
import type { JsonRpcId } from "./jsonrpc.js";
import {
  buildAnswerResponse,
  classifyServerRequest,
  declineResponse,
  type InteractionPolicy,
  type PendingInteraction,
} from "./interaction.js";
import { isTerminal, newRunRecord, RunStore, type RunRecord, type RunState } from "./run.js";

/**
 * The bridge daemon.
 *
 * Durability model: this process, not the CLI, owns the App Server child. CLI
 * invocations are transient clients that connect, ask a question, and leave.
 * That is what makes a run survive an SSH drop or a killed terminal -- the
 * failure mode that previously destroyed hours of finished work.
 *
 * Liveness model: run state is derived from App Server events and from the
 * child process itself. There is no self-maintained PID file that a caller is
 * asked to trust, because a stale `running` record with a dead PID is exactly
 * the kind of bookkeeping that blocks a resume and has to be hand-repaired.
 */

export interface DaemonOptions {
  home?: string;
  socketPath?: string;
  codexPath?: string;
  defaultPolicy?: InteractionPolicy;
}

export function defaultHome(): string {
  return process.env["CODEX_BRIDGE_HOME"] ?? join(homedir(), ".codex-bridge");
}

/**
 * Unix domain socket paths are capped by `SUN_LEN` (108 bytes on Linux) and the
 * failure is a bare `path must be shorter than SUN_LEN`, which is easy to
 * misread as a permissions problem. Keep the control socket in a short,
 * predictable directory rather than under the (long) bridge home.
 */
export function defaultSocketPath(): string {
  const override = process.env["CODEX_BRIDGE_SOCKET"];
  if (override) return override;
  const uid = typeof userInfo().uid === "number" ? userInfo().uid : 0;
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  const base = runtimeDir && runtimeDir.length < 60 ? runtimeDir : "/tmp";
  return join(base, `codex-bridge-${uid}`, "control.sock");
}

interface LiveRun {
  record: RunRecord;
  /** Resolvers for parked server requests, keyed by JSON-RPC request id. */
  parked: Map<string, { pending: PendingInteraction; resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  waiters: Array<() => void>;
}

export class BridgeDaemon {
  #store: RunStore;
  #socketPath: string;
  #codexPath: string;
  #policy: InteractionPolicy;
  #appServer: AppServer | null = null;
  #runs = new Map<string, LiveRun>();
  #byThread = new Map<string, string>();
  #startedAtMs = Date.now();
  #server = createServer();

  constructor(options: DaemonOptions = {}) {
    this.#store = new RunStore(options.home ?? defaultHome());
    this.#socketPath = options.socketPath ?? defaultSocketPath();
    this.#codexPath = options.codexPath ?? process.env["CODEX_BIN"] ?? "codex";
    this.#policy = options.defaultPolicy ?? {};
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.#socketPath), { recursive: true });
    if (existsSync(this.#socketPath)) {
      // A leftover socket from a dead daemon must not block startup. Probing it
      // first avoids evicting a healthy daemon.
      const alive = await probeSocket(this.#socketPath);
      if (alive) throw new Error(`a codex-bridge daemon is already listening on ${this.#socketPath}`);
      rmSync(this.#socketPath, { force: true });
    }

    this.#appServer = this.#spawnAppServer();
    await this.#appServer.initialize();

    this.#server.on("connection", (socket) => this.#handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#socketPath, () => resolve());
    });

    writeFileSync(join(this.#store.root, "daemon.json"), JSON.stringify({
      pid: process.pid,
      socketPath: this.#socketPath,
      startedAtMs: this.#startedAtMs,
    }, null, 2) + "\n", "utf8");
  }

  #spawnAppServer(): AppServer {
    return new AppServer({
      codexPath: this.#codexPath,
      onNotification: (method, params) => this.#onNotification(method, params),
      onServerRequest: (method, params, id) => this.#onServerRequest(method, params, id),
      onTransportError: (error) => this.#broadcastBridgeEvent("bridge/transportError", { message: error.message }),
      onExit: (code, signal) => this.#onAppServerExit(code, signal),
    });
  }

  #onAppServerExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Every non-terminal run dies with the child. Marking them `failed` with the
    // real reason is the honest outcome; leaving them `running` would strand a
    // caller waiting on a process that no longer exists.
    const stderr = this.#appServer?.stderrTail ?? "";
    for (const live of this.#runs.values()) {
      if (isTerminal(live.record.state)) continue;
      this.#transition(live, "failed", {
        error: `app-server exited (code=${code}, signal=${signal})${stderr ? `; stderr tail: ${stderr.slice(-500)}` : "; stderr was empty"}`,
      });
    }
    this.#appServer = null;
  }

  // ---------------------------------------------------------------- events

  #onNotification(method: string, params: unknown): void {
    const record = params as Record<string, unknown> | null;
    const threadId = typeof record?.["threadId"] === "string" ? (record["threadId"] as string) : null;
    const live = threadId ? this.#liveByThread(threadId) : null;
    if (!live) return;

    this.#store.appendEvent(live.record, { atMs: Date.now(), method, params });

    switch (method) {
      case "turn/started": {
        const turn = record?.["turn"] as Record<string, unknown> | undefined;
        if (turn && typeof turn["id"] === "string") live.record.turnId = turn["id"];
        this.#transition(live, "running", {});
        break;
      }
      case "turn/completed": {
        const turn = record?.["turn"] as Record<string, unknown> | undefined;
        const status = String(turn?.["status"] ?? "completed");
        const finalMessage = extractFinalMessage(turn);
        if (status === "completed") {
          this.#transition(live, "completed", { finalMessage });
        } else {
          this.#transition(live, "failed", {
            finalMessage,
            error: `turn ended with status '${status}': ${JSON.stringify(turn?.["error"] ?? null).slice(0, 400)}`,
          });
        }
        break;
      }
      case "error": {
        this.#transition(live, "failed", { error: JSON.stringify(params).slice(0, 800) });
        break;
      }
      default:
        this.#save(live);
        break;
    }
  }

  async #onServerRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    const record = params as Record<string, unknown> | null;
    const threadId = typeof record?.["threadId"] === "string" ? (record["threadId"] as string) : null;
    const live = threadId ? this.#liveByThread(threadId) : null;

    const disposition = classifyServerRequest(method, params, id, this.#policy);

    if (!live) {
      // An unroutable request still gets an answer. Dropping it would hang the
      // originating turn with no visible cause.
      if (disposition.type === "auto") return disposition.response;
      throw new Error(`codex-bridge could not route '${method}' to a known run`);
    }

    this.#store.appendEvent(live.record, { atMs: Date.now(), method: `serverRequest/${method}`, params });

    if (disposition.type === "unsupported") {
      this.#store.appendEvent(live.record, {
        atMs: Date.now(),
        method: "bridge/unsupportedServerRequest",
        params: { method, message: disposition.message },
      });
      throw new Error(disposition.message);
    }

    if (disposition.type === "auto") {
      this.#store.appendEvent(live.record, {
        atMs: Date.now(),
        method: "bridge/autoAnswered",
        params: { method, note: disposition.note },
      });
      return disposition.response;
    }

    // Park it: this is the state the whole tool exists to make visible.
    return new Promise((resolve, reject) => {
      const key = String(id);
      live.parked.set(key, { pending: disposition.pending, resolve, reject });
      live.record.pending = [...live.parked.values()].map((entry) => entry.pending);
      this.#transition(live, "blocked", {});
    });
  }

  // ------------------------------------------------------------ transitions

  #transition(live: LiveRun, state: RunState, patch: Partial<RunRecord>): void {
    live.record.state = state;
    if (patch.finalMessage !== undefined) live.record.finalMessage = patch.finalMessage;
    if (patch.error !== undefined) live.record.error = patch.error;
    if (state !== "blocked") live.record.pending = [...live.parked.values()].map((e) => e.pending);
    this.#store.appendEvent(live.record, { atMs: Date.now(), method: "bridge/state", params: { state } });
    this.#save(live);
    this.#wake(live);
  }

  #save(live: LiveRun): void {
    this.#store.save(live.record);
  }

  /**
   * Wake `wait` callers. Both terminal states and `blocked` release waiters --
   * a blocked run must never be silently waited on, since nothing will change
   * until a human acts.
   */
  #wake(live: LiveRun): void {
    if (!isTerminal(live.record.state) && live.record.state !== "blocked") return;
    const waiters = live.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  #liveByThread(threadId: string): LiveRun | null {
    const runId = this.#byThread.get(threadId);
    return runId ? this.#runs.get(runId) ?? null : null;
  }

  #broadcastBridgeEvent(method: string, params: unknown): void {
    for (const live of this.#runs.values()) {
      this.#store.appendEvent(live.record, { atMs: Date.now(), method, params });
    }
  }

  // --------------------------------------------------------------- control

  #handleConnection(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        void this.#handleCommand(line, socket);
      }
    });
  }

  async #handleCommand(line: string, socket: Socket): Promise<void> {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      socket.write(JSON.stringify({ ok: false, error: "malformed control request" }) + "\n");
      return;
    }
    try {
      const result = await this.dispatchCommand(request);
      socket.write(JSON.stringify({ ok: true, result }) + "\n");
    } catch (error) {
      socket.write(
        JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n",
      );
    }
  }

  async dispatchCommand(request: Record<string, unknown>): Promise<unknown> {
    const op = String(request["op"] ?? "");
    switch (op) {
      case "ping":
        return {
          pid: process.pid,
          appServerPid: this.#appServer?.pid ?? null,
          appServerAlive: this.#appServer !== null,
          uptimeMs: Date.now() - this.#startedAtMs,
          socketPath: this.#socketPath,
          home: this.#store.root,
        };
      case "dispatch":
        return this.#opDispatch(request);
      case "status":
        return this.#requireRecord(String(request["runId"] ?? ""));
      case "list":
        return this.#store.list();
      case "events":
        return this.#store.readEvents(
          String(request["runId"] ?? ""),
          Number(request["since"] ?? 0),
          Number(request["limit"] ?? 500),
        );
      case "wait":
        return this.#opWait(String(request["runId"] ?? ""), Number(request["timeoutMs"] ?? 240000));
      case "answer":
        return this.#opAnswer(request);
      case "interrupt":
        return this.#opInterrupt(String(request["runId"] ?? ""));
      case "shutdown":
        setTimeout(() => this.stop(), 50);
        return { stopping: true };
      default:
        throw new Error(`unknown control op '${op}'`);
    }
  }

  async #opDispatch(request: Record<string, unknown>): Promise<unknown> {
    const appServer = this.#appServer;
    if (!appServer) throw new Error("app-server is not running; restart the daemon");

    const cwd = String(request["cwd"] ?? "");
    if (!cwd) throw new Error("dispatch requires an explicit cwd");
    if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
    const prompt = String(request["prompt"] ?? "");
    if (!prompt.trim()) throw new Error("dispatch requires a non-empty prompt");

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record = newRunRecord(runId, cwd);
    record.model = (request["model"] as string) ?? null;
    record.sandbox = (request["sandbox"] as string) ?? null;
    record.approvalPolicy = (request["approvalPolicy"] as string) ?? null;
    this.#store.create(record);

    const live: LiveRun = { record, parked: new Map(), waiters: [] };
    this.#runs.set(runId, live);

    const { threadId } = await appServer.startThread({
      cwd,
      model: record.model,
      sandbox: record.sandbox,
      approvalPolicy: record.approvalPolicy,
      developerInstructions: (request["developerInstructions"] as string) ?? null,
    });
    record.threadId = threadId;
    this.#byThread.set(threadId, runId);
    this.#store.appendEvent(record, { atMs: Date.now(), method: "bridge/threadStarted", params: { threadId, cwd } });

    const { turnId } = await appServer.startTurn({
      threadId,
      text: prompt,
      cwd,
      model: record.model,
      effort: (request["effort"] as string) ?? null,
    });
    record.turnId = turnId;
    if (record.state === "starting") record.state = "running";
    this.#save(live);

    return { runId, threadId, turnId };
  }

  #requireLive(runId: string): LiveRun {
    const live = this.#runs.get(runId);
    if (!live) throw new Error(`run '${runId}' is not live in this daemon`);
    return live;
  }

  #requireRecord(runId: string): RunRecord {
    const live = this.#runs.get(runId);
    if (live) return live.record;
    const record = this.#store.load(runId);
    if (!record) throw new Error(`unknown run '${runId}'`);
    return record;
  }

  async #opWait(runId: string, timeoutMs: number): Promise<unknown> {
    const record = this.#requireRecord(runId);
    if (isTerminal(record.state) || record.state === "blocked") return record;
    const live = this.#requireLive(runId);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const index = live.waiters.indexOf(onSettle);
        if (index >= 0) live.waiters.splice(index, 1);
        resolve();
      }, Math.max(1000, timeoutMs));
      function onSettle(): void {
        clearTimeout(timer);
        resolve();
      }
      live.waiters.push(onSettle);
    });

    return live.record;
  }

  #opAnswer(request: Record<string, unknown>): unknown {
    const live = this.#requireLive(String(request["runId"] ?? ""));
    const key = String(request["requestId"] ?? "");
    const entry = live.parked.get(key);
    if (!entry) {
      throw new Error(
        `no parked interaction '${key}' on this run; outstanding: ${[...live.parked.keys()].join(", ") || "none"}`,
      );
    }
    const response = buildAnswerResponse(entry.pending, request["answer"]);
    live.parked.delete(key);
    entry.resolve(response);

    this.#store.appendEvent(live.record, {
      atMs: Date.now(),
      method: "bridge/answered",
      params: { requestId: key, method: entry.pending.method },
    });
    live.record.pending = [...live.parked.values()].map((e) => e.pending);
    // Only leave `blocked` once nothing else is waiting on a human.
    this.#transition(live, live.parked.size > 0 ? "blocked" : "running", {});
    return { answered: key, remaining: live.parked.size };
  }

  async #opInterrupt(runId: string): Promise<unknown> {
    const live = this.#requireLive(runId);
    // Parked requests must be answered before interrupting, or the server side
    // is left waiting on a client that has already walked away.
    for (const [key, entry] of live.parked) {
      entry.resolve(declineResponse(entry.pending.method, "run interrupted by user"));
      live.parked.delete(key);
    }
    if (this.#appServer && live.record.threadId) {
      try {
        await this.#appServer.interrupt(live.record.threadId, live.record.turnId);
      } catch (error) {
        this.#store.appendEvent(live.record, {
          atMs: Date.now(),
          method: "bridge/interruptFailed",
          params: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    this.#transition(live, "interrupted", {});
    return { runId, state: live.record.state };
  }

  stop(): void {
    this.#appServer?.close();
    this.#server.close();
    rmSync(this.#socketPath, { force: true });
    process.exit(0);
  }
}

function extractFinalMessage(turn: Record<string, unknown> | undefined): string | null {
  const items = turn?.["items"];
  if (!Array.isArray(items)) return null;
  let text: string | null = null;
  for (const item of items) {
    const record = item as Record<string, unknown>;
    if (record["type"] !== "agentMessage") continue;
    if (typeof record["text"] !== "string") continue;
    // Prefer the final answer, but fall back to the last agent message so a
    // turn that ends without an explicit final phase still reports something.
    if (record["phase"] === "final_answer") return record["text"];
    text = record["text"];
  }
  return text;
}

async function probeSocket(path: string): Promise<boolean> {
  const { connect } = await import("node:net");
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}
