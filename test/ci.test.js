import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CI = join(ROOT, "scripts", "ci.sh");

test("CI wrapper relocates unsafe temporary and cache environments", () => {
  const result = spawnSync("sh", [CI, process.execPath, "-e", [
    "const { mkdtempSync } = require('node:fs');",
    "const { tmpdir } = require('node:os');",
    "const { join } = require('node:path');",
    "console.log(JSON.stringify({ tmpdir: tmpdir(), created: mkdtempSync(join(tmpdir(), 'cbr-ci-probe-')), nodeCache: process.env.NODE_COMPILE_CACHE, npmCache: process.env.npm_config_cache }));",
  ].join("\n")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TMPDIR: ".",
      NODE_COMPILE_CACHE: "./node-compile-cache",
      npm_config_cache: "./node_modules/.cache/npm",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.tmpdir.startsWith(ROOT), false);
  assert.equal(observed.created.startsWith(ROOT), false);
  assert.equal(observed.nodeCache.startsWith(ROOT), false);
  assert.equal(observed.npmCache.startsWith(ROOT), false);
});
