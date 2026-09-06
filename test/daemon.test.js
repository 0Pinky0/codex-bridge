import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_RESUME_START_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  defaultHome,
  defaultSocketPath,
} from "../dist/daemon.js";

/**
 * Unix domain socket paths are capped by SUN_LEN (108 bytes on Linux), and the
 * failure is a bare `path must be shorter than SUN_LEN` that reads like a
 * permissions problem. The socket path must stay short by construction.
 */

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the default socket path stays well inside SUN_LEN", () => {
  withEnv({ CODEX_BRIDGE_SOCKET: undefined, XDG_RUNTIME_DIR: undefined }, () => {
    const path = defaultSocketPath();
    assert.ok(path.length < 100, `socket path is ${path.length} bytes: ${path}`);
    assert.match(path, /control\.sock$/);
  });
});

test("a long XDG_RUNTIME_DIR is refused in favour of /tmp", () => {
  const longDir = "/run/user/1000/" + "x".repeat(80);
  withEnv({ CODEX_BRIDGE_SOCKET: undefined, XDG_RUNTIME_DIR: longDir }, () => {
    const path = defaultSocketPath();
    assert.ok(!path.startsWith(longDir), `should not use the long runtime dir: ${path}`);
    assert.ok(path.length < 100, `socket path is ${path.length} bytes`);
  });
});

test("a short XDG_RUNTIME_DIR is honoured", () => {
  withEnv({ CODEX_BRIDGE_SOCKET: undefined, XDG_RUNTIME_DIR: "/run/user/1000" }, () => {
    assert.ok(defaultSocketPath().startsWith("/run/user/1000/"));
  });
});

test("an explicit socket override wins", () => {
  withEnv({ CODEX_BRIDGE_SOCKET: "/tmp/custom.sock" }, () => {
    assert.equal(defaultSocketPath(), "/tmp/custom.sock");
  });
});

test("the bridge home is overridable so runs can be isolated", () => {
  withEnv({ CODEX_BRIDGE_HOME: "/tmp/cbr-home" }, () => {
    assert.equal(defaultHome(), "/tmp/cbr-home");
  });
  withEnv({ CODEX_BRIDGE_HOME: undefined }, () => {
    assert.match(defaultHome(), /\.codex-bridge$/);
  });
});

test("liveness defaults leave headroom above a nine-minute silent command", () => {
  assert.equal(DEFAULT_STALL_TIMEOUT_MS, 900_000);
  assert.ok(DEFAULT_STALL_TIMEOUT_MS > 9 * 60_000);
  assert.equal(DEFAULT_RESUME_START_TIMEOUT_MS, 10_000);
});
