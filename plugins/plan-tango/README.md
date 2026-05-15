# plan-tango

> Read in Russian: [README.ru.md](README.ru.md)

Auto-converge a Claude Code plan against Codex (gpt-5) review. Instead of manually copy-pasting between terminals, one command runs the loop: Codex reviews → Claude applies fixes → Codex re-reviews → repeat until clean `ALLOW` or one of the stop criteria triggers.

## When to use

You've just drafted a plan in plan mode (Claude Code saved it under `~/.claude/plans/{slug}.md`) and want to harden it with an external AI review before implementation. The skill:

- reads the active plan file,
- runs up to 6 (default; hard cap 12) Codex review iterations,
- applies each round of fixes back into the plan via `Edit` (only the plan file, never any other file),
- optionally finishes with an Opus subagent sanity-check on plans that touch runtime contracts (subagents / permissions / hooks / MCP).

Works **inside plan mode** — no need to exit and re-enter.

## Basic usage

Invoked as **`/plan-tango:run`** (or pick from the slash-command dropdown when you type `/plan-tango`).

Without arguments: uses the active plan from the system prompt, otherwise the newest by mtime under `~/.claude/plans/`.

With an explicit plan:
```
/plan-tango:run <slug-or-path>
/plan-tango:run sample-plan
/plan-tango:run ~/.claude/plans/foo.md
```

Persistent defaults wizard: **`/plan-tango:settings`**.

## All options

| Flag | Default | What it does |
|---|---|---|
| `--max-iter N` | 6 (cap 12) | Iteration budget. On reaching the cap → interactive prompt: continue +4 / continue custom / stop / abort. Hard cap 12 is never bypassed, even through continue. |
| `--effort none\|minimal\|low\|medium\|high\|xhigh` | `high` | Reasoning effort for Codex. ⚠️ `minimal` is rejected by the Codex API when `image_gen` / `web_search` tools are enabled (the default setup) — use `low` for fast runs. |
| `--model <m>` | unset | Specific Codex model. By default `--model` is NOT passed — Codex picks its own default from `~/.codex/config.toml`. Pass explicitly (e.g. `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) if you need a specific one. |
| `--lenient` | off | Stop when no critical/major remain (instead of strict ALLOW). |
| `--final-check` | off | Opt in to Opus sanity-check on converged statuses. Sets `final_check="always"` for this run. |
| `--no-final-check` | off | Deprecated alias — disables Opus final-check for this run (emits a warning; will be removed in v0.3). |
| `--force-final-check` | off | Deprecated alias for `--final-check` (emits a warning; will be removed in v0.3). |
| `--resume` | off | Resume from saved state (requires an explicit slug/path or an active plan from the system prompt). |
| `--takeover` | off | Adopt a corrupt lock after `lock.mjs inspect` (flag is REQUIRED for corrupt locks). Stale locks (>30 min) are auto-removed without this flag (warning to stderr). Fresh locks (≤30 min) are always refused — `--takeover` does NOT override them. Use only for corrupt locks after confirming no parallel run is in progress. |
| `--continue-thread` / `--fresh-each` | `continue` (built-in default) | Thread mode override (mutually exclusive). `continue` (default) — all iterations share one Codex thread (`codex resume`), cheaper / faster / cleaner in the Codex panel; iter ≥ 2 receive a reset-prompt block so Codex doesn't anchor on its prior output. `fresh` — each iteration is a new thread (fully independent audit). See the "Thread mode" section below. |
| `--fast` | off | Shortcut for `--service-tier fast`. Enables Codex priority processing tier (~1.5× speed, higher cost). Requires `features.fast_mode = true` in `~/.codex/config.toml` (default in current Codex CLI). |
| `--service-tier <fast\|flex>` | unset | Explicit service-tier selection (passed as `-c service_tier="<value>"`). |
| `--codex-profile <name>` | unset | Profile from `~/.codex/config.toml` (`-p <name>`). Loaded BEFORE `-c` overrides; canonical settings (effort, service_tier, model) win on conflict. |
| `--quiet` | off | Suppresses per-iteration prints in Phase C (snapshot / sending-to-Codex / verdict-line / apply summary). The final Phase E report always prints. `ERROR` / `MALFORMED` verdict lines always print. Bash IN/OUT panels are rendered by Claude Code itself and not controlled by this flag. |
| `--verbose-report` | off | Opt in to Phase E §3 (per-iteration convergence table) + §5 (narrative). Default off; §1+§2+§4 (and §6 when applicable) always render. |

## Persistent defaults — `~/.claude/plan-tango/config.json`

If you don't want to type `--effort medium --max-iter 8` every run, drop defaults into a file:

```bash
mkdir ~/.claude/plan-tango
cp "$(claude plugin path plan-tango)/skills/run/user-config.example.json" ~/.claude/plan-tango/config.json
# If `claude plugin path` is unavailable, the typical path is:
# ~/.claude/plugins/marketplaces/plan-tango/plugins/plan-tango/skills/run/user-config.example.json
# then edit
```

Or run the interactive wizard: `/plan-tango:settings`.

Fields (all optional — anything absent → built-in default):

```json
{
  "model": null,
  "effort": "high",
  "max_iter": 6,
  "thread_mode": "continue",
  "final_check": "never",
  "lenient": false,
  "service_tier": null,
  "codex_profile": null,
  "extra_codex_config": [],
  "quiet": false,
  "severity_aware": true,
  "verbose_report": false,
  "update_check": true
}
```

> `severity_aware` and `update_check` are **config-only** — no CLI flags (by design — see "Severity-aware convergence" below for the rationale on severity_aware). To toggle them, edit `config.json` or run `/plan-tango:settings`.

**Precedence (highest wins):**
```
CLI flag > ~/.claude/plan-tango/config.json > built-in default
```

Load-time validation: `effort` enum, `max_iter ≤ 12`, `thread_mode ∈ {fresh, continue}`, `service_tier ∈ {null, fast, flex}`, `final_check ∈ {never, always}` (legacy `auto` / `force` are accepted and auto-migrated with a warning). On any violation — abort with a clear error BEFORE the run starts.

`extra_codex_config: ["key=val", ...]` — array of raw `-c key=value` strings to pass through to Codex (for flags plan-tango doesn't surface natively). Applied AFTER profile but BEFORE canonical (effort / service_tier / model win on conflict).

> When running `/plan-tango:settings`, the wizard preserves the existing `extra_codex_config` and `update_check` values without prompting (no UI for editing the raw `-c` array via `AskUserQuestion`; `update_check` is set-and-forget). To add/remove `-c key=value` strings or flip `update_check`, edit `~/.claude/plan-tango/config.json` directly.

## Thread mode

Built-in default is `continue`. Switch via flag or config.

| Mode | Behavior | Pros | Cons |
|---|---|---|---|
| `continue` (default) | Iter 1 opens a thread; iter ≥ 2 calls `codex exec resume <id>` + injects a reset-prompt block at the start of the prompt | Cheaper (prompt-cache hits on repeated blocks), faster, single thread per run in the Codex panel. Reset-prompt reduces anchor bias | Bias is not fully removed — Codex still sees its prior history |
| `fresh` | Each iteration is a new Codex thread (`codex exec` without resume) | Fully independent reviews, no anchor bias | More expensive (no prompt-cache hit), slower, clutters the session list in the Codex panel |

Switch: `--continue-thread` or `--fresh-each` (mutually exclusive). Persistent: `thread_mode` field in `config.json`.

**Lost-session fallback** — in continue mode, if Codex can't find the saved thread (deleted via TUI, evicted from `~/.codex/sessions/`), the wrapper auto-respawns once in fresh mode, updates `thread_id`, and continues. Log line: `Thread <id> lost, falling back to fresh.`

**⚠️ Migration note** (for existing users with a hand-edited `config.json`): if you copied `user-config.example.json` to `~/.claude/plan-tango/config.json` before the v0.2 update, your file likely pins `"thread_mode": "fresh"` (the old default). User-config wins over built-in default. To pick up the new default `continue` — either remove the `thread_mode` line entirely or explicitly set `"continue"`.

## Severity-aware convergence (`severity_aware`)

Enabled by default. Changes the loop's reaction to BLOCK verdicts based on severity:

- **clean** — `ALLOW` + zero findings → `converged` (unchanged).
- **polish-only** — `BLOCK` with only minor/nit (zero critical/major) → **terminal**, no corrective iter. Status: `converged-with-polish` (or `converged-lenient` if you also pass `--lenient`). Polish findings render as an advisory list in §6 of the final report.
- **blocking** — `BLOCK` with ≥1 critical/major → corrective iter (unchanged).

**Why**: on long runs the loop drifts from "reducing risk" into "manufacturing confidence" — polish findings (JSON-comment style, invariant wording) get cycled through corrective iters with the same weight as architectural bugs, and the edits themselves introduce new minor inconsistencies. Severity-aware terminates on polish-only and leaves the advisory list in §6 — you decide whether to apply manually.

**Exact behavior in combinations with `--lenient`**:

| Config | `--lenient` | On polish-only BLOCK |
|---|---|---|
| `severity_aware: true` (default) | off | terminal, status=`converged-with-polish`, advisory in §6 |
| `severity_aware: true` (default) | on | terminal, status=`converged-lenient`, advisory in §6 (preserves `--lenient` downstream-metric semantic) |
| `severity_aware: false` (opt-out) | off | corrective iter (legacy behavior — cycles polish-fixes) |
| `severity_aware: false` (opt-out) | on | terminal, status=`converged-lenient`, advisory **NOT** rendered (legacy `--lenient` path) |

**`--lenient` does NOT skip Opus final-check** — `converged-lenient` is still eligible for the Phase D pre-gate. If you want to skip Opus, use `--no-final-check` (or `final_check: "never"` in config).

**Opt-out**: config-only. Set `"severity_aware": false` in `~/.claude/plan-tango/config.json` or run `/plan-tango:settings`. There is no CLI flag on purpose (`--lenient` already occupies the explicit per-run polish-stop niche; two flags with overlapping semantics would confuse users).

## Quiet mode (`--quiet`)

By default the skill prints 1–2 lines per iteration (snapshot, sending-to-Codex, verdict counts, applied-N-fixes). For long runs (8–12 iters) that's noisy.

`--quiet` (or `quiet: true` in `config.json`) leaves only:

- Phase A heads-up (contract before the run) + deprecation warnings (if any)
- Phase A lock-acquired confirmation (when `lock_took_over_stale = true`)
- **`ERROR` / `MALFORMED` verdict lines** — diagnostics for critical state changes (always printed, even in quiet)
- `AskUserQuestion` (continue-prompt, manual-required)
- `ABORT` / error messages
- **Phase E §1+§2+§4 (and §3+§5 when `--verbose-report`) — full report** (always)

**What this flag does NOT control**: Bash IN/OUT panels are rendered by Claude Code itself (including when calls are allowlisted). To hide those panels too, configure the allowlist via `/fewer-permission-prompts`.

CLI: `/plan-tango:run <slug> --quiet`. Persistent: add `"quiet": true` to `~/.claude/plan-tango/config.json` (or run `/plan-tango:settings`).

## Fast mode (priority service tier)

Codex supports a priority processing tier — ~1.5× speed at a higher per-token cost. Enable via `--fast` or `--service-tier fast`:

```
/plan-tango:run <slug> --fast
```

Under the hood: `-c service_tier="fast"` in the `codex exec` argv. This maps to `service_tier: "priority"` for the OpenAI Responses API.

**Requirements:**
- `features.fast_mode = true` in `~/.codex/config.toml` (default in current Codex CLI). Verify:
  ```powershell
  codex features list | Select-String fast_mode    # Windows
  codex features list | grep fast_mode             # POSIX
  ```
- If `fast_mode` is disabled (`--disable fast_mode` or manual in config), `service_tier=fast` is silently ignored by Codex.

**Billing**: priority tier is charged at a higher rate. If this matters, see [Codex speed docs](https://developers.openai.com/codex/speed) and [OpenAI priority processing](https://developers.openai.com/api/docs/guides/priority-processing).

**Alternative** — permanently via a profile in `~/.codex/config.toml`:
```toml
[profiles.review-fast]
service_tier = "fast"
model_reasoning_effort = "high"
```
Then: `/plan-tango:run <slug> --codex-profile review-fast`.

## How the loop runs

```
Phase A. Init (init.mjs — single Bash call)
   resolve plan-path → validate (size, location) → codex --version →
   resolve repo-root → load merged settings → acquire lock (session_id) →
   write/load state.json → ensure workspace dir → heads-up
   (lock acquired BEFORE any state/workspace write; init handles internal
    cleanup if a step after lock-acquire fails)

Phase C. Loop (up to max-iter times)
   integrity check (sha256) → snapshot → prepare-iter.mjs (prompt+params+stub) →
   call run-codex-review.mjs → handle ERROR/MALFORMED → classify findings →
   check stop conditions → apply fixes via Edit → update last_known_hash → refresh lock

Phase D. Final (when status=converged* AND --final-check)
   pre-gate → Opus final-check → on critical/major: corrective iter →
   ONE Codex re-review

Phase E. Summary
   print stats → run update-check (silent unless newer release) →
   release lock (if acquired) → optional workspace cleanup
```

## Possible terminal statuses

| Status | What happened | What to do |
|---|---|---|
| `converged` | Codex returned a clean ALLOW | Plan is ready |
| `converged-with-polish` | `severity_aware: true` (default), Codex returned BLOCK with only minor/nit | Polish findings in §6 of the report; apply manually if needed (no auto-iter by design — see "Severity-aware convergence") |
| `converged-lenient` | `--lenient` set, only minor/nit remained (or severity_aware+lenient path) | Read the remaining nits in the ledger / §6 and decide manually |
| `converged-final` | After Opus final-check with no critical/major remarks | Plan passed double review |
| `manual-required` | Codex offered a fork (option A/B) or a critical/major fix can't be auto-applied | Decide manually, edit the plan, optionally `--resume` |
| `manual-required-after-final` | Opus found an issue whose fix requires manual decision | See ledger, finish manually |
| `final-check-divergence` | Opus and Codex disagreed on the final pass | Read both finding sets, decide manually |
| `stuck` | Two consecutive iterations returned identical findings | Codex doesn't understand the plan; rewrite the problematic sections manually |
| `oscillating` | Codex flaps between two assessments (X in N-2, Y in N-1, X in N) | Conflicting requirements; resolve manually |
| `regressed` | Critical-finding count grew after applying fixes | Roll back via snapshot |
| `max-iter-reached` | Iteration cap hit; "Stop here" picked at continue-prompt | Read findings, finish manually or re-run with a larger `--max-iter` (cap 12) |
| `aborted-by-user` | "Abort run" picked at continue-prompt | Lock released, ledger closed. State preserved — `--resume` if you change your mind |
| `off-plan-target` | Codex/Opus asked to edit a file outside the plan | Skill forbids it; apply the change to code manually |
| `external-modification` | Plan was edited outside the skill during the cycle | Decide — continue with the new state or roll back |
| `final-check-malformed` | Opus returned non-ALLOW/BLOCK even after retry | Run final-check manually with the same plan |
| `final-recheck-error` / `final-recheck-malformed` | Codex re-review after final-fix failed | Check `stderr_tail`, retry later |

## On-disk artifacts

All files live next to the plan under `~/.claude/plans/`:

```
foo.md                              # the plan itself (edited by the skill)
foo.iter1-2026-...bak               # snapshot before iter 1 apply
foo.iter2-...bak                    # before iter 2
...
foo-tango.state.json                # iter, hashes, settings, repo info
foo-tango.ledger.json               # all findings + actions per iteration
foo-tango.lock                      # active lease (removed in Phase E)
foo-tango.workspace/                # temp prompts/params (cleaned up on success)
  ├── iter1.prompt.md
  ├── iter1.params.json
  └── ...
```

**Ledger schema** — what each entry means:

| `iteration_kind` | When |
|---|---|
| `normal` | Regular Phase C iteration |
| `final-fix` | Corrective iteration after Opus critical/major (Phase D 28b) |
| `final-check-advisory` | Opus polish-only (Phase D 28a-polish) — advisory list, no apply |
| `final-check-ignored` | Legacy: Opus found only minor/nit — skipped |

| `action` | When |
|---|---|
| `applied` | Edit succeeded, plan modified |
| `deferred` | apply-fixes couldn't apply (conflict / ambiguity OR off-plan minor/nit) |
| `manual` | Codex offered multiple variants |
| `advisory` | Polish-only finding — surfaced in §6, not applied |
| `ignored_minor_nit` | Final-check minor/nit, non-blocking |
| `off_plan_blocked` | Critical/major finding pointed at a file outside the plan — blocked |

## Permissions on first run

The skill calls Bash for the helper scripts. The first run will request permission for:

```
Bash(node *plan-tango/scripts/init.mjs *)              # consolidated Phase A init
Bash(node *plan-tango/scripts/prepare-iter.mjs *)      # iter{N}.{prompt,params,last-message} builder
Bash(node *plan-tango/scripts/run-codex-review.mjs *)  # Codex wrapper (spawns codex exec)
Bash(node *plan-tango/scripts/parse-codex-verdict.mjs *)
Bash(node *plan-tango/scripts/parse-codex-jsonl.mjs *)
Bash(node *plan-tango/scripts/load-config.mjs *)
Bash(node *plan-tango/scripts/plan-paths.mjs *)
Bash(node *plan-tango/scripts/snapshot.mjs *)
Bash(node *plan-tango/scripts/workspace.mjs *)
Bash(node *plan-tango/scripts/lock.mjs *)
Bash(node *plan-tango/scripts/apply-fixes.mjs *)
Bash(node *plan-tango/scripts/update-check.mjs *)      # end-of-Phase-E version check
Bash(node *plan-tango/scripts/doctor.mjs *)            # diagnostics (when invoked manually)
Bash(codex --version)                                  # version check inside init.mjs
Edit(~/.claude/plans/*.md)
Read(~/.claude/plans/**)
Read(~/.claude/plan-tango/config.json)                 # persistent defaults (optional file)
Write(~/.claude/plans/*.iter*.bak)
Write(~/.claude/plans/*-tango.state.json)
Write(~/.claude/plans/*-tango.ledger.json)
Write(~/.claude/plans/*-tango.lock)
Write(~/.claude/plans/*-tango.workspace/**)
```

After the first run, invoke `/fewer-permission-prompts` — it adds an allowlist to `~/.claude/settings.json`, and subsequent runs go through without prompts.

**Diagnostics**: if anything looks off (Codex CLI not found, plans dir not writable, lock stuck), run `node ${CLAUDE_PLUGIN_ROOT}/skills/run/scripts/doctor.mjs` — it checks the Codex CLI, user-config parsing, write access to `~/.claude/plans/`, the lock acquire/release cycle, and `run-codex-review.mjs` error handling. All checks are read-only / dry-run; probe files are removed automatically. Add `--json` for machine-readable output.

### Plan mode + paths under `~/.claude/plans/` (important)

In **plan mode**, Claude Code applies additional restrictions: even with `defaultMode: "acceptEdits"` and `skipAutoPermissionPrompt: true`, any `Edit`/`Write` to a path **outside the current VS Code workspace folder OR outside `permissions.additionalDirectories`** requires an approval prompt. The "Yes, allow all edits this session" option applies only to that specific file — the next `Write` to a different file re-prompts.

The skill writes state / ledger / snapshot / workspace files under `~/.claude/plans/<slug>-tango.*`, which is **usually outside your active workspace** (e.g. when working from `D:\dev\my-project\`, paths under `C:\Users\<you>\.claude\plans\` are foreign). In plan mode this triggers 5–10+ approval prompts per run.

**One-time fix** in `~/.claude/settings.json` → `permissions`:

```json
{
  "permissions": {
    "additionalDirectories": ["~/.claude/plans"],
    "allow": [
      "Edit(~/.claude/plans/**)",
      "Write(~/.claude/plans/**)",
      "Read(~/.claude/plans/**)"
    ],
    "defaultMode": "acceptEdits"
  }
}
```

**Why this is separate from the regular allowlist:**

- `additionalDirectories` extends the `acceptEdits` scope beyond the workspace — **required** for paths under `~/.claude/`, which would otherwise fall under the protected-paths policy.
- `Edit(...)` rules cover the built-in file-editing tools overall — **more important** than `Write(...)`. Specify both for reliability.
- The tilde form (`~/.claude/plans/**`) works cross-platform. The Windows form `Edit(C:\\Users\\Alice\\.claude\\plans\\**)` is a fallback if tilde doesn't resolve.

**A restart of the active Claude Code session is required after the patch** — the VS Code extension caches permissions at session start; `settings.json` changes aren't picked up live. Close the VS Code window (or re-open the workspace) → the new session loads the updated permissions.

**Alternative** (if you don't want to edit global settings): run `/plan-tango:run` **outside** plan mode. Plan mode isn't required for the skill — the plan is already written, the rest is just the review loop. Normal mode with `defaultMode: "acceptEdits"` gives a silent flow without extra setup.

## Interruption and resume

**Ctrl+C / interrupt**: `state.json` stays consistent (updated after every apply phase). The lock remains for 30 minutes — after that it's considered stale and auto-overridden by the next run.

**Resume from where you left off**:
```
/plan-tango:run <slug-or-path> --resume
```

The skill reads state, verifies the plan wasn't modified outside the skill (via `last_known_plan_hash`), and continues from the next iteration.

`--resume` WITHOUT an explicit slug/path is refused — by design (defense against the newest-plan-fallback grabbing a different file that appeared between runs).

## Troubleshooting

**"Lock held by another session"** — either another run is actually in progress, or a previous run crashed and the lock hasn't expired yet.

- Check: `node "${CLAUDE_PLUGIN_ROOT}/skills/run/scripts/lock.mjs" inspect --slug <slug>` (or the absolute path under `~/.claude/plugins/marketplaces/plan-tango/...`).
- If no parallel run is in progress → wait up to 30 minutes (auto-stale) or pass `--takeover` after `inspect`.

**"Plan modified outside skill since last completed iteration"** — someone (or you in the editor) changed the plan between iterations.

- If the changes matter → don't `--resume`; start a fresh run and the skill will pick up the new state.
- If the changes were accidental → roll back via `cp foo.iter{N}.bak foo.md` and `--resume`.

**"Codex CLI not found on PATH"** — Codex CLI isn't installed or isn't visible from the current shell.

- Verify: `codex --version` (should print a version).
- Install: `npm install -g @openai/codex`.
- Auth: `codex login` (or `/codex:setup` from the `openai-codex` plugin if installed).

**`status=stuck` or `oscillating`** — Codex is jammed. Read the ledger, find the problematic section, rewrite it manually, then re-run the skill.

**`status=off-plan-target`** — Codex/Opus asked to edit a file outside the plan.

- Expected: the skill edits ONLY the plan file. If the finding is meaningful → make the code change manually.
- If the finding is wrong — it's logged in the ledger as `off_plan_blocked` with `requested_file_path` and `suggested_fix`.

**Nothing happens after `run-codex-review.mjs` is called** — Codex can think for 30–90 seconds on `effort=high`. That's normal.

## Plugin structure (for developers)

```
~/.claude/plugins/marketplaces/plan-tango/
├── .claude-plugin/
│   └── marketplace.json                      # marketplace manifest
├── LICENSE                                   # MIT
├── README.md / README.ru.md                  # OSS pitch (English / Russian)
├── CHANGELOG.md                              # release notes
└── plugins/plan-tango/
    ├── .claude-plugin/
    │   └── plugin.json                       # plugin manifest
    ├── README.md                             # this file (English)
    ├── README.ru.md                          # Russian translation
    ├── agents/
    │   └── plan-final-checker.md             # opus, raw ALLOW/BLOCK → registered as plan-tango:plan-final-checker (Phase D only)
    └── skills/
        ├── run/                              # main loop skill (/plan-tango:run)
        │   ├── SKILL.md                      # orchestrator instructions
        │   ├── user-config.example.json      # sample persistent defaults
        │   ├── scripts/
        │   │   ├── init.mjs                  # Phase A in one Bash call: validate + codex-cli check + repo + load-config + lock + state init/resume + workspace
        │   │   ├── doctor.mjs                # diagnostics one-liner
        │   │   ├── load-config.mjs           # CLI flags + user-config + defaults → merged settings
        │   │   ├── prepare-iter.mjs          # builds iter{N}.{prompt.md,params.json,last-message.txt} in one Bash call
        │   │   ├── run-codex-review.mjs      # spawn() codex exec --json (resolves underlying codex.js); retries empty output once
        │   │   ├── parse-codex-jsonl.mjs     # JSONL events → session_id + diagnostics
        │   │   ├── parse-codex-verdict.mjs   # ALLOW/BLOCK + findings parser (text/file/json)
        │   │   ├── plan-paths.mjs            # validate / newest / list-recent / resolve-repo / hash
        │   │   ├── snapshot.mjs              # fs.copyFileSync with timestamp+hash
        │   │   ├── workspace.mjs             # ensure / cleanup with realpath+lstat guard
        │   │   ├── lock.mjs                  # lease-lock with session_id
        │   │   ├── apply-fixes.mjs           # pure classifier (auto / deferred / manual)
        │   │   └── update-check.mjs          # end-of-Phase-E version check vs GitHub
        │   └── references/
        │       ├── review-prompt-template.md # XML prompt for Codex (with {{RESET_BLOCK}} for continue mode)
        │       └── verdict-contract.md       # verdict format with examples
        └── settings/                         # /plan-tango:settings wizard
            ├── SKILL.md                      # wizard orchestrator instructions
            └── scripts/
                └── write-config.mjs          # atomic config writer + validator
```

**Persistent state** (outside the plugin dir):

- `~/.claude/plan-tango/config.json` — user defaults (optional; copy from `user-config.example.json`).
- `~/.claude/plan-tango/.update-cache.json` — update-check cache (auto-managed by `update-check.mjs`).
- `~/.claude/plans/<slug>.md` — plans.
- `~/.claude/plans/<slug>-tango.{state,ledger,lock}.json` — runtime artifacts.
- `~/.claude/plans/<slug>-tango.workspace/` — temp prompts/params (cleaned up on success).

## Dependencies

- **Node.js** 18+ (any version with `node:*` imports).
- **Codex CLI** on `PATH`. Install: `npm install -g @openai/codex`. Auth: `codex login`.
- (Optional) The `openai-codex` plugin for Claude Code — provides the `/codex:setup` UX wrapper for auth, but **not required** for plan-tango: the skill calls `codex exec` directly via the underlying `codex.js`.

---

**License:** MIT (see [LICENSE](../../LICENSE)) · **Author:** Egor Sokolov · Telegram: [@neiroset_ne_vinovata](https://t.me/neiroset_ne_vinovata)
