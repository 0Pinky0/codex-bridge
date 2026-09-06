import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, hasProseQuestionHint, isTerminal, needsHuman, newRunRecord } from "../dist/run.js";
import { EXIT, exitCodeForRun, summarize } from "../dist/outcome.js";

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "codex-bridge-test-"));
  try {
    fn(new RunStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("blocked and stalled are not terminal, so neither is mistaken for finished", () => {
  assert.equal(isTerminal("blocked"), false);
  assert.equal(needsHuman("blocked"), true);
  for (const state of ["completed", "failed", "interrupted"]) {
    assert.equal(isTerminal(state), true, state);
    assert.equal(needsHuman(state), false, state);
  }
  for (const state of ["starting", "running", "stalled"]) {
    assert.equal(isTerminal(state), false, state);
    assert.equal(needsHuman(state), false, state);
  }
});

test("a blocked run does not exit 0", () => {
  const record = newRunRecord("run-1", "/tmp");
  record.state = "blocked";
  record.pending = [{ requestId: 0, method: "execCommandApproval", kind: "exec", summary: "run: ls" }];
  assert.equal(exitCodeForRun(record), EXIT.BLOCKED);
  assert.notEqual(exitCodeForRun(record), EXIT.OK);
});

test("every state maps to its documented exit code without changing existing meanings", () => {
  const record = newRunRecord("run-1", "/tmp");
  const codes = {};
  for (const state of ["completed", "blocked", "failed", "interrupted", "running", "starting", "stalled"]) {
    record.state = state;
    codes[state] = exitCodeForRun(record);
  }
  assert.equal(codes.completed, 0);
  assert.equal(codes.blocked, 10);
  assert.equal(codes.running, 11);
  assert.equal(codes.starting, 11);
  assert.equal(codes.failed, 12);
  assert.equal(codes.interrupted, 13);
  assert.equal(codes.stalled, 15);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.UNREACHABLE, 14);
  const nonSuccess = Object.entries(codes).filter(([state]) => state !== "completed");
  for (const [state, code] of nonSuccess) assert.notEqual(code, 0, `${state} must not look like success`);
});

test("a stalled summary is unmistakably unhealthy", () => {
  const record = newRunRecord("run-stalled", "/tmp");
  record.state = "stalled";
  record.stalled = true;
  record.lastEventAtMs = 1_000;
  record.stallThresholdMs = 900_000;
  const text = summarize(record);
  assert.match(text, /STALLED/);
  assert.doesNotMatch(text, /success|completed/i);
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

test("the prose-question advisory catches the captured authority-boundary final message", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/prose-question-final-message.json", import.meta.url), "utf8"),
  );
  assert.equal(fixture.sourceRunId, "run-mtnh4itc-ye6dd7");
  assert.equal(hasProseQuestionHint(fixture.finalMessage), true);
});

test("the prose-question advisory catches the captured first-paragraph Round-5 blocker", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/prose-question-first-paragraph.json", import.meta.url), "utf8"),
  );
  assert.equal(fixture.sourceRunId, "run-mtogstp7-301qcb");
  assert.equal(hasProseQuestionHint(fixture.finalMessage), true);
});

test("a prose-question hint stays completed, terminal, non-blocked, and exit 0", () => {
  const record = newRunRecord("run-advisory", "/tmp");
  record.state = "completed";
  record.finalMessage = "Work is complete.\n\nPlease confirm which deployment target to use.";
  record.proseQuestionHint = hasProseQuestionHint(record.finalMessage);

  assert.equal(record.proseQuestionHint, true);
  assert.equal(record.state, "completed");
  assert.equal(needsHuman(record.state), false);
  assert.equal(isTerminal(record.state), true);
  assert.equal(exitCodeForRun(record), EXIT.OK);
  assert.match(summarize(record), /ADVISORY/);
});

test("the prose-question fallback scans every paragraph but keeps no-question reports false", () => {
  assert.equal(hasProseQuestionHint("Did the tests pass?\n\nAll work is complete."), true);
  assert.equal(hasProseQuestionHint("All work is complete."), false);
  assert.equal(hasProseQuestionHint("All work is complete. What next?"), true);
});

test("the prose-question fallback supports a full-width question mark", () => {
  assert.equal(hasProseQuestionHint("需要我继续吗？\n\n当前工作已经完成。"), true);
});

test("the exact marker line is authoritative over prose fallback", () => {
  assert.equal(hasProseQuestionHint("CODEX_BRIDGE_PROSE_QUESTION_HINT: true\n\nWork is complete."), true);
  assert.equal(hasProseQuestionHint("CODEX_BRIDGE_PROSE_QUESTION_HINT: false\n\nDid the tests pass?"), false);
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
