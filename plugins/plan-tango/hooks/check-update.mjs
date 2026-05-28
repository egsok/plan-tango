#!/usr/bin/env node
// SessionStart hook for plan-tango — emit a one-line "update available"
// notice when GitHub has a newer release tag than the installed plugin.
//
// Wraps the existing skills/tango/scripts/update-check.mjs (which handles the
// 7-day on-disk cache, semver comparison, and silent-on-network-failure
// behavior). All this hook adds is:
//   1. Read current plugin version from .claude-plugin/plugin.json
//   2. Honor `update_check: false` in user config (full opt-out)
//   3. Translate update-check.mjs JSON output → plain stdout line that
//      Claude Code's SessionStart pipeline surfaces as session context.
//
// Contract:
//   - status === "newer-available"  → write parsed.message + "\n" to stdout
//   - any other status / any error  → write nothing
//   - always exit 0 (SessionStart hooks must never block the session)
//
// Performance: cache-hit path is <50ms. Cache-miss with healthy network is
// ~1–2s. Cache-miss with bad network is bounded by update-check.mjs's own
// 3s timeout; this wrapper adds a 4.5s spawnSync timeout under the 5s hook
// budget declared in hooks.json.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function silent() {
  process.exit(0);
}

try {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) silent();

  // Respect user opt-out (config-only knob, default true; same field the
  // Phase E update-check reads).
  const configPath = path.join(homedir(), ".claude", "plan-tango", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg && cfg.update_check === false) silent();
    } catch {
      // Unparseable config — proceed silently rather than spam the session
      // with a parse error on every startup.
    }
  }

  const pluginJson = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJson)) silent();
  let current;
  try {
    current = JSON.parse(readFileSync(pluginJson, "utf8")).version;
  } catch {
    silent();
  }
  if (typeof current !== "string") silent();

  const updateCheck = path.join(pluginRoot, "skills", "tango", "scripts", "update-check.mjs");
  if (!existsSync(updateCheck)) silent();

  const result = spawnSync(process.execPath, [updateCheck, "--current-version", current], {
    encoding: "utf8",
    timeout: 4500,
    windowsHide: true,
  });

  if (!result || result.status !== 0 || !result.stdout) silent();

  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { silent(); }

  if (parsed && parsed.status === "newer-available" && typeof parsed.message === "string") {
    // Emit JSON, not plain text. Plain stdout goes to Claude's invisible
    // system-reminder context — the user never sees it in the chat.
    //   - systemMessage: per Claude Code docs, "warning message shown to the
    //     user (available on all hooks)" — primary user-visible channel.
    //   - hookSpecificOutput.additionalContext: fallback. Even if
    //     systemMessage doesn't render visibly in the current Claude Code
    //     client, Claude reads this context and the explicit instruction
    //     surfaces the notice in its first response.
    const output = {
      systemMessage: parsed.message,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[plan-tango update notice — surface to user] ${parsed.message} If you respond to the user, briefly acknowledge this update is available.`
      }
    };
    process.stdout.write(JSON.stringify(output) + "\n");
  }
} catch {
  // Defensive: any unexpected error path → silent. The session must start
  // even if this hook blows up.
}
process.exit(0);