#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { BridgeClient, BridgeRequestError } from "./client.js";
import { BridgeDaemon, defaultHome, defaultSocketPath } from "./daemon.js";
import { parsePolicySpecs, POLICY_KINDS, POLICY_MODES, type InteractionPolicy, type PolicyMode } from "./interaction.js";
import { EXIT, exitCodeForRun, summarize } from "./outcome.js";
import type { RunRecord } from "./run.js";

export { EXIT } from "./outcome.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  /** Last occurrence wins, which is what a scalar flag should mean. */
  flags: Record<string, string | boolean>;
  /** Every occurrence, in order, for flags like `--policy` that repeat. */
  repeated: Record<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      (repeated[key] ??= []).push(next);
      i += 1;
    }
  }
  return { command, positional, flags, repeated };
}

/**
 * Build the per-run interaction policy from `--policy kind=mode` (repeatable)
 * and the `--auto-approve` / `--auto-deny` blanket switches.
 *
 * A bad spec exits with the usage code rather than starting a run under a
 * policy the caller did not write.
 */
function policyFromFlags(args: ParsedArgs): InteractionPolicy {
  const approve = Boolean(args.flags["auto-approve"]);
  const deny = Boolean(args.flags["auto-deny"]);
  if (approve && deny) fail("--auto-approve and --auto-deny contradict each other");
  const blanket: PolicyMode | undefined = approve ? "approve" : deny ? "deny" : undefined;
  try {
    return parsePolicySpecs(args.repeated["policy"] ?? [], blanket);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(message: string, code: number = EXIT.USAGE): never {
  process.stderr.write(`codex-bridge: ${message}\n`);
  process.exit(code);
}

const ENTRYPOINT = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { command, positional, flags } = args;
  const socketPath = typeof flags["socket"] === "string" ? flags["socket"] : defaultSocketPath();
  const client = new BridgeClient(socketPath);

  /** Wait on a run and exit with the code that describes what happened. */
  const waitAndExit = async (runId: string): Promise<never> => {
    const timeoutMs = Number(flags["timeout"] ?? 240000);
    const record = (await client.send({ op: "wait", runId, timeoutMs }, timeoutMs + 30000)) as RunRecord;
    print(record);
    process.stderr.write(summarize(record) + "\n");
    process.exit(exitCodeForRun(record));
  };

  /** Keep crossing bounded daemon wait windows until the run actually settles. */
  const watchAndExit = async (runId: string): Promise<never> => {
    const timeoutMs = Number(flags["timeout"] ?? 240000);
    for (;;) {
      const record = (await client.send({ op: "wait", runId, timeoutMs }, timeoutMs + 30000)) as RunRecord;
      if (exitCodeForRun(record) === EXIT.STILL_RUNNING) continue;
      print(record);
      process.stderr.write(summarize(record) + "\n");
      process.exit(exitCodeForRun(record));
    }
  };

  switch (command) {
    case "daemon": {
      const sub = positional[0] ?? (flags["foreground"] ? "--foreground" : "status");
      if (flags["foreground"] || sub === "--foreground") {
        const daemon = new BridgeDaemon({ socketPath });
        await daemon.start();
        process.on("SIGTERM", () => daemon.stop());
        process.on("SIGINT", () => daemon.stop());
        return; // Run forever.
      }
      if (sub === "start") {
        const started = await client.ensureDaemon(ENTRYPOINT);
        print({ started, socketPath, ...(await client.send({ op: "ping" })) as object });
        return;
      }
      if (sub === "stop") {
        if (!(await client.isRunning())) fail("no daemon is running", EXIT.UNREACHABLE);
        print(await client.send({ op: "shutdown" }, 5000));
        return;
      }
      if (!(await client.isRunning())) {
        print({ running: false, socketPath, home: defaultHome() });
        process.exit(EXIT.UNREACHABLE);
      }
      print({ running: true, ...(await client.send({ op: "ping" })) as object });
      return;
    }

    case "dispatch": {
      const cwd = typeof flags["cwd"] === "string" ? flags["cwd"] : process.cwd();
      const prompt = typeof flags["prompt"] === "string" ? flags["prompt"] : positional.join(" ");
      if (!prompt.trim()) fail("dispatch requires --prompt");
      const policy = policyFromFlags(args);
      await client.ensureDaemon(ENTRYPOINT);
      const result = (await client.send({
        op: "dispatch",
        cwd,
        prompt,
        model: flags["model"] ?? null,
        effort: flags["effort"] ?? null,
        sandbox: flags["sandbox"] ?? null,
        approvalPolicy: flags["approval"] ?? null,
        developerInstructions: flags["instructions"] ?? null,
        policy,
      })) as { runId: string };

      if (!flags["wait"]) {
        print(result);
        return;
      }
      await waitAndExit(result.runId);
      return;
    }

    case "resume": {
      const runId = positional[0];
      if (!runId) fail("resume requires a run id");
      const prompt = typeof flags["prompt"] === "string" ? flags["prompt"] : positional.slice(1).join(" ");
      if (!prompt.trim()) fail("resume requires --prompt");
      const policy = policyFromFlags(args);
      await client.ensureDaemon(ENTRYPOINT);
      const result = (await client.send({
        op: "resume",
        runId,
        prompt,
        cwd: flags["cwd"] ?? null,
        model: flags["model"] ?? null,
        effort: flags["effort"] ?? null,
        newRun: Boolean(flags["new-run"]),
        policy,
      })) as { runId: string };

      if (!flags["wait"]) {
        print(result);
        return;
      }
      // Resuming with --new-run reports under the new id, not the one asked for.
      await waitAndExit(result.runId);
      return;
    }

    case "mcp": {
      // Stdio is the MCP transport, so nothing may write to stdout but the
      // protocol itself; the server module keeps diagnostics on stderr.
      const { serveMcpStdio } = await import("./mcp.js");
      await serveMcpStdio({ client, entrypoint: ENTRYPOINT });
      return; // Run until the client closes the transport.
    }

    case "status": {
      const runId = positional[0];
      if (!runId) fail("status requires a run id");
      const record = (await client.send({ op: "status", runId })) as RunRecord;
      print(record);
      process.stderr.write(summarize(record) + "\n");
      process.exit(exitCodeForRun(record));
      return;
    }

    case "wait": {
      const runId = positional[0];
      if (!runId) fail("wait requires a run id");
      await waitAndExit(runId);
      return;
    }

    case "watch": {
      const runId = positional[0];
      if (!runId) fail("watch requires a run id");
      await watchAndExit(runId);
      return;
    }

    case "answer": {
      const runId = positional[0];
      const requestId = flags["request"];
      if (!runId || typeof requestId !== "string") {
        fail("answer requires a run id and --request <id>");
      }
      const raw = flags["answer"];
      if (raw === undefined) fail("answer requires --answer <value>");
      let parsed: unknown = raw;
      if (typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("["))) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          fail("--answer looked like JSON but did not parse");
        }
      }
      print(await client.send({ op: "answer", runId, requestId, answer: parsed }));
      return;
    }

    case "interrupt": {
      const runId = positional[0];
      if (!runId) fail("interrupt requires a run id");
      print(await client.send({ op: "interrupt", runId }));
      return;
    }

    case "list": {
      if (!(await client.isRunning())) fail("no daemon is running", EXIT.UNREACHABLE);
      print(await client.send({ op: "list" }));
      return;
    }

    case "events": {
      const runId = positional[0];
      if (!runId) fail("events requires a run id");
      print(
        await client.send({
          op: "events",
          runId,
          since: Number(flags["since"] ?? 0),
          limit: Number(flags["limit"] ?? 200),
        }),
      );
      return;
    }

    case "help":
    default: {
      process.stdout.write(
        [
          "codex-bridge -- bidirectional bridge to the Codex App Server",
          "",
          "  daemon [start|stop|status|--foreground] [--socket path]",
          "  dispatch --cwd <dir> --prompt <text> [--wait] [--timeout ms]",
          "           [--model m] [--effort e] [--sandbox s] [--approval p]",
          "           [--policy kind=mode]... [--auto-approve | --auto-deny]",
          "  resume <runId> --prompt <text> [--new-run] [--wait] [--timeout ms]",
          "                 [--cwd d] [--model m] [--effort e] [--policy kind=mode]...",
          "  status <runId>",
          "  wait <runId> [--timeout ms]",
          "  watch <runId> [--timeout ms]   wait across windows until settled",
          "  answer <runId> --request <id> --answer <value|json>",
          "  interrupt <runId>",
          "  list",
          "  events <runId> [--since n] [--limit n]",
          "  mcp                       serve the bridge as an MCP server over stdio",
          "",
          `Policy kinds: ${POLICY_KINDS.join(", ")}`,
          `Policy modes: ${POLICY_MODES.join(", ")} (default: ask)`,
          "",
          "Exit codes: 0 completed, 10 BLOCKED (needs a human), 11 still running,",
          "            12 failed, 13 interrupted, 14 daemon unreachable.",
          "",
          "A blocked run is never reported as success. That distinction is the",
          "reason this tool exists.",
        ].join("\n") + "\n",
      );
      return;
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`codex-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  // A daemon that answered and refused is not a daemon that could not be
  // reached. Reporting both as 14 would send a caller chasing a socket problem
  // that does not exist.
  const unreachable = !(error instanceof BridgeRequestError) || error.unreachable;
  process.exit(unreachable ? EXIT.UNREACHABLE : EXIT.USAGE);
});
