#!/usr/bin/env node
// Load + merge plan-tango user config.
//
// Canonical CLI:
//   node load-config.mjs --merge --cli '<json-string-of-parsed-cli-args>' [--config <path>]
//
// --cli '<json>'    JSON string with parsed CLI args (e.g. {"effort":"medium","max_iter":8}).
//                   Field names match the CLI mapping below; values are post-parse (number / bool / string).
// --config <path>   Optional override path to the user-config file.
//                   Default: ~/.claude/plan-tango/config.json (sibling of ~/.claude/plans).
//
// Output (stdout, success): JSON
//   { "merged": {<settings>}, "sources": {<key>: "cli"|"user_config"|"default"} }
//
// Output (stdout, failure): JSON  (exit code 2)
//   { "error": "<code>", "detail": "<human readable>", "field"?: "<key>" }
//
// Built-in defaults are the single source of truth — example file is documentation only.
//
// Validation: enforces enums, max_iter <=12, types. Validates user-config first
// (strict — invalid file rejected), then validates merged result. CLI args trusted
// to be already-parsed by orchestrator (still type-checked here defensively).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const BUILTIN_DEFAULTS = Object.freeze({
  model: null,
  effort: "high",
  max_iter: 6,
  thread_mode: "continue",
  // Default "never"; user opts in via --final-check or `final_check: "always"`
  // in config. The only valid values are "never" | "always" — the old "auto"
  // and "force" aliases were removed (hard cutover).
  final_check: "never",
  lenient: false,
  service_tier: null,
  codex_profile: null,
  extra_codex_config: [],
  quiet: false,
  severity_aware: true,
  // v0.2 Tier 2.2: Phase E §3 (convergence table) and §5 (narrative) are
  // opt-in via --verbose-report or `verbose_report: true` in config.
  // §1+§2+§4 (and §6 when polish_only_terminal) always render.
  verbose_report: false,
  // v0.2 Tier 3: end-of-Phase-E version check against GitHub releases.
  // No CLI flag — config-only opt-out. Throttled 7d, silent on network
  // failure. See update-check.mjs for protocol.
  update_check: true
});

const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_THREAD_MODES = new Set(["fresh", "continue"]);
// final_check vocabulary: "never" | "always". The old "auto" / "force"
// aliases were removed — encountering them is a hard error (see validateValue).
const VALID_FINAL_CHECK = new Set(["never", "always"]);
const VALID_SERVICE_TIERS = new Set([null, "fast", "flex"]);
const HARD_CAP_MAX_ITER = 12;

const CONFIGURABLE_KEYS = Object.freeze(Object.keys(BUILTIN_DEFAULTS));

function defaultConfigPath() {
  return path.join(homedir(), ".claude", "plan-tango", "config.json");
}

function emitOk(merged, sources) {
  // `warnings` is retained in the output shape (always empty now that the
  // deprecation-alias machinery is gone) so downstream readers stay stable.
  process.stdout.write(JSON.stringify({ merged, sources, warnings: [] }) + "\n");
}

function emitErr(code, detail, extra = {}) {
  process.stdout.write(JSON.stringify({ error: code, detail, ...extra }) + "\n");
  process.exit(2);
}

function parseArgs(argv) {
  const args = { _: [], merge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--merge") {
      args.merge = true;
    } else if (a === "--cli") {
      args.cli = argv[++i];
    } else if (a === "--config") {
      args.config = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function validateValue(key, value, source) {
  // null is the sentinel for "use default" only on optional-string fields
  switch (key) {
    case "model":
    case "codex_profile":
      if (value !== null && typeof value !== "string") {
        emitErr("invalid_type", `${key} must be string or null`, { field: key, source, got: typeof value });
      }
      return;
    case "effort":
      if (!VALID_EFFORTS.has(value)) {
        emitErr("invalid_value", `effort must be one of ${[...VALID_EFFORTS].join(", ")}`, { field: key, source, got: value });
      }
      return;
    case "max_iter":
      if (!Number.isInteger(value) || value < 1 || value > HARD_CAP_MAX_ITER) {
        emitErr("invalid_value", `max_iter must be integer 1..${HARD_CAP_MAX_ITER}`, { field: key, source, got: value });
      }
      return;
    case "thread_mode":
      if (!VALID_THREAD_MODES.has(value)) {
        emitErr("invalid_value", `thread_mode must be one of ${[...VALID_THREAD_MODES].join(", ")}`, { field: key, source, got: value });
      }
      return;
    case "final_check":
      if (value === "auto" || value === "force") {
        const replacement = value === "auto" ? "never" : "always";
        emitErr("removed_value", `final_check="${value}" was removed; use "${replacement}"`, { field: key, source, got: value });
      }
      if (!VALID_FINAL_CHECK.has(value)) {
        emitErr("invalid_value", `final_check must be one of ${[...VALID_FINAL_CHECK].join(", ")}`, { field: key, source, got: value });
      }
      return;
    case "lenient":
      if (typeof value !== "boolean") {
        emitErr("invalid_type", `lenient must be boolean`, { field: key, source, got: typeof value });
      }
      return;
    case "service_tier":
      if (!VALID_SERVICE_TIERS.has(value)) {
        emitErr("invalid_value", `service_tier must be null | "fast" | "flex"`, { field: key, source, got: value });
      }
      return;
    case "extra_codex_config":
      if (!Array.isArray(value)) {
        emitErr("invalid_type", `extra_codex_config must be array`, { field: key, source, got: typeof value });
      }
      for (const item of value) {
        if (typeof item !== "string" || !item.includes("=")) {
          emitErr("invalid_value", `extra_codex_config items must be strings of the form "key=value"`, { field: key, source, got: item });
        }
      }
      return;
    case "quiet":
      if (typeof value !== "boolean") {
        emitErr("invalid_type", `quiet must be boolean`, { field: key, source, got: typeof value });
      }
      return;
    case "severity_aware":
      if (typeof value !== "boolean") {
        emitErr("invalid_type", `severity_aware must be boolean`, { field: key, source, got: typeof value });
      }
      return;
    case "verbose_report":
      if (typeof value !== "boolean") {
        emitErr("invalid_type", `verbose_report must be boolean`, { field: key, source, got: typeof value });
      }
      return;
    case "update_check":
      if (typeof value !== "boolean") {
        emitErr("invalid_type", `update_check must be boolean`, { field: key, source, got: typeof value });
      }
      return;
    default:
      emitErr("unknown_key", `Unknown configurable key: ${key}`, { field: key, source });
  }
}

function loadUserConfig(configPath) {
  if (!existsSync(configPath)) {
    return { config: null, path: configPath, present: false };
  }
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    emitErr("config_read_failed", `Cannot read ${configPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    emitErr("config_invalid_json", `${configPath}: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    emitErr("config_invalid_shape", `${configPath} must be a JSON object`);
  }
  // Strip _comment_* and _README keys (documentation only)
  const sanitized = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("_")) continue;
    if (!CONFIGURABLE_KEYS.includes(k)) {
      emitErr("config_unknown_key", `${configPath} contains unknown key "${k}". Allowed: ${CONFIGURABLE_KEYS.join(", ")}`, { field: k });
    }
    sanitized[k] = v;
  }
  // Validate each provided value strictly (removed "auto"/"force" final_check
  // aliases are rejected by validateValue with a replacement-naming error).
  for (const [k, v] of Object.entries(sanitized)) {
    validateValue(k, v, "user_config");
  }
  return { config: sanitized, path: configPath, present: true };
}

function validateCli(cli) {
  if (cli === null || typeof cli !== "object" || Array.isArray(cli)) {
    emitErr("cli_invalid_shape", `--cli must be a JSON object`);
  }
  // Hard cutover: the deprecated flags --no-final-check / --force-final-check
  // were removed. Fail with a one-line error naming the replacement rather
  // than silently migrating.
  if ("no_final_check" in cli) {
    emitErr(
      "removed_flag",
      `--no-final-check was removed; final_check defaults to "never" — just omit --final-check (or set final_check="never" in config)`,
      { field: "no_final_check" }
    );
  }
  if ("force_final_check" in cli) {
    emitErr("removed_flag", `--force-final-check was removed; use --final-check`, { field: "force_final_check" });
  }
  // Conflict detection: caller may pass synthetic flag-shape — handle both
  // a flat parsed-arg style and an already-mapped style.
  // Allowed flat keys (CLI flag names, post-parse):
  //   final_check_flag (bool, canonical for --final-check),
  //   continue_thread (bool), fresh_each (bool), fast (bool),
  //   verbose_report_flag (bool), plus all CONFIGURABLE_KEYS directly.
  const allowedExtra = new Set([
    "final_check_flag",
    "continue_thread", "fresh_each", "fast",
    "verbose_report_flag"
  ]);
  for (const k of Object.keys(cli)) {
    if (CONFIGURABLE_KEYS.includes(k)) continue;
    if (allowedExtra.has(k)) continue;
    emitErr("cli_unknown_key", `--cli payload contains unknown key "${k}"`, { field: k });
  }
  // Conflict: --continue-thread AND --fresh-each
  if (cli.continue_thread === true && cli.fresh_each === true) {
    emitErr(
      "conflicting_flags",
      "--continue-thread and --fresh-each are mutually exclusive"
    );
  }
  return cli;
}

function mapCliToConfig(cli) {
  const out = {};
  // Direct passthrough for canonical keys (removed final_check aliases are
  // already rejected by validateCli / validateValue before this runs).
  for (const k of CONFIGURABLE_KEYS) {
    if (k in cli) {
      out[k] = cli[k];
    }
  }
  // Synthetic flag mappings. --final-check is the only final_check flag.
  if (cli.final_check_flag === true) {
    out.final_check = "always";
  }
  if (cli.continue_thread === true) out.thread_mode = "continue";
  if (cli.fresh_each === true) out.thread_mode = "fresh";
  if (cli.fast === true) out.service_tier = "fast";
  if (cli.verbose_report_flag === true) out.verbose_report = true;
  return out;
}

function merge(defaults, userCfg, cliCfg) {
  const merged = { ...defaults };
  const sources = {};
  for (const k of CONFIGURABLE_KEYS) {
    sources[k] = "default";
  }
  if (userCfg) {
    for (const [k, v] of Object.entries(userCfg)) {
      merged[k] = v;
      sources[k] = "user_config";
    }
  }
  for (const [k, v] of Object.entries(cliCfg)) {
    merged[k] = v;
    sources[k] = "cli";
  }
  // Re-validate merged result (guards against weird edge cases — e.g. user_config max_iter=12, but no individual rule was violated yet)
  for (const k of CONFIGURABLE_KEYS) {
    validateValue(k, merged[k], sources[k]);
  }
  return { merged, sources };
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help || (!args.merge && argv.length === 0)) {
    process.stdout.write(
      'Usage: load-config.mjs --merge --cli \'<json>\' [--config <path>]\n' +
      'See header comment in load-config.mjs for the schema.\n'
    );
    process.exit(args.help ? 0 : 2);
  }

  if (!args.merge) {
    emitErr("missing_mode", "Expected --merge");
  }

  if (typeof args.cli !== "string") {
    emitErr("missing_cli", "--cli '<json>' is required");
  }

  let cli;
  try {
    cli = JSON.parse(args.cli);
  } catch (err) {
    emitErr("cli_invalid_json", `--cli value is not valid JSON: ${err.message}`);
  }

  validateCli(cli);

  const configPath = args.config || defaultConfigPath();
  const { config: userCfg } = loadUserConfig(configPath);

  const cliCfg = mapCliToConfig(cli);

  const { merged, sources } = merge(BUILTIN_DEFAULTS, userCfg, cliCfg);

  emitOk(merged, sources);
}

main();
