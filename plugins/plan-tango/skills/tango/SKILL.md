---
name: tango
description: "Auto-converge a Claude-written plan with Codex (gpt-5) review. Loops Codex review → Claude fixes → re-review until clean ALLOW or max-iter. Works inside plan mode on the active plan file. Use when you've drafted a plan and want external AI review without manual copypaste. Invoked as /plan-tango:tango."
argument-hint: "[plan-path-or-slug] [--max-iter N (default 6, cap 12)] [--effort none|minimal|low|medium|high|xhigh] [--model <m>] [--lenient] [--final-check] [--resume] [--takeover] [--quiet] [--verbose-report]"
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
Run a Claude↔Codex convergence loop on a plan file under `~/.claude/plans/`: Codex review → orchestrator applies fixes → repeat until clean `ALLOW` or hard cap. Optionally finish with an Opus sanity-check (`plan-tango:plan-final-checker`) on converged statuses when the user opts in.

Works inside plan mode (Read/Edit of plan-file allowed; Bash/Task via permission prompts).
</objective>

<execution_context>
- **Codex CLI**: `codex exec --json --sandbox read-only -o <file>` from `run-codex-review.mjs`. Required: `codex` on PATH (`codex --version`), auth via `codex login` or `/codex:setup`.
- **User config** (optional): `~/.claude/plan-tango/config.json`. CLI overrides. Schema: `${CLAUDE_PLUGIN_ROOT}/skills/tango/user-config.example.json`.
- **Helper scripts** at `${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/`:
  - `plan-paths.mjs` (validate/newest/list-recent/resolve-repo/hash), `workspace.mjs` (ensure/cleanup), `snapshot.mjs`, `lock.mjs` (acquire/refresh/release/inspect), `apply-fixes.mjs` (dry-run classifier → edit_plan + ledger_template + advisory_plan), `parse-codex-jsonl.mjs`, `parse-codex-verdict.mjs`.
  - `load-config.mjs` — merges CLI + config + defaults; emits `{merged, sources, warnings}`.
  - `init.mjs` — orchestrates Phase A in one Bash call (validate plan + codex CLI + repo + load-config + lock + state init/resume + workspace ensure). Returns full context bundle for the orchestrator to bind, with internal lock-cleanup on partial failure.
  - `prepare-iter.mjs` — single deterministic builder for ALL iter{N} artifacts: `iter{N}.prompt.md`, `iter{N}.params.json`, empty stub `iter{N}.last-message.txt`. Settings come inline via `--state-settings '<json>'` — no per-iter `iter{N}.settings.json` Write needed (step 13).
  - `run-codex-review.mjs` — `codex exec` wrapper (called directly via Bash from step 15). Filters cosmetic rollout-recording stderr (see `references/codex-thread-investigation.md`). Retries `codex_empty_output` once internally before reporting.
- **Subagent** at `${CLAUDE_PLUGIN_ROOT}/agents/`: `plan-tango:plan-final-checker` (opus, sanity check on converged statuses — Phase D only).
- **Templates**: `references/review-prompt-template.md`, `references/verdict-contract.md`. Schemas (state, params, ledger, verdict): [references/schemas.md](references/schemas.md).
</execution_context>

<context>
Args from `$ARGUMENTS`:
- positional `plan-path-or-slug` — optional. If absent: active plan from system prompt → newest in `~/.claude/plans/` → AskUserQuestion. **Exception**: `--resume` disables the `--newest` fallback (see Phase A).
**Common flags**:
- `--max-iter N` (default 6, hard cap 12; at the cap step 21's max-iter-reached handling prompts +4 / custom / stop / abort).
- `--effort none|minimal|low|medium|high|xhigh` (default `high`; `minimal` is rejected by Codex when image_gen/web_search are on — use `low` for fast).
- `--model <m>` (default unset — Codex picks from `~/.codex/config.toml`).
- `--lenient` — stop on "no critical/major" instead of strict ALLOW.
- `--final-check` — opt in to Opus sanity-check on converged statuses (sets `final_check="always"`).
- `--resume` — resume from saved state for the same slug.
- `--takeover` — override stale-but-readable lock (corrupt locks always require it).
- `--quiet` — suppress per-iteration progress in Phase C. Phase A heads-up, Phase B init, ERROR/MALFORMED bullets, ABORT messages, AskUserQuestion prompts, and Phase E final report ALWAYS print.
- `--verbose-report` — opt in to Phase E §3 (convergence table) + §5 (narrative). Default off; §1+§2+§4 (and §6 when polish_only_terminal) always render.

Default thread mode is `continue` (reuses one Codex thread; injects `<reset_iteration>` block at iter ≥ 2). Advanced flags — `--continue-thread` / `--fresh-each` (override thread mode), `--service-tier <fast|flex>`, `--fast`, `--codex-profile <name>`, `extra_codex_config` (config field) — are documented in [references/advanced-config.md](references/advanced-config.md). The loader (`load-config.mjs`) emits a `warnings` array the orchestrator surfaces (Phase A step 4). The removed final_check aliases (`--no-final-check` / `--force-final-check`, config `auto` / `force`) are no longer migrated — the loader hard-errors naming the canonical replacement (`--final-check`, `never` / `always`).
</context>

<process>

# Phase A — Init (validate + load + lock + state + workspace)

`init.mjs` consolidates Phase A+B (formerly 11 stepped operations) into one Bash call. Internally it composes existing helpers (`plan-paths`, `load-config`, `lock`, `workspace`) — no new logic, just chained orchestration with internal cleanup on failure.

1. **Build CLI JSON** from `$ARGUMENTS` into a flat object with these keys (using `_` for `-` per loader contract): `max_iter`, `effort`, `model`, `lenient`, `quiet`, `verbose_report_flag`, `final_check_flag` (canonical, set by `--final-check`), `continue_thread`, `fresh_each`, `fast`, `service_tier`, `codex_profile`. Only pass `no_final_check` / `force_final_check` if the user literally typed the removed `--no-final-check` / `--force-final-check` flags — the loader hard-errors on them naming the canonical `--final-check` (do not synthesize them otherwise). See [references/advanced-config.md](references/advanced-config.md) for the advanced flags.
2. **Run init**:
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/init.mjs \
      --cli '<json>' \
      [--plan-arg <positional-or-empty>] \
      [--active-plan <path-from-system-prompt-or-empty>] \
      [--resume] [--takeover]
    ```
    Init resolves plan-path (priority: positional > active-plan > newest under `~/.claude/plans/`; `--resume` disables the newest fallback per Resume-safety invariant), validates the plan (size ≥ 200 bytes, realpath under `~/.claude/plans/`), verifies `codex --version`, resolves repo-root, runs the plan-file-ref pre-flight (`plan_file_refs_total`, `plan_file_refs_missing`, `plan_file_refs_missing_fraction` — a wrong-worktree signal computed over relative refs only, capped at 50; init NEVER aborts on it), loads + validates merged settings, **acquires the lock first**, writes (or loads + hash-checks for resume) `state.json`, and ensures the workspace dir.

    On stdout one JSON object: success — `{ok:true, slug, plan_path, repo_root, plan_file_refs_total, plan_file_refs_missing, plan_file_refs_missing_fraction, codex_version, settings, settings_sources, warnings, lock_acquired:true, lock_session_id, lock_took_over_stale, state_path, state, is_resume, workspace_path}`. Failure — `{ok:false, abort_reason, error, lock_acquired, lock_session_id?, slug?}`.
3. **On `ok:false`**:
    - If `lock_acquired === true` (race fallback — internal cleanup in init failed): release via `lock.mjs release --slug <slug> --session <lock_session_id>`. On `session_mismatch` log a warning, do NOT delete.
    - **Always print** `error` to user. ABORT with `abort_reason` (which is one of: `missing_cli`, `unknown_flag`, `no_plan_resolved`, `resume_no_plan`, `plan_invalid`, `codex_cli_missing`, `repo_resolve_failed`, `config_invalid`, `max_iter_cap`, `lock_held`, `lock_corrupt`, `cannot_takeover_fresh_lock`, `lock_failed`, `resume_no_state`, `state_unreadable`, `state_invalid_json`, `resume_hash_mismatch`, `state_write_failed`, `workspace_failed`).
    - The orchestrator does NOT touch state/workspace itself in any failure path — init handled (or did not reach) those side effects.
4. **On `ok:true`**:
    - Bind for the rest of the run: `state` (full object), `slug`, `plan_path`, `repo_root`, `state_path`, `lock_session_id` (used in step 22 commit-iter lock refresh and step 30 lock.release), `lock_acquired = true`, `is_resume`, **`settings` (top-level from init output — this is the fresh loader output for *this* invocation; distinct from `state.settings` which is persisted at first-run and stays stable across `--resume`).** **Verify defensively**: `state.settings.max_iter ≤ 12` (step 21 re-checks at the max-iter continue-prompt).
    - **When to read `settings` vs `state.settings`**: most runtime decisions read `state.settings` (max_iter, effort, thread_mode, final_check, lenient, severity_aware, verbose_report) — these were settled at first-run for resume-stability. Step 29.5 update-check reads `settings.update_check` (top-level, fresh) so a user who edited `~/.claude/plan-tango/config.json` between runs can flip the opt-out without re-starting from scratch.
    - **Print each `warnings` entry** to the user (deprecation notices). Always print, even with `--quiet`.
    - If `lock_took_over_stale === true`, log: "Took over stale lock from prior session."
    - **Wrong-worktree guard**: if `plan_file_refs_missing_fraction > 0.5` AND `plan_file_refs_total >= 4`, most relative paths the plan references don't exist under `repo_root` — likely the run was launched from the wrong repo root (this has burned ~50-minute runs). Print the missing list (show up to ~10) and AskUserQuestion: "Most plan file refs are missing under {repo_root} — continue anyway / abort / re-run with the correct repo root?". On **abort** or **re-run** → ABORT the run (release lock via the step 30 path; for re-run, tell the user to relaunch from the correct repo root). On **continue anyway** → proceed. Skip this check entirely when the guard condition is not met.
    - **Heads-up**: print "Will call Bash(node run-codex-review.mjs) up to {state.settings.max_iter} times. Allowlist via `/fewer-permission-prompts` if you'll use this often."

State shape, params shape, ledger shape: see [references/schemas.md](references/schemas.md).

# Phase C — Loop (`while N <= max_iter`, where N = state.iter + 1)

For each iteration `N` (`state.iter` is the count of *completed* iterations, starts at 0):

10b. **Integrity check** (BEFORE snapshot, BEFORE Codex call): compute `current_hash = sha256(plan_path)` via `plan-paths.mjs --hash`. If `!== state.last_known_plan_hash` → BREAK with status=`external-modification`. Print: "Plan modified outside skill since last completed apply (expected {short(last_known)}, got {short(current)}). Skill aborts to avoid clobbering manual edits or competing automation. Inspect snapshots in {plan}.iter*-*.bak and decide whether to re-run from scratch." Skips remaining steps (no Codex call wasted; lock released in Phase E). Protects against IDE edits between iterations, second instances, or any external write.
11. **Snapshot**: `snapshot.mjs --plan <plan_path> --iter <N>`. **If quiet=false**: Print `[N/max] Snapshot: <result.snapshot>`.
12. **If quiet=false**: Print `[N/max] Sending to Codex (effort=<effort>, mode=<thread_mode>, tier=<service_tier|standard>, cwd=<repo_root>)...`.
13. **Prepare iter artifacts** via `prepare-iter.mjs` (single Bash call replaces legacy `build-prompt.mjs` + `build-params.mjs` + orchestrator-Write of `iter{N}.settings.json`). Build the codex-relevant settings JSON inline from `state.settings` (subset: `effort`, `model`, `service_tier`, `codex_profile`, `extra_codex_config` — orchestrator-only keys excluded). Then call:
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/prepare-iter.mjs \
      --slug <slug> --iter <N> \
      --plan <plan_path> \
      --repo-root <repo_root> \
      --thread-mode <thread_mode> --resume-thread-id <state.codex_thread_id|null> \
      --state-settings '<json>' \
      --workspace ~/.claude/plans/{slug}-tango.workspace \
      --template ${CLAUDE_PLUGIN_ROOT}/skills/tango/references/review-prompt-template.md
    ```
    The script writes ALL three artifacts: `iter{N}.prompt.md` (template-substituted), `iter{N}.params.json` (with `resume_thread_id` rule enforced — only set when `thread_mode=continue` AND `iter>=2` AND uuid non-null; reset_block in prompt gated by the same predicate), and `iter{N}.last-message.txt` (empty stub — wrapper also clears it before spawn). Returns `{ok, prompt_file, params_file, last_message_file, prompt_lines, prompt_bytes, params_bytes}` or `{ok:false, error, detail}`.

13b. **Build-script failure handling**: if `prepare-iter.mjs` exits non-zero OR returns stdout JSON with `ok:false`:
    - **Always print** (regardless of quiet): `[N/max] ERROR — prepare-iter.mjs failed: <error>: <detail>`.
    - Append ledger entry with `iteration_kind="normal"`, `action="build_script_failed"`, `note=<error>`.
    - Skip Codex spawn. Set status=`build-failed`, BREAK out of the loop.
    - Phase D pre-gate skips Opus on `build-failed` (status not in converged-* set). Phase E renders normally. Lock release in step 30 fires.
15. **Run Codex review** via Bash on `run-codex-review.mjs`:
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/run-codex-review.mjs <abs-path-to-iter{N}.params.json>
    ```
    Returns one JSON object on stdout (full verdict shape per [references/schemas.md](references/schemas.md)). Wrapper output is lean by default for ALLOW/BLOCK (no `raw_final_message`/`raw_output_excerpt` — full text on disk at `last_message_path`); pass `--verbose-output` (or set `PLAN_TANGO_WRAPPER_VERBOSE=1`) when verbose-report path needs raw fields.
16. **Parse verdict JSON** from the response. The wrapper returns the full shape — orchestrator does NOT re-parse the verdict text. Print (per-bullet quiet gating):
    - `verdict ∈ {ALLOW, BLOCK}` — **if quiet=false**: `[N/max] {verdict} — {C} critical, {M} major, {m} minor, {n} nit ({Xs}, evidence={true|false})`.
    - `verdict=ERROR` — **always print**: `[N/max] ERROR — reason={reason}, exit_code={ec}`.
    - `verdict=MALFORMED` — **always print**: `[N/max] MALFORMED — reason={reason}`.

16.5. **Capture thread_id** (when wrapper produced a `session_id`): hold `response.session_id` and `response.fallback_to_fresh` for this iter and pass both to `commit-iter.mjs` (step 22), which persists `state.codex_thread_id` per this rule: `fallback_to_fresh === true` → overwrite (log "Thread <old> lost, switched to <new>."); else if `state.codex_thread_id === null` AND `session_id !== null` → set (first iter in continue mode opens the persistent thread); else leave unchanged. On a terminal break before apply (no commit-iter call), the thread id is not persisted — a subsequent `--resume` re-opens a fresh thread, which is acceptable.

17. **If `verdict == ERROR`** (handle BEFORE classification):
    - `reason=codex_nonzero_exit` AND stderr contains `ENOENT|auth|401|not logged in` → ABORT, suggest: "Run `codex login` (or `/codex:setup`) and re-run."
    - `reason=codex_empty_output` → ABORT (wrapper already retried once internally; `attempts=2`, `retried_empty=true` in the response).
    - `reason=prompt_unreadable` → ABORT (workspace bug; show path).
    - `reason=params_missing|params_unreadable|params_invalid_json|wrapper_exception` → ABORT (skill-internal bug; show JSON).
    - In all cases print stderr_tail and raw_stdout snippet. Skip classification/apply.

18. **If `verdict == MALFORMED`**: one retry (re-spawn same params; fresh thread, Codex may format better). If retry MALFORMED → ABORT, show raw_final_message. If retry succeeded → re-handle through 17.

19. **Collect this iter's finding hashes** (any non-ABORT path). Do NOT push them into `state.findings_history` here — evaluate-stop (step 21) needs the prior-iters-only window, and `commit-iter.mjs` (step 22) performs the single push after apply. `apply-fixes.mjs` derives each finding's hash as sha1 of the normalized `"severity :: title"` (fallback: normalized `problem[:80]`), so hashes are stable across re-phrasings of the same defect.

20. **Dry-run classification** (only when `verdict=BLOCK` with non-empty findings): pipe `{plan_path, findings}` to `apply-fixes.mjs`. Read `classified[]`, `edit_plan[]`, `ledger_template[]`, `advisory_plan[]`, `invariant_summary`.

21. **Stop conditions** — delegate to `evaluate-stop.mjs` (deterministic; replaces the hand-computed severity counts and findings_history set-diffs). Build the input JSON and pipe it in (forward-slash paths are the documented convention; the scripts also tolerate backslashes, but keep forward slashes):
    ```bash
    printf '%s' '<json>' | node ${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/evaluate-stop.mjs
    ```
    Input: `{verdict, findings, classified, settings:{severity_aware, lenient, max_iter}, current_iter:N, history, prev_severity_counts?, fresh_thread_fallback?}` where:
    - `findings` = this iter's verdict findings; `classified` = step 20 output (empty array on ALLOW).
    - `settings.*` from `state.settings`.
    - `history` = `state.findings_history` — prior iters only, oldest first, NOT this iter's hashes (they are not pushed until step 22).
    - `prev_severity_counts` = the previous iter's `severity_counts` (from the prior ledger entry; omit on iter 1) — enables regression detection.
    - `fresh_thread_fallback` = `response.fallback_to_fresh`.
    Returns `{ok:true, action:"continue"|"break", status, reason, human_note}`. Exit 2 only on malformed input (skill bug → ABORT and dump the JSON). Branch priority (a → a2 → b → c → d → e-oscillation → f-stuck → g-regression → h-max-iter → continue) is enforced inside the script; off-plan branches are gone.

    **Map the returned `status` to handling** (keep these human-facing behaviors):
    - `action:"continue"` (status `continue`) → proceed to step 22 apply. If `reason === "regression_suppressed_fresh_thread"`, print `human_note` (a fresh-thread reviewer being more thorough is not a regression).
    - `converged` → BREAK.
    - `converged-with-polish` / `converged-lenient` (severity-aware polish-only stop) → BREAK. Build `state.polish_advisory = [...advisory_plan]` (covers ALL deduped findings incl. manual-classified, unlike `edit_plan[]`); set `state.polish_only_terminal = true`; append `iteration_kind="normal"` ledger entries, one per polish_advisory record: `{hash, severity, action:"advisory", note:"polish_only_terminal"}`. **Apply phase NOT called** — plan file unchanged. Falls through to Phase D pre-gate (Opus may catch architectural issues Codex missed).
    - `manual-required` → BREAK. Print the manual-flagged findings (severity, title, location, problem, suggested_fix) so the user can decide outside the skill — edit the plan manually and re-run, or re-run with different `--effort`. (MANUAL_PATTERNS regex in `apply-fixes.mjs` flags these so they never auto-apply.)
    - `oscillating` / `stuck` → BREAK. (`stuck` = identical finding set two iters running; `oscillating` = a finding resolved then reappeared.)
    - `regressed` → BREAK. Offer rollback to `iter{N-1}.bak`.
    - `max-iter-reached` → **interactive continue-prompt** (do NOT break immediately). AskUserQuestion: "Reached max-iter limit ({max_iter}). Current findings: {C} critical, {M} major, {m} minor, {n} nit. Continue?" Options: "Continue +4", "Continue +N (custom)", "Stop here (status=max-iter-reached)", "Abort run".
       - On abort → BREAK status=`aborted-by-user`.
       - On continue: `new_max = max_iter + extra`. **Hard cap**: if `new_max > 12` → refuse with "Hard cap is 12. For larger budgets re-run with explicit `--max-iter <N>` (still capped at 12) or split the plan." Re-prompt with Stop/Abort only. Otherwise update `state.settings.max_iter`, write state, log "Continuing to iter {next} (new cap: {new_max})", fall through to step 22.
       - On stop → BREAK status=`max-iter-reached`. **Then, if `state.settings.final_check !== "always"`, AskUserQuestion offering one Opus final-check on the current plan** (a real session shipped an undetected major that only Opus caught after max-iter). On accept → run step 26 (spawn `plan-tango:plan-final-checker`, `mode="full"`) and surface its verdict as advisory — no corrective iter; on decline → Phase E.
    (`ALLOW + findings` and `BLOCK + zero findings` are caught upstream by the parser as MALFORMED, so evaluate-stop only ever sees a clean ALLOW/BLOCK.)

22. **Apply phase + commit** (runs on every `action:"continue"` iteration). The **Edit loop** below runs only when classification produced at least one `auto` entry; a deferred/advisory-only iter skips the Edit loop but STILL writes ledger entries and calls `commit-iter.mjs` (otherwise `state.iter` never advances and oscillation/stuck detection breaks).

    **`apply-fixes.mjs` is a CLASSIFIER ONLY**: it returns metadata (`{hash, severity, file_path, location_hint, title, problem, suggested_fix}` + classification `auto`/`deferred`/`manual`). The orchestrator converts each classified finding into a real `Edit` call by interpreting Codex's natural-language `suggested_fix` against the plan text — there is no automatic translation from finding to old_string/new_string.

    - **Plan-only invariant**: `apply-fixes.mjs` always sets `edit_plan[i].file_path = plan_path` by construction, so every Edit targets the plan file. `invariant_summary` is the constant `{all_in_plan:true, off_plan_count:0, off_plan_blocking:false}` and `requested_file_path` is always `null` (mention-based off-plan detection was removed in 0.7.0 — see `<critical_invariants>`). No pre-Edit off-plan check is needed.

    - **Apply** (per auto entry; process severity-first across the batch — critical → major → minor → nit):
      1. **Re-read plan content** before each finding (earlier Edits in this iter change the text).
      2. **Anchor search**: extract a unique anchor from `location_hint` or a quoted snippet inside `problem`/`suggested_fix`. Not found → `action=deferred`, `note="anchor_not_found"`. Ambiguous (>1 match without line-number disambiguation) → `action=deferred`, `note="anchor_ambiguous"`. Anchor clobbered by an earlier Edit this iter → `action=deferred`, `note="anchor_clobbered_by_earlier_edit"`. Unique → proceed.
      3. **Construct Edit** by interpreting `suggested_fix` against the matched section. Minimal `old_string`/`new_string`, tight scope (do not rewrite surrounding paragraphs). For non-mechanical intent ("add error handling" etc.), best interpretation that satisfies the intent; prefer additive over restructuring.
      4. **Execute Edit**. On error → `action=deferred`, `note="edit_tool_rejected: <error_short>"`. On success → `action=applied`, record `edit_summary` (e.g. "+5/-2 lines in §Phase B").
      5. **Verify**: re-grep the anchor area (defense against accidental no-op when old_string===new_string).
    - **Append ledger entries** to `~/.claude/plans/{slug}-tango.ledger.json` (create with skeleton on first write). Per-finding shape see [references/schemas.md](references/schemas.md). `commit-iter.mjs` does NOT touch the ledger — these per-finding entries are still written by the orchestrator during apply.
    - **Commit the iteration** via `commit-iter.mjs` (deterministic bookkeeping — replaces the hand-rolled findings_history push, last_known_plan_hash recompute, thread-id persistence, iter bump, and lock refresh, which one real session got wrong by double-pushing findings_history). Pipe JSON to stdin (forward-slash paths):
        ```bash
        printf '%s' '<json>' | node ${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/commit-iter.mjs
        ```
        stdin: `{state_path, iter:N, plan_path, finding_hashes:[...], verdict, codex_thread_id:<session_id|null>, fallback_to_fresh, lock:{slug, session_id}, history_window:3}`. It refreshes the lock FIRST (session mismatch aborts WITHOUT committing), then recomputes `last_known_plan_hash` from the (edited) plan file, pushes the finding-hash set into `findings_history` (trimmed to `history_window`), persists `codex_thread_id` per the step-16.5 rule, bumps `state.iter`, and stamps `updated_at` — atomically (tmp+rename).
        - stdout success `{ok:true, iter, last_known_plan_hash, findings_history_len, codex_thread_id, codex_thread_id_changed, lock_refreshed, updated_at}`.
        - `{ok:false, reason:"iter_already_committed"}` (exit 0) → the iteration was already committed (e.g. a retried call); treat as already-done, do NOT retry.
        - `{ok:false, reason:"iter_out_of_sequence"}` (exit 0) → state/iter drift; ABORT and show state.
        - `{ok:false, reason:"lock_refresh_failed"}` (exit 0) → someone took over the lock; ABORT.
        - Exit 2 → malformed input (skill bug); ABORT and dump the JSON.
    - **If quiet=false**: Print `[N/max] Applied {k} fixes (+{added}/-{removed} lines), deferred {d}. Starting iter {N+1}.`
23. **Loop.** (`state.iter` was already bumped by `commit-iter.mjs` in step 22.)

# Phase D — Final Check (after loop break)

24. **Pre-gate (v0.2 — single rule):** run Opus full-mode if **both** clauses hold; otherwise skip:
    - **(a) status eligible:** see table below.
    - **(b) settings opt-in:** `state.settings.final_check === "always"` (single normalized output of `load-config.mjs`; CLI > config > default).

    Phase D does NOT re-inspect raw CLI flags or raw config values; the decision is settled in `state.settings.final_check`.

    | status | Opus runs when `final_check === "always"`? |
    |---|---|
    | `converged`, `converged-lenient`, `converged-with-polish` | YES (full mode) |
    | `manual-required`, `stuck`, `regressed`, `max-iter-reached`, `oscillating`, `external-modification`, `build-failed`, `aborted-by-user`, `final-check-malformed`, `final-recheck-error`, `final-recheck-malformed` | NO |

25. _(Auto-gate keyword triggers — removed in v0.2; see [references/final-check.md](references/final-check.md) for historical detail.)_
26. **Run final check**: spawn `plan-tango:plan-final-checker` with `{plan_path, repo_root, mode}`. Receive raw text output. Pipe through `parse-codex-verdict.mjs --from-text` via Bash. If parser returns `verdict=MALFORMED` → ONE retry of the subagent with reminder "Your last response did not start with ALLOW: or BLOCK:. Repeat with correct format". If retry MALFORMED → BREAK status=`final-check-malformed`, show raw output.
27. _(Diagnostic mode — removed in v0.2.)_ Pre-gate (step 24) makes non-converged statuses ineligible regardless of settings.
28. **Full mode** (converged-*):
    - **28a (clean)**: `verdict == ALLOW` AND findings empty → BREAK status=`converged-final`.
    - **28a-polish (Opus polish-only)**: `verdict == BLOCK` AND `findings.length > 0` AND `count(critical) + count(major) === 0` → BREAK status=`converged-final`. **No corrective iter.**
      1. Run dry-run classify on Opus findings via `apply-fixes.mjs`.
      2. Build `opus_advisory = [...advisory_plan]`.
      3. Set `state.polish_only_terminal = true`. Merge `opus_advisory` into `state.polish_advisory` (append + dedupe by hash).
      4. Append ledger `iteration_kind="final-check-advisory"`, one row per opus_advisory entry: `{hash, severity, action: "advisory", note: "opus_polish_only"}`.
      5. Show: "Final-check found {n} polish findings (advisory, see §6 of report)".
    - **28b (critical or major)**: print "Final-check found {C} critical, {M} major. Running one corrective iteration..."
      1. Snapshot via `snapshot.mjs --iter final-fix`.
      2. Dry-run classify on Opus findings.
      3. If `manual` or critical/major `deferred` → BREAK status=`manual-required-after-final`.
      4. _(Off-plan check removed in 0.7.0 — Edits always target the plan file.)_
      5. Apply fixes (same as step 22 apply); append ledger with `iteration_kind="final-fix"`. Recompute last_known_plan_hash (reuse `commit-iter.mjs` if you also want the atomic state bump, or write the hash directly — the final-fix iteration is outside the normal iter counter).
      6. ONE Codex re-review: call `run-codex-review.mjs` again with fresh params.
         - ALLOW → BREAK status=`converged-final`.
         - BLOCK → BREAK status=`final-check-divergence` (Opus and Codex disagree). Show both finding sets. Ask user to resolve.
         - ERROR → BREAK status=`final-recheck-error`.
         - MALFORMED → ONE retry. If retry MALFORMED → BREAK status=`final-recheck-malformed`.
      7. Do NOT run a second Opus final-check. The corrective iteration is the final word.

# Phase E — Summary

29. **Print convergence report.** Source data: `state.findings_history`, `~/.claude/plans/{slug}-tango.ledger.json`, original-vs-current plan hash + size.

    Templates for §2/§3/§5/§6 live in [references/report-format.md](references/report-format.md). Inline summary:

    - **§1** — one-line header, user's chat language ("Plan-converge done." / "Plan-converge завершён.").
    - **§2** — markdown-code-fenced stats block (status, iter count, Codex/Opus call counts, MALFORMED retries, polish flags, plan size delta, ledger/state paths). Always rendered.
    - **§3** — convergence table (per-iter verdict + severity counts). Render only when `state.settings.verbose_report === true`.
    - **§4** — "What Codex caught and fixed", numbered list. Source: ledger.json entries with `action ∈ {applied, deferred, manual}`. By severity (critical → major → minor → nit), one line: `N. **{severity}** — {short title}.` Cap at ~12; "…and {K} more (see ledger)" suffix when over.
    - **§5** — 1-3 sentence convergence narrative. Render only when `verbose_report === true`.
    - **§6** — polish advisory list. Render only when `state.polish_only_terminal === true` AND `state.polish_advisory.length > 0`.

    **Skip rules**: §3+§4+§5 skipped only when N=0 (Phase A abort). §1+§2 always render when N≥1. §3+§5 also skipped when `verbose_report=false` (default).

29.5. **Update notice check.** Independent of §3/§5 verbose-report gating; runs after step 29 report rendering, before step 30 lock release. Skip entirely when `settings.update_check === false` (top-level `settings`, not `state.settings` — see Phase A step 4 binding rationale).

    ```bash
    # Read current plan-tango version once
    CURR_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CLAUDE_PLUGIN_ROOT + '/.claude-plugin/plugin.json', 'utf8')).version)")
    node ${CLAUDE_PLUGIN_ROOT}/skills/tango/scripts/update-check.mjs --current-version "$CURR_VER"
    ```

    Parse the JSON response. The script always exits 0 and always emits JSON:
    - `status === "newer-available"` → print exactly one line to user: `\n<response.message>` (already formatted with the `/plan-tango:update` hint).
    - `status ∈ {ok, skipped, error}` → print nothing. Silent.

    The script is fail-silent on its own (network timeout, missing git, invalid cache) — orchestrator does NOT branch on stderr or exit codes. If the Bash call itself crashes (unlikely but possible), swallow the error and continue to step 30. Update-check is never blocking.

30. **Release lock — ONLY if it was actually acquired.** The orchestrator tracks `lock_acquired` based on what `init.mjs` returned (Phase A step 4): `true` on `ok:true`, `true` only when init reported the race-fallback case `ok:false + lock_acquired:true`, otherwise `false`. The orchestrator never attempts release on early init failures (`init.mjs` either internally cleaned up or never acquired the lock — placeholder values would crash with `invalid_slug` / `missing_session_id`, masking the real abort reason).
    - **`lock_acquired === true`** → `lock.mjs release --slug <slug> --session <lock_session_id>`. On `session_mismatch` log warning, do NOT delete (someone took over). On `lock_missing` no-op, fine.
    - **`lock_acquired === false`**: skip release entirely.
    - This is the ONLY thing letting future runs start. Crash between iter and release with `lock_acquired === true` not having released → next run sees a 30-min stale window before allowed to acquire (or use --takeover sooner).
31. Optionally cleanup workspace: `workspace.mjs cleanup --slug <slug>` if status is terminal-success (`converged-final`, `converged`, `converged-lenient`, `converged-with-polish`). Keep workspace for failed runs so user can inspect.

</process>

<critical_invariants>
The orchestrator must enforce these during the run. Script-enforced and informational invariants (sandbox, subagent-no-Edit, style rules) live in [references/invariants.md](references/invariants.md).

- **Plan-only invariant** (canonical; referenced by step 22): Edits target the plan file only — `edit_plan[].file_path` is always `plan_path` by classifier construction. Mention-based off-plan detection was removed in 0.7.0 (field data across sessions: 14 flagged, 14 false positives, 0 true), so `apply-fixes.mjs` now always reports `requested_file_path:null` and the constant `invariant_summary` `{all_in_plan:true, off_plan_count:0, off_plan_blocking:false}`. No pre-Edit off-plan check runs anywhere.
- **Thread invariant**: in `thread_mode=continue` (default), iter 1 opens a Codex thread (saved as `state.codex_thread_id`); iters 2..N call `codex exec resume <id>` AND inject the `<reset_iteration>` block to limit anchor bias. In `thread_mode=fresh` every iteration opens a new thread. On lost-session error the wrapper auto-fallbacks to fresh and reports `fallback_to_fresh:true`; orchestrator unconditionally overwrites `state.codex_thread_id` (step 16.5).
- **Lock invariant** (Phase A step 2 init.mjs → Phase E step 30): exactly one lock per slug for the run's lifetime. `--resume` re-acquires (state remembers slug; session_id is regenerated each invocation). Release is gated on `lock_acquired === true`. `init.mjs` releases internally if a step AFTER lock-acquire fails; race-fallback (cleanup itself fails) returns `lock_acquired:true` for orchestrator to retry release in Phase E.
- **Integrity invariant** (step 10b): before every iteration, `sha256(plan)` MUST equal `state.last_known_plan_hash`. Mismatch = external modification = abort the cycle.
- **Resume-safety invariant** (enforced by `init.mjs`): `--resume` MUST NOT use the `--newest` fallback. Resume requires explicit slug/path or active plan in system prompt — init returns `abort_reason: resume_no_plan` otherwise.
- **Max-iter hard cap invariant**: `state.settings.max_iter` MUST NOT exceed 12 — neither via initial `--max-iter` nor via the continue-prompt at step 21 (max-iter-reached).
- **Severity-aware invariant** (step 21 a2): when `severity_aware=true` (default), a BLOCK with zero critical+major is TERMINAL, NOT a corrective trigger. Polish findings persist to `state.polish_advisory` (sourced from `apply-fixes.mjs` `advisory_plan[]`, deduped, includes manual-classified) and render in Phase E §6 — never auto-applied. Status branches on `lenient`: true → `converged-lenient`, false → `converged-with-polish`. Step 21 (a2) is the single termination point under this mode; legacy step 21 (d) is unreachable.
</critical_invariants>

<diagnostics>
The skill prints one or two lines per iteration. Counter-progress is visible:
- Iteration count grows but findings counts don't drop → suspect oscillation; the detector should catch it but user can Ctrl-C earlier.
- ERROR at iter 1 with reason `codex_nonzero_exit` → first thing to check is `codex --version` (CLI installed?) and `codex login` status.
- Every snapshot is `~/.claude/plans/{slug}.iter{N}-*.bak` — manual rollback is `cp <bak> <plan>`.
</diagnostics>
