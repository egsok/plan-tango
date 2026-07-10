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

// Synchronous sleep (zero-dependency) — used only for a single short retry
// backoff. Atomics.wait on a throwaway buffer blocks the current thread.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Remove `target` recursively, retrying once after a short delay on EBUSY.
// EBUSY commonly occurs on Windows when the directory (or a descendant) is
// briefly held — e.g. the process cwd was just moved out, or an editor/AV
// still has a handle. Returns {ok:true, note?} or {ok:false, error}.
function rmDirWithRetry(target) {
  try {
    rmSync(target, { recursive: true, force: false });
    return { ok: true };
  } catch (err) {
    if (err && err.code === "EBUSY") {
      sleepSync(150);
      try {
        rmSync(target, { recursive: true, force: false });
        return { ok: true, note: "retried_after_ebusy" };
      } catch (err2) {
        return { ok: false, error: err2 };
      }
    }
    return { ok: false, error: err };
  }
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
  // If the process cwd is inside the workspace we're about to remove, the
  // rmSync will fail with EBUSY (the dir is in use as the cwd). Move out to
  // the plans root (the workspace's parent) first. Best-effort — the EBUSY
  // retry below still guards other transient holders.
  try {
    const realCwd = realpathSync.native(process.cwd());
    const relCwd = path.relative(realTarget, realCwd);
    const cwdInside =
      realCwd === realTarget || (!relCwd.startsWith("..") && !path.isAbsolute(relCwd));
    if (cwdInside) {
      process.chdir(realExpected); // plans root — parent of the workspace
    }
  } catch {
    // ignore — retry-on-EBUSY still applies
  }
  const rmRes = rmDirWithRetry(expected);
  if (rmRes.ok) {
    emit(rmRes.note ? { ok: true, path: expected, note: rmRes.note } : { ok: true, path: expected });
  } else {
    emit({ ok: false, reason: "rm_failed", path: expected, error: String(rmRes.error) });
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
