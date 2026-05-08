#!/usr/bin/env node
// Tier 0.2 — Build iter{N}.params.json. Replaces the orchestrator's Write
// tool path. Smaller than build-prompt.mjs (params.json is ~14 lines), but
// adjacent and same pattern. ~5-10s saved per iter.
//
// CLI:
//   node build-params.mjs \
//     --slug <slug> \
//     --iter <N> \
//     --repo-root <repo_root> \
//     --repo-evidence <true|false> \
//     --thread-mode <fresh|continue> \
//     --resume-thread-id <uuid|null> \
//     --prompt-file <workspace>/iter<N>.prompt.md \
//     --output-last-message-file <workspace>/iter<N>.last-message.txt \
//     --settings-json <path to small JSON with codex-relevant settings subset> \
//     --out <workspace>/iter<N>.params.json
//
// --settings-json contains:
//   {
//     "effort":             "<effort>",
//     "model":              "<model>"     | optional / null,
//     "service_tier":       "<fast|flex>" | optional / null,
//     "codex_profile":      "<name>"      | optional / null,
//     "extra_codex_config": ["key=val", ...]
//   }
//
// Output schema (matches what run-codex-review.mjs consumes — see its docstring
// and the v0.2 plan Tier 0.2 contract):
//   {
//     "prompt_file":              "<abs path>",
//     "repo_root":                "<abs path>",
//     "repo_evidence_available":  true | false,
//     "iter":                     N,
//     "slug":                     "<string>",
//     "output_last_message_file": "<abs path>",
//     "settings": {
//       "effort":             "<effort>",
//       "model":              "<model>"     | optional,
//       "service_tier":       "<fast|flex>" | optional,
//       "codex_profile":      "<name>"      | optional,
//       "extra_codex_config": ["key=val", ...]
//     },
//     "thread_mode":      "fresh" | "continue",
//     "resume_thread_id": "<uuid>" | null
//   }
//
// Rules (must match SKILL.md Phase C step 14):
// - settings.* is the codex-relevant subset only. Orchestrator-only keys
//   (max_iter, thread_mode, final_check, lenient, quiet, verbose_report,
//   severity_aware) MUST NOT be copied. The --settings-json file should
//   contain ONLY codex-relevant fields; we re-validate here.
// - Omit any optional settings.* key whose value is null/empty-array.
//   Always include `effort`.
// - resume_thread_id is set only when thread_mode === "continue" AND
//   iter >= 2 AND a non-null UUID was passed. Otherwise it's null
//   (regardless of what was passed) — wrapper opens a fresh thread.

import { readFileSync, writeFileSync } from "node:fs";

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
    repoRoot: null,
    repoEvidence: null,
    threadMode: null,
    resumeThreadId: null,
    promptFile: null,
    outputLastMessageFile: null,
    settingsJson: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case "--slug": args.slug = val; i++; break;
      case "--iter": args.iter = val; i++; break;
      case "--repo-root": args.repoRoot = val; i++; break;
      case "--repo-evidence": args.repoEvidence = val; i++; break;
      case "--thread-mode": args.threadMode = val; i++; break;
      case "--resume-thread-id": args.resumeThreadId = val; i++; break;
      case "--prompt-file": args.promptFile = val; i++; break;
      case "--output-last-message-file": args.outputLastMessageFile = val; i++; break;
      case "--settings-json": args.settingsJson = val; i++; break;
      case "--out": args.out = val; i++; break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: build-params.mjs --slug <s> --iter <N> --repo-root <p> --repo-evidence <true|false> --thread-mode <fresh|continue> --resume-thread-id <uuid|null> --prompt-file <p> --output-last-message-file <p> --settings-json <p> --out <p>\n"
        );
        process.exit(0);
        break;
      default:
        if (flag.startsWith("--")) fail("unknown_flag", `unknown flag: ${flag}`);
    }
  }
  return args;
}

function parseBool(name, val) {
  if (val === "true") return true;
  if (val === "false") return false;
  fail("invalid_arg", `${name} must be "true" or "false", got: ${JSON.stringify(val)}`);
}

const ALLOWED_SETTINGS_KEYS = new Set([
  "effort",
  "model",
  "service_tier",
  "codex_profile",
  "extra_codex_config",
]);

function loadSettings(settingsJsonPath) {
  let raw;
  try {
    raw = readFileSync(settingsJsonPath, "utf8");
  } catch (err) {
    fail("settings_unreadable", `cannot read --settings-json at ${settingsJsonPath}: ${err?.message || err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail("settings_invalid_json", `--settings-json is not valid JSON: ${err?.message || err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("settings_invalid_shape", "--settings-json must be a JSON object");
  }
  // Defensive: reject orchestrator-only keys if they leaked in.
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      fail("settings_extra_key", `--settings-json contains non-codex-relevant key: ${key}. Allowed: ${[...ALLOWED_SETTINGS_KEYS].join(", ")}`);
    }
  }
  if (typeof parsed.effort !== "string" || !parsed.effort) {
    fail("settings_missing_effort", "--settings-json must include a non-empty `effort` string");
  }
  return parsed;
}

function buildOutputSettings(s) {
  // Always include effort. Omit other keys whose value is null/empty array.
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = [
    ["--slug", args.slug],
    ["--iter", args.iter],
    ["--repo-root", args.repoRoot],
    ["--repo-evidence", args.repoEvidence],
    ["--thread-mode", args.threadMode],
    ["--prompt-file", args.promptFile],
    ["--output-last-message-file", args.outputLastMessageFile],
    ["--settings-json", args.settingsJson],
    ["--out", args.out],
  ];
  for (const [name, val] of required) {
    if (val === null || val === undefined || val === "") fail("missing_arg", `${name} is required`);
  }

  const iterNum = Number.parseInt(args.iter, 10);
  if (!Number.isFinite(iterNum) || iterNum < 1) {
    fail("invalid_arg", `--iter must be a positive integer, got: ${JSON.stringify(args.iter)}`);
  }

  const repoEvidence = parseBool("--repo-evidence", args.repoEvidence);

  if (args.threadMode !== "fresh" && args.threadMode !== "continue") {
    fail("invalid_arg", `--thread-mode must be "fresh" or "continue", got: ${JSON.stringify(args.threadMode)}`);
  }

  // resume_thread_id rule: only set when thread_mode=continue AND iter>=2 AND
  // a non-null UUID was passed. Otherwise null. The orchestrator always passes
  // SOMETHING (either a uuid or the literal string "null"); we normalize here.
  let resumeThreadId = null;
  const rawResume = args.resumeThreadId;
  if (rawResume && rawResume !== "null" && rawResume !== "" && args.threadMode === "continue" && iterNum >= 2) {
    resumeThreadId = rawResume;
  }

  const settings = loadSettings(args.settingsJson);
  const outputSettings = buildOutputSettings(settings);

  const params = {
    prompt_file: args.promptFile,
    repo_root: args.repoRoot,
    repo_evidence_available: repoEvidence,
    iter: iterNum,
    slug: args.slug,
    output_last_message_file: args.outputLastMessageFile,
    settings: outputSettings,
    thread_mode: args.threadMode,
    resume_thread_id: resumeThreadId,
  };

  // Use 2-space indentation to match what the orchestrator was previously
  // producing via Write tool. The compatibility harness (references/build-
  // params-compat.md) verifies byte-for-byte matches across flag matrix.
  const json = JSON.stringify(params, null, 2) + "\n";

  try {
    writeFileSync(args.out, json, "utf8");
  } catch (err) {
    fail("out_unwritable", `cannot write to ${args.out}: ${err?.message || err}`);
  }

  emit({ ok: true, out: args.out, bytes: Buffer.byteLength(json, "utf8") });
}

main();
