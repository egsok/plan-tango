#!/usr/bin/env node
// Manage per-slug workspace directory under ~/.claude/plans/.
// Usage:
//   node workspace.mjs ensure --slug <slug>
//   node workspace.mjs cleanup --slug <slug>
// Outputs JSON: {ok: true, path: "..."} or {ok: false, reason: "...", path: "..."}.

import { homedir } from "node:os";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { _: [] };
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
    } else {
      args._.push(a);
    }
  }
  return args;
}

function plansRoot() {
  return path.join(homedir(), ".claude", "plans");
}

function expectedWorkspace(slug) {
  return path.join(plansRoot(), `${slug}-tango.workspace`);
}

function ensureSlug(slug) {
  if (!slug || typeof slug !== "string") return null;
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  return slug;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function ensureCmd(slug) {
  const target = expectedWorkspace(slug);
  try {
    mkdirSync(target, { recursive: true });
    emit({ ok: true, path: target });
  } catch (err) {
    emit({ ok: false, reason: "mkdir_failed", path: target, error: String(err) });
    process.exit(1);
  }
}

function cleanupCmd(slug) {
  const expected = expectedWorkspace(slug);
  if (!existsSync(expected)) {
    emit({ ok: true, path: expected, note: "already_absent" });
    return;
  }
  let lst;
  try {
    lst = lstatSync(expected);
  } catch (err) {
    emit({
      ok: false,
      reason: "lstat_failed",
      path: expected,
      error: String(err),
    });
    process.exit(1);
  }
  if (lst.isSymbolicLink()) {
    emit({ ok: false, reason: "is_symlink", path: expected });
    process.exit(1);
  }
  if (!lst.isDirectory()) {
    emit({ ok: false, reason: "not_directory", path: expected });
    process.exit(1);
  }
  let realTarget;
  let realExpected;
  try {
    realTarget = realpathSync.native(expected);
    // realpath of expected resolves symlinks in parent components too.
    // If parent dir has a symlink that points elsewhere, both should agree
    // because we computed expected from homedir() directly.
    realExpected = realpathSync.native(plansRoot());
  } catch (err) {
    emit({ ok: false, reason: "realpath_failed", path: expected, error: String(err) });
    process.exit(1);
  }
  // realTarget must be inside realpath(plans_root). Use path.relative + check.
  const rel = path.relative(realExpected, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    emit({
      ok: false,
      reason: "outside_plans_root",
      path: expected,
      real_target: realTarget,
      real_plans_root: realExpected,
    });
    process.exit(1);
  }
  // Final canonical match check: realTarget must end with the expected workspace name.
  const expectedRel = path.relative(realExpected, expected);
  if (rel !== expectedRel) {
    emit({
      ok: false,
      reason: "canonical_mismatch",
      path: expected,
      real_target: realTarget,
      expected_rel: expectedRel,
    });
    process.exit(1);
  }
  try {
    rmSync(expected, { recursive: true, force: false });
    emit({ ok: true, path: expected });
  } catch (err) {
    emit({ ok: false, reason: "rm_failed", path: expected, error: String(err) });
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));
  const slug = ensureSlug(opts.slug);
  if (!slug) {
    emit({ ok: false, reason: "invalid_slug", got: opts.slug ?? null });
    process.exit(2);
  }
  if (cmd === "ensure") {
    ensureCmd(slug);
  } else if (cmd === "cleanup") {
    cleanupCmd(slug);
  } else {
    process.stderr.write("Usage: workspace.mjs <ensure|cleanup> --slug <slug>\n");
    process.exit(2);
  }
}

main();
