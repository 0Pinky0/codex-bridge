import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient, BridgeRequestError } from "../dist/client.js";
import { BridgeDaemon } from "../dist/daemon.js";
import { RunStore, needsHuman, newRunRecord } from "../dist/run.js";
import { EXIT, exitCodeForRun } from "../dist/outcome.js";

/**
 * End-to-end tests against a scripted App Server (test/fixtures), driven over
 * the real control socket.
 *
 * The behaviours that matter here -- a parked request, a resume across a daemon
 * restart, a run orphaned by a dead daemon -- only exist in the seam between
 * the daemon, the store, and a peer that sends requests back. Testing the
 * pieces separately would leave exactly that seam unexercised.
 */

const FAKE_APP_SERVER = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

let socketCounter = 0;

/** Run `fn` against a started daemon, cleaning up even if it throws. */
async function withDaemon(home, fn, options = {}) {
  const socketPath = join(tmpdir(), `cbr-test-${process.pid}-${socketCounter++}.sock`);
  const daemon = new BridgeDaemon({ home, socketPath, codexPath: FAKE_APP_SERVER, ...options });
  await daemon.start();
  const client = new BridgeClient(socketPath);
  try {
    return await fn(client, daemon);
  } finally {
    daemon.close();
  }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "cbr-home-"));
  const saved = process.env.FAKE_APP_SERVER_STATE;
  // The fake keeps its threads here, so a resume after a restart is testing the
  // bridge rather than the fake's amnesia.
  process.env.FAKE_APP_SERVER_STATE = join(home, "fake-threads.json");
  return (async () => {
    try {
      return await fn(home);
    } finally {
      if (saved === undefined) delete process.env.FAKE_APP_SERVER_STATE;
      else process.env.FAKE_APP_SERVER_STATE = saved;
      // Let closing daemon children release files before retrying busy workspace paths.
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  })();
}

const dispatch = (client, extra = {}) =>
  client.send({ op: "dispatch", cwd: process.cwd(), prompt: "ok:done", ...extra });

async function waitForNotification(notifications, runId, state) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = notifications.find((event) => event.record.runId === runId && event.record.state === state);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no ${state} notification arrived for ${runId}`);
}

test("state transitions to blocked and completed are pushed to subscribers", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const notifications = [];
      const unsubscribe = await client.subscribe((event) => notifications.push(event));
      try {
        const { runId } = await dispatch(client, { prompt: "approve:touch marker" });
        const blocked = await waitForNotification(notifications, runId, "blocked");
        assert.equal(blocked.type, "runStateChanged");
        assert.equal(blocked.record.pending.length, 1);

        await client.send({
          op: "answer",
          runId,
          requestId: String(blocked.record.pending[0].requestId),
          answer: "accept",
        });
        await waitForNotification(notifications, runId, "completed");
      } finally {
        unsubscribe();
      }
    });
  });
});

test("transitions to every terminal state are pushed to subscribers", async () => {
  for (const scenario of [
    { state: "completed", prompt: "ok:done" },
    { state: "interrupted", prompt: "hang", interrupt: true },
    { state: "failed", prompt: "crash" },
  ]) {
    await withHome(async (home) => {
      await withDaemon(home, async (client) => {
        const notifications = [];
        const unsubscribe = await client.subscribe((event) => notifications.push(event));
        try {
          const { runId } = await dispatch(client, { prompt: scenario.prompt });
          if (scenario.interrupt) await client.send({ op: "interrupt", runId });
          const event = await waitForNotification(notifications, runId, scenario.state);
          assert.equal(event.record.state, scenario.state);
        } finally {
          unsubscribe();
        }
      });
    });
  }
});

test("a run completes and the daemon keeps serving when no notification client is listening", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "ok:unobserved but durable" });
      const record = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
      assert.equal(record.state, "completed");
      assert.equal(record.finalMessage, "unobserved but durable");
      assert.equal((await client.send({ op: "ping" })).appServerAlive, true);
    });
  });
});

test("a dispatched run completes and reports its final message", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "ok:refactored the parser" });
      const record = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
      assert.equal(record.state, "completed");
      assert.equal(record.finalMessage, "refactored the parser");
      assert.equal(exitCodeForRun(record), EXIT.OK);
    });
  });
});

test("the daemon records a prose-question hint without changing completed semantics", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "ok:Please confirm the deployment target." });
      const record = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
      assert.equal(record.state, "completed");
      assert.equal(record.proseQuestionHint, true);
      assert.equal(needsHuman(record.state), false);
      assert.equal(exitCodeForRun(record), EXIT.OK);
      assert.deepEqual(record.pending, []);
    });
  });
});

test("an approval request parks the run, and an answer releases it", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "approve:rm -rf build" });
      const blocked = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);

      assert.equal(blocked.state, "blocked", "a stop-to-ask must not look like a completion");
      assert.equal(blocked.proseQuestionHint, false);
      assert.equal(needsHuman(blocked.state), true);
      assert.equal(exitCodeForRun(blocked), EXIT.BLOCKED);
      assert.equal(blocked.pending.length, 1);
      assert.match(blocked.pending[0].summary, /rm -rf build/);

      const answered = await client.send({
        op: "answer",
        runId,
        requestId: String(blocked.pending[0].requestId),
        answer: "accept",
      });
      assert.equal(answered.remaining, 0);

      const done = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
      assert.equal(done.state, "completed");
      assert.equal(done.finalMessage, "approved and ran");
    });
  });
});

test("a per-run approve policy answers the request without ever parking", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, {
        prompt: "approve:rm -rf build",
        policy: { exec: "approve" },
      });
      const record = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
      assert.equal(record.state, "completed");
      assert.deepEqual(record.policy, { exec: "approve" }, "the policy is recorded, so an auto-approval is auditable");

      const events = await client.send({ op: "events", runId, since: 0, limit: 500 });
      const auto = events.find((event) => event.method === "bridge/autoAnswered");
      assert.ok(auto, "an auto-answer must be recorded, not silently applied");
      assert.match(auto.params.note, /policy approved exec/);
    });
  });
});

test("one run's policy does not leak into another", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const permissive = await dispatch(client, {
        prompt: "approve:touch a",
        policy: { exec: "approve" },
      });
      await client.send({ op: "wait", runId: permissive.runId, timeoutMs: 5000 }, 10000);

      const strict = await dispatch(client, { prompt: "approve:touch b" });
      const record = await client.send({ op: "wait", runId: strict.runId, timeoutMs: 5000 }, 10000);
      assert.equal(record.state, "blocked", "the default is ask, regardless of what another run allowed");
    });
  });
});

test("a policy the daemon cannot honour is refused before the run is created", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      await assert.rejects(
        () => dispatch(client, { policy: { internal: "approve" } }),
        /unknown interaction kind 'internal'/,
      );
      assert.deepEqual(await client.send({ op: "list" }), [], "nothing may be persisted for a rejected dispatch");
    });
  });
});

test("interrupting a run reports it as interrupted, not as a failure", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "hang" });
      await client.send({ op: "interrupt", runId });

      // The App Server then sends turn/completed with status 'interrupted'.
      // Flattening that into `failed` would send the user hunting for an error
      // that does not exist, and would exit 12 instead of 13.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const record = await client.send({ op: "status", runId });
      assert.equal(record.state, "interrupted");
      assert.equal(record.error, null);
      assert.equal(exitCodeForRun(record), EXIT.INTERRUPTED);
    });
  });
});

test("interrupting answers parked requests so the server is not left waiting", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "approve:rm -rf /" });
      const blocked = await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
      assert.equal(blocked.state, "blocked");

      await client.send({ op: "interrupt", runId });
      const record = await client.send({ op: "status", runId });
      assert.equal(record.state, "interrupted");
      assert.deepEqual(record.pending, []);
    });
  });
});

test("resume sends another turn on the same thread", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const first = await dispatch(client, { prompt: "ok:first" });
      await client.send({ op: "wait", runId: first.runId, timeoutMs: 5000 }, 10000);

      const resumed = await client.send({ op: "resume", runId: first.runId, prompt: "ok:second" });
      assert.equal(resumed.runId, first.runId, "without --new-run the history stays under one id");
      assert.equal(resumed.threadId, first.threadId);

      const record = await client.send({ op: "wait", runId: first.runId, timeoutMs: 5000 }, 10000);
      assert.equal(record.finalMessage, "second");
      // The log is append-only across the resume, so the first turn is still there.
      const events = await client.send({ op: "events", runId: first.runId, since: 0, limit: 500 });
      assert.ok(events.some((event) => event.method === "bridge/threadResumed"));
    });
  });
});

test("resume --new-run leaves the original record untouched", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const first = await dispatch(client, { prompt: "approve:rm -rf build" });
      const blocked = await client.send({ op: "wait", runId: first.runId, timeoutMs: 5000 }, 10000);
      await client.send({
        op: "answer",
        runId: first.runId,
        requestId: String(blocked.pending[0].requestId),
        answer: "decline",
      });
      await client.send({ op: "wait", runId: first.runId, timeoutMs: 5000 }, 10000);

      const resumed = await client.send({
        op: "resume",
        runId: first.runId,
        prompt: "ok:took another run at it",
        newRun: true,
      });
      assert.notEqual(resumed.runId, first.runId);
      assert.equal(resumed.resumedFrom, first.runId);

      const fresh = await client.send({ op: "wait", runId: resumed.runId, timeoutMs: 5000 }, 10000);
      assert.equal(fresh.finalMessage, "took another run at it");

      // The record that holds the evidence of why a resume was needed survives.
      const original = await client.send({ op: "status", runId: first.runId });
      assert.equal(original.state, "failed");
      assert.equal(original.finalMessage, null);
    });
  });
});

test("resume refuses a run that is still blocked or running", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "approve:rm -rf build" });
      await client.send({ op: "wait", runId, timeoutMs: 5000 }, 10000);
      // A second turn on the same thread would orphan the parked approval.
      await assert.rejects(
        () => client.send({ op: "resume", runId, prompt: "ok:go on" }),
        /is blocked; answer its pending requests or interrupt it/,
      );
    });
  });
});

test("a daemon refusal is not reported as an unreachable daemon", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const error = await client
        .send({ op: "status", runId: "run-does-not-exist" })
        .then(() => null, (caught) => caught);
      assert.ok(error instanceof BridgeRequestError);
      // "the daemon is gone" and "the daemon said no" are different problems
      // with different fixes, and the exit code has to tell them apart.
      assert.equal(error.unreachable, false);
      assert.match(error.message, /unknown run/);
    });
  });
});

test("an absent daemon is reported as unreachable", async () => {
  const client = new BridgeClient(join(tmpdir(), "cbr-nothing-listening.sock"));
  const error = await client.send({ op: "ping" }, 2000).then(() => null, (caught) => caught);
  assert.ok(error instanceof BridgeRequestError);
  assert.equal(error.unreachable, true);
});

test("a run left non-terminal by a dead daemon is closed out, not left claiming progress", async () => {
  await withHome(async (home) => {
    let runId;
    let threadId;
    await withDaemon(home, async (client) => {
      const started = await dispatch(client, { prompt: "hang" });
      runId = started.runId;
      threadId = started.threadId;
      assert.equal((await client.send({ op: "status", runId })).state, "running");
    });

    // Model a daemon that died without unwinding -- SIGKILL, an OOM, a host
    // reboot -- rather than the clean shutdown above, which gets to mark its
    // own runs. What is left behind is a `running` record with nothing driving
    // it, which is the stale bookkeeping that used to need hand-repair.
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the clean teardown finish writing
    const store = new RunStore(home);
    const stale = store.load(runId);
    stale.state = "running";
    stale.error = null;
    store.save(stale);

    await withDaemon(home, async (client) => {
      const record = await client.send({ op: "status", runId });
      assert.equal(record.state, "failed", "a `running` record with no process behind it is a lie");
      assert.match(record.error, /orphaned/);
      // The thread id survives, so the work is resumable rather than lost.
      assert.equal(record.threadId, threadId);
      assert.match(record.error, new RegExp(`resume ${runId}`));

      const resumed = await client.send({ op: "resume", runId, prompt: "ok:picked it back up" });
      const done = await client.send({ op: "wait", runId: resumed.runId, timeoutMs: 5000 }, 10000);
      assert.equal(done.state, "completed");
      assert.equal(done.finalMessage, "picked it back up");
    });
  });
});

test("when the app server dies, its runs are failed with the real reason", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "crash" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const record = await client.send({ op: "status", runId });
      assert.equal(record.state, "failed");
      assert.match(record.error, /app-server exited/);
      // Empty stderr is itself a diagnostic and must be said out loud.
      assert.match(record.error, /stderr/);
    });
  });
});

test("a broken event log degrades one run instead of killing the daemon", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const doomed = await dispatch(client, { prompt: "hang" });
      // Event appends happen inside the transport's data handler. An unguarded
      // throw there escapes as an uncaught exception and takes down every
      // unrelated run along with it -- the exact durability failure this daemon
      // exists to prevent.
      rmSync(join(home, "runs", doomed.runId), { recursive: true, force: true });
      await client.send({ op: "interrupt", runId: doomed.runId });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const degraded = await client.send({ op: "status", runId: doomed.runId });
      assert.match(degraded.storeError, /store write failed/, "a hole in the log is reported, not swallowed");

      // The daemon is still serving, and a new run is unaffected.
      const healthy = await dispatch(client, { prompt: "ok:still here" });
      const record = await client.send({ op: "wait", runId: healthy.runId, timeoutMs: 5000 }, 10000);
      assert.equal(record.state, "completed");
      assert.equal(record.storeError, null);
    });
  });
});

test("a running run whose real event stream freezes is reported stalled", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "hang" });
      await new Promise((resolve) => setTimeout(resolve, 120));

      const record = await client.send({ op: "status", runId });
      assert.equal(record.state, "stalled");
      assert.equal(record.stalled, true);
      assert.ok(record.lastEventAtMs <= Date.now() - 80);
      const events = await client.send({ op: "events", runId, since: 0, limit: 200 });
      assert.ok(events.some((event) => event.method === "bridge/stalled"));
    }, { stallTimeoutMs: 80 });
  });
});

test("a slow run with continuing App Server events is not reported stalled", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "slow-alive" });
      await new Promise((resolve) => setTimeout(resolve, 180));
      const active = await client.send({ op: "status", runId });
      assert.equal(active.state, "running");
      assert.equal(active.stalled, false);
      const done = await client.send({ op: "wait", runId, timeoutMs: 1000 }, 3000);
      assert.equal(done.state, "completed");
    }, { stallTimeoutMs: 100 });
  });
});

test("resume fails loudly when the accepted turn produces no start activity", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const first = await dispatch(client, { prompt: "ok:first" });
      await client.send({ op: "wait", runId: first.runId, timeoutMs: 1000 }, 3000);
      await assert.rejects(
        () => client.send({ op: "resume", runId: first.runId, prompt: "no-start" }, 3000),
        /accepted turn\/start but no turn activity.*within 80ms/i,
      );
      const record = await client.send({ op: "status", runId: first.runId });
      assert.equal(record.state, "failed");
      assert.match(record.error, /no turn activity/i);
    }, { resumeStartTimeoutMs: 80, stallTimeoutMs: 1000 });
  });
});

test("a collab wait with no receivers adds a diagnostic warning without failing", async () => {
  await withHome(async (home) => {
    await withDaemon(home, async (client) => {
      const { runId } = await dispatch(client, { prompt: "empty-wait" });
      const record = await client.send({ op: "wait", runId, timeoutMs: 1000 }, 3000);
      assert.equal(record.state, "completed");
      assert.equal(record.warnings.length, 1);
      assert.match(record.warnings[0].message, /waiting on nobody/i);
      const events = await client.send({ op: "events", runId, since: 0, limit: 200 });
      const warning = events.find((event) => event.method === "bridge/warning");
      assert.equal(warning.params.code, "empty_wait_receivers");
    });
  });
});

test("startup reconciles a persisted stalled record as orphaned rather than healthy", async () => {
  await withHome(async (home) => {
    const store = new RunStore(home);
    const stale = newRunRecord("run-stalled-orphan", process.cwd());
    stale.threadId = "thread-stalled-orphan";
    stale.state = "stalled";
    stale.stalled = true;
    store.create(stale);
    store.appendEvent(stale, { atMs: 1_000, method: "item/started", params: { fixture: true } });
    store.save(stale);

    await withDaemon(home, async (client) => {
      const record = await client.send({ op: "status", runId: stale.runId });
      assert.equal(record.state, "failed");
      assert.equal(record.stalled, false);
      assert.match(record.error, /daemon.*exited while it was 'stalled'/);
      const events = await client.send({ op: "events", runId: stale.runId, since: 0, limit: 20 });
      const orphaned = events.find((event) => event.method === "bridge/orphaned");
      assert.equal(orphaned.params.previousState, "stalled");
    });
  });
});
