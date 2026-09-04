#!/usr/bin/env node
/**
 * Rewrite extensionless relative imports in generated protocol bindings.
 *
 * `codex app-server generate-ts` emits ts-rs style imports (`from "./Foo"`),
 * which TypeScript rejects under `moduleResolution: nodenext`. This script is
 * run as part of `npm run regen-protocol` so the generated tree is always
 * produced by tooling and never hand-edited -- a hand-patched generated file
 * silently diverges from the protocol on the next regeneration.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.argv[2] ?? "src/protocol";

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

let changed = 0;
let scanned = 0;
for (const file of walk(root)) {
  scanned += 1;
  const before = readFileSync(file, "utf8");
  const after = before.replace(
    /(from\s+")(\.\.?\/[^"]+?)(")/g,
    (match, prefix, spec, suffix) => {
      if (spec.endsWith(".js")) return match;
      // A bare directory re-export (`from "./v2"`) must resolve to its index,
      // not to a sibling `v2.js` that does not exist.
      const target = join(dirname(file), spec);
      const resolved = existsSync(target) && statSync(target).isDirectory() ? `${spec}/index.js` : `${spec}.js`;
      return `${prefix}${resolved}${suffix}`;
    },
  );
  if (after !== before) {
    writeFileSync(file, after, "utf8");
    changed += 1;
  }
}

process.stdout.write(`fix-protocol-imports: scanned ${scanned} files, rewrote ${changed}\n`);
