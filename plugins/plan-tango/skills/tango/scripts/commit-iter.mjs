#!/usr/bin/env node
// Deterministic post-iteration bookkeeping for a plan-tango run.
//
// After the orchestrator applies fixes for an iteration it must update several
// pieces of state in lockstep: bump the iteration counter, push the finding-
// hash set into the rolling findings_history window, recompute
// last_known_plan_hash from the (now-edited) plan file, persist the Codex
// thread id, stamp updated_at, and refresh the lock lease. Historically the
// orchestrator improvised this — in one real session it double-pushed
// findings_history and needed manual state repair. This script does it once,
// atomically (tmp+rename), with an idempotency guard so a re-run cannot
// double-commit the same iteration.
//
// Reads JSON from stdin, writes JSON to stdout.
//
// Input (stdin JSON):
//   {
//     "state_path":       "<abs path to {slug}-tango.state.json>",  // REQUIRED
//     "iter":             <N>,        // REQUIRED, 1-based iteration being committed
//     "plan_path":        "<abs>",    // REQUIRED, recompute last_known_plan_hash from this
//     "finding_hashes":   ["h1","h2"],// finding-hash set for this iter (default [])
//                                     //   alt: "findings":[{"hash":"h"}|"h", ...]
//     "verdict":          "BLOCK",    // optional -> state.last_verdict
//     "codex_thread_id":  "<uuid>",   // optional, persisted per the step-16.5 rule below
//     "fallback_to_fresh":false,      // optional, forces thread-id overwrite
//     "lock":             { "slug":"...", "session_id":"..." },  // optional -> refresh lease
//     "history_window":   3           // optional, default 3
//   }
//
// codex_thread_id persistence rule (SKILL.md step 16.5):
//   - fallback_to_fresh === true AND a non-empty codex_thread_id → overwrite.
//   - else if state.codex_thread_id is null AND codex_thread_id non-empty → set
//     (first thread opened in continue mode).
//   - else → leave state.codex_thread_id unchanged (never clobber a live thread).
//
// Idempotency: requires state.iter === iter - 1. A second call with the same
// iter (state.iter === iter) is refused with reason "iter_already_committed";
// a stale/ahead iter is refused with "iter_out_of_sequence". This is what
// prevents the double-push of findings_history.
//
// Output (stdout, success): {ok:true, ...summary}
//   { "ok": true, "iter": N, "last_known_plan_hash": "<sha256>",
//     "findings_history_len": <len>, "codex_thread_id": "<uuid|null>",
//     "codex_thread_id_changed": <bool>, "lock_refreshed": <bool|null>,
//     "updated_at": "<iso>" }
//
// Output (stdout, semantic refusal): {ok:false, reason} with EXIT 0
//   reasons: "iter_already_committed", "iter_out_of_sequence",
//            "lock_refresh_failed", "state_write_failed"
//
// Output (stdout, bad input): {ok:false, reason} with EXIT 2
//   reasons: "stdin_empty", "stdin_not_json", "missing_state_path",
//            "missing_iter", "missing_plan_path", "state_unreadable",
//            "state_invalid_json", "plan_unreadable"

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function badInput(reason, extra = {}) {
  emit({ ok: false, reason, ...extra });
  process.exit(2);
}

function refuse(reason, extra = {}) {
  // Semantic refusal — a normal handled outcome the orchestrator branches on.
  emit({ ok: false, reason, ...extra });
  process.exit(0);
}

function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// Normalize finding-hash input: accept ["h", ...] or [{hash:"h"}, ...].
function normalizeHashes(input) {
  let list = [];
  if (Array.isArray(input.finding_hashes)) list = input.finding_hashes;
  else if (Array.isArray(input.findings)) list = input.findings;
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const h = typeof item === "string" ? item : item && typeof item.hash === "string" ? item.hash : null;
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

function refreshLock(lock, planHash) {
  // Returns {ok:true} | {ok:false, reason, detail}.
  if (!lock || typeof lock !== "object") return { ok: true, skipped: true };
  const slug = lock.slug;
  const session = lock.session_id;
  if (!slug || !session) {
    return { ok: false, reason: "lock_missing_slug_or_session" };
  }
  const lockScript = path.join(SCRIPT_DIR, "lock.mjs");
  const args = ["refresh", "--slug", slug, "--session", session];
  if (planHash) args.push("--plan-hash", planHash);
  const res = spawnSync(process.execPath, [lockScript, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  let parsed = null;
  try {
    const lines = (res.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    parsed = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch {
    parsed = null;
  }
  if (res.status === 0 && parsed && parsed.ok) return { ok: true };
  return {
    ok: false,
    reason: (parsed && parsed.reason) || "lock_refresh_error",
    detail: parsed || (res.stderr || "").slice(0, 512),
  };
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) badInput("stdin_empty", { note: "expected JSON {state_path, iter, plan_path, ...}" });

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    badInput("stdin_not_json", { error: String(err) });
  }

  if (!input.state_path || typeof input.state_path !== "string") badInput("missing_state_path");
  const iter = Number(input.iter);
  if (!Number.isInteger(iter) || iter < 1) badInput("missing_iter", { got: input.iter });
  if (!input.plan_path || typeof input.plan_path !== "string") badInput("missing_plan_path");

  const statePath = input.state_path;
  if (!existsSync(statePath)) badInput("state_unreadable", { path: statePath });
  let stateRaw;
  try {
    stateRaw = readFileSync(statePath, "utf8");
  } catch (err) {
    badInput("state_unreadable", { path: statePath, error: String(err) });
  }
  let state;
  try {
    state = JSON.parse(stateRaw);
  } catch (err) {
    badInput("state_invalid_json", { path: statePath, error: String(err) });
  }

  // Idempotency guard — this iter must be exactly the next uncommitted one.
  const completed = Number.isInteger(state.iter) ? state.iter : 0;
  if (iter === completed) {
    refuse("iter_already_committed", { state_iter: completed, requested_iter: iter });
  }
  if (iter !== completed + 1) {
    refuse("iter_out_of_sequence", {
      state_iter: completed,
      requested_iter: iter,
      expected_iter: completed + 1,
    });
  }

  // Recompute plan hash from the (edited) plan file.
  if (!existsSync(input.plan_path)) badInput("plan_unreadable", { path: input.plan_path });
  let planHash;
  try {
    planHash = sha256OfFile(input.plan_path);
  } catch (err) {
    badInput("plan_unreadable", { path: input.plan_path, error: String(err) });
  }

  // Refresh lock FIRST — if a competing session took over we must not commit.
  const lockResult = refreshLock(input.lock, planHash);
  if (!lockResult.ok) {
    refuse("lock_refresh_failed", { detail: lockResult.reason, extra: lockResult.detail });
  }
  const lockRefreshed = lockResult.skipped ? null : true;

  // findings_history push (idempotency guard above guarantees single push).
  const window = Number.isInteger(input.history_window) && input.history_window > 0 ? input.history_window : 3;
  const hashes = normalizeHashes(input);
  if (!Array.isArray(state.findings_history)) state.findings_history = [];
  state.findings_history.push(hashes);
  while (state.findings_history.length > window) state.findings_history.shift();

  // codex_thread_id persistence (SKILL.md step 16.5).
  const prevThread = state.codex_thread_id ?? null;
  const incomingThread =
    typeof input.codex_thread_id === "string" && input.codex_thread_id ? input.codex_thread_id : null;
  if (incomingThread) {
    if (input.fallback_to_fresh === true) {
      state.codex_thread_id = incomingThread; // overwrite on lost-session fallback
    } else if (prevThread === null) {
      state.codex_thread_id = incomingThread; // first thread opened
    }
    // else leave unchanged — never clobber a live thread
  }
  const threadChanged = (state.codex_thread_id ?? null) !== prevThread;

  // Scalar bookkeeping.
  if (typeof input.verdict === "string") state.last_verdict = input.verdict;
  state.last_known_plan_hash = planHash;
  state.iter = iter;
  const updatedAt = new Date().toISOString();
  state.updated_at = updatedAt;

  try {
    writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    refuse("state_write_failed", { path: statePath, error: String(err) });
  }

  emit({
    ok: true,
    iter,
    last_known_plan_hash: planHash,
    findings_history_len: state.findings_history.length,
    codex_thread_id: state.codex_thread_id ?? null,
    codex_thread_id_changed: threadChanged,
    lock_refreshed: lockRefreshed,
    updated_at: updatedAt,
  });
}

main();
