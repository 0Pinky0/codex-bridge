import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { defaultSocketPath } from "./daemon.js";

/**
 * A control-request failure, tagged with whether the daemon could be reached.
 *
 * The distinction is load-bearing: "the daemon is not there" and "the daemon
 * refused what you asked" are different problems with different fixes, and
 * collapsing them would report a rejected `resume` as infrastructure trouble.
 */
export class BridgeRequestError extends Error {
  readonly unreachable: boolean;
  constructor(message: string, unreachable: boolean) {
    super(message);
    this.name = "BridgeRequestError";
    this.unreachable = unreachable;
  }
}

/** Transient client for the bridge daemon's control socket. */
export class BridgeClient {
  #socketPath: string;

  constructor(socketPath = defaultSocketPath()) {
    this.#socketPath = socketPath;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  /**
   * Send one control command and return its result.
   *
   * `timeoutMs` must exceed any server-side wait, otherwise a long-poll would
   * look like a dead daemon.
   */
  send(request: Record<string, unknown>, timeoutMs = 300000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#socketPath);
      let buffer = "";
      let settled = false;

      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };

      const timer = setTimeout(
        () =>
          finish(
            new BridgeRequestError(
              `control request '${String(request["op"])}' timed out after ${timeoutMs}ms`,
              true,
            ),
          ),
        timeoutMs,
      );

      socket.setEncoding("utf8");
      socket.on("error", (error) =>
        finish(
          new BridgeRequestError(
            `cannot reach codex-bridge daemon at ${this.#socketPath}: ${error.message}`,
            true,
          ),
        ),
      );
      socket.on("close", () =>
        finish(new BridgeRequestError("daemon closed the connection without responding", true)),
      );
      socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        let response: Record<string, unknown>;
        try {
          response = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
        } catch {
          finish(new BridgeRequestError("daemon returned malformed JSON", true));
          return;
        }
        if (response["ok"]) finish(null, response["result"]);
        // The daemon answered; it just said no. That is the caller's problem to
        // fix, not the transport's.
        else finish(new BridgeRequestError(String(response["error"] ?? "unknown daemon error"), false));
      });
    });
  }

  async isRunning(): Promise<boolean> {
    if (!existsSync(this.#socketPath)) return false;
    try {
      await this.send({ op: "ping" }, 3000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start a detached daemon and wait for it to answer.
   *
   * Detaching matters: the daemon must outlive the shell that started it, which
   * is the whole point of moving run ownership out of the CLI.
   */
  async ensureDaemon(entrypoint: string, timeoutMs = 30000): Promise<boolean> {
    if (await this.isRunning()) return false;
    const child = spawn(process.execPath, [entrypoint, "daemon", "--foreground"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await this.isRunning()) return true;
    }
    throw new Error(`daemon did not become reachable at ${this.#socketPath} within ${timeoutMs}ms`);
  }
}
