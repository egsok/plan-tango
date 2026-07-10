#!/usr/bin/env node
// Plan path resolution / validation / repo-root detection.
// Modes:
//   --validate <path>             Verify plan exists, size>=200, lives under ~/.claude/plans/.
//                                 Returns canonical plan_path + slug + plan_size_bytes.
//   --newest                      Return newest .md in ~/.claude/plans/ by mtime.
//   --list-recent [N]             Return N (default 5) recent plan files.
//   --resolve-repo [--cwd <dir>] [--plan <path>]
//                                 Detect repo-root via `git rev-parse --show-toplevel`.
//                                 Returns {repo_root}.
//   --hash <path>                 Compute sha256 of file content; returns {ok, hash, short}.
// Outputs JSON to stdout. Always exits 0 on successful detection (even when result
// is "not found"); exits 1 on validation failure with structured error.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MIN_PLAN_BYTES = 200;

function plansRoot() {
  return path.join(homedir(), ".claude", "plans");
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
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

function validateCmd(rawPath) {
  if (!rawPath || typeof rawPath !== "string") {
    emit({ ok: false, reason: "no_path_provided" });
    process.exit(1);
  }
  let resolvedPath;
  try {
    resolvedPath = path.resolve(rawPath);
  } catch (err) {
    emit({ ok: false, reason: "path_resolve_failed", error: String(err) });
    process.exit(1);
  }
  if (!existsSync(resolvedPath)) {
    emit({ ok: false, reason: "file_missing", path: resolvedPath });
    process.exit(1);
  }
  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch (err) {
    emit({ ok: false, reason: "stat_failed", path: resolvedPath, error: String(err) });
    process.exit(1);
  }
  if (!stat.isFile()) {
    emit({ ok: false, reason: "not_file", path: resolvedPath });
    process.exit(1);
  }
  if (stat.size < MIN_PLAN_BYTES) {
    emit({
      ok: false,
      reason: "plan_too_small",
      path: resolvedPath,
      size: stat.size,
      min: MIN_PLAN_BYTES,
    });
    process.exit(1);
  }
  let realPlan;
  let realRoot;
  try {
    realPlan = realpathSync(resolvedPath);
    realRoot = realpathSync(plansRoot());
  } catch (err) {
    emit({ ok: false, reason: "realpath_failed", error: String(err), path: resolvedPath });
    process.exit(1);
  }
  const rel = path.relative(realRoot, realPlan);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    emit({
      ok: false,
      reason: "outside_plans_root",
      path: realPlan,
      plans_root: realRoot,
    });
    process.exit(1);
  }
  const slug = path.basename(realPlan, ".md");
  emit({
    ok: true,
    plan_path: realPlan,
    slug,
    plan_size_bytes: stat.size,
    mtime_iso: new Date(stat.mtimeMs).toISOString(),
  });
}

function listMdFiles(limit = null) {
  const root = plansRoot();
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => {
      const full = path.join(root, e.name);
      try {
        const st = statSync(full);
        return { path: full, name: e.name, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return limit ? entries.slice(0, limit) : entries;
}

function newestCmd() {
  const list = listMdFiles(1);
  if (list.length === 0) {
    emit({ ok: true, found: false });
    return;
  }
  const top = list[0];
  emit({
    ok: true,
    found: true,
    plan_path: top.path,
    slug: path.basename(top.path, ".md"),
    plan_size_bytes: top.size,
    mtime_iso: new Date(top.mtimeMs).toISOString(),
  });
}

function listRecentCmd(n) {
  const limit = Number(n) > 0 ? Number(n) : 5;
  const list = listMdFiles(limit).map((e) => ({
    plan_path: e.path,
    slug: path.basename(e.path, ".md"),
    size: e.size,
    mtime_iso: new Date(e.mtimeMs).toISOString(),
  }));
  emit({ ok: true, recent: list });
}

function detectRepoFromPlanText(planPath) {
  // Read first 4KB and look for cwd:/repo: hints or D:\dev paths.
  try {
    const head = readFileSync(planPath, "utf8").slice(0, 4096);
    const cwdLine = head.match(/^\s*(?:cwd|repo|repo[_-]root)\s*[:=]\s*["']?([^"'\n]+)/im);
    if (cwdLine) return cwdLine[1].trim();
    // Match Windows paths starting with X:\(dev|repo|projects)\... — single-segment OR nested.
    // Old regex required nested dev/repo/projects which broke common D:\dev\project layout.
    const winPath = head.match(/\b[A-Za-z]:\\(?:dev|repo|projects)\\[A-Za-z0-9 _\\-]+/);
    if (winPath) return winPath[0].trim();
    const posixPath = head.match(/\/(?:[a-z]|home\/[^/]+)\/(?:dev|repo|projects)\/[A-Za-z0-9 _-]+/);
    if (posixPath) return posixPath[0].trim();
  } catch {
    // ignore
  }
  return null;
}

function gitTopLevel(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status === 0) return r.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

function resolveRepoCmd(opts) {
  // Repo evidence is ALWAYS available — Codex runs sandbox=read-only with cwd
  // access and can investigate any cwd, git or not. The old git-gated
  // `repo_evidence_available` flag was collapsed out: it forced text-only
  // review on legitimate cases (new project before `git init`, non-git
  // monorepos) and is redundant with run-codex-review.mjs always passing
  // --skip-git-repo-check. This command now returns only `repo_root`.
  //
  // We still prefer a "real" repo_root when one is detectable: plan-text
  // explicit path > git toplevel > cwd. This affects the cwd Codex spawns in.
  const cwd = opts.cwd && typeof opts.cwd === "string" ? path.resolve(opts.cwd) : process.cwd();
  const planPath = opts.plan && typeof opts.plan === "string" ? opts.plan : null;
  const candidates = [];
  if (planPath && existsSync(planPath)) {
    const fromPlan = detectRepoFromPlanText(planPath);
    if (fromPlan) candidates.push({ source: "plan_text", path: fromPlan });
  }
  candidates.push({ source: "cwd", path: cwd });
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    const top = gitTopLevel(c.path);
    if (top) {
      emit({
        ok: true,
        repo_root: top,
        source: `${c.source}+git`,
        candidate: c.path,
      });
      return;
    }
  }
  // No git found in any candidate — Codex investigates whatever's at repo_root.
  emit({
    ok: true,
    repo_root: cwd,
    source: "cwd_no_git",
    note: "no git repo detected; reviewer will investigate cwd as-is. Codex grounding rules still apply.",
  });
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.validate) {
    validateCmd(typeof args.validate === "string" ? args.validate : argv[1]);
  } else if (args.newest) {
    newestCmd();
  } else if (args["list-recent"]) {
    const n = typeof args["list-recent"] === "string" ? args["list-recent"] : 5;
    listRecentCmd(n);
  } else if (args["resolve-repo"]) {
    resolveRepoCmd(args);
  } else if (args.hash) {
    hashCmd(typeof args.hash === "string" ? args.hash : argv[1]);
  } else {
    process.stderr.write(
      "Usage: plan-paths.mjs --validate <path> | --newest | --list-recent [N] | --resolve-repo [--cwd <dir>] [--plan <path>] | --hash <path>\n",
    );
    process.exit(2);
  }
}

function hashCmd(target) {
  if (!target || typeof target !== "string") {
    emit({ ok: false, reason: "no_path_provided" });
    process.exit(1);
  }
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    emit({ ok: false, reason: "file_missing", path: resolved });
    process.exit(1);
  }
  let buf;
  try {
    buf = readFileSync(resolved);
  } catch (err) {
    emit({ ok: false, reason: "read_failed", path: resolved, error: String(err) });
    process.exit(1);
  }
  const hash = createHash("sha256").update(buf).digest("hex");
  emit({
    ok: true,
    path: resolved,
    hash,
    short: hash.slice(0, 12),
    bytes: buf.length,
  });
}

main();
