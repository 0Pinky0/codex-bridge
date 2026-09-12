import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BridgeRequestError } from "../dist/client.js";
import { newRunRecord } from "../dist/run.js";
import { EXIT, exitCodeForRun } from "../dist/outcome.js";
import { watchAll } from "../dist/watch.js";

function record(runId, state = "running", eventCount = 1) {
  return { ...newRunRecord(runId, "/repo"), state, eventCount, stalled: state === "stalled" };
}

function fakeClient(onSnapshot) {
  let notify;
  let disconnect;
  const client = {
    subscriptions: 0,
    closed: 0,
    snapshots: 0,
    emit(value) { notify({ type: "runStateChanged", record: value }); },
    disconnect() { disconnect(new BridgeRequestError("daemon closed the subscription", true)); },
    async subscribe(handler, _timeout, onDisconnect) {
      notify = handler;
      disconnect = onDisconnect;
      client.subscriptions += 1;
      return () => { client.closed += 1; };
    },
    async send(request) {
      assert.equal(request.op, "list", "aggregate watch must not poll individual waits");
      assert.ok(client.subscriptions > 0, "the subscription must precede the snapshot");
      client.snapshots += 1;
      return onSnapshot(client);
    },
  };
  return client;
}

test("aggregate watch retains a settlement delivered during the initial snapshot", async () => {
  const running = record("race");
  const blocked = record("race", "blocked", 2);
  const client = fakeClient(() => {
    client.emit(blocked);
    return [running];
  });
  const result = await watchAll(client, { retryUnreachableMs: 0 });
  assert.equal(result.record.runId, "race");
  assert.equal(exitCodeForRun(result.record), EXIT.BLOCKED);
  assert.equal(client.closed, 1);
});

test("aggregate watch applies every precedence level to simultaneous settlements", async () => {
  const states = ["blocked", "stalled", "failed", "interrupted", "completed"];
  for (let index = 0; index < states.length; index += 1) {
    const candidates = states.slice(index).reverse().map((state) => record(`run-${state}`, state, 2));
    const client = fakeClient(() => {
      for (const value of candidates) client.emit(value);
      return candidates;
    });
    const result = await watchAll(client, { retryUnreachableMs: 0 });
    assert.equal(result.record.state, states[index]);
    assert.equal(result.record.runId, `run-${states[index]}`);
  }
});

test("aggregate watch excludes historical terminal runs from the startup snapshot", async () => {
  const client = fakeClient(() => [record("old-success", "completed"), record("old-failure", "failed")]);
  const result = await watchAll(client, { retryUnreachableMs: 0 });
  assert.deepEqual(result, { record: null, reason: "no-in-flight-runs" });
  assert.equal(client.closed, 1);
});

test("aggregate heartbeat waits without repeatedly reading records", async () => {
  const client = fakeClient(() => [record("still-running")]);
  const started = Date.now();
  const watching = watchAll(client, { retryUnreachableMs: 0, heartbeatMs: 80 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.snapshots, 1, "a quiet stream must not cause snapshot polling");
  const result = await watching;
  assert.deepEqual(result, { record: null, reason: "heartbeat" });
  assert.ok(Date.now() - started >= 70);
  assert.equal(client.snapshots, 2, "only startup and exit reconciliation should read records");
});

test("aggregate watch covers a new run while an existing run stays active", async () => {
  const existing = record("existing");
  const client = fakeClient(() => [existing]);
  const watching = watchAll(client, { retryUnreachableMs: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  client.emit(record("new-run", "blocked", 2));
  const result = await watching;
  assert.equal(result.record.runId, "new-run");
  assert.equal(result.record.state, "blocked");
});

test("aggregate watch reconciles a tracked run that settles during disconnection", async () => {
  const client = fakeClient(() => client.subscriptions === 1
    ? [record("recovered")]
    : [record("recovered", "failed", 2)]);
  const watching = watchAll(client, { retryUnreachableMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  client.disconnect();
  const result = await watching;
  assert.equal(client.subscriptions, 2);
  assert.equal(result.record.runId, "recovered");
  assert.equal(exitCodeForRun(result.record), EXIT.FAILED);
  assert.equal(client.closed, 2);
});

test("aggregate watch retries an unreachable daemon and preserves the outage limit", async () => {
  let attempts = 0;
  const client = {
    async subscribe() {
      attempts += 1;
      throw new BridgeRequestError("missing daemon", true);
    },
  };
  const started = Date.now();
  await assert.rejects(watchAll(client, { retryUnreachableMs: 80 }), (error) => {
    assert.equal(error.unreachable, true);
    assert.match(error.message, /after retrying for \d+ms \(limit: 80ms\)/);
    return true;
  });
  assert.ok(attempts >= 2);
  assert.ok(Date.now() - started >= 70);
});

test("aggregate watch never retries a daemon refusal", async () => {
  const client = fakeClient(() => { throw new BridgeRequestError("list refused", false); });
  await assert.rejects(watchAll(client, { retryUnreachableMs: 1000 }), (error) => {
    assert.equal(error.unreachable, false);
    assert.equal(error.message, "list refused");
    return true;
  });
  assert.equal(client.subscriptions, 1);
  assert.equal(client.closed, 1);
});

test("aggregate watch returns a completed transition with the OK code", async () => {
  const client = fakeClient(() => {
    client.emit(record("done", "completed", 2));
    return [record("done", "running")];
  });
  const result = await watchAll(client, { retryUnreachableMs: 0 });
  assert.equal(result.record.runId, "done");
  assert.equal(exitCodeForRun(result.record), EXIT.OK);
});

test("aggregate watch uses fresh state when a blocked notification was already answered", async () => {
  const client = fakeClient(() => {
    client.emit(record("answered", "blocked", 2));
    return [record("answered", "completed", 3)];
  });
  const result = await watchAll(client, { retryUnreachableMs: 0 });
  assert.equal(result.record.state, "completed");
  assert.equal(result.record.eventCount, 3);
});
