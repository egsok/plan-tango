---
name: settings
description: "Interactive wizard to create or edit ~/.claude/plan-tango/config.json — persistent defaults for /plan-tango:tango. Reads existing values if present, walks the user through each setting via AskUserQuestion, validates via load-config.mjs, writes atomically. Use when user wants to set or update plan-tango defaults without hand-editing JSON. Invoked as /plan-tango:settings."
allowed-tools:
  - Read
  - Write
  - Bash
  - AskUserQuestion
---

<objective>
Edit `~/.claude/plan-tango/config.json` interactively. Cover all configurable keys (model, effort, max_iter, thread_mode, final_check, lenient, service_tier, codex_profile, extra_codex_config, quiet, severity_aware, verbose_report, update_check). Validate the merged result before writing.
</objective>

<process>

# Step 1 — Read current state (resilient to broken existing config)

Run via Bash (paths quoted for spaces):
```
node "${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/load-config.mjs" --merge --cli '{}'
```

**Three outcomes**, each handled explicitly:

1. **Exit 0 + `{merged, sources}`** — happy path. Parse stdout. `sources[k] === "user_config"` means existing `config.json` set this key; `"default"` means built-in fallback. Use `merged` as "current state" for question descriptions.

2. **Exit 2 with a recoverable user-config error** — existing `~/.claude/plan-tango/config.json` is malformed but the wizard exists precisely to fix it. Recovery conditions (verified against the loader):

   | Recovery condition | Loader error code | Source field check |
   |---|---|---|
   | Always recover | `config_invalid_json` | n/a |
   | Always recover | `config_invalid_shape` | n/a |
   | Always recover | `config_unknown_key` | n/a (loader emits this only for user_config) |
   | Recover only if from user-config | `invalid_value` | require `source === "user_config"` in error payload |
   | Recover only if from user-config | `invalid_type` | require `source === "user_config"` in error payload |

   The `source` check on `invalid_value`/`invalid_type` is required because those same codes are also emitted for bad CLI input (which would be a wizard bug, not a recoverable user-config problem).

   Recovery flow:
   - Print warning: `"⚠ Existing ~/.claude/plan-tango/config.json is invalid: <error.detail> (field=<error.field>). Wizard will use built-in defaults as current state and write a fresh replacement (the broken file is preserved on disk until Step 6 atomic rename overwrites it)."`
   - Set `merged` to built-in defaults: `{model:null, effort:"high", max_iter:6, thread_mode:"continue", final_check:"never", lenient:false, service_tier:null, codex_profile:null, extra_codex_config:[], quiet:false, severity_aware:true, verbose_report:false, update_check:true}`. Set all `sources[k] = "default"`.
   - **`extra_codex_config` recovery**: attempt to read & parse the broken `config.json` as raw JSON via Read tool + `JSON.parse`. If it parses to an array of `"key=value"` strings → preserve. If parse fails OR field is absent OR items don't match `key=value` shape → use `[]` and warn separately: `"⚠ Could not preserve extra_codex_config from broken config — falling back to []. If you had custom -c keys, re-add them after the wizard finishes."`
   - Continue to Step 2. Step 6's atomic rename overwrites the broken file with the validated candidate.

3. **Exit 2 with any other error** — abort wizard with the loader's `{error, detail}`. This bucket includes `config_read_failed`, `cli_*` codes (wizard bug), `missing_mode`/`missing_cli` (wizard bug), anything else not enumerated above. Don't attempt recovery.

**File-existence flag** (independent of loader behavior):
```
test -f ~/.claude/plan-tango/config.json && echo "exists" || echo "fresh"
```
Save flag `config_exists` for Step 4 (diff-or-create branch).

# Step 2 — Walk through settings via AskUserQuestion

**Question batches** (AskUserQuestion limit: max 4 per call, max 4 options per question). 2 batches total — 7 settings asked interactively, the rest preserved from existing config or defaults (see "Preserved as-is" section below):

**Batch 1 (4 questions):**
1. `effort` — current value as first option (Recommended). Curated options (4 + AskUserQuestion's built-in **Other**): `high`, `medium`, `low`, `xhigh`. **Other** path covers schema-valid `none`/`minimal` (free-text input; validated via `load-config.mjs` step 6 — invalid → re-ask).
2. `max_iter` — options (4 + Other): `6`, `8`, `10`, `12`. **Other** for any integer 1..12.
3. `service_tier` — options: `Standard (default)` (description: `Normal Codex queue. No extra cost.`), `Fast (priority tier, ~1.5× speed)` (description: `Codex priority processing. Costs more. Same as --fast flag. Requires features.fast_mode=true in ~/.codex/config.toml (default in current Codex CLI).`), `Flex` (description: `OpenAI flex tier (queued, may be slower).`).
4. `thread_mode` — options: `continue`, `fresh`.

**Batch 2 (3 questions):**
5. `final_check` — options: `never`, `always`. (Deprecated `auto` and `force` are accepted by the loader but auto-migrated with a warning — wizard never writes them.)
6. `quiet` — options: `false (verbose)`, `true (Phase E only)`.
7. `severity_aware` — options (binary, labels ≤25 chars): label `true`, description `Stop on polish-only BLOCK (minor/nit-only — no extra round). Default; usually what you want.`. Label `false`, description `Legacy: always run a corrective iter on any BLOCK, even minor-only.`.

**Preserved as-is — no wizard question.** These advanced/set-and-forget settings are taken from `merged` (existing user config or built-in defaults) without an interactive prompt. They were previously asked in the wizard, but most users left defaults, and the cognitive load right before the confirm step wasn't worth it.

- `model` — preserved (default `null`, meaning Codex picks from `~/.codex/config.toml`). To pin a model, hand-edit `~/.claude/plan-tango/config.json` or pass `--model <m>` per run.
- `codex_profile` — preserved (default `null`). To use a named profile from `~/.codex/config.toml`, hand-edit config or pass `--codex-profile <name>` per run.
- `verbose_report` — preserved (default `false`). To get the full §3+§5 Phase E report, hand-edit config or pass `--verbose-report` per run.
- `lenient` — preserved (default `false`). Only changes behavior when `severity_aware: false` (advanced/legacy mode). With the default `severity_aware: true`, the loop already stops on polish-only BLOCK; `lenient` then merely toggles the final status label (`converged-with-polish` ↔ `converged-lenient`) without changing termination. To toggle, hand-edit `~/.claude/plan-tango/config.json` or use `--lenient` per run.
- `extra_codex_config` — preserved (default `[]`). Hand-edit to add `-c key=value` overrides plan-tango doesn't surface natively.
- `update_check` — preserved (default `true`). Config-only opt-out for end-of-Phase-E version check, the SessionStart hook update notice (`hooks/check-update.mjs`), AND the `/plan-tango:update` skill's first read all consult this field. Running `/plan-tango:update` manually is an explicit user intent — the skill honours it even when `update_check: false` (the opt-out only silences the automatic notices). If the user has opted out via hand-edit, the wizard MUST NOT silently re-enable it — see Step 3 `newConfig` template.

**After Batch 2, print** (one block, before Step 4 diff):
```
Advanced settings (model, codex_profile, verbose_report, lenient, extra_codex_config) preserved as-is.
To edit them, hand-edit ~/.claude/plan-tango/config.json after this wizard finishes,
or use --model / --codex-profile / --verbose-report / --lenient CLI flags per run.
```

**Per-question UX:**
- **Recommended option = current value**.
  - If current value is in curated list → reorder so it's first, mark `(Recommended)`.
  - If current value is schema-valid but NOT in curated list (e.g. current `effort=none`) → inject as first option (label: literal value or `<value> (current)`), drop the **last** curated option to stay within the 4-option AskUserQuestion limit, mark `(Recommended)`.
  - If current value would NOT pass schema validation (defensive) → fall back to built-in default as recommended.
  - For binary/full-coverage questions just reorder (no injection needed).
- Description содержит current value и краткое описание trade-off.
- Option labels короткие (≤25 chars).

# Step 3 — Build new config object

**Label → value mapping** (applied per question BEFORE assembling `newConfig`):
- Sentinel labels prefixed with `null (...)` → JS `null`.
- For `service_tier` specifically: label `Standard (default)` → JS `null`; label `Fast (priority tier, ~1.5× speed)` → `"fast"`; label `Flex` → `"flex"`. (Defensive: these labels don't share a prefix with the `null (...)` rule, so the mapping is spelled out.)
- Numeric labels (`6`, `8`, ...) → integer (`parseInt`).
- Boolean labels like `false (strict)` → `false`; `true (...)` → `true`.
- Plain text labels (`high`, `gpt-5`, `continue`) → string verbatim (without parenthesised description).
- Free-text from AskUserQuestion's **Other** field → used verbatim as the scalar value.
- For `max_iter`: parse Other as integer; reject non-integer or out-of-range `1..12` → re-ask.
- For `effort`: validate Other against schema enum (`none|minimal|low|medium|high|xhigh`); reject otherwise → re-ask.

After mapping every answer to its scalar value:
```js
const newConfig = {
  effort: <answer>,                  // string in schema enum
  max_iter: <answer>,                // integer 1..12
  thread_mode: <answer>,             // "continue" | "fresh"
  final_check: <answer>,             // "never" | "always" (wizard never writes deprecated "auto" / "force")
  service_tier: <answer>,            // null | "fast" | "flex"
  lenient: <preserved>,              // from current merged.lenient (default false) — advanced, no wizard question (only meaningful when severity_aware=false; with default severity_aware=true it only toggles the status label)
  quiet: <answer>,                   // boolean
  severity_aware: <answer>,          // boolean — config-only knob, no CLI flag (see plan-tango README)
  model: <preserved>,                // from current merged.model (default null) — advanced, no wizard question
  codex_profile: <preserved>,        // from current merged.codex_profile (default null) — advanced, no wizard question
  verbose_report: <preserved>,       // from current merged.verbose_report (default false) — advanced, no wizard question; --verbose-report CLI flag overrides per run
  extra_codex_config: <preserved>,   // from current merged.extra_codex_config (default [])
  update_check: <preserved>          // from current merged.update_check (default true) — config-only opt-out for end-of-Phase-E version check AND SessionStart update-notice hook. /plan-tango:update is an explicit user intent and runs regardless of this field. MUST be preserved across wizard runs or hand-edited "false" would be silently lost
};
```

**Hard invariant**: sentinel option labels (e.g. `Standard (default)`, parenthesised description fragments) MUST NOT appear as values in `newConfig`. The label is for human display; mapping rules above translate to actual config values. A run that would emit `service_tier: "Standard (default)"` is a wizard bug — abort before invoking write-config.

# Step 4 — Show diff (if config_exists)

If `config_exists === true`: print a side-by-side diff of changed keys only:
```
Changes to ~/.claude/plan-tango/config.json:
  effort:       high   →  medium
  max_iter:     6      →  8
  thread_mode:  (no change)
  ...
```
If `config_exists === false`: print "Will create new config:" + JSON pretty-printed.

# Step 5 — Confirm via AskUserQuestion (single yes/no)

"Write this config to ~/.claude/plan-tango/config.json?"
Options: "Yes, write" / "No, abort".

On abort → STOP without writing.

# Step 6 — Write atomically (file-based transport)

**Why this design**: embedding `JSON.stringify(newConfig)` in a `--json '<...>'` shell argument is fragile (single quotes inside string values, shell metacharacters, Windows escaping inconsistencies) and a vector for command injection. Instead the skill writes the candidate JSON to a temp file via Write tool, then passes the **path** to the wrapper.

Flow:

1. **Skill — drop temp file** via Write tool:
   - Path: `~/.claude/plan-tango/config.json.tmp.wizard-<random-suffix>` (use `Date.now()` or similar; `.wizard-*` suffix distinguishes from `config.json.tmp.<pid>` reserved by wrapper).
   - Content: `JSON.stringify(newConfig, null, 2) + "\n"` — already sanitized at Step 3 (no `_*` keys).
   - `mkdir -p ~/.claude/plan-tango` happens automatically when Write creates an absent parent.

2. **Skill — invoke wrapper** via Bash (paths double-quoted because plugin paths can contain spaces, e.g. `C:\Users\Alice Smith\...`):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/settings/scripts/write-config.mjs" --file "<abs-path-to-tmp-file>"
   ```

3. **`write-config.mjs --file <path>`** does:
   1. Verify the temp file exists; abort with `temp_missing` otherwise.
   2. Read the file; parse JSON; abort with `invalid_json` on parse error (and `unlink` the temp).
   3. **Sanitize defensively** — strip any keys starting with `_` (belt-and-suspenders).
   4. **Re-write** the sanitized JSON back to the same temp path so step 5 validates the EXACT bytes that will become the live config.
   5. **Validate** by spawning `node load-config.mjs --merge --config <temp-path> --cli '{}'`. Using `--config <temp>` (not `--cli '<json>'`) is critical — it validates the temp file *as if it were the live user config*, independent of any pre-existing `~/.claude/plan-tango/config.json`. On non-zero exit → `unlink(temp)`, re-emit `{error, detail, field?}`, exit 2.
   6. **Backup existing live config** to `~/.claude/plan-tango/config.json.bak` BEFORE the rename — symmetric with snapshot.mjs `.iter*.bak` semantics. If no live config exists yet (fresh create), skip. If backup itself fails → `unlink(temp)` + abort with `backup_failed`; live config left intact for retry.
   7. `fs.renameSync(<temp-path>, ~/.claude/plan-tango/config.json)` — atomic on the same filesystem.
   8. Print `{ok:true, path:"<final>", backup_path:"<bak-or-null>"}` and exit 0.

**Why `--config <temp>` and not `--cli`**: live `load-config.mjs` validates the on-disk user config FIRST (strict reject on bad value), then merges CLI overrides. Validating with `--cli '<newConfig>'` would (a) re-validate the existing config first — so a broken file blocks the wizard from writing a fixed replacement, and (b) validate "old config + CLI override" instead of the exact JSON about to land on disk.

**On any failure** — temp file is `unlink`ed by the wrapper; live config is never partially overwritten.

# Step 7 — Confirm + next steps

Print (substitute `<backup-line>` per wrapper response — present only if `backup_path` is non-null):

```
✓ Wrote ~/.claude/plan-tango/config.json
<backup-line>
Verify: node "$(claude plugin path plan-tango)/skills/tango/scripts/load-config.mjs" --merge --cli '{}'
Run plan-tango: /plan-tango:tango
```

`<backup-line>` template (omit entirely if wrapper returned `backup_path: null`):
```
  Previous config saved to ~/.claude/plan-tango/config.json.bak (recover with: cp config.json.bak config.json)
```

</process>

<critical_invariants>
- All values pass through `load-config.mjs` validation BEFORE write — no bypass.
- Atomic write only (temp + rename); never partial-write the live config.
- `extra_codex_config` is preserved across runs of this wizard — never silently zeroed.
- **Filesystem footprint** — wizard writes ONLY to:
  1. `~/.claude/plan-tango/config.json` (the final live config),
  2. `~/.claude/plan-tango/config.json.bak` (backup of prior version, overwritten each successful run; absent on fresh-create runs),
  3. `~/.claude/plan-tango/config.json.tmp.wizard-*` (transient candidate; `unlink`ed on any failure path; renamed to (1) on success).

  Wizard does NOT touch `~/.claude/plans/` or any plan files, NOR any other path under `~/.claude/`.
</critical_invariants>
