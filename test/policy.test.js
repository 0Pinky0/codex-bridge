import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  POLICY_KINDS,
  POLICY_MODES,
  classifyServerRequest,
  parsePolicySpecs,
  sanitizePolicy,
} from "../dist/interaction.js";

/**
 * A policy the caller mistyped must never be silently discarded. Dropping
 * `--policy exce=approve` would leave them believing a kind was pre-answered,
 * and they would only find out when a run parked on it hours later.
 */

test("policy kinds exclude the ones no policy can satisfy", () => {
  // `internal` (auth refresh, attestation) is refused at every setting, so
  // offering a knob for it would advertise a capability that does not exist.
  assert.ok(!POLICY_KINDS.includes("internal"));
  assert.deepEqual([...POLICY_MODES], ["ask", "approve", "deny"]);
});

test("a misspelled kind is rejected, not ignored", () => {
  assert.throws(() => parsePolicySpecs(["exce=approve"]), /unknown interaction kind 'exce'/);
  assert.throws(() => parsePolicySpecs(["internal=deny"]), /unknown interaction kind 'internal'/);
});

test("a misspelled mode is rejected, not ignored", () => {
  assert.throws(() => parsePolicySpecs(["exec=yes"]), /unknown policy mode 'yes'/);
});

test("a spec without an = is a usage error rather than a no-op", () => {
  assert.throws(() => parsePolicySpecs(["exec"]), /expects kind=mode/);
  assert.throws(() => parsePolicySpecs(["=approve"]), /expects kind=mode/);
});

test("repeated specs accumulate across kinds", () => {
  assert.deepEqual(parsePolicySpecs(["exec=approve", "fileChange=deny"]), {
    exec: "approve",
    fileChange: "deny",
  });
});

test("the last spec for a kind wins", () => {
  assert.deepEqual(parsePolicySpecs(["exec=approve", "exec=deny"]), { exec: "deny" });
});

test("a blanket switch covers every policy kind", () => {
  const policy = parsePolicySpecs([], "deny");
  for (const kind of POLICY_KINDS) assert.equal(policy[kind], "deny", kind);
  assert.equal(Object.keys(policy).length, POLICY_KINDS.length);
});

test("an explicit spec overrides the blanket switch", () => {
  const policy = parsePolicySpecs(["exec=ask"], "approve");
  assert.equal(policy.exec, "ask");
  assert.equal(policy.fileChange, "approve");
});

test("no policy at all means ask, which is the safe default", () => {
  assert.deepEqual(parsePolicySpecs([]), {});
  const disposition = classifyServerRequest(
    "item/commandExecution/requestApproval",
    { command: ["rm", "-rf", "build"] },
    1,
    parsePolicySpecs([]),
  );
  assert.equal(disposition.type, "park");
});

test("a blanket approve still parks what it cannot express", () => {
  // `--auto-approve` must not become a way to make permission grants vanish.
  const policy = parsePolicySpecs([], "approve");
  assert.equal(classifyServerRequest("item/permissions/requestApproval", {}, 1, policy).type, "park");
  assert.equal(classifyServerRequest("item/tool/call", {}, 1, policy).type, "park");
  assert.equal(classifyServerRequest("item/commandExecution/requestApproval", {}, 1, policy).type, "auto");
});

test("sanitizePolicy guards the daemon against a hand-written control request", () => {
  assert.deepEqual(sanitizePolicy(undefined), {});
  assert.deepEqual(sanitizePolicy(null), {});
  assert.deepEqual(sanitizePolicy({ exec: "deny" }), { exec: "deny" });
  assert.throws(() => sanitizePolicy({ exec: "maybe" }), /unknown policy mode/);
  assert.throws(() => sanitizePolicy({ nope: "deny" }), /unknown interaction kind/);
  assert.throws(() => sanitizePolicy(["exec=deny"]), /must be an object/);
  assert.throws(() => sanitizePolicy("exec=deny"), /must be an object/);
});
