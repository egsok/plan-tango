#!/usr/bin/env node
// Atomic write of plan-tango user config with independent revalidation.
//
// Usage:
//   node write-config.mjs --file <abs-path-to-temp-file>
//
// The skill MUST drop the candidate JSON to <abs-path-to-temp-file> via Write
// tool BEFORE invoking this wrapper. We do not accept --json / --stdin to keep
// the transport free of shell-quoting hazards.
//
// Steps:
//   1. Read --file (abort temp_missing if absent, invalid_json on parse error).
//   2. Sanitize: strip keys starting with `_` (defensive; wizard shouldn't emit them).
//   3. Re-write the sanitized JSON back to the same temp path — so the validator
//      in step 4 sees the EXACT bytes about to become the live config.
//   4. Validate by spawning `load-config.mjs --merge --config <temp> --cli '{}'`.
//      This intentionally uses --config (not --cli) so the candidate is validated
//      INDEPENDENTLY of any pre-existing ~/.claude/plan-tango/config.json — a broken
//      existing file must not block the wizard from writing a fixed replacement.
//      On non-zero exit → unlink(temp), re-emit loader's {error, detail, field?},
//      exit 2.
//   4.5. Backup existing config.json to .bak before overwrite (best-effort; abort
//        if backup itself fails — live config stays intact for retry).
//   5. fs.renameSync(<temp>, ~/.claude/plan-tango/config.json) — atomic same-fs.
//   6. Print {ok:true, path:<final>, backup_path:<bak-or-null>}.
//
// On any failure between steps 1-4: temp file is unlinked. The live config is
// never partially overwritten.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function emitErr(code, detail, extra = {}) {
  process.stdout.write(JSON.stringify({ error: code, detail, ...extra }) + "\n");
  process.exit(2);
}

function tryUnlink(p) {
  try { if (p && existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") args.file = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) emitErr("missing_arg", "--file <abs-path-to-temp-file> required");

  const tempPath = path.resolve(args.file);

  // Step 1: read
  if (!existsSync(tempPath)) emitErr("temp_missing", `temp file not found: ${tempPath}`);
  let raw;
  try { raw = readFileSync(tempPath, "utf8"); }
  catch (err) { tryUnlink(tempPath); emitErr("temp_unreadable", err.message); }

  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (err) { tryUnlink(tempPath); emitErr("invalid_json", `temp file not parseable: ${err.message}`); }

  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    tryUnlink(tempPath);
    emitErr("invalid_shape", "temp file must contain a JSON object");
  }

  // Step 2: sanitize defensively (strip _* keys)
  const sanitized = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!k.startsWith("_")) sanitized[k] = v;
  }

  // Step 3: re-write sanitized content back to temp path so validation sees final bytes
  try {
    writeFileSync(tempPath, JSON.stringify(sanitized, null, 2) + "\n", "utf8");
  } catch (err) {
    tryUnlink(tempPath);
    emitErr("temp_rewrite_failed", err.message);
  }

  // Step 4: independent validation via --config <temp>
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = .../skills/settings/scripts ; sibling = .../skills/tango/scripts/load-config.mjs
  const loadConfigPath = path.resolve(here, "..", "..", "tango", "scripts", "load-config.mjs");

  const validation = spawnSync(
    process.execPath,
    [loadConfigPath, "--merge", "--config", tempPath, "--cli", "{}"],
    { encoding: "utf8" }
  );
  if (validation.status !== 0) {
    let parsed = {};
    try { parsed = JSON.parse(validation.stdout || "{}"); } catch { /* keep empty */ }
    tryUnlink(tempPath);
    emitErr(
      parsed.error || "validation_failed",
      parsed.detail || validation.stderr || "load-config.mjs rejected the candidate config",
      parsed.field ? { field: parsed.field } : {}
    );
  }

  // Step 4.5: backup existing config.json to .bak before overwrite.
  // Symmetric with snapshot.mjs semantics elsewhere in the plugin (which creates
  // .iter*.bak before plan edits). Allows recovery via `cp config.json.bak config.json`.
  // Best-effort: if backup itself fails, abort BEFORE renaming so the live config
  // stays intact.
  const finalDir = path.join(homedir(), ".claude", "plan-tango");
  if (!existsSync(finalDir)) mkdirSync(finalDir, { recursive: true });
  const finalPath = path.join(finalDir, "config.json");
  const backupPath = path.join(finalDir, "config.json.bak");

  let backedUp = false;
  if (existsSync(finalPath)) {
    try {
      copyFileSync(finalPath, backupPath);
      backedUp = true;
    } catch (err) {
      tryUnlink(tempPath);
      emitErr("backup_failed", `Could not back up existing config.json to .bak: ${err.message}`, { final_path: finalPath, backup_path: backupPath });
    }
  }

  // Step 5: atomic rename
  try {
    renameSync(tempPath, finalPath);
  } catch (err) {
    tryUnlink(tempPath);
    emitErr("rename_failed", err.message, { temp_path: tempPath, final_path: finalPath });
  }

  // Step 6: success (include backup_path if a previous config was preserved)
  process.stdout.write(JSON.stringify({ ok: true, path: finalPath, backup_path: backedUp ? backupPath : null }) + "\n");
}

main();
