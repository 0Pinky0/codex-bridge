import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { InteractionPolicy, PendingInteraction } from "./interaction.js";

/**
 * Run state model and durable event log.
 *
 * The single most important design rule lives here: `blocked` is a distinct
 * terminal-looking state that is NOT `completed`. A supervising process that
 * cannot tell "the agent stopped to ask you something" from "the agent
 * finished" will sit on a finished-looking run for hours. Any code that maps
 * these two states together is a bug, and `isTerminal()` deliberately excludes
 * `blocked` so that waiters keep waiting on it rather than returning success.
 * A completed final message can still look like a natural-language question;
 * that is only an advisory hint because there is no parked request to answer.
 */

export type RunState =
  | "starting"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "interrupted";

export function isTerminal(state: RunState): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}

/** States in which a human is required before anything else can happen. */
export function needsHuman(state: RunState): boolean {
  return state === "blocked";
}

/**
 * Modest natural-language heuristic for completed messages that may be asking
 * the supervisor to respond. Only the final non-empty paragraph is inspected.
 * It detects a literal `?` or a short list of explicit "please <verb>" requests.
 * It intentionally does not claim to understand indirect requests, other
 * languages, or questions earlier in a long final message.
 */
export function hasProseQuestionHint(message: string | null): boolean {
  if (!message?.trim()) return false;
  const paragraphs = message.trim().split(/\n\s*\n/);
  const finalParagraph = paragraphs.at(-1) ?? "";
  if (finalParagraph.includes("?")) return true;
  return /\bplease\s+(?:authorize|confirm|choose|decide|provide|clarify|advise|tell|select)\b/i.test(finalParagraph);
}

export interface RunEvent {
  atMs: number;
  /** `bridge/*` for our own lifecycle events, otherwise the App Server method. */
  method: string;
  params?: unknown;
}

export interface RunRecord {
  runId: string;
  threadId: string | null;
  turnId: string | null;
  state: RunState;
  cwd: string;
  model: string | null;
  sandbox: string | null;
  approvalPolicy: string | null;
  /**
   * Per-kind interaction policy for this run, layered over the daemon default.
   * Persisted so that `status` shows what a run was actually dispatched under:
   * an auto-approved exec is only auditable if the policy that approved it is
   * recorded alongside the event that used it.
   */
  policy: InteractionPolicy;
  createdAtMs: number;
  updatedAtMs: number;
  /** Final assistant message, populated on completion. */
  finalMessage: string | null;
  /** Heuristic advisory only; unlike `blocked`, there is no parked request. */
  proseQuestionHint: boolean;
  /** Populated on `failed`. */
  error: string | null;
  /**
   * Set when a write to this run's event log or snapshot failed.
   *
   * A run whose log cannot be written is degraded even if the turn itself is
   * fine: the transcript now has a hole in it. Saying so beats presenting a
   * short log as a complete one.
   */
  storeError: string | null;
  /** Outstanding server requests awaiting a human answer. */
  pending: PendingInteraction[];
  /** Monotonic count of events appended, so clients can poll incrementally. */
  eventCount: number;
}

export function newRunRecord(runId: string, cwd: string): RunRecord {
  const now = Date.now();
  return {
    runId,
    threadId: null,
    turnId: null,
    state: "starting",
    cwd,
    model: null,
    sandbox: null,
    approvalPolicy: null,
    policy: {},
    createdAtMs: now,
    updatedAtMs: now,
    finalMessage: null,
    proseQuestionHint: false,
    error: null,
    storeError: null,
    pending: [],
    eventCount: 0,
  };
}

/**
 * Filesystem layout, rooted at the bridge home:
 *
 *   runs/<runId>/record.json   current snapshot, rewritten on each change
 *   runs/<runId>/events.jsonl  append-only event log
 *
 * The snapshot is written last so a crash mid-write leaves the log ahead of the
 * snapshot rather than the reverse; a snapshot must never claim more progress
 * than the log can substantiate.
 */
export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "runs"), { recursive: true });
  }

  runDir(runId: string): string {
    return join(this.root, "runs", runId);
  }

  create(record: RunRecord): void {
    mkdirSync(this.runDir(record.runId), { recursive: true });
    this.save(record);
  }

  save(record: RunRecord): void {
    record.updatedAtMs = Date.now();
    const path = join(this.runDir(record.runId), "record.json");
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  }

  load(runId: string): RunRecord | null {
    const path = join(this.runDir(runId), "record.json");
    if (!existsSync(path)) return null;
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
      // Records written by an older build predate `policy`. Backfilling the
      // safe default here beats letting `undefined` reach the classifier, where
      // it would read as "no policy set" only by accident.
      record.policy ??= {};
      record.storeError ??= null;
      record.proseQuestionHint ??=
        record.state === "completed" && hasProseQuestionHint(record.finalMessage);
      return record;
    } catch {
      return null;
    }
  }

  appendEvent(record: RunRecord, event: RunEvent): void {
    appendFileSync(join(this.runDir(record.runId), "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
    record.eventCount += 1;
  }

  readEvents(runId: string, since = 0, limit = 500): RunEvent[] {
    const path = join(this.runDir(runId), "events.jsonl");
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
    const out: RunEvent[] = [];
    for (const line of lines.slice(since, since + limit)) {
      try {
        out.push(JSON.parse(line) as RunEvent);
      } catch {
        out.push({ atMs: 0, method: "bridge/unparseableEvent", params: { line: line.slice(0, 200) } });
      }
    }
    return out;
  }

  list(): RunRecord[] {
    const runsDir = join(this.root, "runs");
    if (!existsSync(runsDir)) return [];
    const records: RunRecord[] = [];
    for (const entry of readdirSync(runsDir)) {
      const record = this.load(entry);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
}
