import type { RunRecord } from "./run.js";

/**
 * How a run's state is reported to the outside world.
 *
 * This lives apart from the CLI entrypoint so it can be tested without
 * executing `main()`. The mapping is the tool's contract, and a contract that
 * cannot be tested in isolation tends to drift.
 */

/**
 * Exit codes are part of this tool's contract.
 *
 * `BLOCKED` exists so that no caller can mistake "stopped to ask you a
 * question" for "finished successfully". A supervising agent that only checks
 * for exit 0 still will not treat a blocked run as done, and one that checks
 * the code learns exactly what happened without parsing prose.
 */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  BLOCKED: 10,
  STILL_RUNNING: 11,
  FAILED: 12,
  INTERRUPTED: 13,
  UNREACHABLE: 14,
} as const;

export function exitCodeForRun(record: RunRecord): number {
  switch (record.state) {
    case "completed":
      return EXIT.OK;
    case "blocked":
      return EXIT.BLOCKED;
    case "failed":
      return EXIT.FAILED;
    case "interrupted":
      return EXIT.INTERRUPTED;
    default:
      return EXIT.STILL_RUNNING;
  }
}

/** A one-line human summary that never hides a blocked state behind a status word. */
export function summarize(record: RunRecord): string {
  if (record.state === "blocked") {
    const questions = record.pending.map((p) => `  [${String(p.requestId)}] ${p.kind}: ${p.summary}`);
    return [
      `run ${record.runId} is BLOCKED and needs a human answer:`,
      ...questions,
      `answer with: codex-bridge answer ${record.runId} --request <id> --answer <value>`,
    ].join("\n");
  }
  if (record.state === "completed") {
    return record.proseQuestionHint
      ? `run ${record.runId} completed (ADVISORY: final message may be asking for a response)`
      : `run ${record.runId} completed`;
  }
  if (record.state === "failed") return `run ${record.runId} failed: ${record.error ?? "unknown error"}`;
  if (record.state === "interrupted") return `run ${record.runId} was interrupted`;
  return `run ${record.runId} is ${record.state}`;
}
