import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AppServer } from "./appserver.js";
import type { JsonRpcId } from "./jsonrpc.js";
import {
  buildAnswerResponse,
  classifyServerRequest,
  declineResponse,
  sanitizePolicy,
  type InteractionPolicy,
  type PendingInteraction,
} from "./interaction.js";
import {
  hasProseQuestionHint,
  isTerminal,
  newRunRecord,
  RunStore,
  type RunEvent,
  type RunRecord,
  type RunState,
} from "./run.js";

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
  stallTimeoutMs?: number;
  resumeStartTimeoutMs?: number;
}

export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_RESUME_START_TIMEOUT_MS = 10_000;

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
  const uid = typeof userInfo().uid === "number" ? userInfo().uid : 0;
  if (override) {
    return requireAbsoluteSocketPath(override, "CODEX_BRIDGE_SOCKET");
  }
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  const base = runtimeDir && isAbsolute(runtimeDir) && runtimeDir.length < 60 ? runtimeDir : "/tmp";
  return join(base, `codex-bridge-${uid}`, "control.sock");
}

export function requireAbsoluteSocketPath(path: string, label = "socket path"): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return path;
}

interface LiveRun {
  record: RunRecord;
  /** Resolvers for parked server requests, keyed by JSON-RPC request id. */
  parked: Map<string, { pending: PendingInteraction; resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  waiters: Array<() => void>;
  stallTimer: NodeJS.Timeout | null;
  turnActivityIds: Set<string>;
  unscopedTurnActivityVersion: number;
  turnActivityWaiters: Array<() => void>;
}

export class BridgeDaemon {
  #store: RunStore;
  #socketPath: string;
  #codexPath: string;
  #policy: InteractionPolicy;
  #stallTimeoutMs: number;
  #resumeStartTimeoutMs: number;
  #appServer: AppServer | null = null;
  #runs = new Map<string, LiveRun>();
  #byThread = new Map<string, string>();
  #startedAtMs = Date.now();
  #server = createServer();
  /** Disposable listeners; no run ever waits for delivery or acknowledgement. */
  #subscribers = new Set<Socket>();

  constructor(options: DaemonOptions = {}) {
    this.#store = new RunStore(options.home ?? defaultHome());
    this.#socketPath = options.socketPath
      ? requireAbsoluteSocketPath(options.socketPath)
      : defaultSocketPath();
    this.#codexPath = options.codexPath ?? process.env["CODEX_BIN"] ?? "codex";
    this.#policy = options.defaultPolicy ?? {};
    this.#stallTimeoutMs = positiveDuration(
      options.stallTimeoutMs ?? process.env["CODEX_BRIDGE_STALL_TIMEOUT_MS"] ?? DEFAULT_STALL_TIMEOUT_MS,
      "stall timeout",
    );
    this.#resumeStartTimeoutMs = positiveDuration(
      options.resumeStartTimeoutMs ??
        process.env["CODEX_BRIDGE_RESUME_START_TIMEOUT_MS"] ??
        DEFAULT_RESUME_START_TIMEOUT_MS,
      "resume start timeout",
    );
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

    this.#reconcileOrphanedRuns();

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

  /**
   * On startup, close out runs left non-terminal by a previous daemon.
   *
   * A bridge home is owned by one daemon at a time -- `start()` refuses to run
   * beside a live one -- so a `running` or `blocked` record on disk at this
   * moment has no process behind it and never will. Leaving it alone is the
   * stale-bookkeeping failure this tool was written against: `wait` would hang
   * on a turn nobody is driving, and `status` would report progress that
   * stopped hours ago. Marking it `failed` says what actually happened, and the
   * thread id survives in the record so `resume` can pick the work back up.
   */
  #reconcileOrphanedRuns(): void {
    for (const record of this.#store.list()) {
      if (isTerminal(record.state)) continue;
      const previousState = record.state;
      record.state = "failed";
      record.stalled = false;
      record.pending = [];
      record.error =
        `orphaned: the daemon that owned this run exited while it was '${previousState}'` +
        (record.threadId ? `; resume it with: codex-bridge resume ${record.runId} --prompt <text>` : "");
      this.#store.appendEvent(record, {
        atMs: Date.now(),
        method: "bridge/orphaned",
        params: { previousState },
      });
      this.#store.save(record);
    }
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

    const wasStalled = live.record.state === "stalled";
    this.#record(live, { atMs: Date.now(), method, params });
    if (method === "turn/started" || method === "turn/completed" || method.startsWith("item/")) {
      this.#markTurnActivity(live, record);
    }
    if (method === "item/started") this.#warnOnEmptyWait(live, record);
    if (isTerminal(live.record.state)) {
      this.#save(live);
      return;
    }

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
        } else if (status === "interrupted" || live.record.state === "interrupted") {
          // `interrupted` is a first-class TurnStatus, and it is not a failure:
          // reporting a user's own stop as `failed` would send them hunting for
          // an error that does not exist, and would exit 12 instead of 13.
          this.#transition(live, "interrupted", { finalMessage });
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
        if (wasStalled) this.#transition(live, "running", {});
        else this.#save(live);
        break;
    }
  }

  async #onServerRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    const record = params as Record<string, unknown> | null;
    const threadId = typeof record?.["threadId"] === "string" ? (record["threadId"] as string) : null;
    const live = threadId ? this.#liveByThread(threadId) : null;

    // The run's own policy is layered over the daemon default, so a `dispatch`
    // that pre-approved one kind does not leak that decision into other runs.
    const policy = live ? { ...this.#policy, ...live.record.policy } : this.#policy;
    const disposition = classifyServerRequest(method, params, id, policy);

    if (!live) {
      // An unroutable request still gets an answer. Dropping it would hang the
      // originating turn with no visible cause.
      if (disposition.type === "auto") return disposition.response;
      throw new Error(`codex-bridge could not route '${method}' to a known run`);
    }

    this.#record(live, { atMs: Date.now(), method: `serverRequest/${method}`, params });
    this.#markTurnActivity(live, record);
    if (isTerminal(live.record.state)) {
      throw new Error(`codex-bridge received '${method}' after run '${live.record.runId}' was ${live.record.state}`);
    }
    if (live.record.state === "stalled") this.#transition(live, "running", {});

    if (disposition.type === "unsupported") {
      this.#record(live, {
        atMs: Date.now(),
        method: "bridge/unsupportedServerRequest",
        params: { method, message: disposition.message },
      });
      throw new Error(disposition.message);
    }

    if (disposition.type === "auto") {
      this.#record(live, {
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
    const previousState = live.record.state;
    live.record.state = state;
    live.record.stalled = state === "stalled";
    if (patch.finalMessage !== undefined) live.record.finalMessage = patch.finalMessage;
    live.record.proseQuestionHint = state === "completed" && hasProseQuestionHint(live.record.finalMessage);
    if (patch.error !== undefined) live.record.error = patch.error;
    if (state !== "blocked") live.record.pending = [...live.parked.values()].map((e) => e.pending);
    this.#record(live, { atMs: Date.now(), method: "bridge/state", params: { state } }, false);
    this.#save(live);
    this.#scheduleStallCheck(live);
    this.#wake(live);
    if (isTerminal(state)) this.#wakeTurnActivity(live);
    if (state !== previousState) this.#publishState(live.record);
  }

  #publishState(record: RunRecord): void {
    if (this.#subscribers.size === 0) return;
    const line = JSON.stringify({ notification: "run/stateChanged", record }) + "\n";
    for (const socket of this.#subscribers) {
      if (!socket.destroyed) socket.write(line);
    }
  }

  #save(live: LiveRun): void {
    this.#guardStore(live, "snapshot", () => this.#store.save(live.record));
  }

  /**
   * Append to a run's event log without letting the write take the daemon down.
   *
   * `appendEvent` runs inside the transport's data handler, so an unguarded
   * throw -- a removed run directory, a full disk -- escapes as an uncaught
   * exception and kills the process, taking every unrelated run with it. That
   * is a strictly worse outcome than a hole in one log. The hole is recorded on
   * the run and reported on stderr rather than swallowed, because a silently
   * short transcript is one that reads as complete.
   */
  #record(live: LiveRun, event: RunEvent, observedActivity = true): void {
    this.#guardStore(live, `event ${event.method}`, () =>
      this.#store.appendEvent(live.record, event, observedActivity));
    if (observedActivity) this.#scheduleStallCheck(live);
  }

  #scheduleStallCheck(live: LiveRun): void {
    if (live.stallTimer) clearTimeout(live.stallTimer);
    live.stallTimer = null;
    if (live.record.state !== "running") return;
    const remaining = Math.max(1, this.#stallTimeoutMs - (Date.now() - live.record.lastEventAtMs));
    live.stallTimer = setTimeout(() => this.#refreshStall(live), remaining);
  }

  #refreshStall(live: LiveRun): void {
    if (live.record.state !== "running") return;
    const quietMs = Date.now() - live.record.lastEventAtMs;
    if (quietMs < this.#stallTimeoutMs) {
      this.#scheduleStallCheck(live);
      return;
    }
    live.record.state = "stalled";
    live.record.stalled = true;
    this.#record(live, {
      atMs: Date.now(),
      method: "bridge/stalled",
      params: { lastEventAtMs: live.record.lastEventAtMs, quietMs, thresholdMs: this.#stallTimeoutMs },
    }, false);
    this.#save(live);
    this.#wake(live);
    this.#publishState(live.record);
  }

  #markTurnActivity(live: LiveRun, notification: Record<string, unknown> | null): void {
    const turn = notification?.["turn"] as Record<string, unknown> | undefined;
    const turnId = typeof notification?.["turnId"] === "string"
      ? notification["turnId"]
      : typeof turn?.["id"] === "string"
        ? turn["id"]
        : null;
    if (turnId) live.turnActivityIds.add(turnId);
    else live.unscopedTurnActivityVersion += 1;
    this.#wakeTurnActivity(live);
  }

  #wakeTurnActivity(live: LiveRun): void {
    const waiters = live.turnActivityWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async #waitForTurnActivity(live: LiveRun, turnId: string | null, unscopedBaseline: number): Promise<boolean> {
    const hasActivity = (): boolean =>
      (turnId !== null && live.turnActivityIds.has(turnId)) ||
      live.unscopedTurnActivityVersion > unscopedBaseline;
    if (hasActivity()) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const index = live.turnActivityWaiters.indexOf(onActivity);
        if (index >= 0) live.turnActivityWaiters.splice(index, 1);
        resolve();
      }, this.#resumeStartTimeoutMs);
      function onActivity(): void {
        clearTimeout(timer);
        resolve();
      }
      live.turnActivityWaiters.push(onActivity);
    });
    return hasActivity();
  }

  #warnOnEmptyWait(live: LiveRun, notification: Record<string, unknown> | null): void {
    const item = notification?.["item"] as Record<string, unknown> | undefined;
    if (
      item?.["type"] !== "collabAgentToolCall" ||
      item["tool"] !== "wait" ||
      !Array.isArray(item["receiverThreadIds"]) ||
      item["receiverThreadIds"].length !== 0
    ) return;
    const warning = {
      code: "empty_wait_receivers",
      message: "collaboration wait has an empty receiver list and is waiting on nobody",
      atMs: Date.now(),
      ...(typeof item["id"] === "string" ? { itemId: item["id"] } : {}),
    };
    live.record.warnings.push(warning);
    this.#record(live, { atMs: warning.atMs, method: "bridge/warning", params: warning }, false);
  }

  #guardStore(live: LiveRun | null, label: string, write: () => void): void {
    try {
      write();
    } catch (error) {
      const message = `store write failed (${label}): ${error instanceof Error ? error.message : String(error)}`;
      if (live) live.record.storeError = message;
      process.stderr.write(`codex-bridge: ${message}\n`);
    }
  }

  /**
   * Wake `wait` callers. Both terminal states and `blocked` release waiters --
   * a blocked run must never be silently waited on, since nothing will change
   * until a human acts.
   */
  #wake(live: LiveRun): void {
    if (!isTerminal(live.record.state) && live.record.state !== "blocked" && live.record.state !== "stalled") return;
    const waiters = live.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  #liveByThread(threadId: string): LiveRun | null {
    const runId = this.#byThread.get(threadId);
    return runId ? this.#runs.get(runId) ?? null : null;
  }

  #broadcastBridgeEvent(method: string, params: unknown): void {
    for (const live of this.#runs.values()) {
      this.#record(live, { atMs: Date.now(), method, params }, false);
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
    if (request["op"] === "subscribe") {
      this.#subscribers.add(socket);
      socket.once("close", () => this.#subscribers.delete(socket));
      socket.write(JSON.stringify({ ok: true, result: { subscribed: true } }) + "\n");
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
      case "resume":
        return this.#opResume(request);
      case "status":
        return this.#status(String(request["runId"] ?? ""));
      case "list": {
        for (const live of this.#runs.values()) this.#refreshStall(live);
        return this.#store.list();
      }
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
    // Validate before anything is persisted: a run started under a policy the
    // caller mistyped is worse than a run that never started.
    const policy = sanitizePolicy(request["policy"]);

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record = newRunRecord(runId, cwd);
    record.stallThresholdMs = this.#stallTimeoutMs;
    record.model = (request["model"] as string) ?? null;
    record.sandbox = (request["sandbox"] as string) ?? null;
    record.approvalPolicy = (request["approvalPolicy"] as string) ?? null;
    record.policy = policy;
    this.#store.create(record);

    const live = this.#newLive(record);
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
    this.#scheduleStallCheck(live);

    return { runId, threadId, turnId };
  }

  /**
   * Resume a previous thread and send it another turn.
   *
   * This is what makes a run survive the daemon, not just the terminal. The
   * thread id is read back from the persisted record, so a run dispatched
   * before a daemon restart -- and therefore absent from `#runs` -- is still
   * resumable. Requiring it to be live would reintroduce exactly the
   * "the work is gone because the supervisor died" failure the store exists to
   * prevent.
   */
  async #opResume(request: Record<string, unknown>): Promise<unknown> {
    const appServer = this.#appServer;
    if (!appServer) throw new Error("app-server is not running; restart the daemon");

    const runId = String(request["runId"] ?? "");
    const source = this.#requireRecord(runId);
    if (!source.threadId) {
      throw new Error(`run '${runId}' never started a thread; there is nothing to resume`);
    }

    const existing = this.#runs.get(runId);
    if (existing && !isTerminal(existing.record.state)) {
      // Resuming over a live turn would start a second turn on the same thread
      // and orphan whatever the first one was waiting for.
      const hint =
        existing.record.state === "blocked"
          ? "answer its pending requests or interrupt it"
          : "wait for it or interrupt it";
      throw new Error(`run '${runId}' is ${existing.record.state}; ${hint} before resuming`);
    }

    const prompt = String(request["prompt"] ?? "");
    if (!prompt.trim()) throw new Error("resume requires a non-empty prompt");
    const cwd = String(request["cwd"] ?? source.cwd);
    if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
    const policy = sanitizePolicy(request["policy"]);

    const threadId = source.threadId;
    const asNewRun = Boolean(request["newRun"]);

    let record: RunRecord;
    let live: LiveRun;
    if (asNewRun) {
      // Keep the old record exactly as it was left. Overwriting the record that
      // holds a failure or an unanswered question destroys the evidence of why
      // a resume was needed in the first place.
      record = newRunRecord(`run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, cwd);
      record.stallThresholdMs = this.#stallTimeoutMs;
      record.threadId = threadId;
      record.model = (request["model"] as string) ?? source.model;
      record.sandbox = source.sandbox;
      record.approvalPolicy = source.approvalPolicy;
      record.policy = Object.keys(policy).length > 0 ? policy : source.policy;
      this.#store.create(record);
      this.#store.appendEvent(record, {
        atMs: Date.now(),
        method: "bridge/resumedFrom",
        params: { runId: source.runId, threadId },
      });
      live = this.#newLive(record);
    } else {
      record = source;
      record.cwd = cwd;
      record.state = "starting";
      record.finalMessage = null;
      record.proseQuestionHint = false;
      record.error = null;
      record.pending = [];
      record.turnId = null;
      if (request["model"] !== undefined && request["model"] !== null) record.model = request["model"] as string;
      if (Object.keys(policy).length > 0) record.policy = policy;
      live = existing ?? this.#newLive(record);
      live.record = record;
      record.stallThresholdMs = this.#stallTimeoutMs;
      record.stalled = false;
    }
    this.#runs.set(record.runId, live);

    await appServer.resumeThread({ threadId, cwd });
    // A resumed thread belongs to whichever run is now driving it; otherwise
    // approvals for this turn would route to the run that finished with it.
    this.#byThread.set(threadId, record.runId);
    this.#store.appendEvent(record, {
      atMs: Date.now(),
      method: "bridge/threadResumed",
      params: { threadId, cwd, resumedFrom: source.runId },
    });

    const unscopedActivityBaseline = live.unscopedTurnActivityVersion;
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
    this.#scheduleStallCheck(live);

    if (!(await this.#waitForTurnActivity(live, turnId, unscopedActivityBaseline))) {
      const reason = isTerminal(record.state) && record.error
        ? `resume turn failed before activity began: ${record.error}`
        : `App Server accepted turn/start but no turn activity (turn/started, item event, ` +
          `server request, or turn/completed) ` +
          `arrived within ${this.#resumeStartTimeoutMs}ms`;
      if (!isTerminal(record.state)) {
        this.#record(live, {
          atMs: Date.now(),
          method: "bridge/resumeStartFailed",
          params: { turnId, timeoutMs: this.#resumeStartTimeoutMs, reason },
        }, false);
        this.#transition(live, "failed", { error: reason });
      }
      throw new Error(reason);
    }

    return { runId: record.runId, threadId, turnId, resumedFrom: source.runId };
  }

  #newLive(record: RunRecord): LiveRun {
    return {
      record,
      parked: new Map(),
      waiters: [],
      stallTimer: null,
      turnActivityIds: new Set(),
      unscopedTurnActivityVersion: 0,
      turnActivityWaiters: [],
    };
  }

  #status(runId: string): RunRecord {
    const live = this.#runs.get(runId);
    if (live) this.#refreshStall(live);
    return this.#requireRecord(runId);
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
    const record = this.#status(runId);
    if (isTerminal(record.state) || record.state === "blocked" || record.state === "stalled") return record;
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

    this.#record(live, {
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
        this.#record(live, {
          atMs: Date.now(),
          method: "bridge/interruptFailed",
          params: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    this.#transition(live, "interrupted", {});
    return { runId, state: live.record.state };
  }

  /**
   * Release every resource this daemon owns. Kept separate from {@link stop} so
   * a test -- or any embedder -- can shut a daemon down without taking the
   * whole process with it.
   */
  close(): void {
    for (const live of this.#runs.values()) {
      if (live.stallTimer) clearTimeout(live.stallTimer);
    }
    for (const subscriber of this.#subscribers) subscriber.destroy();
    this.#subscribers.clear();
    this.#appServer?.close();
    this.#server.close();
    rmSync(this.#socketPath, { force: true });
  }

  stop(): never {
    this.close();
    process.exit(0);
  }
}

function positiveDuration(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number of milliseconds`);
  return parsed;
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
