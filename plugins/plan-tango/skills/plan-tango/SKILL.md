---
name: plan-tango
description: "Auto-converge a Claude-written plan with Codex (gpt-5) review. Loops Codex review → Claude fixes → re-review until clean ALLOW or max-iter. Works inside plan mode on the active plan file. Use when you've drafted a plan and want external AI review without manual copypaste."
argument-hint: "[plan-path-or-slug] [--max-iter N (default 6, cap 12)] [--effort none|minimal|low|medium|high|xhigh] [--model <m>] [--lenient] [--final-check] [--no-final-check] [--resume] [--takeover] [--continue-thread|--fresh-each] [--fast | --service-tier fast|flex] [--codex-profile <name>] [--quiet]"
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Task
  - AskUserQuestion
---

<objective>
Run a Claude↔Codex convergence loop on a plan file under `~/.claude/plans/`:
Codex review → orchestrator applies fixes → repeat until clean `ALLOW` or hard cap.
Optionally finish with an Opus sanity-check (`plan-tango:plan-final-checker` subagent) for plans
with runtime-contract triggers or fast convergence.

Works inside plan mode (Read/Edit of plan-file are allowed; Bash/Task work via permission prompts).
</objective>

<execution_context>
- Codex CLI: invoked directly as `codex exec --json --sandbox read-only -o <file> ...` from `run-codex-review.mjs`. Required: `codex` on PATH (verify via `codex --version`); auth via `codex login` (`/codex:setup` from openai-codex plugin works too but is no longer required). The wrapper resolves the underlying `node <npm-prefix>/node_modules/@openai/codex/bin/codex.js` to bypass the npm shim layer (cross-platform, no shell escaping).
- User config (optional): `~/.claude/plan-tango/config.json` — persistent defaults loaded by `load-config.mjs`. CLI flags always override. Schema documented in `${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/user-config.example.json`.
- Helper scripts (orchestrator calls these via Bash): `${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/`
  - `plan-paths.mjs` — validate / newest / list-recent / resolve-repo / hash
  - `workspace.mjs` — ensure / cleanup workspace dir
  - `snapshot.mjs` — fs.copyFileSync plan backup
  - `lock.mjs` — lease-lock acquire / refresh / release / inspect
  - `apply-fixes.mjs` — dry-run classifier returning edit_plan + ledger_template
  - `load-config.mjs` — merges CLI flags + user-config.json + built-in defaults; emits `{merged, sources}`
  - `build-prompt.mjs` — Tier 0: deterministic substitution of `{{PLAN_BODY}}`, `{{REPO_EVIDENCE_NOTE}}`, `{{RESET_BLOCK}}` into the review template. Replaces orchestrator Write of ~280-line file (~1-2 min) with ~50ms Bash call. Used by Phase C step 13.
  - `build-params.mjs` — Tier 0: writes `iter{N}.params.json` with the codex-relevant settings subset, enforcing the resume_thread_id rule and rejecting orchestrator-only keys. Used by Phase C step 14.
  - `run-codex-review.mjs` — direct `codex exec` wrapper (called by `plan-tango:plan-reviewer` subagent only). Returns full verdict shape (verdict, summary, findings, session_id, fallback_to_fresh, ...). Filters cosmetic codex-cli rollout-recording stderr noise via `filterRolloutNoise` (see `references/codex-thread-investigation.md`).
  - `parse-codex-jsonl.mjs` — minimal JSONL events → `session_id` + diagnostics
  - `parse-codex-verdict.mjs` — text/file/json parser for verdict text (used by run-codex-review and Opus final-check)
- Subagents (plugin-registered as `plan-tango:<name>`, source in `${CLAUDE_PLUGIN_ROOT}/agents/`):
  - `plan-tango:plan-reviewer` (sonnet) — thin Bash wrapper for one Codex pass
  - `plan-tango:plan-final-checker` (opus) — sanity check
- Review prompt template: `references/review-prompt-template.md`
- Verdict format spec: `references/verdict-contract.md`
</execution_context>

<context>
Args from `$ARGUMENTS`:
- positional `plan-path-or-slug` — optional. If absent, autodetect (active plan from system prompt → newest in `~/.claude/plans/` → ask via AskUserQuestion). **Exception: `--resume` mode disables the `newest` fallback (see Phase A).**
- `--max-iter N` — default 6, hard cap 12. On reaching the limit Phase C step 21h asks the user whether to continue (+4 by default, custom, or stop) — see step for details.
- `--effort none|minimal|low|medium|high|xhigh` — reasoning effort, default `high`. **Note**: `minimal` is rejected by Codex API when image_gen/web_search tools are enabled (the default model setup). Use `low` if you want fast.
- `--model <m>` — default unset (Codex picks its own default from `~/.codex/config.toml`)
- `--lenient` — stop on "no critical/major" instead of strict ALLOW
- `--final-check` — opt in to the Opus sanity-check after a converged status (v0.2 canonical). Sets `final_check="always"`. Cannot be combined with `--no-final-check`.
- `--no-final-check` — _(deprecated alias, still works)_ disable Opus override; sets `final_check="never"` for this run, even if config says `"always"`. Prints a one-line deprecation warning. Will be removed in v0.3.
- `--force-final-check` — _(deprecated alias for `--final-check`, still works)_ same effect; prints a one-line deprecation warning. Will be removed in v0.3.
- `--resume` — resume from saved state for the same slug
- `--takeover` — when an existing lock is fresh (<30 min), normally we refuse; `--takeover` overrides for stale-but-readable locks (corrupt locks always require it). Use only after confirming no parallel run.
- `--continue-thread` / `--fresh-each` — thread mode override (mutually exclusive). Default comes from `~/.claude/plan-tango/config.json:thread_mode` if set, otherwise `continue`. `continue` (default) reuses one Codex thread across iterations (cheaper, faster, cleaner Codex panel) and inserts a reset-prompt at iter ≥ 2 to limit anchor bias. `fresh` opens a new thread per iteration (fully independent reviews).
- `--fast` — shortcut for `--service-tier fast` (Codex priority processing tier — ~1.5x speed at higher per-token cost; requires `features.fast_mode = true` in `~/.codex/config.toml`, which is the default in current Codex CLI).
- `--service-tier <fast|flex>` — explicit form; passed via `-c service_tier="<value>"` to codex.
- `--codex-profile <name>` — selects a `[profiles.<name>]` block from `~/.codex/config.toml` via `-p`. Profile is loaded BEFORE per-call `-c` overrides; canonical settings (effort, service_tier, model) still override the profile.
- `--quiet` — suppress per-iteration progress lines in Phase C (snapshot prints, build-prompt prints, post-Codex one-liner verdict for ALLOW/BLOCK, apply summary). Phase A heads-up, Phase B init confirmations, Phase C step 16 ERROR/MALFORMED bullets, ABORT/error messages, AskUserQuestion prompts, and Phase E final report (§1-§5) are ALWAYS printed. Default false. Persistent override: `quiet: true` in `~/.claude/plan-tango/config.json`.
</context>

<process>

# Phase A — Validation

1. **Resolve plan-path** (priority order). Common rules apply to both modes:
   1. Explicit positional arg (normalize: absolute > relative-to-cwd > slug under `~/.claude/plans/`).
   2. Active plan from system prompt: search for "Plan File Info" or "plan file at" pointing at a path under `~/.claude/plans/`. Extract that path.

   **Without `--resume`** (fresh run):
   3. Helper: `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/plan-paths.mjs --newest`.
   4. If still nothing → AskUserQuestion with `--list-recent 5` results.

   **With `--resume`** (NEVER use `--newest` fallback):
   3. ABORT with: "Cannot --resume without an explicit plan path/slug or an active plan in system prompt. Re-run with /plan-tango <slug-or-path> --resume to be unambiguous."
   4. Optionally use AskUserQuestion to list slugs that currently have a `*-tango.state.json` file (filter `--list-recent` to those with state).
   This rule prevents resume from silently picking up a different plan that landed in `~/.claude/plans/` while the previous run was paused.
2. **Validate** via `plan-paths.mjs --validate <path>`. The helper enforces existence, size ≥ 200 bytes, realpath under `~/.claude/plans/`. On non-zero exit, abort with the helper's `reason` field.
3. **Verify codex CLI exists** by running `codex --version` via Bash (capture stdout). If exit code ≠ 0 or no output, abort with: "Codex CLI not found on PATH. Install with `npm install -g @openai/codex`, then run `codex login` (or `/codex:setup` from openai-codex plugin). Re-run /plan-tango once codex --version succeeds." Save the version string to use later in step 8 (state.codex_version).
4. **Resolve repo-root** via `plan-paths.mjs --resolve-repo --cwd <process.cwd> --plan <plan_path>`. Use the returned `repo_root` and `repo_evidence_available`. **v0.2:** `repo_evidence_available` is now ALWAYS `true` — the old git-required gate was over-defensive and forced text-only review on legitimate cases (new project pre-`git init`, monorepos with non-git toolchains, code dirs without VCS metadata). With Codex sandbox=read-only and the existing prompt grounding rules, allowing investigation in any cwd is safe — worst case is shallow/noisy findings if user runs from the wrong dir, easy to spot and re-run. The `repo_root` selection priority is unchanged (plan-text explicit path > git toplevel > cwd); only the boolean flag flipped.
5. **Heads-up to user**: print one line saying "Will call Bash(node run-codex-review.mjs) up to {max_iter} times. Allowlist via `/fewer-permission-prompts` if you'll use this often."

# Phase B — Init

**Critical ordering:** lock acquisition MUST happen BEFORE any state/workspace writes. Otherwise a second concurrent run can corrupt state files before its `lock_held` abort fires.

6. `slug = path.basename(plan_path, '.md')`.
7. **Acquire lock FIRST** (before any writes) via `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/lock.mjs acquire --slug <slug> --plan <plan_path>` (add `--takeover` if user passed it).
   - Save the returned `session_id` for the rest of the run — every refresh/release call must pass the same session_id.
   - On `lock_held` → ABORT with the helper's message (existing session, age, hint). Do NOT proceed. Do NOT touch state or workspace.
   - On `lock_corrupt` (and no --takeover) → ABORT, suggest: "Inspect with `lock.mjs inspect --slug <slug>`; if no parallel run, re-run with --takeover."
   - On `cannot_takeover_fresh_lock` → ABORT (someone explicitly tried takeover but lock is too fresh).
   - On success (`acquired:true`) → set `lock_acquired = true` (orchestrator-side flag, see Phase E step 30 for usage) and continue. Log if `took_over_stale:true` so user knows we adopted an old lease.
8. `state_path = ~/.claude/plans/{slug}-tango.state.json`. Schema (illustrative — actual values come from `load-config.mjs` in step 8.5):
   ```json
   {
     "iter": 0,
     "original_plan_hash": "<sha256>",
     "last_known_plan_hash": "<sha256>",
     "last_verdict": null,
     "findings_history": [[], [], []],
     "settings": {
       "max_iter": 6, "effort": "high", "model": null, "lenient": false, "final_check": "auto",
       "thread_mode": "continue", "service_tier": null, "codex_profile": null, "extra_codex_config": [], "quiet": false,
       "severity_aware": true
     },
     "settings_sources": { "max_iter": "default", "effort": "default", "...": "..." },
     "repo_root": "...",
     "repo_evidence_available": true,
     "codex_thread_id": null,
     "codex_version": "...",
     "polish_only_terminal": false,
     "polish_advisory": []
   }
   ```
8.5. **Load merged settings via `load-config.mjs`**: orchestrator builds a JSON of parsed CLI args (using `_` for `-` in names: `max_iter`, `no_final_check` (deprecated alias), `force_final_check` (deprecated alias), `final_check_flag` (v0.2 canonical, set by `--final-check`), `continue_thread`, `fresh_each`, `fast`, `service_tier`, `codex_profile`, `effort`, `model`, `lenient`, `quiet`) and runs:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/load-config.mjs --merge --cli '<json>'
   ```
   - On exit 2 / `error` field present (validation failure or config conflict like `--no-final-check + --final-check`) → ABORT with the helper's `error`/`detail`. Release the lock acquired in step 7.
   - On success: parse stdout `{merged, sources, warnings}`. Set `state.settings = merged`, `state.settings_sources = sources`. Then verify `state.settings.max_iter ≤ 12` (defensive — load-config also enforces this). **Print each entry of `warnings` to the user** (deprecation notices for old CLI aliases or old config values — see Tier 2.1 migration). Always print, even with `--quiet`.
   - **Skip-loader bypass** (defensive only): if env `PLAN_TANGO_NO_CONFIG_LOADER=1`, skip step 8.5 and apply legacy initialization (parsed args → state.settings, defaults: max_iter=6, effort=high, thread_mode=continue, final_check=never, lenient=false, service_tier=null, codex_profile=null, extra_codex_config=[], quiet=false, severity_aware=true, settings_sources={}, warnings=[]). Same hard-cap check applies.
9. **If `--resume`**:
   - Load state file.
   - Compute `current_hash = sha256(plan_file)`.
   - If `current_hash !== state.last_known_plan_hash` → ABORT: "Plan modified outside skill since last completed iteration (expected hash {short(last_known)}, got {short(current)}). Re-run without --resume to start fresh." Then release the lock we just acquired (Phase E rules apply).
   - Otherwise resume from `state.iter + 1`.
10. **Else (fresh)**: Write state with `original_plan_hash = last_known_plan_hash = sha256(plan)`, iter=0, settings populated per rules above.
11. **Ensure workspace dir**: `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/workspace.mjs ensure --slug <slug>`.

# Phase C — Loop (`while N <= max_iter`, where N = state.iter + 1)

For each iteration `N = state.iter + 1` (N is the **current** iteration number; `state.iter` is the count of *completed* iterations, starts at 0):

10b. **Integrity check** (BEFORE snapshot, BEFORE Codex call):
     Compute `current_hash = sha256(plan_path)` via `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/plan-paths.mjs --hash <plan_path>`.
     If `current_hash !== state.last_known_plan_hash`:
       BREAK with status=`external-modification`. Print:
         "Plan modified outside skill since last completed apply (expected hash {short(last_known)}, got {short(current)}). Skill aborts to avoid clobbering manual edits or competing automation. Inspect snapshots in {plan}.iter*-*.bak and decide whether to re-run from scratch."
       Skip remaining steps (no Codex call wasted, lock will be released in Phase E).
     This protects against:
       - User editing the plan in their IDE between iterations
       - A second instance somehow running despite the lock (defense in depth)
       - Any external process touching the plan
11. **Snapshot**: `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/snapshot.mjs --plan <plan_path> --iter <N>`. **If `state.settings.quiet === false`**: Print: "[N/max] Snapshot: <result.snapshot>".
12. **If `state.settings.quiet === false`**: Print: `[N/max] Sending to Codex (effort=<effort>, mode=<thread_mode>, tier=<service_tier|standard>, cwd=<repo_root>)...`.
13. **Build prompt** via `build-prompt.mjs` (Tier 0 — was: orchestrator Write of ~280-line file, ~1-2 min/iter; now: deterministic Bash script, ~50ms). Compute `reset_block_flag = (state.settings.thread_mode === "continue" AND N >= 2 AND state.codex_thread_id !== null)`. Then call:
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/build-prompt.mjs \
      --template ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/references/review-prompt-template.md \
      --plan <plan_path> \
      --repo-evidence <repo_evidence_available> \
      --reset-block <reset_block_flag> \
      --out ~/.claude/plans/{slug}-tango.workspace/iter{N}.prompt.md
    ```
    The script handles the three placeholder substitutions ({{PLAN_BODY}}, {{REPO_EVIDENCE_NOTE}}, {{RESET_BLOCK}}) — see [build-prompt.mjs](scripts/build-prompt.mjs) for the literal text variants.
14. **Build params** via `build-params.mjs`. First the orchestrator writes a small codex-relevant settings subset (orchestrator-only keys like `max_iter`, `thread_mode`, `final_check`, `lenient`, `quiet`, `verbose_report`, `severity_aware` MUST be excluded) to `~/.claude/plans/{slug}-tango.workspace/iter{N}.settings.json`:
    ```json
    {
      "effort":             "<state.settings.effort>",
      "model":              "<state.settings.model or omitted>",
      "service_tier":       "<state.settings.service_tier or omitted>",
      "codex_profile":      "<state.settings.codex_profile or omitted>",
      "extra_codex_config": ["key=value", ...]
    }
    ```
    Omit any optional key whose value is null/empty array. Always include `effort`. This file is small (~5 lines), so a Write tool call here is cheap.
    Then call:
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/build-params.mjs \
      --slug <slug> --iter <N> \
      --repo-root <repo_root> \
      --repo-evidence <repo_evidence_available> \
      --thread-mode <state.settings.thread_mode> \
      --resume-thread-id <state.codex_thread_id|null> \
      --prompt-file ~/.claude/plans/{slug}-tango.workspace/iter{N}.prompt.md \
      --output-last-message-file ~/.claude/plans/{slug}-tango.workspace/iter{N}.last-message.txt \
      --settings-json ~/.claude/plans/{slug}-tango.workspace/iter{N}.settings.json \
      --out ~/.claude/plans/{slug}-tango.workspace/iter{N}.params.json
    ```
    The script enforces the resume_thread_id rule (only set when thread_mode=continue AND iter>=2 AND uuid is non-null), handles settings omissions, and rejects orchestrator-only keys defensively. Output schema matches what `run-codex-review.mjs` consumes (see its docstring).
    **Pre-create empty output file** before spawn (wrapper also clears it; doing it here protects against stale data if spawn fails before clear): orchestrator does `Write(path=output_last_message_file, content="")`.

14b. **Build-script failure handling** (Tier 0 invariant): if either `build-prompt.mjs` or `build-params.mjs` exits non-zero OR returns stdout JSON with `ok:false`:
    - **Always print** (regardless of `--quiet`): `[N/max] ERROR — build-{prompt|params}.mjs failed: <error>: <detail>`.
    - Append ledger entry with `iteration_kind="normal"`, `action="build_script_failed"`, `note=<error>`.
    - Skip Codex spawn (do NOT proceed to step 15). Set status=`build-failed`, BREAK out of the loop.
    - Phase D pre-gate skips final-check on `build-failed` (status NOT in converged-* set, see status-eligibility table).
    - Phase E reports normally. Lock release in step 30 fires (lock was acquired in Phase B; orchestrator owns it).
    User can inspect the workspace dir and re-run after fixing the issue.
15. **Spawn `plan-tango:plan-reviewer` subagent** via Task tool (`subagent_type: "plan-tango:plan-reviewer"`). Pass the absolute path to `iter{N}.params.json` as the only input. The subagent runs `run-codex-review.mjs` and returns its stdout verbatim (one JSON object).
16. **Parse verdict JSON** from subagent's response. The wrapper returns the full shape (verdict, summary, findings, session_id, fallback_to_fresh, last_message_path, ...) — orchestrator does NOT re-parse the verdict text itself. Print (per-bullet quiet gating):
    - For `verdict ∈ {ALLOW, BLOCK}` — **If `state.settings.quiet === false`**: `[N/max] {verdict} — {C} critical, {M} major, {m} minor, {n} nit ({Xs}, evidence={true|false})` where counts come from findings array. (Per-iter chatter; suppressed in quiet mode.)
    - For `verdict=ERROR` — **ALWAYS print** (regardless of quiet): `[N/max] ERROR — reason={reason}, exit_code={ec}`. Diagnostic info — signals codex_nonzero_exit/codex_empty_output BEFORE step 17 runs its retry/ABORT logic.
    - For `verdict=MALFORMED` — **ALWAYS print** (regardless of quiet): `[N/max] MALFORMED — reason={reason}`. Signals retry happening before step 18's silent-or-ABORT path.

16.5. **Save thread_id to state** (NEW — applies for all non-ERROR-with-spawn-failure verdicts where wrapper produced a `session_id`):
    Read `response.session_id` and `response.fallback_to_fresh`. Apply this rule to `state.codex_thread_id`:
    - If `response.fallback_to_fresh === true` (lost-session re-spawn): **always overwrite** `state.codex_thread_id = response.session_id`. Log: `Thread <old_id> lost, switched to <new_id>.`
    - Else if `state.settings.thread_mode === "continue"` AND `state.codex_thread_id === null` AND `response.session_id !== null`: **save** `state.codex_thread_id = response.session_id` (first iteration in continue mode opens the persistent thread).
    - Else: do not change `state.codex_thread_id` (subsequent iters in continue-mode reuse it; fresh-mode never persists).
    Write state immediately after this assignment so a Ctrl-C between iterations preserves the thread for `--resume`.

17. **If `verdict == ERROR`** (handle BEFORE classification):
    - `reason=codex_nonzero_exit` AND stderr contains `ENOENT|auth|401|not logged in` → ABORT, suggest: "Run `codex login` (or `/codex:setup` from openai-codex plugin) and re-run."
    - `reason=codex_empty_output` → 1 retry (re-spawn with same params). On retry-empty also → ABORT.
    - `reason=prompt_unreadable` → ABORT, this is a workspace bug; show path.
    - `reason=params_missing|params_unreadable|params_invalid_json|wrapper_exception` → ABORT, this is a skill-internal bug; show user the JSON.
    - In all cases print stderr_tail and raw_stdout snippet. Skip classification/apply.

18. **If `verdict == MALFORMED`** (handle BEFORE classification):
    - One retry: re-spawn the subagent with same params (a new fresh thread, Codex may produce a better-formatted sample).
    - If retry also MALFORMED → ABORT, show raw_final_message.
    - If retry succeeded → re-handle through 17 (verdict could be ERROR/ALLOW/BLOCK).
    - Skip classification/apply for MALFORMED iterations.

19. **Update state** (any non-ABORT path): append current findings hashes to `findings_history`, drop oldest if length > 3.

20. **Dry-run classification** (only when verdict=BLOCK with non-empty findings):
    Pipe `{plan_path, findings}` to `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/apply-fixes.mjs`. Read its `classified[]`, `edit_plan[]`, `ledger_template[]`, `invariant_summary`.

21. **Stop conditions** (in priority order):
    a) `verdict == ALLOW` and findings empty → BREAK with status=`converged`.
    a2) **Severity-aware polish-only stop** (default behavior — see `severity_aware` setting): `state.settings.severity_aware === true` AND `verdict == BLOCK` AND `findings.length > 0` AND `count(critical) + count(major) === 0` → BREAK. **Status branches on lenient flag** to preserve existing `--lenient` semantics: `state.settings.lenient ? "converged-lenient" : "converged-with-polish"`. Both populate advisory identically.
       - **Hash sourcing**: step 20 already produced dry-run classify (`apply-fixes.mjs`); its `advisory_plan[]` field contains ALL deduped unique findings regardless of classification (including `manual`-flagged), with shape `{hash, severity, title, location, problem, fix}`. Build: `state.polish_advisory = [...advisory_plan]`. Set `state.polish_only_terminal = true`.
       - **Why `advisory_plan[]`, not `edit_plan[]`**: live classifier excludes `classification === "manual"` findings from edit_plan; for polish-only advisory we need full coverage including manual-flagged. Do NOT rely on `classified[i] === findings[i]` parallel-array assumption — apply-fixes dedupes by hash, so `classified.length` may be < `findings.length`. `advisory_plan[]` is deduped-by-construction and authoritative.
       - **Ledger**: append `iteration_kind="normal"` entries, one per polish_advisory record: `{hash, severity, action: "advisory", note: "polish_only_terminal"}`.
       - **Apply phase**: NOT called. Plan file is not modified at this stop.
       - **Precedence rule**: when severity_aware=true, (a2) is the single termination point for polish-only verdicts; legacy (d) is unreachable (a2 always fires first). When severity_aware=false, (a2) is skipped and (d) handles --lenient users via legacy path (without advisory rendering).
       - Falls through to Phase D pre-gate (treat `converged-with-polish` and `converged-lenient` identically to `converged` — Opus may catch architectural issues Codex missed).
    b) Any classified finding with `classification=manual` → BREAK with status=`manual-required`. **v0.2:** print the manual-flagged findings (severity, title, location, problem, suggested_fix) so the user can decide outside the skill — edit the plan manually and re-run, or re-run with different `--effort`. The legacy AskUserQuestion apply-A/apply-B/skip/abort UI is removed (Codex rarely emitted A/B variants in practice; users typically picked skip/abort). The MANUAL_PATTERNS regex in [apply-fixes.mjs](scripts/apply-fixes.mjs) is unchanged — manual findings are still flagged (so they don't get auto-applied via Edit), just not auto-resolved via UI.
    c) Any classified finding with `severity ∈ {critical, major}` AND `classification=deferred` → BREAK with status=`manual-required` (same branch as b).
    d) `--lenient` set AND `BLOCK` with findings AND zero critical/major → BREAK with status=`converged-lenient`. (Checked AFTER b/c so lenient cannot bypass manual.)
    e) **Oscillation**: any finding hash appears in `findings_history[N-2]` but NOT `findings_history[N-1]` → BREAK with status=`oscillating`.
    f) **Stuck**: `findings_history[N-1]` set equals current findings set → BREAK with status=`stuck`.
    g) **Regression**: count(critical) in current > count(critical) in `N-1` → BREAK with status=`regressed`. Offer rollback to `iter{N-1}.bak`.
    h) `N === state.settings.max_iter` (i.e. this is the LAST permitted iteration in current cap) → **interactive continue-prompt** (do NOT break immediately):
       - AskUserQuestion (single-select):
         "Reached max-iter limit ({max_iter}). Current findings: {C} critical, {M} major, {m} minor, {n} nit. Continue?"
         Options:
           1. "Continue +4 iterations" — set `extra=4`
           2. "Continue +N iterations (custom)" — ask follow-up for N
           3. "Stop here (status=max-iter-reached)" — set `decision=stop`
           4. "Abort run" — set `decision=abort`
       - On `decision=stop` → BREAK with status=`max-iter-reached` (current behavior).
       - On `decision=abort` → BREAK with status=`aborted-by-user`. Release lock as usual in Phase E.
       - On Continue (`extra` set):
         - Compute `new_max = state.settings.max_iter + extra`.
         - **Hard cap check**: if `new_max > 12` → refuse with "Hard cap is 12 (current cap protects against runaway loops via accidental Continue clicks). For larger budgets re-run skill with explicit `--max-iter <N>` (still capped at 12) or split the plan into smaller pieces." Then re-prompt with same options minus Continue (only Stop/Abort remain).
         - Otherwise: `state.settings.max_iter = new_max`, write state, print "Continuing to iter {next} (new cap: {new_max})", do NOT break — fall through to step 22 (apply) and let the loop iterate normally.
    (`ALLOW + findings` and `BLOCK + zero findings` are handled by the parser as MALFORMED in step 18.)

22. **Apply phase** (only reached when classification produced edit_plan with at least one auto entry):

    **Contract clarification (apply-fixes.mjs is a CLASSIFIER ONLY):**
    `apply-fixes.mjs` does NOT produce executable Edit operations. It returns metadata: `{hash, severity, file_path, location_hint, title, problem, suggested_fix, requested_file_path?}` per finding plus classification (`auto`/`deferred`/`manual`). The orchestrator (this main agent) is responsible for converting each classified finding into a real `Edit` call by interpreting Codex's natural-language `suggested_fix` against the plan text. There is no automatic translation from finding to old_string/new_string — Codex provides intent, the orchestrator constructs the diff.

    - **Invariant check (off-plan detection):** the live `apply-fixes.mjs` always sets `edit_plan[i].file_path = plan_path` for non-manual entries (the editable target is always the plan file). Off-plan findings are signaled via `edit_plan[i].requested_file_path !== null` AND/OR `invariant_summary.off_plan_count > 0` / `off_plan_blocking === true`. The orchestrator MUST detect off-plan via `requested_file_path`, NOT by comparing `file_path` to `plan_path` (they're always equal by construction).
      - For each `edit_plan[i]` with `requested_file_path !== null`:
        - If severity ∈ {critical, major} → BREAK with status=`off-plan-target`. Append ledger entries with `iteration_kind="normal"`, `action="off_plan_blocked"`, fields `requested_file_path` and `suggested_fix`. Show user the list and stop.
        - If severity ∈ {minor, nit} → log as `action=deferred` with `note="off-plan-file target"` and `requested_file_path`, but continue applying the in-plan entries.
      - Cross-check via `invariant_summary.off_plan_blocking`: if true and we did not break above, that's a logic bug — abort with status=`off-plan-target` and dump full classified array for debugging.

    - **Apply** (for each in-plan auto entry — pre-flight checks before Edit):
      1. **Read current plan content** (always re-read; do NOT cache between findings — earlier Edits in this iteration change the text).
      2. **Anchor search**: extract a unique anchor from `location_hint` or from a quoted snippet inside `problem`/`suggested_fix`. Search the plan for the anchor:
         - If anchor not found → mark `action=deferred` with `note="anchor_not_found"` and full `location_hint` in ledger. Skip Edit.
         - If anchor matches >1 location and `location_hint` lacks line-number disambiguation → mark `action=deferred` with `note="anchor_ambiguous"`. Skip Edit.
         - If anchor unique → proceed.
      3. **Construct Edit** by interpreting `suggested_fix` against the matched section:
         - Compose minimal `old_string` (the text being replaced) and `new_string` (the corrected text). Keep change scope tight — do not rewrite surrounding paragraphs.
         - For non-mechanical fixes (Codex described intent only, e.g. "add error handling"), apply best interpretation that satisfies the intent. Be conservative: prefer additive changes over restructuring.
         - If the same `location_hint` is targeted by another finding in this batch → process them in severity order (critical first, then major, then minor, then nit), re-reading after each successful Edit. If a later finding's anchor was modified by an earlier Edit, mark it `action=deferred` with `note="anchor_clobbered_by_earlier_edit"`.
      4. **Execute Edit** via the Edit tool. The Edit tool itself errors if `old_string` is not unique or not found:
         - On Edit error → mark `action=deferred` with `note="edit_tool_rejected: <error_short>"`.
         - On Edit success → mark `action=applied`, record `edit_summary` (e.g. "+5/-2 lines in §Phase B").
      5. **Verification after Edit**: re-grep the anchor area to confirm the change took effect (defense against accidental no-op when old_string === new_string).
    - **Append ledger entries** to `~/.claude/plans/{slug}-tango.ledger.json` (create file with skeleton on first write):
      - For each finding processed this iter, push `{hash, severity, action, note?, requested_file_path?, suggested_fix?, edit_summary?}` under the iteration entry. `iteration_kind="normal"`.
    - **Update last_known_plan_hash**: compute `sha256(updated_plan_file)` and write to state.
    - **Refresh lock** so the lease doesn't go stale during long iterations:
      `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/lock.mjs refresh --slug <slug> --session <session_id> --plan-hash <new_hash>`.
      On `session_mismatch` → ABORT (someone took over our lock while we were running).
    - **If `state.settings.quiet === false`**: Print: `[N/max] Applied {k} fixes (+{added}/-{removed} lines), deferred {d}. Starting iter {N+1}.`
23. **Increment iter**, loop.

# Phase D — Final Check (after loop break)

24. **Pre-gate (v0.2 — single rule):** run Opus full-mode if **both** clauses hold; otherwise skip:
    - **(a) status eligible:** `status ∈ {converged, converged-lenient, converged-with-polish}`. Non-converged statuses (`manual-required`, `stuck`, `regressed`, `max-iter-reached`, `oscillating`, `off-plan-target`, `external-modification`, `build-failed`, `aborted-by-user`, `final-check-malformed`, `final-recheck-error`, `final-recheck-malformed`) are NEVER eligible. Diagnostic mode (running Opus on non-converged) was removed in v0.2.
    - **(b) settings opt-in:** `state.settings.final_check === "always"`. This value is the single normalized output of `load-config.mjs` (CLI > config > default), which already resolved the precedence between `--final-check`, `--no-final-check`, deprecated `--force-final-check`, deprecated config `auto`/`force`, and the new default `"never"`.
    
    Phase D does NOT re-inspect raw CLI flags or raw config values; the decision is settled in `state.settings.final_check`.
25. _(Auto-gate keyword triggers — removed in v0.2.)_ The historical keyword-list auto-gate (which triggered Opus on plans containing `permission`, `MCP`, `subagent`, etc.) is gone. It fired on practically every Claude Code plan, making Opus effectively always-on without explicit user opt-in. v0.2 makes Opus opt-in via `--final-check` or config `final_check: "always"`. See `references/final-check.md` for historical detail.
26. **Run final check**:
    - Spawn `plan-tango:plan-final-checker` subagent (`subagent_type: "plan-tango:plan-final-checker"`) with `{plan_path, repo_root, repo_evidence_available, mode}`.
    - Receive raw text output. Pipe through `parse-codex-verdict.mjs --from-text` (via Bash).
    - If parser returns `verdict=MALFORMED` → ONE retry of the subagent with reminder "Your last response did not start with ALLOW: or BLOCK:. Repeat with correct format". If retry MALFORMED → BREAK with status=`final-check-malformed`, show raw output.
27. _(Diagnostic mode — removed in v0.2.)_ The old behavior of running Opus in read-only diagnostic mode on non-converged statuses (when `--force-final-check` was passed) is gone. Pre-gate (step 24) now makes non-converged statuses ineligible regardless of settings.
28. **Full mode** (converged-*):
    - **28a (clean)**: `verdict == ALLOW` AND `findings.length === 0` → BREAK with status=`converged-final`.
    - **28a-polish (Opus polish-only)**: `verdict == BLOCK` AND `findings.length > 0` AND `count(critical) + count(major) === 0` → BREAK with status=`converged-final`. **No corrective iter.**
      1. Run dry-run classify on Opus findings via `apply-fixes.mjs` (hash-only — no apply phase follows). Cross-check `invariant_summary.off_plan_blocking` — if true, BREAK with status=`off-plan-target` per current step 22 protocol; do NOT write polish_advisory.
      2. Build `opus_advisory = [...advisory_plan]` from the dry-run output (uses the same `advisory_plan[]` field as Phase C step 21 a2 — covers all deduped findings regardless of classification).
      3. Set `state.polish_only_terminal = true`. Merge `opus_advisory` into `state.polish_advisory` (append + dedupe by hash; existing entries from any earlier Phase C polish-only stop are preserved).
      4. Append ledger entry `iteration_kind="final-check-advisory"` with one row per `opus_advisory` entry: `{hash, severity, action: "advisory", note: "opus_polish_only"}`.
      5. Show: "Final-check found {n} polish findings (advisory, see §6 of report)".
    - **28b (critical or major)**: print "Final-check found {C} critical, {M} major. Running one corrective iteration..."
      1. Snapshot via `snapshot.mjs --iter final-fix`.
      2. Dry-run classification on Opus findings via `apply-fixes.mjs`.
      3. If `manual` or critical/major `deferred` → BREAK with status=`manual-required-after-final`.
      4. Reuse off-plan invariant from step 22 (check `requested_file_path !== null`, NOT `file_path !== plan_path`). Failures here → BREAK with status=`off-plan-target` (ledger `iteration_kind="final-fix"`, `action="off_plan_blocked"`).
      5. Apply fixes (same as step 22 apply); append ledger with `iteration_kind="final-fix"`. Update last_known_plan_hash.
      6. ONE Codex re-review: spawn `plan-tango:plan-reviewer` again with fresh params for current plan.
         - Verdict ALLOW → BREAK with status=`converged-final`.
         - Verdict BLOCK → BREAK with status=`final-check-divergence` (Opus and Codex disagree). Show both sets of findings. Ask user to resolve.
         - Verdict ERROR → BREAK with status=`final-recheck-error`. Show reason and stderr_tail.
         - Verdict MALFORMED → ONE retry of the re-review. If retry MALFORMED → BREAK with status=`final-recheck-malformed`.
      7. Do NOT run a second Opus final-check. The corrective iteration is the final word.

# Phase E — Summary

29. **Print rich convergence report** (mandatory — all four sections, in order, regardless of run length).
    Source data: `state.findings_history`, `~/.claude/plans/{slug}-tango.ledger.json`, original-vs-current plan hash + size.

    **§1 — One-line header.** "Plan-converge done." or "Plan-converge завершён." (match user's chat language).

    **§2 — Stats block** (markdown code-fenced for visual emphasis):
    ```
    Final status: {status}{optional courtesy/note suffix, e.g. "(+ courtesy minor fixes applied past cap)"}
    Iterations: {N}
    Codex review calls: {N}
    Codex seconds (total): {T}s ({iter1_s} + {iter2_s} + ... + {iterN_s})
    MALFORMED retries (in-loop): {M}
    Codex re-review calls (after final-fix): {0|1}
    Final re-review MALFORMED retries: {0|1}
    Opus final-check calls: {0|1} (auto-gate {triggered|absent}, --force {applied|N/A}, --no-final-check {applied|N/A})
    Opus final-check MALFORMED retries: {0|1}
    Polish-only terminal: {true|false}                  # render only if state.polish_only_terminal===true
    Polish advisory findings: {state.polish_advisory.length}  # render only if state.polish_only_terminal===true
    Lenient deferred minor/nit: {n}
    Plan size: {orig_bytes} → {new_bytes} bytes ({+/-pct}%)
    Snapshots: {N} (.iter1..iter{N} .bak)
    Ledger: ~/.claude/plans/{slug}-tango.ledger.json
    State:  ~/.claude/plans/{slug}-tango.state.json (intact for --resume)
    ```

    **§3 — Convergence table** (markdown table, one row per completed iteration, MUST always be included even for N=1):
    | Iter | Verdict | Critical | Major | Minor | Nit |
    |---|---|---|---|---|---|
    | 1 | BLOCK/ALLOW/ERROR/MALFORMED | C | M | m | n |
    | 2 | ... | ... | ... | ... | ... |

    Counts come from per-iter ledger entries (or findings_history if ledger unavailable). For ERROR/MALFORMED rows put `—` in count columns.

    **§4 — "What Codex caught and fixed"** (numbered list, severity-tagged, ledger-sourced):
    Pull from ledger.json all entries with `action ∈ {applied, deferred, manual, off_plan_blocked}`. List by severity (critical → major → minor → nit), one line each: `N. **{severity}** — {short title}.` Cap at ~12 items; if more, end with "… and {K} more (see ledger)".

    **§5 — Convergence narrative** (1-3 sentences in plain prose, NOT bullet list):
    Touch on:
    - When critical/major dropped to zero (which iter)
    - Whether courtesy fixes were applied past the cap (when status=max-iter-reached)
    - If oscillating/stuck/regressed — what was the conflict pattern (cite findings)
    - One-sentence final verdict on plan quality ("План сильно качественнее, чем был." / "Hit hard cap with 3 valuable major still open." / etc.)

    **Examples** (illustrative — not to be copied verbatim, language matches user):
    > Iter 1: BLOCK 1 critical + 4 major. Iter 2: BLOCK 0 critical + 2 major. Iter 3: BLOCK 0+0+1+1. Iter 4 (post-cap courtesy): BLOCK 0+0+2+0. Critical устранён за 1 итерацию. Major — за 3. Iter 4 принёс только minor — applied как courtesy, потому что простые текстовые правки.

    **§6 — Polish recommendations (advisory, not applied)** — render only when `state.polish_only_terminal === true` AND `state.polish_advisory.length > 0`.

    Lead-in paragraph (verbatim, language matches user):
    > Codex/Opus reached polish-only severity (only minor/nit findings, zero critical/major). Per severity-aware convergence the loop terminated without applying these — further auto-iters tend to introduce new minor inconsistencies. Review and apply manually if relevant.

    Followed by numbered list, source `state.polish_advisory[]`:
    > 1. **{severity}** — {title}
    >    File/section: {location}
    >    Suggested fix: {fix}
    > 2. ...

    Cap at ~12 entries; if more, append: "… and {K} more (see ledger.json `action=advisory` entries)".

    Skip §3+§4+§5 ONLY when N=0 (Phase A abort before any iteration ran). Always include §1+§2. Skip §6 when `state.polish_only_terminal === false` (it's render-conditional).
30. **Release lock** — ONLY if it was actually acquired:
    The orchestrator MUST track an `lock_acquired = false` flag from session start. Set it to `true` ONLY after a successful Phase B step 7 acquire (with the returned `session_id` saved). Phase A aborts (plan validation, codex CLI missing, repo resolve failure) happen BEFORE step 7 — they MUST NOT call `lock.mjs release`, because `slug` and `session_id` don't exist yet, and a literal `lock.mjs release --slug <slug> --session <session_id>` with placeholder values would crash with `invalid_slug` or `missing_session_id`, masking the real validation error.
    - **If `lock_acquired === true`**: call `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/lock.mjs release --slug <slug> --session <session_id>`.
      - On `session_mismatch` → log warning, do NOT delete (someone took over).
      - On `lock_missing` (already_absent) → no-op, fine.
    - **If `lock_acquired === false`** (Phase A abort, or step 7 itself failed with `lock_held`/`lock_corrupt`/etc.): skip release entirely. The lock either doesn't exist or belongs to another session.
    - This is the ONLY thing that lets future runs start. If the orchestrator crashes between iter and release with `lock_acquired === true` not having released, the next run will see a 30-min stale window before being allowed to acquire (or use --takeover sooner).
31. Optionally cleanup workspace dir: `node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/workspace.mjs cleanup --slug <slug>` if status is terminal-success (`converged-final`, `converged`, `converged-lenient`, `converged-with-polish`). Keep workspace for failed runs so user can inspect.

</process>

<critical_invariants>
- The skill modifies ONLY the plan file (Edit tool). All other state writes go through `Write` to files under `~/.claude/plans/{slug}-tango*` paths.
- Subagents do NOT edit the plan file. The orchestrator owns Edit operations.
- Off-plan invariant on edit_plan entries (via `requested_file_path !== null`) is checked BEFORE every Edit (steps 22 and 28b). The `file_path` field itself is always `plan_path` by classifier construction — do NOT confuse the two fields.
- All shell paths to wrapper/helpers go through `$HOME` / `$env:USERPROFILE`, never hardcoded usernames.
- **Thread invariant**: in `thread_mode=continue` (default), iter 1 opens a Codex thread (saved as `state.codex_thread_id`); iters 2..N call `codex exec resume <id>` AND inject the `<reset_iteration>` block to limit anchor bias. In `thread_mode=fresh` (opt-in via `--fresh-each`), every iteration opens a new Codex thread — fully independent reviews. On lost-session error the wrapper auto-fallbacks to fresh and reports `fallback_to_fresh:true`; orchestrator unconditionally overwrites `state.codex_thread_id` in that case (step 16.5).
- **Sandbox invariant**: every codex call goes with `--sandbox read-only` regardless of user config — review never gets write capability (apply-fixes is done by orchestrator via Edit tool, never by Codex).
- **Lock invariant** (Phase B step 10a → Phase E step 30): exactly one lock per slug for the run's lifetime. `--resume` re-acquires (state remembers slug; session_id is regenerated each invocation).
- **Integrity invariant** (Phase C step 10b): before every iteration, sha256(plan) MUST equal `state.last_known_plan_hash`. Mismatch = external modification = abort the cycle.
- **Resume-safety invariant**: `--resume` MUST NOT use the `--newest` fallback. Resume requires explicit slug/path or active plan in system prompt.
- **Max-iter hard cap invariant**: `state.settings.max_iter` MUST NOT exceed 12 at any point — neither via initial `--max-iter` argument nor via the continue-prompt at step 21h. This cap protects against runaway loops from accidental Continue clicks. For larger budgets the user must split the plan or accept stopping at 12.
- **Severity-aware invariant**: when `state.settings.severity_aware === true` (default), a BLOCK verdict with `count(critical) + count(major) === 0` is a TERMINAL state, NOT a corrective trigger. Polish findings are persisted to `state.polish_advisory` (sourced from `apply-fixes.mjs` `advisory_plan[]`, deduped, includes manual-classified) and rendered in Phase E §6 — never auto-applied. Status branches on `state.settings.lenient`: true → `converged-lenient` (preserves existing downstream-metric semantic), false → `converged-with-polish` (new). Step 21 (a2) is the single termination point under this mode; legacy step 21 (d) is unreachable when severity_aware=true (a2 fires first by priority order).
</critical_invariants>

<diagnostics>
The skill prints one or two lines per iteration. Counter-progress is visible:
- If iteration count grows but findings counts don't drop → suspect oscillation; the detector should catch it but user can Ctrl-C earlier.
- If ERROR at iter 1 with reason `codex_nonzero_exit` → first thing to check is `codex --version` (CLI installed?) and `codex login` status (`/codex:setup` from openai-codex plugin works too).
- Every snapshot is `~/.claude/plans/{slug}.iter{N}-*.bak` — manual rollback is `cp <bak> <plan>`.
</diagnostics>
