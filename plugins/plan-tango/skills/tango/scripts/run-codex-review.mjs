#!/usr/bin/env node
// Wrapper that spawns `codex exec --json --sandbox read-only -o <file>` directly,
// pipes the prompt via stdin, parses the JSONL stream + last-message file, and
// returns one structured JSON object on stdout. Wrapper exits 0 in all paths
// except argv parsing failure; Codex/parser failures are encoded in the JSON.
//
// Usage:
//   node run-codex-review.mjs <abs-path-to-params.json>
//
// params.json schema (extended; see plan-tango plan Phase 2 contract):
//   {
//     "prompt_file":              "<abs path>",
//     "repo_root":                "<abs path>",
//     "repo_evidence_available":  true | false,
//     "iter":                     <number>,
//     "slug":                     "<string>",
//     "output_last_message_file": "<abs path>",
//     "settings": {
//       "effort":             "<effort>",
//       "model":              "<model>"     | optional / null,
//       "service_tier":       "<fast|flex>" | optional / null,
//       "codex_profile":      "<name>"      | optional / null,
//       "extra_codex_config": ["key=val", ...]
//     },
//     "thread_mode":      "fresh" | "continue",
//     "resume_thread_id": "<uuid>" | null
//   }
//
// Return shape (stdout, success or expected failure):
//   {
//     "verdict":            "ALLOW"|"BLOCK"|"ERROR"|"MALFORMED",
//     "summary":            "...",
//     "findings":           [...],
//     "session_id":         "<uuid>" | null,
//     "fallback_to_fresh":  false | true,
//     "last_message_path":  "<abs path>",
//     "warnings":           [...],
//     "stderr_tail":        "...",
//     "exit_code":          0,
//     "raw_output_excerpt": "...",
//     "codex_seconds":      <float>
//   }

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERDICT_PARSER = path.join(SCRIPT_DIR, "parse-codex-verdict.mjs");
const JSONL_PARSER = path.join(SCRIPT_DIR, "parse-codex-jsonl.mjs");

const DEBUG_ENV = "PLAN_TANGO_DEBUG_CODEX_ARGS";
// v0.2: lean output by default. For ALLOW/BLOCK clean verdicts the wrapper
// omits `raw_final_message` (full Codex text — already on disk at
// last_message_path) and `raw_output_excerpt` (head of JSONL stdout). Both
// are still included for MALFORMED/ERROR (debug-critical) and when verbose
// mode is requested via --verbose-output flag or PLAN_TANGO_WRAPPER_VERBOSE=1
// env (used by Phase E §3/§5 verbose-report path).
const VERBOSE_OUTPUT =
  process.env.PLAN_TANGO_WRAPPER_VERBOSE === "1" ||
  process.argv.includes("--verbose-output");

// Resolve the actual codex CLI entry point. On Windows the npm shim is `codex.cmd`,
// which Node's spawn cannot dispatch without `shell: true`. We bypass the shim entirely
// by locating `<npm-prefix>/node_modules/@openai/codex/bin/codex.js` and spawning
// `node <codex.js>` directly. Cross-platform, no shell escaping pitfalls.
//
// Returns { command: <executable>, prefixArgs: <array> } where final spawn is:
//   spawn(command, [...prefixArgs, ...userArgs], opts)
// On POSIX with codex on PATH and no .ps1/.cmd shim layer, we just use codex directly.
function resolveCodexEntry() {
  const isWin = process.platform === "win32";

  // Try `where`/`which` to locate any codex* on PATH
  const probe = isWin ? "where" : "which";
  const probeName = isWin ? "codex" : "codex";
  let foundPaths = [];
  try {
    const result = spawnSync(probe, [probeName], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) {
      foundPaths = result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    // ignore
  }

  // On Windows, prefer locating the JS entry next to a .cmd or .ps1 shim
  for (const p of foundPaths) {
    if (isWin && (p.toLowerCase().endsWith(".cmd") || p.toLowerCase().endsWith(".ps1") || /\\codex$/i.test(p))) {
      const shimDir = path.dirname(p);
      const candidate = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
      try {
        if (statSync(candidate).isFile()) {
          return { command: process.execPath, prefixArgs: [candidate], source: "node_via_shim_dir" };
        }
      } catch {
        // continue to next candidate
      }
    } else if (!isWin) {
      // POSIX: codex on PATH is usually directly executable
      return { command: p, prefixArgs: [], source: "direct_posix" };
    }
  }

  // Heuristic for Windows: %APPDATA%/npm
  if (isWin) {
    const appdata = process.env.APPDATA;
    if (appdata) {
      const candidate = path.join(appdata, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      try {
        if (statSync(candidate).isFile()) {
          return { command: process.execPath, prefixArgs: [candidate], source: "node_via_appdata" };
        }
      } catch {
        // continue
      }
    }
  }

  // Last-resort fallback: hope `codex` works as-is (POSIX systems where which failed but it works anyway)
  return { command: "codex", prefixArgs: [], source: "fallback_codex_on_path" };
}

const CODEX_ENTRY = resolveCodexEntry();

function tail(buf, max) {
  if (!buf) return "";
  if (buf.length <= max) return buf;
  return buf.slice(buf.length - max);
}

function head(buf, max) {
  if (!buf) return "";
  if (buf.length <= max) return buf;
  return buf.slice(0, max);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitError(reason, extra = {}) {
  emit({
    verdict: "ERROR",
    reason,
    ...extra,
    parsed_at: new Date().toISOString(),
  });
}

function buildCodexArgs(params, { resumeThreadId }) {
  const s = params.settings || {};
  const effort = s.effort;
  const model = s.model || null;
  const serviceTier = s.service_tier || null;
  const codexProfile = s.codex_profile || null;
  const extraCodexConfig = Array.isArray(s.extra_codex_config) ? s.extra_codex_config : [];

  const args = [
    "exec",
    "-C", params.repo_root,
    "--json",
    "--sandbox", "read-only",
    // v0.2 contract: repo_evidence_available is always true (see
    // plan-paths.mjs --resolve-repo). Codex's git-repo trust check is
    // redundant with sandbox=read-only + prompt grounding rules and
    // refuses non-git cwds with a confusing error. Pass unconditionally.
    "--skip-git-repo-check",
  ];
  args.push("-o", params.output_last_message_file);

  // 1. profile FIRST (base layer)
  if (codexProfile) {
    args.push("-p", codexProfile);
  }

  // 2. extra user -c overrides (overlay on profile, but canonical wins)
  for (const kv of extraCodexConfig) {
    args.push("-c", kv);
  }

  // 3. canonical fields LAST (always win on conflict)
  args.push("-c", `model_reasoning_effort="${effort}"`);
  if (serviceTier) {
    args.push("-c", `service_tier="${serviceTier}"`);
  }
  if (model) {
    args.push("-m", model);
  }

  // resume subcommand (must come AFTER exec-level options, BEFORE prompt positional)
  if (resumeThreadId) {
    args.push("resume", resumeThreadId);
  }

  // prompt via stdin
  args.push("-");

  return args;
}

function runCodex(args, promptText, repoRoot) {
  return new Promise((resolve) => {
    const finalArgs = [...CODEX_ENTRY.prefixArgs, ...args];
    if (process.env[DEBUG_ENV] === "1") {
      process.stderr.write(`[plan-tango/run-codex-review] codex_entry: ${CODEX_ENTRY.source}\n`);
      process.stderr.write(`[plan-tango/run-codex-review] argv: ${JSON.stringify([CODEX_ENTRY.command, ...finalArgs])}\n`);
    }
    let stdoutBuf = "";
    let stderrBuf = "";
    const started = Date.now();
    let child;
    try {
      child = spawn(CODEX_ENTRY.command, finalArgs, {
        cwd: repoRoot,
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ kind: "spawn_failed", error: String(err) });
      return;
    }
    child.stdout.on("data", (d) => { stdoutBuf += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderrBuf += d.toString("utf8"); });
    child.on("error", (err) => {
      resolve({ kind: "spawn_failed", error: String(err), stderrBuf });
    });
    child.on("close", (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(2);
      resolve({
        kind: "exited",
        exit_code: code,
        stdoutBuf,
        stderrBuf,
        seconds: Number(seconds),
      });
    });
    try {
      child.stdin.end(promptText, "utf8");
    } catch (err) {
      resolve({ kind: "spawn_failed", error: `stdin write failed: ${err}`, stderrBuf });
    }
  });
}

function runChildJson(scriptPath, scriptArgs, stdinPayload) {
  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
      return;
    }
    child.stdout.on("data", (d) => { stdoutBuf += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderrBuf += d.toString("utf8"); });
    child.on("error", (err) => { resolve({ ok: false, error: String(err), stderrBuf }); });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout: stdoutBuf, stderr: stderrBuf, exit_code: code });
    });
    if (typeof stdinPayload === "string") {
      try {
        child.stdin.end(stdinPayload, "utf8");
      } catch {
        try { child.stdin.end(); } catch { /* ignore */ }
      }
    } else {
      try { child.stdin.end(); } catch { /* ignore */ }
    }
  });
}

// Codex CLI 0.125+ emits a cosmetic rollout-recording error on EVERY successful
// `exec` and `exec resume` call. Confirmed via Tier 5 investigation
// (references/codex-thread-investigation.md): session resume works correctly
// (model recalls prior context, prompt cache hit ~10× higher) but stderr still
// contains this noise line. We filter it out before any stderr-based decision
// or before exposing stderr_tail to the orchestrator. Pattern is intentionally
// specific — DO NOT generalize to all "thread not found" lines, because a real
// lost-session error from a different codex subsystem could legitimately use
// similar wording, and we still want to detect that via isLostSession().
const ROLLOUT_NOISE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR codex_core::session: failed to record rollout items: thread [0-9a-f-]+ not found\s*$/;

function filterRolloutNoise(stderrBuf) {
  if (!stderrBuf) return stderrBuf;
  const lines = stderrBuf.split(/\r?\n/);
  const kept = lines.filter((line) => !ROLLOUT_NOISE_RE.test(line));
  // If nothing changed, avoid reallocating
  if (kept.length === lines.length) return stderrBuf;
  // Preserve trailing newline behavior of original buffer
  return kept.join("\n");
}

function isLostSession(stderrBuf) {
  if (!stderrBuf) return false;
  // Filter cosmetic rollout-recording noise first — otherwise its
  // "thread <id> not found" wording would match the patterns below
  // and trigger a false-positive fallback. (Currently safe only because
  // exit_code=0 gates the fallback, but defense-in-depth.)
  const cleaned = filterRolloutNoise(stderrBuf);
  if (!cleaned) return false;
  // Codex emits messages like:
  //   ... session not found / no such session ...
  //   failed to resume <id>: ... not found
  // Use a coarse multi-pattern match on the cleaned buffer.
  const patterns = [
    /thread\s+[0-9a-f-]+\s+not found/i,
    /session\s+not\s+found/i,
    /no\s+such\s+session/i,
    /failed to resume.*not\s+found/i,
  ];
  return patterns.some((re) => re.test(cleaned));
}

async function main() {
  // --- params validation ---
  // First positional arg that is NOT a recognized flag is the params path.
  // Recognized flags: --verbose-output (parsed at module-load via includes()).
  // This lets callers use either order: `wrapper params.json --verbose-output`
  // or `wrapper --verbose-output params.json`.
  const positionals = process.argv.slice(2).filter((a) => a !== "--verbose-output");
  const paramsPath = positionals[0];
  if (!paramsPath) {
    emitError("params_missing");
    return;
  }
  if (!existsSync(paramsPath)) {
    emitError("params_unreadable", { path: paramsPath, note: "file does not exist" });
    return;
  }
  let raw;
  try {
    raw = readFileSync(paramsPath, "utf8");
  } catch (err) {
    emitError("params_unreadable", { path: paramsPath, error: String(err) });
    return;
  }
  let params;
  try {
    params = JSON.parse(raw);
  } catch (err) {
    emitError("params_invalid_json", { path: paramsPath, parse_error: String(err) });
    return;
  }
  for (const required of ["prompt_file", "repo_root", "output_last_message_file"]) {
    if (!params[required] || typeof params[required] !== "string") {
      emitError("params_invalid_json", { path: paramsPath, missing_field: required });
      return;
    }
  }
  if (!params.settings || typeof params.settings !== "object") {
    emitError("params_invalid_json", { path: paramsPath, missing_field: "settings" });
    return;
  }
  if (!params.settings.effort || typeof params.settings.effort !== "string") {
    emitError("params_invalid_json", { path: paramsPath, missing_field: "settings.effort" });
    return;
  }

  // --- read prompt ---
  let promptText;
  try {
    promptText = readFileSync(params.prompt_file, "utf8");
  } catch (err) {
    emitError("prompt_unreadable", { path: params.prompt_file, error: String(err) });
    return;
  }

  // --- ensure last-message file is empty before spawn (prevents reading stale data) ---
  try {
    writeFileSync(params.output_last_message_file, "", "utf8");
  } catch (err) {
    emitError("wrapper_exception", {
      message: `cannot create empty output_last_message_file: ${err}`,
      path: params.output_last_message_file,
    });
    return;
  }

  // --- run codex (with optional resume) ---
  const wantResume = params.thread_mode === "continue" && typeof params.resume_thread_id === "string" && params.resume_thread_id;
  let codexArgs = buildCodexArgs(params, { resumeThreadId: wantResume ? params.resume_thread_id : null });
  let result = await runCodex(codexArgs, promptText, params.repo_root);
  let fallbackToFresh = false;

  if (result.kind === "exited" && wantResume && result.exit_code !== 0 && isLostSession(result.stderrBuf)) {
    // Lost-session fallback: re-spawn fresh, replace thread.
    process.stderr.write(`[plan-tango/run-codex-review] lost session ${params.resume_thread_id}, falling back to fresh\n`);
    fallbackToFresh = true;
    codexArgs = buildCodexArgs(params, { resumeThreadId: null });
    // Reset output file before second run
    try { writeFileSync(params.output_last_message_file, "", "utf8"); } catch { /* ignore */ }
    result = await runCodex(codexArgs, promptText, params.repo_root);
  }

  if (result.kind === "spawn_failed") {
    emitError("codex_nonzero_exit", {
      exit_code: -1,
      stderr_tail: tail(filterRolloutNoise(result.stderrBuf || ""), 2048),
      raw_stdout: "",
      spawn_error: result.error,
      fallback_to_fresh: fallbackToFresh,
    });
    return;
  }

  const { exit_code, stdoutBuf, stderrBuf, seconds } = result;

  if (exit_code !== 0) {
    emitError("codex_nonzero_exit", {
      exit_code,
      stderr_tail: tail(filterRolloutNoise(stderrBuf), 2048),
      raw_stdout: head(stdoutBuf, 4096),
      codex_seconds: seconds,
      fallback_to_fresh: fallbackToFresh,
    });
    return;
  }

  // v0.2 commit 3 (G): retry codex_empty_output once inside the wrapper.
  // Codex occasionally returns empty output transiently; one extra attempt
  // resolves most cases without forcing the orchestrator to retry.
  // Track latest result for stderr/seconds reporting.
  let stdoutBufLatest = stdoutBuf;
  let stderrBufLatest = stderrBuf;
  let secondsLatest = seconds;
  let attempts = 1;
  let retriedEmpty = false;

  // --- parse JSONL for session_id + diagnostics ---
  const jsonlResult = await runChildJson(JSONL_PARSER, [], stdoutBufLatest);
  let sessionId = null;
  let jsonlAgentText = null;
  if (jsonlResult.ok) {
    try {
      const jsonlOut = JSON.parse(jsonlResult.stdout);
      sessionId = jsonlOut.session_id || null;
      jsonlAgentText = jsonlOut.agent_text || null;
    } catch {
      // non-fatal — continue with sessionId=null
    }
  }

  // --- read last-message file ---
  let lastMessage = "";
  try {
    lastMessage = readFileSync(params.output_last_message_file, "utf8");
  } catch {
    // fall back to JSONL agent_text if file unreadable
    lastMessage = jsonlAgentText || "";
  }
  if (!lastMessage.trim() && jsonlAgentText) {
    lastMessage = jsonlAgentText;
  }

  // v0.2 (G): if empty, retry once before erroring out. Use the same
  // codexArgs (preserving any lost-session fresh fallback already applied).
  if (!lastMessage.trim()) {
    attempts = 2;
    retriedEmpty = true;
    process.stderr.write(
      `[plan-tango/run-codex-review] empty output on attempt 1, retrying once\n`
    );
    try { writeFileSync(params.output_last_message_file, "", "utf8"); } catch { /* ignore */ }
    const retryResult = await runCodex(codexArgs, promptText, params.repo_root);
    if (retryResult.kind === "spawn_failed") {
      emitError("codex_nonzero_exit", {
        exit_code: -1,
        stderr_tail: tail(filterRolloutNoise(retryResult.stderrBuf || ""), 2048),
        raw_stdout: "",
        spawn_error: retryResult.error,
        fallback_to_fresh: fallbackToFresh,
        attempts,
        retried_empty: retriedEmpty,
      });
      return;
    }
    stdoutBufLatest = retryResult.stdoutBuf;
    stderrBufLatest = retryResult.stderrBuf;
    secondsLatest = retryResult.seconds;
    if (retryResult.exit_code !== 0) {
      emitError("codex_nonzero_exit", {
        exit_code: retryResult.exit_code,
        stderr_tail: tail(filterRolloutNoise(stderrBufLatest), 2048),
        raw_stdout: head(stdoutBufLatest, 4096),
        codex_seconds: secondsLatest,
        fallback_to_fresh: fallbackToFresh,
        attempts,
        retried_empty: retriedEmpty,
      });
      return;
    }
    // Re-parse JSONL + read last-message from the retry.
    const jsonlResult2 = await runChildJson(JSONL_PARSER, [], stdoutBufLatest);
    if (jsonlResult2.ok) {
      try {
        const jsonlOut = JSON.parse(jsonlResult2.stdout);
        sessionId = jsonlOut.session_id || sessionId;
        jsonlAgentText = jsonlOut.agent_text || jsonlAgentText;
      } catch {
        // non-fatal
      }
    }
    try {
      lastMessage = readFileSync(params.output_last_message_file, "utf8");
    } catch {
      lastMessage = jsonlAgentText || "";
    }
    if (!lastMessage.trim() && jsonlAgentText) {
      lastMessage = jsonlAgentText;
    }
  }

  if (!lastMessage.trim()) {
    emitError("codex_empty_output", {
      stderr_tail: tail(filterRolloutNoise(stderrBufLatest), 2048),
      codex_seconds: secondsLatest,
      session_id: sessionId,
      fallback_to_fresh: fallbackToFresh,
      attempts,
      retried_empty: retriedEmpty,
      raw_output_excerpt: head(stdoutBufLatest, 1024),
    });
    return;
  }

  // --- pipe last-message into verdict parser (--from-text via stdin for portability) ---
  const verdictResult = await runChildJson(VERDICT_PARSER, ["--from-text"], lastMessage);
  if (!verdictResult.ok) {
    emitError("wrapper_exception", {
      message: "verdict parser invocation failed",
      stack: head(verdictResult.stderr || verdictResult.error || "", 1024),
      session_id: sessionId,
      fallback_to_fresh: fallbackToFresh,
    });
    return;
  }
  let parserOut;
  try {
    parserOut = JSON.parse(verdictResult.stdout);
  } catch (err) {
    emitError("wrapper_exception", {
      message: "verdict parser stdout was not valid JSON",
      stack: head(verdictResult.stdout, 1024),
      parse_error: String(err),
      session_id: sessionId,
      fallback_to_fresh: fallbackToFresh,
    });
    return;
  }

  // --- assemble final return shape ---
  parserOut.session_id = sessionId;
  parserOut.fallback_to_fresh = fallbackToFresh;
  parserOut.last_message_path = params.output_last_message_file;
  parserOut.codex_seconds = secondsLatest;
  parserOut.codex_stderr_tail = tail(filterRolloutNoise(stderrBufLatest), 1024);
  parserOut.exit_code = exit_code;
  parserOut.attempts = attempts;
  parserOut.retried_empty = retriedEmpty;
  // v0.2: lean output. Drop raw_final_message + skip raw_output_excerpt for
  // clean ALLOW/BLOCK verdicts unless verbose mode requested. Full text
  // available on disk at last_message_path.
  const isCleanVerdict = parserOut.verdict === "ALLOW" || parserOut.verdict === "BLOCK";
  if (isCleanVerdict && !VERBOSE_OUTPUT) {
    delete parserOut.raw_final_message;
    // raw_output_excerpt deliberately NOT added in lean path
  } else {
    parserOut.raw_output_excerpt = head(stdoutBufLatest, 1024);
  }
  if (!Array.isArray(parserOut.warnings)) {
    parserOut.warnings = parserOut.parse_warnings || [];
  }
  emit(parserOut);
}

main().catch((err) => {
  emitError("wrapper_exception", {
    message: String(err?.message || err),
    stack: String(err?.stack || "").slice(0, 1024),
  });
});
