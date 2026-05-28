#!/usr/bin/env node
// Snapshot a plan file before modification using fs.copyFileSync.
// Windows-safe: handles paths with spaces because we never use shell.
// Usage:
//   node snapshot.mjs --plan <abs-path> --iter <N>
// Outputs JSON: {ok: true, snapshot: "<path>", short_hash: "..."} or {ok: false, ...}.

import { copyFileSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function shortHash(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha1").update(buf).digest("hex").slice(0, 8);
}

function timestamp() {
  // Compact ISO without colons or fractional seconds (filesystem-safe).
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = args.plan;
  const iter = args.iter;
  if (!plan || !iter) {
    process.stderr.write("Usage: snapshot.mjs --plan <abs-path> --iter <N>\n");
    process.exit(2);
  }
  let stat;
  try {
    stat = statSync(plan);
  } catch (err) {
    emit({ ok: false, reason: "plan_not_readable", error: String(err), plan });
    process.exit(1);
  }
  if (!stat.isFile()) {
    emit({ ok: false, reason: "plan_not_file", plan });
    process.exit(1);
  }
  let hash;
  try {
    hash = shortHash(plan);
  } catch (err) {
    emit({ ok: false, reason: "hash_failed", error: String(err), plan });
    process.exit(1);
  }
  const ts = timestamp();
  const snapshot = `${plan}.iter${iter}-${ts}-${hash}.bak`;
  try {
    copyFileSync(plan, snapshot);
    emit({ ok: true, snapshot, short_hash: hash, timestamp: ts });
  } catch (err) {
    emit({ ok: false, reason: "copy_failed", error: String(err), plan, snapshot });
    process.exit(1);
  }
}

main();
