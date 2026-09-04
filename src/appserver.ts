import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcPeer, type JsonRpcId } from "./jsonrpc.js";

/**
 * Owns a `codex app-server --stdio` child process and speaks the App Server
 * protocol to it.
 *
 * Why stdio and not a socket: the unix-socket transports exposed by the CLI
 * (`--listen unix://` and the daemon control socket via `app-server proxy`)
 * accept a connection but return nothing for newline-delimited JSON,
 * Content-Length framing, or raw bodies. Rather than guess at an undocumented
 * handshake, this bridge uses the transport it can actually verify, and
 * supplies durability itself by running as a detached daemon that owns the
 * child. See README "Transport".
 */

export interface AppServerOptions {
  /** Executable to spawn. Defaults to `codex` on PATH. */
  codexPath?: string;
  /** Extra environment for the child, merged over `process.env`. */
  env?: Record<string, string>;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;
  onTransportError?: (error: Error) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface InitializeResult {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

export class AppServer {
  #child: ChildProcessWithoutNullStreams;
  #peer: JsonRpcPeer;
  #stderr = "";

  constructor(options: AppServerOptions = {}) {
    const codexPath = options.codexPath ?? "codex";
    this.#child = spawn(codexPath, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
    });

    // Keep a bounded tail of stderr. Empty stderr on a failed launch is itself
    // a signal worth reporting, so this is surfaced rather than discarded.
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-8000);
    });

    this.#child.on("exit", (code, signal) => options.onExit?.(code, signal));

    this.#peer = new JsonRpcPeer(this.#child.stdout, this.#child.stdin, {
      onNotification: options.onNotification,
      onRequest: options.onServerRequest,
      onTransportError: options.onTransportError,
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return this.#peer.request(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.#peer.notify(method, params);
  }

  async initialize(clientName = "codex-bridge", version = "0.1.0"): Promise<InitializeResult> {
    const result = await this.#peer.request("initialize", {
      clientInfo: { name: clientName, title: "codex-bridge", version },
    });
    return (result ?? {}) as InitializeResult;
  }

  /**
   * Start a thread. `cwd` is always passed explicitly: inheriting the working
   * directory from whichever shell happened to launch the process is how a
   * dispatch ends up pointed at the wrong repository.
   */
  async startThread(params: {
    cwd: string;
    model?: string | null;
    sandbox?: string | null;
    approvalPolicy?: string | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
  }): Promise<{ threadId: string }> {
    const payload: Record<string, unknown> = { cwd: params.cwd };
    if (params.model) payload["model"] = params.model;
    if (params.sandbox) payload["sandbox"] = params.sandbox;
    if (params.approvalPolicy) payload["approvalPolicy"] = params.approvalPolicy;
    if (params.baseInstructions) payload["baseInstructions"] = params.baseInstructions;
    if (params.developerInstructions) payload["developerInstructions"] = params.developerInstructions;
    const result = (await this.#peer.request("thread/start", payload)) as Record<string, unknown>;
    const threadId = extractThreadId(result);
    if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(result).slice(0, 300)}`);
    return { threadId };
  }

  async resumeThread(params: {
    threadId: string;
    cwd?: string;
    excludeTurns?: boolean;
  }): Promise<{ threadId: string }> {
    const payload: Record<string, unknown> = {
      threadId: params.threadId,
      excludeTurns: params.excludeTurns ?? true,
    };
    if (params.cwd) payload["cwd"] = params.cwd;
    const result = (await this.#peer.request("thread/resume", payload)) as Record<string, unknown>;
    return { threadId: extractThreadId(result) ?? params.threadId };
  }

  async startTurn(params: {
    threadId: string;
    text: string;
    cwd?: string;
    model?: string | null;
    effort?: string | null;
  }): Promise<{ turnId: string | null }> {
    const payload: Record<string, unknown> = {
      threadId: params.threadId,
      input: [{ type: "text", text: params.text }],
    };
    if (params.cwd) payload["cwd"] = params.cwd;
    if (params.model) payload["model"] = params.model;
    if (params.effort) payload["effort"] = params.effort;
    const result = (await this.#peer.request("turn/start", payload)) as Record<string, unknown>;
    const turn = result?.["turn"] as Record<string, unknown> | undefined;
    const turnId = (result?.["turnId"] ?? turn?.["id"] ?? null) as string | null;
    return { turnId };
  }

  async interrupt(threadId: string, turnId: string | null): Promise<void> {
    const payload: Record<string, unknown> = { threadId };
    if (turnId) payload["turnId"] = turnId;
    await this.#peer.request("turn/interrupt", payload);
  }

  close(): void {
    this.#peer.close("app server closed");
    this.#child.kill("SIGTERM");
  }
}

function extractThreadId(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  if (typeof result["threadId"] === "string") return result["threadId"];
  const thread = result["thread"] as Record<string, unknown> | undefined;
  if (thread && typeof thread["id"] === "string") return thread["id"];
  return null;
}
