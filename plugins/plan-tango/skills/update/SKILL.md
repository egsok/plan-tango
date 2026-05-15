---
name: update
description: "Self-update plan-tango by pulling the latest release tag into the marketplace clone. Checks GitHub for newer version, prompts confirmation, runs git fetch + git reset --hard <tag>, prints a reload reminder. Replaces the manual /plugin → Marketplaces → plan-tango → Update navigation. Invoked as /plan-tango:update. Use when an update notice mentions a newer version, or proactively to verify you're on latest."
argument-hint: "[--check] [--force]"
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

<objective>
Self-update plan-tango from the GitHub release channel. Resolves the marketplace clone directory, version-checks against the latest release tag, confirms with the user, runs `git fetch + git reset --hard v<latest>` in the clone, and prints a reload reminder. Mirrors the `/plugin → Marketplaces → plan-tango → Update` UI as a single command.
</objective>

<execution_context>
- **Update checker**: `${CLAUDE_PLUGIN_ROOT}/skills/run/scripts/update-check.mjs` — handles the 7-day on-disk cache (`~/.claude/plan-tango/.update-cache.json`), `git ls-remote --tags` query, semver comparison, silent-on-network-failure behaviour. Reused as-is; this skill only adds the `git pull` step on top.
- **Plugin version source**: `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` — read `.version` to pass as `--current-version`.
- **Marketplace clone**: the parent-parent of `${CLAUDE_PLUGIN_ROOT}`. The marketplace.json `source` field is `./plugins/plan-tango`, so the plugin lives at `<MARKETPLACE_ROOT>/plugins/plan-tango/`. Two `cd ..` from `CLAUDE_PLUGIN_ROOT` reaches the git repo root.
- **User opt-out**: `update_check: false` in `~/.claude/plan-tango/config.json` blocks the SessionStart hook and Phase E notice but does NOT block this skill — running `/plan-tango:update` is an explicit user intent, so we always honour it.
</execution_context>

<process>

# Step 1 — Resolve marketplace root + sanity check

```bash
MARKETPLACE_DIR="$(cd "${CLAUDE_PLUGIN_ROOT}/../.." && pwd)"
test -d "$MARKETPLACE_DIR/.git" && echo "$MARKETPLACE_DIR" || echo "NOT_GIT"
```

If output is `NOT_GIT` → ABORT with:

```
Cannot self-update: <MARKETPLACE_DIR> is not a git repository. plan-tango
was likely installed via direct git clone or symlink, not through Claude
Code's marketplace. Pull/build the new version manually from
https://github.com/egsok/plan-tango.
```

# Step 2 — Parse flags from $ARGUMENTS

- `--check` — print version status and STOP (no git pull, no AskUserQuestion).
- `--force` — skip the clean-working-tree safety check in Step 4. Equivalent to "I know I have local mods, discard them".
- No flag — run the full check + confirm + pull flow.

# Step 3 — Version check

Read current version:

```bash
CURRENT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CLAUDE_PLUGIN_ROOT + '/.claude-plugin/plugin.json','utf8')).version)")
```

Run update-check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/run/scripts/update-check.mjs" --current-version "$CURRENT"
```

Parse the JSON response from stdout. Branch on `status`:

- `"ok"` → print `✓ Already up to date (v<CURRENT>).` → STOP (exit cleanly).
- `"newer-available"` → bind `LATEST = parsed.latest`. Print `plan-tango v<LATEST> is available (you're on v<CURRENT>).` Continue.
- `"skipped"` → print `Network check failed (no cache; git unavailable or timeout). Try again later, or update manually via /plugin → Marketplaces → plan-tango → Update.` → STOP.
- `"error"` → print `Update check error: <parsed.message>` → STOP.

**If `--check` flag was passed**: STOP here regardless of status. No git operations.

# Step 4 — Safety check: clean working tree

```bash
cd "$MARKETPLACE_DIR" && git status --porcelain
```

If stdout is non-empty:

- **Without `--force`**: ABORT with:
  ```
  Marketplace clone has local modifications at <MARKETPLACE_DIR>:
  <list first 10 modified files from git status --porcelain>

  Resolve them manually before updating, or pass --force to discard
  them.
  ```
- **With `--force`**: print one-line warning `⚠ Discarding local modifications: <count> file(s).` and continue.

# Step 5 — Confirm with user

Use AskUserQuestion (single question, two options):

- Question: `Update plan-tango from v<CURRENT> to v<LATEST>?`
- Header: `Update?`
- Options:
  - Label `Yes, update now`, description `Pull v<LATEST> from GitHub and overwrite the local plugin install.`
  - Label `Cancel`, description `Leave the current version in place.`

If user picks `Cancel` → print `Update cancelled.` → STOP.

# Step 6 — Pull the tag

```bash
cd "$MARKETPLACE_DIR" && git fetch origin --tags && git reset --hard "v$LATEST"
```

If `git fetch` fails (network) → ABORT with `Fetch failed; aborting. Try again or update manually via /plugin UI.` Tree is untouched.

If `git reset --hard "v$LATEST"` fails (tag doesn't exist — race with a tag deletion) → ABORT with `Tag v<LATEST> not found on remote. Aborting. The update-check cache may be stale; try /plan-tango:update again in a few minutes.`

On success — capture the new commit:

```bash
NEW_COMMIT=$(git rev-parse --short HEAD)
```

# Step 7 — Reload reminder

Print exactly:

```
✓ plan-tango updated to v<LATEST> (commit <NEW_COMMIT>).

To activate the new version in your current Claude Code session:
- Terminal:  /reload-plugins
- VS Code:   Developer: Reload Window  (or restart Claude Code)

After reload, run /plan-tango:run normally — the new skill code, scripts,
and agents will be picked up.
```

</process>

<critical_invariants>
- **Never edit anything outside `$MARKETPLACE_DIR`.** This skill only touches the marketplace clone; user's `~/.claude/plan-tango/config.json`, plans under `~/.claude/plans/`, and any other path stay untouched.
- **Confirmation gate is mandatory** for the non-`--check` flow. No auto-pull without user picking `Yes, update now`.
- **Tag-pinned reset, never `origin/main`.** Lands users on a stable release; never on whatever's currently on the development branch.
- **Network failures are non-fatal at every step** — the only way the live install changes is the explicit `git reset --hard` in Step 6.
</critical_invariants>
