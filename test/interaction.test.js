import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SERVER_REQUEST_KINDS,
  buildAnswerResponse,
  classifyServerRequest,
  declineResponse,
} from "../dist/interaction.js";

/**
 * These tests pin the behaviour the tool exists for: a server-initiated request
 * is never dropped, and an approval is never fabricated.
 */

/** Every server request method the App Server can send, from its ServerRequest union. */
const ALL_SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
];

test("every documented server request is classified", () => {
  for (const method of ALL_SERVER_REQUESTS) {
    assert.ok(SERVER_REQUEST_KINDS[method], `${method} has no kind`);
  }
  assert.equal(Object.keys(SERVER_REQUEST_KINDS).length, ALL_SERVER_REQUESTS.length);
});

test("no server request is ever dropped: every method yields a disposition", () => {
  for (const method of ALL_SERVER_REQUESTS) {
    const disposition = classifyServerRequest(method, {}, 1, {});
    assert.ok(["auto", "park", "unsupported"].includes(disposition.type), `${method} -> ${disposition.type}`);
  }
  // An unknown future method is answered with an error, not silently ignored.
  const unknown = classifyServerRequest("some/futureMethod", {}, 1, {});
  assert.equal(unknown.type, "unsupported");
});

test("the default policy is to ask, not to auto-approve", () => {
  const disposition = classifyServerRequest("item/commandExecution/requestApproval", { command: "rm -rf /" }, 7, {});
  assert.equal(disposition.type, "park");
  assert.equal(disposition.pending.requestId, 7);
  assert.equal(disposition.pending.kind, "exec");
  assert.match(disposition.pending.summary, /rm -rf \//);
});

test("host-application requests are refused explicitly, never parked", () => {
  for (const method of ["account/chatgptAuthTokens/refresh", "attestation/generate"]) {
    const disposition = classifyServerRequest(method, {}, 1, {});
    assert.equal(disposition.type, "unsupported", method);
    assert.match(disposition.message, /host application/);
  }
});

test("an approve policy that cannot be expressed parks instead of dropping", () => {
  // There is no blanket "yes" for a permission grant, so `approve` must not
  // silently degrade into ignoring the request.
  const disposition = classifyServerRequest("item/permissions/requestApproval", {}, 1, {
    permissions: "approve",
  });
  assert.equal(disposition.type, "park");
});

test("deny policy auto-answers with the shape each method expects", () => {
  const exec = classifyServerRequest("execCommandApproval", {}, 1, { exec: "deny" });
  assert.equal(exec.type, "auto");
  assert.deepEqual(exec.response, { decision: { denied: { rejection: "declined by codex-bridge policy" } } });

  const fileChange = classifyServerRequest("item/fileChange/requestApproval", {}, 1, { fileChange: "deny" });
  assert.equal(fileChange.type, "auto");
  assert.deepEqual(fileChange.response, { decision: "decline" });
});

test("approve policy uses the legacy and v2 decision vocabularies correctly", () => {
  const legacy = classifyServerRequest("applyPatchApproval", {}, 1, { patch: "approve" });
  assert.deepEqual(legacy.response, { decision: "approved" });

  const v2 = classifyServerRequest("item/commandExecution/requestApproval", {}, 1, { exec: "approve" });
  assert.deepEqual(v2.response, { decision: "accept" });
});

test("requestUserInput questions are surfaced so a human can answer them", () => {
  const params = {
    questions: [
      {
        id: "q1",
        header: "Region",
        question: "Which region should this deploy to?",
        options: [{ label: "us-east-1", description: "primary" }],
        isOther: false,
        isSecret: false,
      },
      { id: "q2", header: "Confirm", question: "Proceed?", options: null, isOther: true, isSecret: false },
    ],
  };
  const disposition = classifyServerRequest("item/tool/requestUserInput", params, "abc", {});
  assert.equal(disposition.type, "park");
  assert.equal(disposition.pending.questions.length, 2);
  assert.equal(disposition.pending.questions[0].header, "Region");
  assert.match(disposition.pending.summary, /Which region.*\+1 more/);
});

test("buildAnswerResponse maps a human answer onto the protocol shape", () => {
  const exec = { method: "item/commandExecution/requestApproval", kind: "exec" };
  assert.deepEqual(buildAnswerResponse(exec, "accept"), { decision: "accept" });
  assert.deepEqual(buildAnswerResponse(exec, "approve-session"), { decision: "acceptForSession" });
  assert.deepEqual(buildAnswerResponse(exec, "decline"), { decision: "decline" });
  assert.deepEqual(buildAnswerResponse(exec, { decision: "cancel" }), { decision: "cancel" });

  const legacy = { method: "execCommandApproval", kind: "exec" };
  assert.deepEqual(buildAnswerResponse(legacy, "approve"), { decision: "approved" });
  assert.deepEqual(buildAnswerResponse(legacy, "deny"), {
    decision: { denied: { rejection: "declined by user" } },
  });
});

test("an unrecognized decision is rejected rather than guessed at", () => {
  const exec = { method: "item/commandExecution/requestApproval", kind: "exec" };
  assert.throws(() => buildAnswerResponse(exec, "yes please"), /unrecognized decision/);
});

test("codex-bridge refuses to fabricate an approval it cannot express", () => {
  // Approving a permission grant or synthesizing a tool result would invent
  // authority the user never gave. Declining is always available.
  const permissions = { method: "item/permissions/requestApproval", kind: "permissions" };
  assert.throws(() => buildAnswerResponse(permissions, "accept"), /can only decline/);
  assert.deepEqual(buildAnswerResponse(permissions, "decline"), {});

  const toolCall = { method: "item/tool/call", kind: "toolCall" };
  assert.throws(() => buildAnswerResponse(toolCall, "accept"), /can only decline/);
});

test("requestUserInput accepts a bare string for a single question", () => {
  const pending = {
    method: "item/tool/requestUserInput",
    kind: "userInput",
    questions: [{ id: "q1", header: "", question: "", options: null, isOther: false, isSecret: false }],
  };
  assert.deepEqual(buildAnswerResponse(pending, "us-east-1"), {
    answers: { q1: { answers: ["us-east-1"] } },
  });
  assert.deepEqual(buildAnswerResponse(pending, { q1: ["a", "b"] }), {
    answers: { q1: { answers: ["a", "b"] } },
  });
  assert.throws(() => buildAnswerResponse(pending, {}), /empty answer/);
});

test("declineResponse answers every request type so no turn is left hanging", () => {
  for (const method of ALL_SERVER_REQUESTS) {
    const response = declineResponse(method, "run interrupted by user");
    assert.equal(typeof response, "object");
    assert.notEqual(response, null);
  }
  assert.deepEqual(declineResponse("mcpServer/elicitation/request"), { action: "decline" });
  assert.equal(declineResponse("item/tool/call", "gone").success, false);
});
