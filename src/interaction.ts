import type { JsonRpcId } from "./jsonrpc.js";

/**
 * Classification and handling of server-initiated requests.
 *
 * This is the module the whole tool exists for. The Codex App Server sends ten
 * distinct request types back to its client. A client that ignores them does
 * not "run without approvals" -- it hangs the turn indefinitely, and from the
 * outside that is indistinguishable from a long-running task. Worse, a wrapper
 * that reports such a turn as finished converts a stop-to-ask into a false
 * success.
 *
 * So every inbound request lands in exactly one of three buckets:
 *
 *   auto       -- answered immediately from policy, recorded in the event log
 *   park       -- the run enters the `blocked` state and waits for a human
 *   unsupported-- answered with an explicit JSON-RPC error, never left hanging
 *
 * There is deliberately no fourth bucket for "drop it".
 */

export type InteractionKind =
  | "exec"
  | "patch"
  | "fileChange"
  | "permissions"
  | "userInput"
  | "elicitation"
  | "toolCall"
  | "internal";

export type PolicyMode = "ask" | "approve" | "deny";

/** Per-kind policy. Anything unset defaults to `ask`, which is the safe default. */
export type InteractionPolicy = Partial<Record<InteractionKind, PolicyMode>>;

export const SERVER_REQUEST_KINDS: Record<string, InteractionKind> = {
  "execCommandApproval": "exec",
  "item/commandExecution/requestApproval": "exec",
  "applyPatchApproval": "patch",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permissions",
  "item/tool/requestUserInput": "userInput",
  "mcpServer/elicitation/request": "elicitation",
  "item/tool/call": "toolCall",
  "account/chatgptAuthTokens/refresh": "internal",
  "attestation/generate": "internal",
};

export interface PendingInteraction {
  /** JSON-RPC id of the server request; the handle a human answers against. */
  requestId: JsonRpcId;
  method: string;
  kind: InteractionKind;
  /** One-line human-readable description of what is being asked. */
  summary: string;
  /** Structured questions, present only for `userInput`. */
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }> | null;
    isOther: boolean;
    isSecret: boolean;
  }>;
  /** Whether the server says this request blocks turn progress. */
  isBlocking: boolean;
  params: unknown;
  createdAtMs: number;
}

export type InteractionDisposition =
  | { type: "auto"; response: unknown; note: string }
  | { type: "park"; pending: PendingInteraction }
  | { type: "unsupported"; message: string };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function summarizeExec(params: unknown): string {
  const record = asRecord(params);
  const command = record["command"];
  if (Array.isArray(command)) return `run: ${command.join(" ")}`.slice(0, 300);
  if (typeof command === "string") return `run: ${command}`.slice(0, 300);
  const reason = record["reason"];
  return typeof reason === "string" ? `approve command: ${reason}`.slice(0, 300) : "approve a command";
}

function summarizeFileChange(params: unknown): string {
  const record = asRecord(params);
  const reason = record["reason"];
  const root = record["grantRoot"] ?? record["root"];
  if (typeof root === "string") return `write access under ${root}`;
  if (typeof reason === "string") return `file change: ${reason}`.slice(0, 300);
  return "approve a file change";
}

/**
 * Build the correct decline payload for a request type. Used for `deny` policy
 * and when a run is interrupted while interactions are parked -- an abandoned
 * request must still be answered so the server can unwind cleanly.
 */
export function declineResponse(method: string, rejection = "declined by codex-bridge policy"): unknown {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection } } };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline" };
    case "item/tool/call":
      return { contentItems: [{ type: "text", text: rejection }], success: false };
    default:
      return {};
  }
}

function approveResponse(method: string): unknown {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "approved" };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "accept" };
    default:
      // `permissions`, `userInput`, `elicitation` and `toolCall` have no
      // meaningful blanket "yes"; they must be parked or declined explicitly.
      return null;
  }
}

export function classifyServerRequest(
  method: string,
  params: unknown,
  requestId: JsonRpcId,
  policy: InteractionPolicy,
  now = Date.now(),
): InteractionDisposition {
  const kind = SERVER_REQUEST_KINDS[method];

  if (kind === undefined) {
    return {
      type: "unsupported",
      message: `codex-bridge does not implement server request '${method}'`,
    };
  }

  if (kind === "internal") {
    // Auth-token refresh and attestation are host-application plumbing. We
    // cannot satisfy them, and parking them would show a human a question they
    // have no way to answer. Answering with an error is the honest outcome.
    return {
      type: "unsupported",
      message: `'${method}' requires a host application; codex-bridge cannot satisfy it`,
    };
  }

  const mode: PolicyMode = policy[kind] ?? "ask";

  if (mode === "deny") {
    return { type: "auto", response: declineResponse(method), note: `policy denied ${kind}` };
  }

  if (mode === "approve") {
    const response = approveResponse(method);
    if (response !== null) {
      return { type: "auto", response, note: `policy approved ${kind}` };
    }
    // Fall through to parking: an "approve" policy that has no expressible
    // approval must not be silently downgraded to a drop.
  }

  const record = asRecord(params);
  const pending: PendingInteraction = {
    requestId,
    method,
    kind,
    summary: summarizeInteraction(method, params),
    isBlocking: record["isBlocking"] === undefined ? true : Boolean(record["isBlocking"]),
    params,
    createdAtMs: now,
  };

  if (kind === "userInput" && Array.isArray(record["questions"])) {
    pending.questions = (record["questions"] as Array<Record<string, unknown>>).map((question) => ({
      id: String(question["id"] ?? ""),
      header: String(question["header"] ?? ""),
      question: String(question["question"] ?? ""),
      options: Array.isArray(question["options"])
        ? (question["options"] as Array<Record<string, unknown>>).map((option) => ({
            label: String(option["label"] ?? ""),
            description: String(option["description"] ?? ""),
          }))
        : null,
      isOther: Boolean(question["isOther"]),
      isSecret: Boolean(question["isSecret"]),
    }));
  }

  return { type: "park", pending };
}

export function summarizeInteraction(method: string, params: unknown): string {
  switch (method) {
    case "execCommandApproval":
    case "item/commandExecution/requestApproval":
      return summarizeExec(params);
    case "applyPatchApproval":
      return "apply a patch";
    case "item/fileChange/requestApproval":
      return summarizeFileChange(params);
    case "item/permissions/requestApproval":
      return "grant a permission profile";
    case "item/tool/requestUserInput": {
      const questions = asRecord(params)["questions"];
      if (Array.isArray(questions) && questions.length > 0) {
        const first = asRecord(questions[0])["question"];
        const suffix = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
        return `asked: ${String(first)}${suffix}`.slice(0, 300);
      }
      return "asked a question";
    }
    case "mcpServer/elicitation/request":
      return "an MCP server requested input";
    case "item/tool/call":
      return `dynamic tool call: ${String(asRecord(params)["name"] ?? "unknown")}`;
    default:
      return method;
  }
}

/**
 * Build the response payload for a human-supplied answer to a parked request.
 *
 * `answer` is intentionally loose at the edge (it arrives from a CLI) and is
 * narrowed here, where the protocol shapes are known.
 */
export function buildAnswerResponse(pending: PendingInteraction, answer: unknown): unknown {
  const method = pending.method;

  if (method === "item/tool/requestUserInput") {
    // Accept either {questionId: ["a"]} or a bare string for single-question asks.
    const answers: Record<string, { answers: string[] }> = {};
    if (typeof answer === "string") {
      const first = pending.questions?.[0];
      if (!first) throw new Error("no question to answer");
      answers[first.id] = { answers: [answer] };
      return { answers };
    }
    const record = asRecord(answer);
    for (const [key, value] of Object.entries(record)) {
      answers[key] = { answers: Array.isArray(value) ? value.map(String) : [String(value)] };
    }
    if (Object.keys(answers).length === 0) throw new Error("empty answer for requestUserInput");
    return { answers };
  }

  const decision = typeof answer === "string" ? answer : String(asRecord(answer)["decision"] ?? "");

  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    if (decision === "approve" || decision === "approved") return { decision: "approved" };
    if (decision === "approve-session") return { decision: "approved_for_session" };
    if (decision === "deny" || decision === "decline") {
      return { decision: { denied: { rejection: "declined by user" } } };
    }
    if (decision === "abort") return { decision: "abort" };
    throw new Error(`unrecognized decision '${decision}' for ${method}`);
  }

  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    if (decision === "approve" || decision === "accept") return { decision: "accept" };
    if (decision === "approve-session") return { decision: "acceptForSession" };
    if (decision === "deny" || decision === "decline") return { decision: "decline" };
    if (decision === "abort" || decision === "cancel") return { decision: "cancel" };
    throw new Error(`unrecognized decision '${decision}' for ${method}`);
  }

  // For request types whose accept payload we cannot synthesize safely, only
  // an explicit decline is offered. Inventing a permission grant or a tool
  // result would be fabricating authority the user never gave.
  if (decision === "deny" || decision === "decline") return declineResponse(method, "declined by user");
  throw new Error(
    `codex-bridge can only decline '${method}'; approving it requires a host application`,
  );
}
