# codex-bridge

A bidirectional client for the **Codex App Server**, built to replace the Codex
plugin forwarder for programmatic dispatch.

The plugin's failure mode is not that it is slow or awkward — it is that it
**cannot tell "the agent stopped to ask you a question" from "the agent
finished"**. Both are recorded as `status=completed`, so a run that paused for
authorization can sit unnoticed for hours. Everything here is organized around
removing that ambiguity.

The mirror-image failure is also explicit: a nominally running turn that emits
no events for 15 minutes becomes `stalled`. The default deliberately exceeds a
known legitimate nine-minute silent `pytest` command while still detecting a
dead turn far sooner than an hour-long watch. Set
`CODEX_BRIDGE_STALL_TIMEOUT_MS` before starting the daemon to tune the window.

```
$ codex-bridge dispatch --cwd /repo --prompt 'refactor the parser' --wait
...
run run-mtn7uc8l-40pzr9 is BLOCKED and needs a human answer:
  [0] exec: run: /bin/bash -lc 'rm -rf build'
answer with: codex-bridge answer run-mtn7uc8l-40pzr9 --request 0 --answer <value>
$ echo $?
10
```

## Why the ambiguity was structural

The App Server protocol sends **ten** distinct server→client *requests*, not
just notifications:

| method | kind |
| --- | --- |
| `item/commandExecution/requestApproval` | exec |
| `execCommandApproval` | exec (legacy) |
| `item/fileChange/requestApproval` | fileChange |
| `applyPatchApproval` | patch (legacy) |
| `item/permissions/requestApproval` | permissions |
| `item/tool/requestUserInput` | userInput |
| `mcpServer/elicitation/request` | elicitation |
| `item/tool/call` | toolCall |
| `account/chatgptAuthTokens/refresh` | internal |
| `attestation/generate` | internal |

A blocking JSON-RPC *request* is structurally distinct from a `turn/completed`
notification. A client that only consumes notifications does not "run without
approvals" — it leaves the request unanswered and the turn hangs forever. That
is why a wrapper cannot recover the distinction after the fact; it has to be a
bidirectional peer.

`codex-bridge` routes every inbound request into exactly one of three buckets,
and there is deliberately no fourth bucket for "drop it":

- **auto** — answered immediately from policy, and recorded in the event log
- **park** — the run enters `blocked` and waits for a human
- **unsupported** — answered with an explicit JSON-RPC error, never left hanging

## Install

```sh
npm install
npm run ci        # typecheck + build + test
node dist/cli.js help
```

Requires Node ≥ 20 and the `codex` CLI on `PATH` (verified against 0.152.0).

Runtime dependencies are `@modelcontextprotocol/sdk` and `zod`, both used only
by the `mcp` command. Nothing on the CLI or daemon path imports them, so the
core bridge still runs on the standard library alone.

## Usage

```sh
codex-bridge daemon start
codex-bridge dispatch --cwd /repo --prompt '...' [--wait] [--timeout ms]
                      [--model m] [--effort e] [--sandbox s] [--approval p]
                      [--policy kind=mode]... [--auto-approve | --auto-deny]
codex-bridge resume <runId> --prompt '...' [--new-run] [--wait] [--timeout ms]
                            [--cwd d] [--model m] [--effort e] [--policy kind=mode]...
codex-bridge status <runId>
codex-bridge wait <runId> [--timeout ms]
codex-bridge watch <runId> [--timeout ms] [--retry-unreachable ms]
codex-bridge watch --all [--heartbeat ms] [--retry-unreachable ms]
codex-bridge answer <runId> --request <id> --answer <value|json>
codex-bridge interrupt <runId>
codex-bridge list
codex-bridge events <runId> [--since n] [--limit n]
codex-bridge mcp
```

`--sandbox` is `read-only` | `workspace-write` | `danger-full-access`.
`--approval` is `untrusted` | `on-request` | `never`.

### Interaction policy

By default every inbound request is parked and waits for a human — a bridge
whose whole point is surfacing questions must not answer them by accident.
`--policy kind=mode` opts specific kinds out of that, and repeats:

```sh
codex-bridge dispatch --cwd /repo --prompt 'run the tests' --wait \
  --policy exec=approve --policy fileChange=deny
```

| | values |
| --- | --- |
| kinds | `exec`, `patch`, `fileChange`, `permissions`, `userInput`, `elicitation`, `toolCall` |
| modes | `ask` (default, parks), `approve`, `deny` |

`--auto-approve` and `--auto-deny` set every kind at once and can still be
overridden per kind — `--auto-approve --policy fileChange=ask` approves
everything but patches. The two blanket switches contradict each other and are
rejected together.

`approve` cannot manufacture authority the bridge does not have: `permissions`
and `toolCall` requests still park under `--auto-approve`, because a permission
grant and a dynamic tool result have no answer that can be synthesized honestly.
A misspelled kind or mode is a **usage error (exit 2) before any run is
created** — never a silently ignored flag that leaves a run under a policy the
caller did not write. The effective policy is stored on the run record, so an
auto-approved exec is auditable next to the `bridge/autoAnswered` event that
used it.

### Resuming

`resume` sends another turn on a finished run's thread and rebuilds the live
record around it. The thread id is read from the persisted snapshot, so this
works after a daemon restart, a reboot, or a run the daemon has never seen in
this process:

```sh
codex-bridge resume run-mtn7uc8l-40pzr9 --prompt 'now update the tests' --wait
codex-bridge resume run-mtn7uc8l-40pzr9 --prompt 'try again' --new-run --wait
```

Without `--new-run` the continuation stays under the original runId and the
event log grows append-only across the resume. With `--new-run` the
continuation gets a fresh runId carrying a `bridge/resumedFrom` event, and the
original record — which holds the evidence of *why* a resume was needed — is
left untouched.

A run that is still `blocked`, `running`, or `stalled` is refused rather than resumed. A
second turn on a live thread would orphan the parked approval that made the run
interesting in the first place; answer it or interrupt it first. After the App
Server accepts `turn/start`, `resume` also waits up to 10 seconds for real turn
activity (`turn/started`, an item event, a server request, or completion). If
none arrives, the run is marked `failed` and the resume call returns the precise
failure instead of a run id that only appears to be progressing. The bounded
window is configurable with `CODEX_BRIDGE_RESUME_START_TIMEOUT_MS`.

### MCP server

`codex-bridge mcp` serves the bridge over stdio as an MCP server, exposing
`codex_dispatch`, `codex_resume`, `codex_status`, `codex_wait`, `codex_answer`,
`codex_interrupt`, `codex_list`, and `codex_events`.

The MCP server also subscribes to the daemon's control socket and emits a
standard `notifications/message` logging notification whenever a run changes
state, including when it becomes `blocked` or `stalled`, or reaches `completed`,
`failed`, or `interrupted`. The notification data contains `{ type: "runStateChanged",
record }`. Delivery is best-effort: disconnected clients miss events, and the
daemon neither buffers them nor waits for delivery, so a dropped MCP client can
never delay or damage a run.

```json
{ "command": "node", "args": ["/path/to/codex-bridge/dist/cli.js", "mcp"] }
```

A model has no exit code to read, so unhealthy states are carried twice on
every run-shaped result: the first line is the same unmistakable summary the
CLI prints, while `structuredContent.needsHuman` and
`structuredContent.stalled` are booleans to branch on. These fields are always
present, so callers reading only prose or only structure reach the same
conclusion.

A completed run can also carry `proseQuestionHint: true`. This is an advisory,
not a state: it never changes `completed`, `needsHuman`, terminality, or exit
code 0, because prose has no parked `requestId` that `codex_answer` could
answer. Packet authors can make the hint deterministic by putting exactly one
of these machine-readable lines in the final message:

```text
CODEX_BRIDGE_PROSE_QUESTION_HINT: true
CODEX_BRIDGE_PROSE_QUESTION_HINT: false
```

That exact, case-sensitive marker is authoritative. When it is absent, the
fallback scans the whole message and flags `?`, the full-width `？`, or an
explicit `please authorize`, `please confirm`, `please choose`, `please decide`,
`please provide`, `please clarify`, `please advise`, `please tell`, or `please
select`. It can miss indirect asks and languages that use neither question-mark
form, and it can flag rhetorical or quoted questions anywhere in a completed
report. When present, the first-line summary also says that the final message
may be asking for a response.

`codex_wait` is **bounded** — 60s by default, 240s maximum. When the window
elapses before the run settles, the result says the run has *not* finished, sets
`timedOut: true` and `exitCode: 11`, and tells the caller to call again. A wait
that ran until the MCP client's own timeout would surface as a transport error
instead of a run state, losing exactly the information the tool exists to
report.

MCP logging notifications cannot wake an idle supervising model: the bridge can
deliver `notifications/message` to the host, but the host may not schedule the
model to read it. For a reliable process-level wake-up, launch
`codex-bridge watch <runId>` in the background. `watch` repeatedly crosses the
daemon's bounded wait windows until the run is completed, blocked, stalled,
failed, or interrupted, then its process exits with the semantic code below. A
stall timer wakes an outstanding wait immediately; `watch` does not have to
finish its current window first. `--timeout`
sets the size of each bounded daemon wait window; it is not an overall deadline.
If the daemon becomes unreachable, `watch` alone retries the connection with
backoff for up to `--retry-unreachable` milliseconds (300000ms by default).
That retry window measures a continuous outage and resets after any successful
daemon response. If the window expires, `watch` exits 14 and reports how long it
retried. Set `--retry-unreachable 0` to restore fail-fast behaviour. This only
reconnects: `watch` never starts a daemon. An already-settled or unknown run
returns promptly because a daemon response is never retried. The existing
`wait` and `codex_wait` commands remain bounded and fail fast on an outage.

For coverage across every live run, use `watch --all`. It subscribes to the
daemon's state-transition stream and takes a startup snapshot, so a run that
settles during setup is still observed. The first line names the run that
caused exit and uses the same summary as `watch <runId>`. When several runs have
settled together, the selected outcome follows this precedence:
`BLOCKED > STALLED > FAILED > INTERRUPTED > OK`; the run id breaks ties within
an outcome. `watch --all` never starts a daemon and uses the same
`--retry-unreachable` outage window as the single-run watcher.

`--heartbeat <ms>` is opt-in. If the interval elapses without a settled run,
`watch --all` exits **16** and reports a heartbeat. With no heartbeat, an empty
startup snapshot exits **16** with "no in-flight runs; nothing to report". This
is deliberately distinct from exit 0, which means a run completed. The flag
must be a positive number of milliseconds.

When a shell script must expose the watcher's exit code, make `watch` the final
command in that script. In `watch --all; echo "$?"`, `echo` prints the status
saved from `watch`, but the shell reports `echo`'s own successful exit (0) to
the caller, so the watcher's status is lost.

### Exit codes are the contract

| code | meaning |
| --- | --- |
| 0 | completed |
| 2 | usage error |
| **10** | **BLOCKED — needs a human answer** |
| 11 | still running |
| 12 | failed |
| 13 | interrupted |
| 14 | daemon unreachable |
| **15** | **STALLED — no event activity beyond the configured threshold** |
| **16** | **aggregate heartbeat or no in-flight runs — nothing to report** |

A caller that only checks for exit 0 still will not mistake a blocked or stalled
run for a finished one. A caller that reads the code learns exactly what
happened without parsing prose. Existing codes retain their prior meanings.

The prose-question advisory deliberately has no new exit code. It is uncertain
and unanswerable through `codex_answer`; changing a completed run's exit status
would break existing shell callers and blur that protocol distinction.

A daemon that answered and *refused* exits 2, not 14. "The daemon is gone" and
"the daemon said no" are different problems with different fixes, and collapsing
them would send a caller chasing a socket failure that never happened.

### Answering a parked request

```sh
codex-bridge answer <runId> --request 0 --answer accept
codex-bridge answer <runId> --request 0 --answer approve-session
codex-bridge answer <runId> --request 0 --answer decline
codex-bridge answer <runId> --request 2 --answer '{"q1": ["us-east-1"]}'   # requestUserInput
```

If the App Server cancels or replaces a parked request, the upstream may remove
that request without a `codex-bridge answer` call. The bridge records and
reports requests while they exist, but consumers must not assume a pending
entry disappears only because a human answered it; refresh `status` after an
upstream cancellation.

`codex-bridge` will **not** synthesize an approval it cannot express. Permission
grants and dynamic tool results can only be declined, because inventing them
would fabricate authority the user never gave. It says so and errors out rather
than guessing.

## Design

### Durability: the daemon owns the child

`codex-bridge daemon` is a detached process that owns the
`codex app-server --stdio` child. CLI invocations are transient clients over a
unix control socket. A dropped SSH session or a killed terminal takes out the
client, not the run — which is the failure that previously destroyed hours of
finished work.

Run state is derived from App Server events and from the child process itself.
There is no self-maintained PID file that callers are asked to trust: a stale
`running` record pointing at a dead PID is exactly the bookkeeping that blocks a
resume and has to be hand-repaired.

While the daemon is alive, each run records `lastEventAtMs`,
`stallThresholdMs`, and the explicit `stalled` boolean. App Server activity
resets the inactivity timer; status reads and derived bridge diagnostics do
not. Crossing the threshold appends `bridge/stalled` without rewriting prior
events, sets state `stalled`, persists the snapshot, publishes the transition,
and wakes waiters. Later real activity can return the live run to `running`.

Each run is persisted under `$CODEX_BRIDGE_HOME` (default `~/.codex-bridge`):

```
runs/<runId>/record.json    current snapshot, rewritten on each change
runs/<runId>/events.jsonl   append-only log
```

The snapshot is written *after* the log, so a crash mid-write leaves the log
ahead of the snapshot rather than the reverse. A snapshot must never claim more
progress than the log can substantiate.

On startup the daemon reconciles runs that a previous daemon left non-terminal.
A `running`, `blocked`, or `stalled` record with no process behind it is a lie,
so it is marked `failed`
with a `bridge/orphaned` event and an error that names the state it died in and
the exact `codex-bridge resume` command that picks the work back up — the
resume-blocking bookkeeping is repaired rather than described.

A failed write to a run's log or snapshot degrades that one run instead of
taking down the daemon: the reason is recorded on the record's `storeError` and
echoed to stderr. These writes happen inside the transport's data handler, where
an unguarded throw escapes as an uncaught exception and kills every unrelated
run along with it — the precise durability failure this daemon exists to
prevent. A hole in a transcript is reported, never presented as a short but
complete log.

### Transport

Only `codex app-server --stdio` is used, with newline-delimited JSON framing.

This was settled empirically rather than assumed. The unix-socket transports —
the daemon control socket, `codex app-server proxy` (with and without `--sock`),
and a self-managed `--listen unix://` — all accept a connection but return
**nothing** for newline JSON, Content-Length framing, or raw bodies. They
presumably expect an undocumented handshake. Rather than guess, this bridge uses
the transport it can actually verify and supplies durability itself.

### Socket paths and SUN_LEN

Unix domain socket paths are capped at 108 bytes, and the failure is a bare
`path must be shorter than SUN_LEN` that reads like a permissions problem. The
control socket therefore lives at `$XDG_RUNTIME_DIR/codex-bridge-<uid>/control.sock`
— falling back to `/tmp` when the runtime dir is itself long — and never under
the (long) bridge home. Relative runtime directories and socket overrides are
rejected or fall back to `/tmp`; override with an absolute `CODEX_BRIDGE_SOCKET`.

A daemon on a custom socket is intentionally not auto-stopped when idle: it may
own a blocked run indefinitely. Stop it explicitly with `codex-bridge daemon
stop --socket /path/to/control.sock` (or with the same `CODEX_BRIDGE_SOCKET`
environment value used to start it). The daemon also records its socket path in
`$CODEX_BRIDGE_HOME/daemon.json`; there is no safe global scan that can discover
an arbitrary socket and home pair.

### Explicit everything

`cwd`, `sandbox`, and `approvalPolicy` are always sent explicitly on
`thread/start`. Inheriting the working directory from whichever shell happened
to launch the process is how a dispatch ends up pointed at the wrong repository,
and a hardcoded sandbox mode is how a run dies on a host whose bubblewrap cannot
create user namespaces.

### Failures are reported, not inferred

- An unparseable line on the transport calls `onTransportError`; it is never
  skipped. Treating unparseable output as "nothing happened" is how truncated
  or fabricated transcripts get mistaken for success.
- When the App Server child exits, every non-terminal run is marked `failed`
  with the real exit code, signal, and a bounded stderr tail. **Empty stderr is
  reported as "stderr was empty"**, not omitted — the absence of a diagnostic is
  itself a diagnostic.
- Interrupting a run answers every parked request with a decline *before*
  interrupting, so the server side is never left waiting on a client that has
  already walked away.
- An interrupted turn is reported as `interrupted` (exit 13), not flattened into
  `failed` (exit 12). The protocol has a first-class `interrupted` turn status;
  reporting it as a failure would send a caller hunting for an error that does
  not exist.
- An `item/started` event for a collaboration `wait` whose
  `receiverThreadIds` is empty adds a non-fatal `empty_wait_receivers` warning
  to the record and a `bridge/warning` event. It remains diagnostic: the bridge
  neither answers nor fails the turn on its own.

## Environment

`npm run ci` runs its checks through `scripts/ci.sh`. That entrypoint creates
temporary directories outside the checkout and overrides `TMPDIR`,
`NODE_COMPILE_CACHE`, and npm's cache for every child process. This keeps a
caller-supplied value such as `TMPDIR=.` from depositing test or compiler
artifacts in the repository.

| variable | meaning |
| --- | --- |
| `CODEX_BRIDGE_HOME` | run store root (default `~/.codex-bridge`) |
| `CODEX_BRIDGE_SOCKET` | control socket path |
| `CODEX_BIN` | `codex` executable (default: `codex` on `PATH`) |
| `CODEX_BRIDGE_STALL_TIMEOUT_MS` | event inactivity threshold (default `900000`, 15 minutes) |
| `CODEX_BRIDGE_RESUME_START_TIMEOUT_MS` | resumed-turn activity deadline (default `10000`, 10 seconds) |

## Protocol bindings

`src/protocol/` is generated by `codex app-server generate-ts` and is never
hand-edited. `npm run regen-protocol` regenerates it and re-runs
`scripts/fix-protocol-imports.mjs`, a deterministic codemod that appends `.js`
to the extensionless relative imports ts-rs emits (and resolves directory
re-exports to `/index.js`), which `moduleResolution: nodenext` otherwise
rejects. Hand-patching a generated file would silently diverge on the next
regeneration.

## Status

Feature-complete against its original scope: the MCP server surface,
`thread/resume` on the CLI, and per-kind policy flags all landed.

Verified end to end against `codex` 0.152.0 on Linux:

- happy path — `dispatch --wait` returned `completed`, exit 0
- blocked path — an approval request parked the run, `wait` returned `blocked`
  with exit **10** and the pending question surfaced; `answer --answer accept`
  released it and the run completed with exit 0
- policy — the same prompt under `--policy exec=approve` completed without ever
  parking; `--policy exce=approve` exited 2 with the valid-kinds list before a
  daemon was even started
- resume — `resume --prompt` kept the thread's context; `resume --new-run` after
  a full `daemon stop` produced a fresh runId on the same thread and left the
  original record intact; `resume` on a blocked run was refused

`npm run ci` is green. Beyond the unit tests, `test/bridge.test.js`
drives the real control socket against a scripted App Server stand-in
(`test/fixtures/fake-app-server.mjs`), because the behaviours that matter here —
a parked request, a resume across a daemon restart, a run orphaned by a dead
daemon — only exist in the seam between the daemon, the store, and a peer that
sends requests back. Three bugs were found that way and fixed: an interrupted
turn reported as `failed`, a daemon refusal reported as an unreachable daemon,
and an unguarded event-log write that could kill the daemon.
