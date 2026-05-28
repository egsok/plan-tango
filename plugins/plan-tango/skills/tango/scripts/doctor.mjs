#!/usr/bin/env node
// v0.2 commit 9 — doctor.mjs: single-command diagnostics.
//
// Runs all read-only or dry-run checks against the plan-tango install:
//   1. codex CLI on PATH (codex --version)
//   2. ~/.claude/plan-tango/config.json parse (if file present)
//   3. write-test in ~/.claude/plans/ (creates + deletes a probe file)
//   4. lock.mjs acquire + release dry-run on a probe slug
//   5. run-codex-review.mjs with intentionally-broken params (verifies the
//      wrapper exits cleanly on bad input rather than throwing)
//
// All checks are non-mutating outside of the probe write/lock cycle (which
// is cleaned up before the script exits).
//
// Usage:
//   node doctor.mjs            # human-readable + structured stdout
//   node doctor.mjs --json     # JSON-only stdout (for piping)
//
// Exit code: 0 if all checks pass, 1 if any FAIL, 2 on argv error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLANS_ROOT = path.join(homedir(), ".claude", "plans");
const CONFIG_PATH = path.join(homedir(), ".claude", "plan-tango", "config.json");

const PROBE_SLUG = ".tango-doctor-probe";
const PROBE_PLAN = path.join(PLANS_ROOT, `${PROBE_SLUG}.md`);
const PROBE_FILE = path.join(PLANS_ROOT, ".tango-doctor-write-probe");

function parseArgs(argv) {
  const out = { json: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: doctor.mjs [--json]\n");
      process.exit(0);
    } else if (a.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function runHelper(scriptName, args, opts = {}) {
  const scriptPath = path.join(SCRIPT_DIR, scriptName);
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  });
}

function parseHelperJson(stdout) {
  const lines = (stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : "{}";
  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

// === Checks ===

function checkCodexCli() {
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return {
      name: "codex_cli",
      ok: false,
      detail:
        "codex --version failed. Install with `npm install -g @openai/codex`, then run `codex login`.",
      stderr: (result.stderr || "").trim().slice(0, 256),
    };
  }
  return {
    name: "codex_cli",
    ok: true,
    detail: `codex --version: ${(result.stdout || "").trim()}`,
  };
}

function checkConfigFile() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      name: "user_config",
      ok: true,
      detail: `${CONFIG_PATH} does not exist (optional — defaults apply).`,
      skipped: true,
    };
  }
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    return {
      name: "user_config",
      ok: false,
      detail: `cannot read ${CONFIG_PATH}: ${err.message || err}`,
    };
  }
  try {
    JSON.parse(raw);
  } catch (err) {
    return {
      name: "user_config",
      ok: false,
      detail: `${CONFIG_PATH} is not valid JSON: ${err.message || err}`,
    };
  }
  // Validate via load-config.mjs --merge --cli '{}' --config <path>
  const loaderResult = runHelper("load-config.mjs", [
    "--merge",
    "--cli", "{}",
    "--config", CONFIG_PATH,
  ]);
  if (loaderResult.status !== 0) {
    const parsed = parseHelperJson(loaderResult.stdout);
    return {
      name: "user_config",
      ok: false,
      detail: `load-config.mjs rejected ${CONFIG_PATH}: ${
        parsed ? `${parsed.error}: ${parsed.detail || ""}` : "unknown error"
      }`,
    };
  }
  return {
    name: "user_config",
    ok: true,
    detail: `${CONFIG_PATH} parses cleanly via load-config.mjs.`,
  };
}

function checkWriteProbe() {
  try {
    if (!existsSync(PLANS_ROOT)) {
      mkdirSync(PLANS_ROOT, { recursive: true });
    }
  } catch (err) {
    return {
      name: "plans_dir_writable",
      ok: false,
      detail: `cannot create ${PLANS_ROOT}: ${err.message || err}`,
    };
  }
  try {
    writeFileSync(PROBE_FILE, `doctor probe ${new Date().toISOString()}\n`, "utf8");
  } catch (err) {
    return {
      name: "plans_dir_writable",
      ok: false,
      detail: `cannot write ${PROBE_FILE}: ${err.message || err}`,
    };
  }
  try {
    rmSync(PROBE_FILE);
  } catch (err) {
    return {
      name: "plans_dir_writable",
      ok: false,
      detail: `wrote probe but cannot remove it (${PROBE_FILE}): ${err.message || err}`,
    };
  }
  return {
    name: "plans_dir_writable",
    ok: true,
    detail: `${PLANS_ROOT} accepts read/write/delete.`,
  };
}

function checkLockCycle() {
  // Need a real plan file for `lock.mjs acquire --plan <path>` to validate
  // against. Create a small one, lock-acquire, release, delete.
  const probePlanCreated = !existsSync(PROBE_PLAN);
  if (probePlanCreated) {
    try {
      writeFileSync(
        PROBE_PLAN,
        "# tango-doctor-probe\n\nThis file exists only while doctor.mjs is running. " +
          "If you find it after doctor exits, delete it manually.\n\nMore padding " +
          "to satisfy the >=200 byte minimum-size validation imposed by " +
          "plan-paths.mjs --validate. Lorem ipsum dolor sit amet.\n",
        "utf8"
      );
    } catch (err) {
      return {
        name: "lock_cycle",
        ok: false,
        detail: `cannot create probe plan ${PROBE_PLAN}: ${err.message || err}`,
      };
    }
  }
  // Acquire
  const acqRes = runHelper("lock.mjs", [
    "acquire",
    "--slug", PROBE_SLUG,
    "--plan", PROBE_PLAN,
  ]);
  const acq = parseHelperJson(acqRes.stdout);
  if (acqRes.status !== 0 || !acq?.ok) {
    if (probePlanCreated) {
      try { rmSync(PROBE_PLAN); } catch { /* ignore */ }
    }
    return {
      name: "lock_cycle",
      ok: false,
      detail: `lock.mjs acquire failed: ${
        acq ? acq.reason || JSON.stringify(acq) : "no JSON output"
      }`,
    };
  }
  // Release
  const relRes = runHelper("lock.mjs", [
    "release",
    "--slug", PROBE_SLUG,
    "--session", acq.session_id,
  ]);
  const rel = parseHelperJson(relRes.stdout);
  // Cleanup
  if (probePlanCreated) {
    try { rmSync(PROBE_PLAN); } catch { /* ignore */ }
  }
  if (relRes.status !== 0 || !rel?.ok) {
    return {
      name: "lock_cycle",
      ok: false,
      detail: `lock.mjs release failed (lock may be stuck — inspect with lock.mjs inspect --slug ${PROBE_SLUG}): ${
        rel ? rel.reason || JSON.stringify(rel) : "no JSON output"
      }`,
    };
  }
  return {
    name: "lock_cycle",
    ok: true,
    detail: "lock.mjs acquire + release dry-run completed cleanly.",
  };
}

function checkWrapperErrorPath() {
  // Run wrapper with no params — should emit verdict:ERROR cleanly.
  const result = runHelper("run-codex-review.mjs", []);
  if (result.status !== 0) {
    return {
      name: "wrapper_error_path",
      ok: false,
      detail: `run-codex-review.mjs exited non-zero (${result.status}) on missing-params input — wrapper should always exit 0 with verdict:ERROR.`,
    };
  }
  const parsed = parseHelperJson(result.stdout);
  if (!parsed || parsed.verdict !== "ERROR" || parsed.reason !== "params_missing") {
    return {
      name: "wrapper_error_path",
      ok: false,
      detail: `run-codex-review.mjs did not produce verdict:ERROR + reason:params_missing on empty input. Got: ${JSON.stringify(parsed)}`,
    };
  }
  return {
    name: "wrapper_error_path",
    ok: true,
    detail: "run-codex-review.mjs handles missing-params input cleanly (verdict:ERROR).",
  };
}

// === Main ===

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const checks = [
    checkCodexCli(),
    checkConfigFile(),
    checkWriteProbe(),
    checkLockCycle(),
    checkWrapperErrorPath(),
  ];

  const failed = checks.filter((c) => !c.ok);
  const overall = failed.length === 0 ? "PASS" : "FAIL";

  if (args.json) {
    process.stdout.write(JSON.stringify({ overall, checks }) + "\n");
  } else {
    process.stdout.write(`plan-tango doctor — ${overall}\n`);
    for (const c of checks) {
      const tag = c.ok ? (c.skipped ? "SKIP" : "OK  ") : "FAIL";
      process.stdout.write(`  [${tag}] ${c.name}: ${c.detail}\n`);
      if (!c.ok && c.stderr) {
        process.stdout.write(`         stderr: ${c.stderr}\n`);
      }
    }
    if (failed.length > 0) {
      process.stdout.write(
        `\n${failed.length} check(s) failed. Re-run with --json for structured output.\n`
      );
    }
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main();
