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
  // v0.2: default flipped from "auto" (keyword auto-gate triggered for almost
  // every Claude Code plan → effectively always-on) to "never". User opts in
  // via --final-check or `final_check: "always"` in config. Old "auto" and
  // "force" values are accepted as deprecated aliases (see migration logic).
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
  verbose_report: false
});

const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_THREAD_MODES = new Set(["fresh", "continue"]);
// v0.2 vocabulary: "never" | "always". Old "auto" and "force" are accepted
// as deprecated aliases at the config-load stage and migrated before this
// validator runs (see migrateDeprecatedConfigValues).
const VALID_FINAL_CHECK = new Set(["never", "always"]);
const VALID_SERVICE_TIERS = new Set([null, "fast", "flex"]);
const HARD_CAP_MAX_ITER = 12;

const CONFIGURABLE_KEYS = Object.freeze(Object.keys(BUILTIN_DEFAULTS));

function defaultConfigPath() {
  return path.join(homedir(), ".claude", "plan-tango", "config.json");
}

function emitOk(merged, sources, warnings = []) {
  // v0.2: `warnings` is an array of one-line strings to be printed by the
  // orchestrator (typically deprecation notices). Empty array if no warnings.
  process.stdout.write(JSON.stringify({ merged, sources, warnings }) + "\n");
}

// v0.2: deprecation aliases for `final_check` config value.
// Migrates `auto`→`never`, `force`→`always` and appends a one-line warning.
// Returns the normalized value (or the input unchanged for non-deprecated values).
function migrateDeprecatedFinalCheckValue(value, source, warnings) {
  if (value === "auto") {
    warnings.push(
      `[plan-tango] ${source}: final_check="auto" is deprecated; treating as "never" (the new default).`
    );
    return "never";
  }
  if (value === "force") {
    warnings.push(
      `[plan-tango] ${source}: final_check="force" is deprecated; treating as "always".`
    );
    return "always";
  }
  return value;
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
    default:
      emitErr("unknown_key", `Unknown configurable key: ${key}`, { field: key, source });
  }
}

function loadUserConfig(configPath, warnings) {
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
  // v0.2: migrate deprecated final_check vocabulary BEFORE strict validation,
  // so old "auto" / "force" values don't trip the validator. Emits a warning.
  if ("final_check" in sanitized) {
    sanitized.final_check = migrateDeprecatedFinalCheckValue(sanitized.final_check, "config", warnings);
  }
  // Validate each provided value strictly
  for (const [k, v] of Object.entries(sanitized)) {
    validateValue(k, v, "user_config");
  }
  return { config: sanitized, path: configPath, present: true };
}

function validateCli(cli) {
  if (cli === null || typeof cli !== "object" || Array.isArray(cli)) {
    emitErr("cli_invalid_shape", `--cli must be a JSON object`);
  }
  // Conflict detection: caller may pass synthetic flag-shape — handle both
  // a flat parsed-arg style and an already-mapped style.
  // Allowed flat keys (CLI flag names, post-parse):
  //   no_final_check (bool, deprecated alias),
  //   force_final_check (bool, deprecated alias),
  //   final_check_flag (bool, v0.2 canonical for --final-check),
  //   continue_thread (bool), fresh_each (bool), fast (bool),
  //   plus all CONFIGURABLE_KEYS directly.
  const allowedExtra = new Set([
    "no_final_check", "force_final_check", "final_check_flag",
    "continue_thread", "fresh_each", "fast",
    "verbose_report_flag"
  ]);
  for (const k of Object.keys(cli)) {
    if (CONFIGURABLE_KEYS.includes(k)) continue;
    if (allowedExtra.has(k)) continue;
    emitErr("cli_unknown_key", `--cli payload contains unknown key "${k}"`, { field: k });
  }
  // Conflict: --no-final-check is mutually exclusive with --final-check / --force-final-check
  // (you can't disable AND enable simultaneously). The two enable-flags are
  // alias-equivalent and may both be present without conflict (we just warn
  // on the deprecated one).
  if (cli.no_final_check === true && (cli.force_final_check === true || cli.final_check_flag === true)) {
    emitErr(
      "conflicting_flags",
      "--no-final-check is mutually exclusive with --final-check / --force-final-check"
    );
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

function mapCliToConfig(cli, warnings) {
  const out = {};
  // Direct passthrough for canonical keys (orchestrator may pass either style)
  for (const k of CONFIGURABLE_KEYS) {
    if (k in cli) {
      // v0.2: migrate deprecated `final_check` vocabulary if passed directly
      // via --cli (rare path, but possible).
      if (k === "final_check") {
        out[k] = migrateDeprecatedFinalCheckValue(cli[k], "cli", warnings);
      } else {
        out[k] = cli[k];
      }
    }
  }
  // Synthetic flag mappings.
  // v0.2: --final-check is canonical; --force-final-check is deprecated alias;
  //       --no-final-check is deprecated disable-override (still works, but
  //       always warned). All of them set the normalized final_check value.
  if (cli.no_final_check === true) {
    out.final_check = "never";
    warnings.push(
      `[plan-tango] --no-final-check is deprecated; it now sets final_check="never" for this run, overriding config. Will be removed in v0.3.`
    );
  }
  if (cli.force_final_check === true) {
    out.final_check = "always";
    warnings.push(
      `[plan-tango] --force-final-check is deprecated; use --final-check instead.`
    );
  }
  if (cli.final_check_flag === true) {
    // Canonical --final-check flag — no warning.
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

  // v0.2: collect deprecation warnings from both config-load and CLI mapping.
  const warnings = [];

  const configPath = args.config || defaultConfigPath();
  const { config: userCfg } = loadUserConfig(configPath, warnings);

  const cliCfg = mapCliToConfig(cli, warnings);

  const { merged, sources } = merge(BUILTIN_DEFAULTS, userCfg, cliCfg);

  emitOk(merged, sources, warnings);
}

main();
