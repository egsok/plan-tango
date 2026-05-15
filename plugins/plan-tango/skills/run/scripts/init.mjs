#!/usr/bin/env node
// v0.2 commit 8 — single helper that orchestrates Phase A+B init.
// Composes existing helpers (plan-paths, load-config, lock, workspace) into
// one Bash call. Replaces ~40 lines of stepped orchestration in SKILL.md.
//
// Behavior is identical to the stepped path the orchestrator used to perform
// inline. No new logic — just chaining + structured return + internal cleanup
// when failure occurs after lock acquisition.
//
// CLI:
//   node init.mjs --cli '<json>' \
//     [--plan-arg <slug-or-path>] \
//     [--active-plan <abs-path>] \
//     [--resume] [--takeover]
//
// --cli '<json>'    Parsed CLI args object (passes through to load-config.mjs).
// --plan-arg        Positional plan-path-or-slug from $ARGUMENTS, or omit.
// --active-plan     Active plan from system prompt's "Plan File Info", or omit.
// --resume          Disable --newest fallback; require state.json + hash match.
// --takeover        Pass --takeover to lock.mjs acquire.
//
// Output (stdout, success):
//   {
//     "ok": true,
//     "slug": "...",
//     "plan_path": "<abs>",
//     "repo_root": "<abs>",
//     "repo_evidence_available": true,
//     "codex_version": "codex-cli 0.125.0",
//     "settings": {...},
//     "settings_sources": {...},
//     "warnings": [...],
//     "lock_acquired": true,
//     "lock_session_id": "<uuid>",
//     "lock_took_over_stale": false,
//     "state_path": "<abs>",
//     "state": {...},
//     "is_resume": false,
//     "workspace_path": "<abs>"
//   }
//
// Output (stdout, failure):
//   {
//     "ok": false,
//     "abort_reason": "<code>",
//     "error": "<human-readable>",
//     "lock_acquired": <bool>,    // if true: orchestrator MUST release
//     "lock_session_id"?: "...",  // present when lock_acquired:true
//     "slug"?: "..."              // present when lock_acquired:true
//   }
//
// Exit code: always 0 (caller checks `ok`). This avoids two failure channels.
//
// Lock cleanup: if a step AFTER step 6 (lock acquire) fails, init releases
// the lock internally and reports lock_acquired:false. If the release itself
// fails, init reports lock_acquired:true + lock_session_id so the
// orchestrator can attempt cleanup in Phase E.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLANS_ROOT = path.join(homedir(), ".claude", "plans");
const HARD_CAP_MAX_ITER = 12;

// === Output helpers ===

function emitObj(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function failNoLock(abortReason, error) {
  emitObj({ ok: false, abort_reason: abortReason, error, lock_acquired: false });
  process.exit(0);
}

function failAfterLock(abortReason, error, lockState) {
  emitObj({
    ok: false,
    abort_reason: abortReason,
    error,
    lock_acquired: lockState.acquired,
    lock_session_id: lockState.acquired ? lockState.sessionId : undefined,
    slug: lockState.acquired ? lockState.slug : undefined,
  });
  process.exit(0);
}

// === CLI parsing ===

function parseArgs(argv) {
  const out = { resume: false, takeover: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--cli": out.cli = argv[++i]; break;
      case "--plan-arg": out.planArg = argv[++i]; break;
      case "--active-plan": out.activePlan = argv[++i]; break;
      case "--resume": out.resume = true; break;
      case "--takeover": out.takeover = true; break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          failNoLock("unknown_flag", `unknown flag: ${a}`);
        }
    }
  }
  return out;
}

// === Helper invocation ===

function runHelper(scriptName, args) {
  const scriptPath = path.join(SCRIPT_DIR, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    spawnError: result.error,
  };
}

function parseHelperJson(scriptName, result) {
  if (result.spawnError) {
    return { ok: false, _error: `spawn failed for ${scriptName}: ${result.spawnError}` };
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : "{}";
  try {
    return JSON.parse(lastLine);
  } catch (err) {
    return {
      ok: false,
      _error: `${scriptName}: invalid JSON output: ${err.message}`,
      raw_stdout: result.stdout.slice(0, 1024),
    };
  }
}

function shaFile(p) {
  const buf = readFileSync(p);
  return createHash("sha256").update(buf).digest("hex");
}

// === Plan-path resolution ===

function resolvePlanPath({ planArg, activePlan, isResume }) {
  if (planArg) {
    if (path.isAbsolute(planArg)) return planArg;
    if (existsSync(planArg)) return path.resolve(planArg);
    const slugCandidate = path.join(PLANS_ROOT, `${planArg}.md`);
    if (existsSync(slugCandidate)) return slugCandidate;
    // Let downstream --validate produce a clean error message.
    return path.resolve(planArg);
  }
  if (activePlan) return activePlan;
  if (isResume) {
    // Resume-safety invariant: no --newest fallback.
    return null;
  }
  // Try newest as last resort. plan-paths.mjs --newest returns
  // {ok:true, found:true|false, plan_path?, slug?, plan_size_bytes?, mtime_iso?}.
  const newestRes = runHelper("plan-paths.mjs", ["--newest"]);
  const parsed = parseHelperJson("plan-paths.mjs --newest", newestRes);
  if (parsed && parsed.ok && parsed.found && parsed.plan_path) {
    return parsed.plan_path;
  }
  return null;
}

// === Main ===

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(
      "Usage: init.mjs --cli '<json>' [--plan-arg <s>] [--active-plan <path>] [--resume] [--takeover]\n"
    );
    process.exit(0);
  }

  if (typeof args.cli !== "string") {
    failNoLock("missing_cli", "--cli '<json>' is required");
  }

  // Treat the literal string "null" or empty as absent (orchestrator may
  // pass these defensively from $ARGUMENTS).
  const normalize = (v) =>
    v === undefined || v === null || v === "" || v === "null" ? null : v;

  // 1. Resolve plan-path
  const planPath = resolvePlanPath({
    planArg: normalize(args.planArg),
    activePlan: normalize(args.activePlan),
    isResume: args.resume,
  });
  if (!planPath) {
    if (args.resume) {
      failNoLock(
        "resume_no_plan",
        "Cannot --resume without an explicit plan path/slug or active plan. Re-run /plan-tango:run <slug-or-path> --resume to be unambiguous."
      );
    }
    failNoLock(
      "no_plan_resolved",
      "Could not resolve plan-path: no positional arg, no active plan from system prompt, no recent plans found in ~/.claude/plans/."
    );
  }

  // 2. Validate plan
  const valRes = runHelper("plan-paths.mjs", ["--validate", planPath]);
  const validation = parseHelperJson("plan-paths.mjs --validate", valRes);
  if (!validation.ok) {
    failNoLock(
      "plan_invalid",
      `Plan validation failed: ${validation.reason || validation._error || "unknown"}`
    );
  }
  const canonicalPlanPath = validation.plan_path || planPath;
  const slug = validation.slug;
  if (!slug) {
    failNoLock("plan_invalid", "validator did not return a slug");
  }

  // 3. Verify codex CLI
  // Use shell:true on Windows to handle .cmd shim; spawnSync without shell
  // would fail to dispatch codex.cmd directly.
  const codexRes = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  if (codexRes.status !== 0) {
    failNoLock(
      "codex_cli_missing",
      "Codex CLI not found on PATH. Install with `npm install -g @openai/codex`, then run `codex login` (or `/codex:setup`). Re-run /plan-tango:run once codex --version succeeds."
    );
  }
  const codexVersion = (codexRes.stdout || "").trim() || "unknown";

  // 4. Resolve repo-root
  const repoRes = runHelper("plan-paths.mjs", [
    "--resolve-repo",
    "--cwd", process.cwd(),
    "--plan", canonicalPlanPath,
  ]);
  const repoInfo = parseHelperJson("plan-paths.mjs --resolve-repo", repoRes);
  if (!repoInfo.ok) {
    failNoLock(
      "repo_resolve_failed",
      `Cannot resolve repo-root: ${repoInfo._error || JSON.stringify(repoInfo)}`
    );
  }
  const repoRoot = repoInfo.repo_root;
  const repoEvidenceAvailable = repoInfo.repo_evidence_available !== false;

  // 5. Load merged settings
  const cfgRes = runHelper("load-config.mjs", ["--merge", "--cli", args.cli]);
  const cfg = parseHelperJson("load-config.mjs", cfgRes);
  if (cfgRes.exitCode !== 0 || cfg.error) {
    failNoLock(
      "config_invalid",
      cfg.detail || cfg.error || cfg._error || "load-config failed"
    );
  }
  if (!cfg.merged) {
    failNoLock("config_invalid", "load-config returned no merged settings");
  }
  if (cfg.merged.max_iter > HARD_CAP_MAX_ITER) {
    failNoLock(
      "max_iter_cap",
      `max_iter must be <= ${HARD_CAP_MAX_ITER}, got ${cfg.merged.max_iter}`
    );
  }

  // 6. Acquire lock — FIRST among on-disk side effects
  const lockArgs = ["acquire", "--slug", slug, "--plan", canonicalPlanPath];
  if (args.takeover) lockArgs.push("--takeover");
  const lockRes = runHelper("lock.mjs", lockArgs);
  const lock = parseHelperJson("lock.mjs acquire", lockRes);
  if (lockRes.exitCode !== 0 || !lock.ok) {
    failNoLock(
      lock.reason || "lock_failed",
      lock.detail ||
        lock._error ||
        `lock acquire failed (reason: ${lock.reason || "unknown"})`
    );
  }
  const lockSessionId = lock.session_id;
  const tookOverStale = lock.took_over_stale === true;
  const lockState = { acquired: true, sessionId: lockSessionId, slug };

  // From here on: failure must release the lock.
  function releaseLock() {
    const rel = runHelper("lock.mjs", [
      "release",
      "--slug", slug,
      "--session", lockSessionId,
    ]);
    const relInfo = parseHelperJson("lock.mjs release", rel);
    if (rel.exitCode === 0 && relInfo.ok) {
      lockState.acquired = false;
      return true;
    }
    // Cleanup failed — leave lockState.acquired=true so orchestrator retries
    // release in Phase E. This is the "race fallback" path documented in
    // the plan.
    return false;
  }

  // 7. State init or resume
  const statePath = path.join(PLANS_ROOT, `${slug}-tango.state.json`);
  const planHash = shaFile(canonicalPlanPath);
  let state = null;
  let isResume = false;

  if (args.resume) {
    if (!existsSync(statePath)) {
      releaseLock();
      failAfterLock(
        "resume_no_state",
        `--resume requested but no state file at ${statePath}. Run without --resume to start fresh.`,
        lockState
      );
    }
    let raw;
    try {
      raw = readFileSync(statePath, "utf8");
    } catch (err) {
      releaseLock();
      failAfterLock(
        "state_unreadable",
        `Cannot read state at ${statePath}: ${err.message || err}`,
        lockState
      );
    }
    try {
      state = JSON.parse(raw);
    } catch (err) {
      releaseLock();
      failAfterLock(
        "state_invalid_json",
        `Cannot parse state at ${statePath}: ${err.message || err}`,
        lockState
      );
    }
    if (state.last_known_plan_hash !== planHash) {
      releaseLock();
      const expected = state.last_known_plan_hash
        ? state.last_known_plan_hash.slice(0, 8)
        : "unknown";
      const got = planHash.slice(0, 8);
      failAfterLock(
        "resume_hash_mismatch",
        `Plan modified outside skill since last completed iteration (expected ${expected}, got ${got}). Re-run without --resume to start fresh.`,
        lockState
      );
    }
    isResume = true;
  } else {
    // Fresh state — see references/schemas.md for the canonical shape.
    state = {
      iter: 0,
      original_plan_hash: planHash,
      last_known_plan_hash: planHash,
      last_verdict: null,
      findings_history: [],
      settings: cfg.merged,
      settings_sources: cfg.sources || {},
      repo_root: repoRoot,
      repo_evidence_available: repoEvidenceAvailable,
      codex_thread_id: null,
      codex_version: codexVersion,
      polish_only_terminal: false,
      polish_advisory: [],
    };
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch (err) {
      releaseLock();
      failAfterLock(
        "state_write_failed",
        `Cannot write state to ${statePath}: ${err.message || err}`,
        lockState
      );
    }
  }

  // 8. Ensure workspace
  const wsRes = runHelper("workspace.mjs", ["ensure", "--slug", slug]);
  const ws = parseHelperJson("workspace.mjs ensure", wsRes);
  if (wsRes.exitCode !== 0 || !ws.ok) {
    releaseLock();
    failAfterLock(
      "workspace_failed",
      ws.reason || ws._error || "workspace.mjs ensure failed",
      lockState
    );
  }

  // === Success ===
  emitObj({
    ok: true,
    slug,
    plan_path: canonicalPlanPath,
    repo_root: repoRoot,
    repo_evidence_available: repoEvidenceAvailable,
    codex_version: codexVersion,
    settings: cfg.merged,
    settings_sources: cfg.sources || {},
    warnings: cfg.warnings || [],
    lock_acquired: true,
    lock_session_id: lockSessionId,
    lock_took_over_stale: tookOverStale,
    state_path: statePath,
    state,
    is_resume: isResume,
    workspace_path: ws.path || path.join(PLANS_ROOT, `${slug}-tango.workspace`),
  });
}

main();
