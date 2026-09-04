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

## Usage

```sh
codex-bridge daemon start
codex-bridge dispatch --cwd /repo --prompt '...' [--wait] [--timeout ms]
                      [--model m] [--effort e] [--sandbox s] [--approval p]
codex-bridge status <runId>
codex-bridge wait <runId> [--timeout ms]
codex-bridge answer <runId> --request <id> --answer <value|json>
codex-bridge interrupt <runId>
codex-bridge list
codex-bridge events <runId> [--since n] [--limit n]
```

`--sandbox` is `read-only` | `workspace-write` | `danger-full-access`.
`--approval` is `untrusted` | `on-request` | `never`.

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

Verified end to end against `codex` 0.152.0 on Linux:

- happy path — `dispatch --wait` returned `completed`, exit 0
- blocked path — an approval request parked the run, `wait` returned `blocked`
  with exit **10** and the pending question surfaced; `answer --answer accept`
  released it and the run completed with exit 0

`npm run ci` is green (35 tests). Not yet implemented: the MCP server surface,
`thread/resume` wired to the CLI, and per-kind policy flags on `dispatch`.
