#!/usr/bin/env node
// v0.2 commit 5 — single helper that prepares ALL iter{N}.* artifacts in one
// Bash call:
//   - iter{N}.prompt.md       (replaces build-prompt.mjs)
//   - iter{N}.params.json     (replaces build-params.mjs)
//   - iter{N}.last-message.txt (empty stub — replaces orchestrator Write)
//
// Settings come INLINE via --state-settings '<json>' instead of through a
// separate iter{N}.settings.json file that the orchestrator used to Write.
// This eliminates the last per-iteration orchestrator Write of structured
// data — only iter{N}.prompt.md (large literal text) and iter{N}.params.json
// (small structured) plus an empty stub remain, all written by this script.
//
// Byte-compat preserved: the literals for {{REPO_EVIDENCE_NOTE}} and
// {{RESET_BLOCK}} match build-prompt.mjs exactly. params.json uses 2-space
// JSON.stringify like build-params.mjs. resume_thread_id rule (continue +
// iter>=2 + non-null) matches build-params.mjs.
//
// Repo evidence is always available (the old `repo_evidence_available` flag was
// collapsed out — see plan-paths.mjs --resolve-repo). {{REPO_EVIDENCE_NOTE}} is
// always the "available" note, and params.json no longer carries the field. The
// legacy `--repo-evidence` flag is still accepted but ignored (no-op).
//
// CLI:
//   node prepare-iter.mjs \
//     --slug <slug> \
//     --iter <N> \
//     --plan <plan_path> \
//     --repo-root <repo_root> \
//     --thread-mode <fresh|continue> \
//     --resume-thread-id <uuid|null> \
//     --state-settings '<json>' \
//     --workspace <abs path to workspace dir> \
//     --template <abs path to review-prompt-template.md>
//
// --state-settings JSON shape (codex-relevant subset of state.settings):
//   {
//     "effort":             "<effort>",
//     "model":              "<model>"     | optional / null,
//     "service_tier":       "<fast|flex>" | optional / null,
//     "codex_profile":      "<name>"      | optional / null,
//     "extra_codex_config": ["key=val", ...]
//   }
//
// Output (stdout, success):
//   {"ok":true,
//    "prompt_file":"<workspace>/iter<N>.prompt.md",
//    "params_file":"<workspace>/iter<N>.params.json",
//    "last_message_file":"<workspace>/iter<N>.last-message.txt",
//    "prompt_lines":<N>,
//    "prompt_bytes":<B>,
//    "params_bytes":<B>}
//
// Output (stdout, failure) AND non-zero exit:
//   {"ok":false,"error":"<code>","detail":"<message>"}

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// === Literals (MUST match build-prompt.mjs byte-for-byte) ===

const REPO_EVIDENCE_NOTE =
  "Repository state is available via your tools at cwd. Inspect referenced files when checking claims.";

// Trailing blank line is intentional — matches the layout the orchestrator
// previously produced (Reset block followed by an empty line before <task>).
const RESET_BLOCK_LITERAL =
  "<reset_iteration>\n" +
  "You are reviewing this plan again. IGNORE your previous verdicts and findings from earlier\n" +
  "turns in this thread — the plan may have changed substantively. Read the plan from scratch\n" +
  "as if you were a new auditor. Do not anchor on prior conclusions.\n" +
  "</reset_iteration>\n\n";

// === Settings whitelisting (defensive — matches build-params.mjs) ===

const ALLOWED_SETTINGS_KEYS = new Set([
  "effort",
  "model",
  "service_tier",
  "codex_profile",
  "extra_codex_config",
]);

// === Helpers ===

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(error, detail) {
  emit({ ok: false, error, detail });
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    slug: null,
    iter: null,
    plan: null,
    repoRoot: null,
    threadMode: null,
    resumeThreadId: null,
    stateSettings: null,
    workspace: null,
    template: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case "--slug": args.slug = val; i++; break;
      case "--iter": args.iter = val; i++; break;
      case "--plan": args.plan = val; i++; break;
      case "--repo-root": args.repoRoot = val; i++; break;
      // Deprecated no-op — repo evidence is always available. Consume the
      // value if present so a stale caller doesn't hard-fail on it.
      case "--repo-evidence": i++; break;
      case "--thread-mode": args.threadMode = val; i++; break;
      case "--resume-thread-id": args.resumeThreadId = val; i++; break;
      case "--state-settings": args.stateSettings = val; i++; break;
      case "--workspace": args.workspace = val; i++; break;
      case "--template": args.template = val; i++; break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: prepare-iter.mjs --slug <s> --iter <N> --plan <p> --repo-root <p> --thread-mode <fresh|continue> --resume-thread-id <uuid|null> --state-settings '<json>' --workspace <p> --template <p>\n"
        );
        process.exit(0);
        break;
      default:
        if (flag.startsWith("--")) fail("unknown_flag", `unknown flag: ${flag}`);
    }
  }
  return args;
}

function parseSettings(jsonStr) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    fail("settings_invalid_json", `--state-settings is not valid JSON: ${err?.message || err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("settings_invalid_shape", "--state-settings must be a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      fail(
        "settings_extra_key",
        `--state-settings contains non-codex-relevant key: ${key}. Allowed: ${[...ALLOWED_SETTINGS_KEYS].join(", ")}`
      );
    }
  }
  if (typeof parsed.effort !== "string" || !parsed.effort) {
    fail("settings_missing_effort", "--state-settings must include a non-empty `effort` string");
  }
  return parsed;
}

function buildOutputSettings(s) {
  // Always include effort. Omit other keys whose value is null/empty array.
  // Exact same logic as build-params.mjs to preserve byte-compat.
  const out = { effort: s.effort };
  if (s.model !== undefined && s.model !== null && s.model !== "") {
    out.model = s.model;
  }
  if (s.service_tier !== undefined && s.service_tier !== null && s.service_tier !== "") {
    out.service_tier = s.service_tier;
  }
  if (s.codex_profile !== undefined && s.codex_profile !== null && s.codex_profile !== "") {
    out.codex_profile = s.codex_profile;
  }
  if (Array.isArray(s.extra_codex_config) && s.extra_codex_config.length > 0) {
    out.extra_codex_config = s.extra_codex_config;
  }
  return out;
}

// === Main ===

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = [
    ["--slug", args.slug],
    ["--iter", args.iter],
    ["--plan", args.plan],
    ["--repo-root", args.repoRoot],
    ["--thread-mode", args.threadMode],
    ["--state-settings", args.stateSettings],
    ["--workspace", args.workspace],
    ["--template", args.template],
  ];
  for (const [name, val] of required) {
    if (val === null || val === undefined || val === "") fail("missing_arg", `${name} is required`);
  }

  const iterNum = Number.parseInt(args.iter, 10);
  if (!Number.isFinite(iterNum) || iterNum < 1) {
    fail("invalid_arg", `--iter must be a positive integer, got: ${JSON.stringify(args.iter)}`);
  }

  if (args.threadMode !== "fresh" && args.threadMode !== "continue") {
    fail("invalid_arg", `--thread-mode must be "fresh" or "continue", got: ${JSON.stringify(args.threadMode)}`);
  }

  // reset_block flag: continue + iter>=2 + non-null thread (per SKILL.md
  // step 13 logic). Same predicate as resume_thread_id eligibility.
  const rawResume = args.resumeThreadId;
  const haveValidResume =
    rawResume && rawResume !== "null" && rawResume !== "" && rawResume !== "undefined";
  const resetBlock = args.threadMode === "continue" && iterNum >= 2 && haveValidResume;

  const settings = parseSettings(args.stateSettings);
  const outputSettings = buildOutputSettings(settings);

  // === Compose paths ===
  // Use POSIX-style joining always — preserves byte-compat with the legacy
  // build-params.mjs path that received forward-slash paths from the
  // orchestrator. JSON.stringify escapes backslashes (Windows path.join
  // would produce "\\\\"), forward slashes pass through unchanged.
  // Normalize the workspace input to forward slashes for the same reason.
  const workspaceNorm = args.workspace.replace(/\\/g, "/");
  const promptFile = path.posix.join(workspaceNorm, `iter${iterNum}.prompt.md`);
  const paramsFile = path.posix.join(workspaceNorm, `iter${iterNum}.params.json`);
  const lastMessageFile = path.posix.join(workspaceNorm, `iter${iterNum}.last-message.txt`);

  // === Read template + plan ===
  let template;
  try {
    template = readFileSync(args.template, "utf8");
  } catch (err) {
    fail("template_unreadable", `cannot read template at ${args.template}: ${err?.message || err}`);
  }

  let plan;
  try {
    plan = readFileSync(args.plan, "utf8");
  } catch (err) {
    fail("plan_unreadable", `cannot read plan at ${args.plan}: ${err?.message || err}`);
  }

  // === Build prompt (byte-compat with build-prompt.mjs) ===
  let promptOut = template
    .replace("{{RESET_BLOCK}}", resetBlock ? RESET_BLOCK_LITERAL : "")
    .replace("{{REPO_EVIDENCE_NOTE}}", REPO_EVIDENCE_NOTE);
  // {{PLAN_BODY}} replaced last with function value (regex-special-safe).
  promptOut = promptOut.replace("{{PLAN_BODY}}", () => plan);

  // === Build params (byte-compat with build-params.mjs) ===
  // resume_thread_id rule: only set when thread_mode=continue AND iter>=2 AND
  // a non-null UUID was passed. Otherwise null.
  const resumeThreadIdOut = resetBlock ? rawResume : null;

  const params = {
    prompt_file: promptFile,
    repo_root: args.repoRoot,
    iter: iterNum,
    slug: args.slug,
    output_last_message_file: lastMessageFile,
    settings: outputSettings,
    thread_mode: args.threadMode,
    resume_thread_id: resumeThreadIdOut,
  };
  // 2-space indentation matches build-params.mjs and legacy orchestrator Write.
  const paramsJson = JSON.stringify(params, null, 2) + "\n";

  // === Write all three artifacts ===
  try {
    writeFileSync(promptFile, promptOut, "utf8");
  } catch (err) {
    fail("prompt_unwritable", `cannot write prompt to ${promptFile}: ${err?.message || err}`);
  }
  try {
    writeFileSync(paramsFile, paramsJson, "utf8");
  } catch (err) {
    fail("params_unwritable", `cannot write params to ${paramsFile}: ${err?.message || err}`);
  }
  try {
    writeFileSync(lastMessageFile, "", "utf8");
  } catch (err) {
    fail("last_message_unwritable", `cannot pre-create last-message file at ${lastMessageFile}: ${err?.message || err}`);
  }

  emit({
    ok: true,
    prompt_file: promptFile,
    params_file: paramsFile,
    last_message_file: lastMessageFile,
    prompt_lines: promptOut.split("\n").length,
    prompt_bytes: Buffer.byteLength(promptOut, "utf8"),
    params_bytes: Buffer.byteLength(paramsJson, "utf8"),
  });
}

main();
