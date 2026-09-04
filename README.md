# codex-bridge

A bidirectional client for the **Codex App Server**, built to replace the Codex
plugin forwarder for programmatic dispatch.

The plugin's failure mode is not that it is slow or awkward — it is that it
**cannot tell "the agent stopped to ask you a question" from "the agent
finished"**. Both are recorded as `status=completed`, so a run that paused for
authorization can sit unnoticed for hours. Everything here is organized around
removing that ambiguity.

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

A run that is still `blocked` or `running` is refused rather than resumed. A
second turn on a live thread would orphan the parked approval that made the run
interesting in the first place; answer it or interrupt it first.

### MCP server

`codex-bridge mcp` serves the bridge over stdio as an MCP server, exposing
`codex_dispatch`, `codex_resume`, `codex_status`, `codex_wait`, `codex_answer`,
`codex_interrupt`, `codex_list`, and `codex_events`.

```json
{ "command": "node", "args": ["/path/to/codex-bridge/dist/cli.js", "mcp"] }
```

A model has no exit code to read, so the blocked/completed distinction is
carried twice on every run-shaped result: the first line of text is the same
summary the CLI prints (which never describes a blocked run in words that read
as success), and `structuredContent.needsHuman` is a boolean to branch on. Both
are always present, so a caller reading only the prose and one reading only the
structure reach the same conclusion.

`codex_wait` is **bounded** — 60s by default, 240s maximum. When the window
elapses before the run settles, the result says the run has *not* finished, sets
`timedOut: true` and `exitCode: 11`, and tells the caller to call again. A wait
that ran until the MCP client's own timeout would surface as a transport error
instead of a run state, losing exactly the information the tool exists to
report.

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

A caller that only checks for exit 0 still will not mistake a blocked run for a
finished one. A caller that reads the code learns exactly what happened without
parsing prose.

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

Each run is persisted under `$CODEX_BRIDGE_HOME` (default `~/.codex-bridge`):

```
runs/<runId>/record.json    current snapshot, rewritten on each change
runs/<runId>/events.jsonl   append-only log
```

The snapshot is written *after* the log, so a crash mid-write leaves the log
ahead of the snapshot rather than the reverse. A snapshot must never claim more
progress than the log can substantiate.

On startup the daemon reconciles runs that a previous daemon left non-terminal.
A `running` record with no process behind it is a lie, so it is marked `failed`
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
the (long) bridge home. Override with `CODEX_BRIDGE_SOCKET`.

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

## Environment

| variable | meaning |
| --- | --- |
| `CODEX_BRIDGE_HOME` | run store root (default `~/.codex-bridge`) |
| `CODEX_BRIDGE_SOCKET` | control socket path |
| `CODEX_BIN` | `codex` executable (default: `codex` on `PATH`) |

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

`npm run ci` is green (75 tests). Beyond the unit tests, `test/bridge.test.js`
drives the real control socket against a scripted App Server stand-in
(`test/fixtures/fake-app-server.mjs`), because the behaviours that matter here —
a parked request, a resume across a daemon restart, a run orphaned by a dead
daemon — only exist in the seam between the daemon, the store, and a peer that
sends requests back. Three bugs were found that way and fixed: an interrupted
turn reported as `failed`, a daemon refusal reported as an unreachable daemon,
and an unguarded event-log write that could kill the daemon.
