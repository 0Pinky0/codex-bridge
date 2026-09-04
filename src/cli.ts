#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { BridgeClient } from "./client.js";
import { BridgeDaemon, defaultHome, defaultSocketPath } from "./daemon.js";
import { EXIT, exitCodeForRun, summarize } from "./outcome.js";
import type { RunRecord } from "./run.js";

export { EXIT } from "./outcome.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
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
      i += 1;
    }
  }
  return { command, positional, flags };
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
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const socketPath = typeof flags["socket"] === "string" ? flags["socket"] : defaultSocketPath();
  const client = new BridgeClient(socketPath);

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
      })) as { runId: string };

      if (!flags["wait"]) {
        print(result);
        return;
      }
      const timeoutMs = Number(flags["timeout"] ?? 240000);
      const record = (await client.send(
        { op: "wait", runId: result.runId, timeoutMs },
        timeoutMs + 30000,
      )) as RunRecord;
      print(record);
      process.stderr.write(summarize(record) + "\n");
      process.exit(exitCodeForRun(record));
      return;
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
      const timeoutMs = Number(flags["timeout"] ?? 240000);
      const record = (await client.send({ op: "wait", runId, timeoutMs }, timeoutMs + 30000)) as RunRecord;
      print(record);
      process.stderr.write(summarize(record) + "\n");
      process.exit(exitCodeForRun(record));
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
          "  daemon [start|stop|status|--foreground]",
          "  dispatch --cwd <dir> --prompt <text> [--wait] [--timeout ms]",
          "           [--model m] [--effort e] [--sandbox s] [--approval p]",
          "  status <runId>",
          "  wait <runId> [--timeout ms]",
          "  answer <runId> --request <id> --answer <value|json>",
          "  interrupt <runId>",
          "  list",
          "  events <runId> [--since n] [--limit n]",
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
  process.exit(EXIT.UNREACHABLE);
});
