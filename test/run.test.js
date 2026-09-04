import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, isTerminal, needsHuman, newRunRecord } from "../dist/run.js";
import { EXIT, exitCodeForRun, summarize } from "../dist/outcome.js";

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "codex-bridge-test-"));
  try {
    fn(new RunStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("blocked is not terminal, so a waiter never treats it as finished", () => {
  assert.equal(isTerminal("blocked"), false);
  assert.equal(needsHuman("blocked"), true);
  for (const state of ["completed", "failed", "interrupted"]) {
    assert.equal(isTerminal(state), true, state);
    assert.equal(needsHuman(state), false, state);
  }
  for (const state of ["starting", "running"]) {
    assert.equal(isTerminal(state), false, state);
  }
});

test("a blocked run does not exit 0", () => {
  const record = newRunRecord("run-1", "/tmp");
  record.state = "blocked";
  record.pending = [{ requestId: 0, method: "execCommandApproval", kind: "exec", summary: "run: ls" }];
  assert.equal(exitCodeForRun(record), EXIT.BLOCKED);
  assert.notEqual(exitCodeForRun(record), EXIT.OK);
});

test("every state maps to a distinct, non-success exit code except completed", () => {
  const record = newRunRecord("run-1", "/tmp");
  const codes = {};
  for (const state of ["completed", "blocked", "failed", "interrupted", "running", "starting"]) {
    record.state = state;
    codes[state] = exitCodeForRun(record);
  }
  assert.equal(codes.completed, 0);
  assert.equal(codes.blocked, 10);
  assert.equal(codes.running, 11);
  assert.equal(codes.starting, 11);
  assert.equal(codes.failed, 12);
  assert.equal(codes.interrupted, 13);
  const nonSuccess = Object.entries(codes).filter(([state]) => state !== "completed");
  for (const [state, code] of nonSuccess) assert.notEqual(code, 0, `${state} must not look like success`);
});

test("the summary of a blocked run says BLOCKED and lists the questions", () => {
  const record = newRunRecord("run-1", "/tmp");
  record.state = "blocked";
  record.pending = [
    { requestId: 3, method: "execCommandApproval", kind: "exec", summary: "run: rm -rf build" },
  ];
  const text = summarize(record);
  assert.match(text, /BLOCKED/);
  assert.match(text, /rm -rf build/);
  assert.match(text, /codex-bridge answer run-1 --request/);
});

test("a failed run's summary carries the real error, not a generic word", () => {
  const record = newRunRecord("run-1", "/tmp");
  record.state = "failed";
  record.error = "app-server exited (code=1, signal=null); stderr was empty";
  assert.match(summarize(record), /stderr was empty/);
});

test("records round-trip through the store", () => {
  withStore((store) => {
    const record = newRunRecord("run-abc", "/tmp/work");
    store.create(record);
    record.state = "running";
    record.threadId = "t-1";
    store.save(record);

    const loaded = store.load("run-abc");
    assert.equal(loaded.state, "running");
    assert.equal(loaded.threadId, "t-1");
    assert.equal(loaded.cwd, "/tmp/work");
    assert.equal(store.load("run-missing"), null);
  });
});

test("the event log is append-only and readable incrementally", () => {
  withStore((store) => {
    const record = newRunRecord("run-abc", "/tmp");
    store.create(record);
    for (let i = 0; i < 5; i += 1) {
      store.appendEvent(record, { atMs: i, method: `event/${i}` });
    }
    assert.equal(record.eventCount, 5);

    const all = store.readEvents("run-abc");
    assert.equal(all.length, 5);
    assert.equal(all[0].method, "event/0");

    const tail = store.readEvents("run-abc", 3);
    assert.equal(tail.length, 2);
    assert.equal(tail[0].method, "event/3");

    const page = store.readEvents("run-abc", 1, 2);
    assert.deepEqual(page.map((e) => e.method), ["event/1", "event/2"]);

    assert.deepEqual(store.readEvents("run-missing"), []);
  });
});

test("list returns newest first", () => {
  withStore((store) => {
    const older = newRunRecord("run-old", "/tmp");
    older.createdAtMs = 1000;
    const newer = newRunRecord("run-new", "/tmp");
    newer.createdAtMs = 2000;
    store.create(older);
    store.create(newer);
    assert.deepEqual(store.list().map((r) => r.runId), ["run-new", "run-old"]);
  });
});
