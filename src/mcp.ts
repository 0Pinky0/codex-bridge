import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BridgeClient, RunStateNotification } from "./client.js";
import { POLICY_KINDS, POLICY_MODES, type PolicyMode } from "./interaction.js";
import { EXIT, exitCodeForRun, summarize } from "./outcome.js";
import { needsHuman, type RunRecord } from "./run.js";

/**
 * The bridge, exposed as an MCP server.
 *
 * The consumer here is a model, not a shell, so the exit-code contract that
 * carries the blocked/completed distinction on the CLI is unavailable. That
 * distinction is instead carried in two places on every run-shaped result:
 *
 *   - the first line of text is {@link summarize}, which never describes a
 *     blocked run in words that could be read as success
 *   - `structuredContent.needsHuman` is a boolean the caller can branch on
 *
 * Both are always present. A model that reads only the prose and one that reads
 * only the structure arrive at the same conclusion, which is the property the
 * exit codes give a shell caller.
 */

export interface McpServerOptions {
  client: BridgeClient;
  /** Path to the CLI entrypoint, used to start the daemon on demand. */
  entrypoint: string;
}

/**
 * Bound so a wait cannot outlive the MCP client's own request timeout.
 *
 * An unbounded wait would surface to the caller as a transport error rather
 * than as a run state, which loses the very information this tool exists to
 * report. A bounded wait that returns `running` is strictly more informative.
 */
const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 240_000;

const RUN_OUTPUT_SHAPE = {
  runId: z.string(),
  state: z.string(),
  /** True exactly when the run is stopped waiting for a person. */
  needsHuman: z.boolean(),
  /** True when `codex_wait` returned before the run settled. */
  timedOut: z.boolean(),
  /** The exit code the CLI would use, so both surfaces agree. */
  exitCode: z.number(),
};

/**
 * Every kind is optional, but unknown keys are a hard error rather than being
 * stripped. A silently dropped `{"internal": "approve"}` would leave the caller
 * believing they had configured something the bridge cannot do.
 */
const POLICY_SCHEMA = z
  .object(
    Object.fromEntries(POLICY_KINDS.map((kind) => [kind, z.enum(POLICY_MODES).optional()])) as Record<
      (typeof POLICY_KINDS)[number],
      z.ZodOptional<z.ZodEnum<Record<PolicyMode, PolicyMode>>>
    >,
  )
  .strict()
  .describe(
    "Per-kind interaction policy. Unset kinds default to 'ask', which parks the " +
      "run and waits for a human. 'approve' auto-answers only where an approval " +
      "can actually be expressed; 'deny' auto-declines.",
  );

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

/**
 * Render a run record so that neither the prose nor the structure can be read
 * as "finished" when the run is actually parked on a question.
 */
function runResult(record: RunRecord, timedOut = false): CallToolResult {
  const lines = [summarize(record)];
  if (timedOut) {
    lines.push(
      `This run has NOT finished; the wait window elapsed first. ` +
        `Call codex_wait again with the same runId to keep waiting.`,
    );
  }
  if (record.finalMessage && record.state === "completed") lines.push("", record.finalMessage);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      ...record,
      needsHuman: needsHuman(record.state),
      timedOut,
      exitCode: timedOut ? EXIT.STILL_RUNNING : exitCodeForRun(record),
    },
  };
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const { client, entrypoint } = options;
  const server = new McpServer(
    { name: "codex-bridge", version: "0.1.0" },
    {
      capabilities: { logging: {} },
      instructions:
        "Dispatch and supervise Codex App Server runs. A run can stop to ask a " +
        "question instead of finishing: whenever a result reports state " +
        "'blocked' or needsHuman=true, the run is waiting on a person and will " +
        "make no further progress until codex_answer is called. Never report " +
        "such a run as done.",
    },
  );

  /** Send a control command, starting the daemon first when one is needed. */
  const call = async (request: Record<string, unknown>, timeoutMs?: number): Promise<unknown> => {
    await client.ensureDaemon(entrypoint);
    return timeoutMs === undefined ? client.send(request) : client.send(request, timeoutMs);
  };

  server.registerTool(
    "codex_dispatch",
    {
      title: "Dispatch a Codex run",
      description:
        "Start a Codex run in a working directory. Returns immediately with a " +
        "runId unless `wait` is set. The run may end up blocked on an approval " +
        "rather than completed -- check `needsHuman`.",
      inputSchema: {
        cwd: z.string().describe("Absolute path the run works in. Always passed explicitly."),
        prompt: z.string().min(1),
        model: z.string().optional(),
        effort: z.string().optional(),
        sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        approval: z.enum(["untrusted", "on-request", "never"]).optional(),
        instructions: z.string().optional().describe("Developer instructions for the thread."),
        policy: POLICY_SCHEMA.optional(),
        wait: z.boolean().optional().describe("Wait for the run to settle or block before returning."),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const started = (await call({
        op: "dispatch",
        cwd: args.cwd,
        prompt: args.prompt,
        model: args.model ?? null,
        effort: args.effort ?? null,
        sandbox: args.sandbox ?? null,
        approvalPolicy: args.approval ?? null,
        developerInstructions: args.instructions ?? null,
        policy: args.policy ?? {},
      })) as { runId: string; threadId: string };

      if (!args.wait) return jsonResult({ ...started, note: "run started; poll with codex_status or codex_wait" });
      return waitFor(started.runId, args.timeoutMs);
    },
  );

  server.registerTool(
    "codex_resume",
    {
      title: "Resume a Codex run",
      description:
        "Send another turn to a finished run's thread. Works across daemon " +
        "restarts, since the thread id is read from the persisted record. Set " +
        "`newRun` to record the continuation under a fresh runId, leaving the " +
        "original record untouched.",
      inputSchema: {
        runId: z.string(),
        prompt: z.string().min(1),
        newRun: z.boolean().optional(),
        cwd: z.string().optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        policy: POLICY_SCHEMA.optional(),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const resumed = (await call({
        op: "resume",
        runId: args.runId,
        prompt: args.prompt,
        newRun: args.newRun ?? false,
        cwd: args.cwd ?? null,
        model: args.model ?? null,
        effort: args.effort ?? null,
        policy: args.policy ?? {},
      })) as { runId: string };

      if (!args.wait) return jsonResult(resumed);
      return waitFor(resumed.runId, args.timeoutMs);
    },
  );

  server.registerTool(
    "codex_status",
    {
      title: "Read a run's current state",
      description: "Return a run record without waiting. Does not block.",
      inputSchema: { runId: z.string() },
      outputSchema: RUN_OUTPUT_SHAPE,
    },
    async (args) => runResult((await call({ op: "status", runId: args.runId })) as RunRecord),
  );

  server.registerTool(
    "codex_wait",
    {
      title: "Wait for a run to settle or block",
      description:
        `Wait until the run completes, fails, is interrupted, or blocks on a ` +
        `question. Bounded (default ${DEFAULT_WAIT_MS}ms, max ${MAX_WAIT_MS}ms): if the window ` +
        `elapses first, the result reports the run as still running with ` +
        `timedOut=true. That is not a completion -- call this again.`,
      inputSchema: {
        runId: z.string(),
        timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
      },
      outputSchema: RUN_OUTPUT_SHAPE,
    },
    async (args) => waitFor(args.runId, args.timeoutMs),
  );

  server.registerTool(
    "codex_answer",
    {
      title: "Answer a blocked run's pending request",
      description:
        "Release a blocked run by answering one parked request. `answer` is a " +
        "decision word (accept, approve-session, decline, cancel) or, for a " +
        "requestUserInput question, an object mapping question id to answers. " +
        "Permission grants and dynamic tool calls can only be declined.",
      inputSchema: {
        runId: z.string(),
        requestId: z
          .union([z.string(), z.number()])
          .describe("The requestId shown in the run's `pending` list."),
        answer: z.union([z.string(), z.record(z.string(), z.unknown())]),
      },
    },
    async (args) => jsonResult(await call({
      op: "answer",
      runId: args.runId,
      requestId: String(args.requestId),
      answer: args.answer,
    })),
  );

  server.registerTool(
    "codex_interrupt",
    {
      title: "Interrupt a run",
      description:
        "Stop a run. Any parked requests are declined first, so the server side " +
        "is not left waiting on a client that has walked away.",
      inputSchema: { runId: z.string() },
    },
    async (args) => jsonResult(await call({ op: "interrupt", runId: args.runId })),
  );

  server.registerTool(
    "codex_list",
    {
      title: "List runs",
      description:
        "All known runs, newest first. Use this to find runs that are blocked " +
        "and have been waiting on a human.",
      inputSchema: {
        state: z
          .enum(["starting", "running", "blocked", "completed", "failed", "interrupted"])
          .optional()
          .describe("Filter to one state."),
      },
    },
    async (args) => {
      const records = (await call({ op: "list" })) as RunRecord[];
      const filtered = args.state ? records.filter((record) => record.state === args.state) : records;
      const blocked = filtered.filter((record) => needsHuman(record.state));
      return jsonResult({
        runs: filtered.map((record) => ({
          runId: record.runId,
          state: record.state,
          needsHuman: needsHuman(record.state),
          cwd: record.cwd,
          updatedAtMs: record.updatedAtMs,
          pending: record.pending.map((p) => ({ requestId: p.requestId, kind: p.kind, summary: p.summary })),
        })),
        blockedCount: blocked.length,
      });
    },
  );

  server.registerTool(
    "codex_events",
    {
      title: "Read a run's event log",
      description:
        "Slice the append-only event log for a run. `since` is an index into " +
        "the log, so repeated calls can page forward without re-reading.",
      inputSchema: {
        runId: z.string(),
        since: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args) => jsonResult(await call({
      op: "events",
      runId: args.runId,
      since: args.since ?? 0,
      limit: args.limit ?? 200,
    })),
  );

  /**
   * Wait, then report. The client-side timeout is deliberately larger than the
   * daemon-side one: if the daemon's bounded wait is the thing that expires, we
   * get a run record back and can say "still running". If the socket timeout
   * fired first we would only be able to say "something went wrong".
   */
  async function waitFor(runId: string, requested?: number): Promise<CallToolResult> {
    const timeoutMs = Math.min(requested ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
    const record = (await call({ op: "wait", runId, timeoutMs }, timeoutMs + 15_000)) as RunRecord;
    const settled = record.state !== "starting" && record.state !== "running";
    return runResult(record, !settled);
  }

  return server;
}

/**
 * Forward daemon state events as standard MCP `notifications/message` events.
 * Delivery is advisory and fire-and-forget: a closed MCP transport only drops
 * the message, and never feeds back into daemon run progress.
 */
export async function subscribeMcpToRunStates(options: McpServerOptions, server: McpServer): Promise<() => void> {
  await options.client.ensureDaemon(options.entrypoint);
  return options.client.subscribe((notification: RunStateNotification) => {
    void server.sendLoggingMessage({
      level: "notice",
      logger: "codex-bridge",
      data: notification,
    }).catch(() => {
      // MCP notifications are best-effort. A dropped supervisor must not make
      // the daemon or the run depend on its transport.
    });
  });
}

export async function serveMcpStdio(options: McpServerOptions): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  await subscribeMcpToRunStates(options, server);
}
