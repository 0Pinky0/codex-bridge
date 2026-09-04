import type { Readable, Writable } from "node:stream";

/**
 * Minimal bidirectional JSON-RPC 2.0 peer over newline-delimited JSON.
 *
 * Framing note: the Codex App Server stdio transport uses newline-delimited
 * JSON. This was verified empirically against `codex app-server --stdio`
 * (0.152.0); the unix-socket transports did not respond to newline JSON,
 * Content-Length framing, or raw bodies, so stdio is the only framing this
 * module claims to support.
 *
 * The important property here is that this peer is *bidirectional*: the App
 * Server initiates requests back to the client (approvals, user input), and a
 * client that cannot answer them will hang the turn forever. Every inbound
 * request is routed to {@link JsonRpcPeer.onRequest}.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(body: JsonRpcErrorBody) {
    super(body.message);
    this.name = "JsonRpcError";
    this.code = body.code;
    this.data = body.data;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export interface JsonRpcPeerHandlers {
  /**
   * Called for every server-initiated request. Whatever this resolves to is
   * sent back as the JSON-RPC result. Throwing sends a JSON-RPC error.
   *
   * There is no default. A peer constructed without a handler answers every
   * inbound request with an error rather than silently dropping it, because a
   * dropped request is indistinguishable from a hung turn.
   */
  onRequest?: (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
  /** Transport-level or parse-level failures. Never used for JSON-RPC errors. */
  onTransportError?: (error: Error) => void;
}

export class JsonRpcPeer {
  #stdin: Writable;
  #pending = new Map<JsonRpcId, Pending>();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  #handlers: JsonRpcPeerHandlers;

  constructor(stdout: Readable, stdin: Writable, handlers: JsonRpcPeerHandlers = {}) {
    this.#stdin = stdin;
    this.#handlers = handlers;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.#ingest(chunk));
    stdout.on("close", () => this.#failAll(new Error("transport closed")));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Send a request and await its response. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("peer is closed"));
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  close(reason = "closed by client"): void {
    this.#failAll(new Error(reason));
  }

  #failAll(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) pending.reject(error);
    this.#pending.clear();
  }

  #write(message: unknown): void {
    this.#stdin.write(JSON.stringify(message) + "\n");
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A malformed line is a real failure to surface, never a silent skip:
        // treating unparseable output as "nothing happened" is how fabricated
        // or truncated transcripts get mistaken for success.
        this.#handlers.onTransportError?.(
          new Error(`unparseable JSON-RPC line: ${line.slice(0, 200)}`),
        );
        continue;
      }
      this.#dispatch(parsed);
    }
  }

  #dispatch(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    const hasId = "id" in record && record["id"] !== null && record["id"] !== undefined;
    const hasMethod = typeof record["method"] === "string";

    if (hasId && hasMethod) {
      void this.#handleInboundRequest(record as unknown as JsonRpcRequest);
      return;
    }
    if (hasMethod) {
      this.#handlers.onNotification?.(record["method"] as string, record["params"]);
      return;
    }
    if (hasId) {
      this.#handleResponse(record as unknown as JsonRpcResponse);
    }
  }

  #handleResponse(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.error) pending.reject(new JsonRpcError(response.error));
    else pending.resolve(response.result);
  }

  async #handleInboundRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.#handlers.onRequest;
    if (!handler) {
      this.#write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `no handler for server-initiated request '${request.method}'`,
        },
      });
      return;
    }
    try {
      const result = await handler(request.method, request.params, request.id);
      this.#write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.#write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
