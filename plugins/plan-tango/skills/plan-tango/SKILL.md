---
name: plan-tango
description: "Auto-converge a Claude-written plan with Codex (gpt-5) review. Loops Codex review → Claude fixes → re-review until clean ALLOW or max-iter. Works inside plan mode on the active plan file. Use when you've drafted a plan and want external AI review without manual copypaste."
argument-hint: "[plan-path-or-slug] [--max-iter N (default 6, cap 12)] [--effort none|minimal|low|medium|high|xhigh] [--model <m>] [--lenient] [--final-check] [--no-final-check] [--resume] [--takeover] [--continue-thread|--fresh-each] [--fast | --service-tier fast|flex] [--codex-profile <name>] [--quiet] [--verbose-report]"
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
- **User config** (optional): `~/.claude/plan-tango/config.json`. CLI overrides. Schema: `${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/user-config.example.json`.
- **Helper scripts** at `${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/`:
  - `plan-paths.mjs` (validate/newest/list-recent/resolve-repo/hash), `workspace.mjs` (ensure/cleanup), `snapshot.mjs`, `lock.mjs` (acquire/refresh/release/inspect), `apply-fixes.mjs` (dry-run classifier → edit_plan + ledger_template + advisory_plan), `parse-codex-jsonl.mjs`, `parse-codex-verdict.mjs`.
  - `load-config.mjs` — merges CLI + config + defaults; emits `{merged, sources, warnings}`.
  - `prepare-iter.mjs` — single deterministic builder for ALL iter{N} artifacts: `iter{N}.prompt.md`, `iter{N}.params.json`, empty stub `iter{N}.last-message.txt`. Settings come inline via `--state-settings '<json>'` — no per-iter `iter{N}.settings.json` Write needed (step 13).
  - `run-codex-review.mjs` — `codex exec` wrapper (called directly via Bash from step 15). Filters cosmetic rollout-recording stderr (see `references/codex-thread-investigation.md`). Retries `codex_empty_output` once internally before reporting.
- **Subagent** at `${CLAUDE_PLUGIN_ROOT}/agents/`: `plan-tango:plan-final-checker` (opus, sanity check on converged statuses — Phase D only).
- **Templates**: `references/review-prompt-template.md`, `references/verdict-contract.md`. Schemas (state, params, ledger, verdict): [references/schemas.md](references/schemas.md).
</execution_context>

<context>
Args from `$ARGUMENTS`:
- positional `plan-path-or-slug` — optional. If absent: active plan from system prompt → newest in `~/.claude/plans/` → AskUserQuestion. **Exception**: `--resume` disables the `--newest` fallback (see Phase A).
**Common flags**:
- `--max-iter N` (default 6, hard cap 12; at the cap step 21h prompts +4 / custom / stop / abort).
- `--effort none|minimal|low|medium|high|xhigh` (default `high`; `minimal` is rejected by Codex when image_gen/web_search are on — use `low` for fast).
- `--model <m>` (default unset — Codex picks from `~/.codex/config.toml`).
- `--lenient` — stop on "no critical/major" instead of strict ALLOW.
- `--final-check` — opt in to Opus sanity-check on converged statuses (sets `final_check="always"`; mutually exclusive with `--no-final-check`).
- `--resume` — resume from saved state for the same slug.
- `--takeover` — override stale-but-readable lock (corrupt locks always require it).
- `--continue-thread` / `--fresh-each` — thread mode override; default `continue` (reuses one Codex thread; injects `<reset_iteration>` block at iter ≥ 2).
- `--quiet` — suppress per-iteration progress in Phase C. Phase A heads-up, Phase B init, ERROR/MALFORMED bullets, ABORT messages, AskUserQuestion prompts, and Phase E final report ALWAYS print.
- `--verbose-report` — opt in to Phase E §3 (convergence table) + §5 (narrative). Default off; §1+§2+§4 (and §6 when polish_only_terminal) always render.

**Advanced**: `--fast` (alias for `--service-tier fast`; needs `features.fast_mode=true`); `--service-tier <fast|flex>`; `--codex-profile <name>`. **Deprecated aliases (still work, print warning, removed in v0.3)**: `--no-final-check` (disable override), `--force-final-check` (same as `--final-check`).
</context>

<process>

# Phase A — Validation

1. **Resolve plan-path** (priority order):
   1. Explicit positional arg (normalize: absolute > relative-to-cwd > slug under `~/.claude/plans/`).
   2. Active plan from system prompt ("Plan File Info" / "plan file at" → path under `~/.claude/plans/`).

   **Without `--resume`** (fresh): try `plan-paths.mjs --newest`, then AskUserQuestion with `--list-recent 5`.

   **With `--resume`** (no `--newest` fallback): ABORT with "Cannot --resume without an explicit plan path/slug or active plan. Re-run /plan-tango <slug-or-path> --resume to be unambiguous." Optionally AskUserQuestion listing slugs that have `*-tango.state.json`.
2. **Validate** via `plan-paths.mjs --validate <path>`. Helper checks existence, size ≥ 200 bytes, realpath under `~/.claude/plans/`. On non-zero exit, ABORT with the helper's `reason`.
3. **Verify codex CLI**: `codex --version` via Bash. Exit ≠ 0 → ABORT with: "Codex CLI not found on PATH. Install with `npm install -g @openai/codex`, then run `codex login` (or `/codex:setup`). Re-run /plan-tango once codex --version succeeds." Save the version string for state (step 8).
4. **Resolve repo-root** via `plan-paths.mjs --resolve-repo --cwd <process.cwd> --plan <plan_path>`. Use the returned `repo_root` and `repo_evidence_available`. **v0.2:** `repo_evidence_available` is now ALWAYS `true`. The old git-required gate forced text-only review on legitimate cases (pre-`git init` projects, monorepos with non-git toolchains). With sandbox=read-only and prompt grounding rules, allowing investigation in any cwd is safe.
5. **Heads-up**: print "Will call Bash(node run-codex-review.mjs) up to {max_iter} times. Allowlist via `/fewer-permission-prompts` if you'll use this often."

# Phase B — Init

**Critical ordering:** lock acquisition MUST precede any state/workspace writes. Otherwise a second concurrent run can corrupt state files before its `lock_held` abort fires.

6. `slug = path.basename(plan_path, '.md')`.
7. **Acquire lock FIRST**: `lock.mjs acquire --slug <slug> --plan <plan_path>` (add `--takeover` if user passed it).
   - Save the returned `session_id` for the rest of the run (every refresh/release uses it).
   - On `lock_held` → ABORT (existing session, age, hint). Do NOT proceed. Do NOT touch state or workspace.
   - On `lock_corrupt` (no `--takeover`) → ABORT, suggest: "Inspect with `lock.mjs inspect --slug <slug>`; if no parallel run, re-run with --takeover."
   - On `cannot_takeover_fresh_lock` → ABORT (fresh lock, takeover refused).
   - On success → set `lock_acquired = true` (orchestrator-side flag, see step 30). Log if `took_over_stale:true`.
8. `state_path = ~/.claude/plans/{slug}-tango.state.json`. State shape and field semantics: see [references/schemas.md](references/schemas.md).
8.5. **Load merged settings** via `load-config.mjs --merge --cli '<json>'`. Orchestrator builds CLI JSON with these keys (using `_` for `-`): `max_iter`, `effort`, `model`, `lenient`, `quiet`, `verbose_report_flag`, `final_check_flag` (canonical, set by `--final-check`), `no_final_check` (deprecated alias), `force_final_check` (deprecated alias), `continue_thread`, `fresh_each`, `fast`, `service_tier`, `codex_profile`.
   - On exit 2 / `error` field present (validation failure or conflict like `--no-final-check + --final-check`) → ABORT with helper's `error`/`detail`. Release the lock acquired in step 7.
   - On success: parse stdout `{merged, sources, warnings}`. Set `state.settings = merged`, `state.settings_sources = sources`. Verify `state.settings.max_iter ≤ 12` defensively. **Print each `warnings` entry to the user** (deprecation notices). Always print, even with `--quiet`.
   - **Skip-loader bypass** (defensive): if env `PLAN_TANGO_NO_CONFIG_LOADER=1`, skip step 8.5 and apply legacy defaults inline (max_iter=6, effort=high, thread_mode=continue, final_check=never, lenient=false, service_tier=null, codex_profile=null, extra_codex_config=[], quiet=false, verbose_report=false, severity_aware=true; warnings=[]).
9. **If `--resume`**: load state, compute `current_hash = sha256(plan)`. If `current_hash !== state.last_known_plan_hash` → ABORT: "Plan modified outside skill since last completed iteration (expected {short(last_known)}, got {short(current)}). Re-run without --resume to start fresh." Release the lock per Phase E rules. Otherwise resume from `state.iter + 1`.
10. **Else (fresh)**: write state with `original_plan_hash = last_known_plan_hash = sha256(plan)`, `iter=0`, settings populated.
11. **Ensure workspace dir**: `workspace.mjs ensure --slug <slug>`.

# Phase C — Loop (`while N <= max_iter`, where N = state.iter + 1)

For each iteration `N` (`state.iter` is the count of *completed* iterations, starts at 0):

10b. **Integrity check** (BEFORE snapshot, BEFORE Codex call): compute `current_hash = sha256(plan_path)` via `plan-paths.mjs --hash`. If `!== state.last_known_plan_hash` → BREAK with status=`external-modification`. Print: "Plan modified outside skill since last completed apply (expected {short(last_known)}, got {short(current)}). Skill aborts to avoid clobbering manual edits or competing automation. Inspect snapshots in {plan}.iter*-*.bak and decide whether to re-run from scratch." Skips remaining steps (no Codex call wasted; lock released in Phase E). Protects against IDE edits between iterations, second instances, or any external write.
11. **Snapshot**: `snapshot.mjs --plan <plan_path> --iter <N>`. **If quiet=false**: Print `[N/max] Snapshot: <result.snapshot>`.
12. **If quiet=false**: Print `[N/max] Sending to Codex (effort=<effort>, mode=<thread_mode>, tier=<service_tier|standard>, cwd=<repo_root>)...`.
13. **Prepare iter artifacts** via `prepare-iter.mjs` (single Bash call replaces legacy `build-prompt.mjs` + `build-params.mjs` + orchestrator-Write of `iter{N}.settings.json`). Build the codex-relevant settings JSON inline from `state.settings` (subset: `effort`, `model`, `service_tier`, `codex_profile`, `extra_codex_config` — orchestrator-only keys excluded). Then call:
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/prepare-iter.mjs \
      --slug <slug> --iter <N> \
      --plan <plan_path> \
      --repo-root <repo_root> --repo-evidence <repo_evidence_available> \
      --thread-mode <thread_mode> --resume-thread-id <state.codex_thread_id|null> \
      --state-settings '<json>' \
      --workspace ~/.claude/plans/{slug}-tango.workspace \
      --template ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/references/review-prompt-template.md
    ```
    The script writes ALL three artifacts: `iter{N}.prompt.md` (template-substituted), `iter{N}.params.json` (with `resume_thread_id` rule enforced — only set when `thread_mode=continue` AND `iter>=2` AND uuid non-null; reset_block in prompt gated by the same predicate), and `iter{N}.last-message.txt` (empty stub — wrapper also clears it before spawn). Returns `{ok, prompt_file, params_file, last_message_file, prompt_lines, prompt_bytes, params_bytes}` or `{ok:false, error, detail}`.

13b. **Build-script failure handling**: if `prepare-iter.mjs` exits non-zero OR returns stdout JSON with `ok:false`:
    - **Always print** (regardless of quiet): `[N/max] ERROR — prepare-iter.mjs failed: <error>: <detail>`.
    - Append ledger entry with `iteration_kind="normal"`, `action="build_script_failed"`, `note=<error>`.
    - Skip Codex spawn. Set status=`build-failed`, BREAK out of the loop.
    - Phase D pre-gate skips Opus on `build-failed` (status not in converged-* set). Phase E renders normally. Lock release in step 30 fires.
15. **Run Codex review** via Bash on `run-codex-review.mjs`:
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/skills/plan-tango/scripts/run-codex-review.mjs <abs-path-to-iter{N}.params.json>
    ```
    Returns one JSON object on stdout (full verdict shape per [references/schemas.md](references/schemas.md)). Wrapper output is lean by default for ALLOW/BLOCK (no `raw_final_message`/`raw_output_excerpt` — full text on disk at `last_message_path`); pass `--verbose-output` (or set `PLAN_TANGO_WRAPPER_VERBOSE=1`) when verbose-report path needs raw fields.
16. **Parse verdict JSON** from the response. The wrapper returns the full shape — orchestrator does NOT re-parse the verdict text. Print (per-bullet quiet gating):
    - `verdict ∈ {ALLOW, BLOCK}` — **if quiet=false**: `[N/max] {verdict} — {C} critical, {M} major, {m} minor, {n} nit ({Xs}, evidence={true|false})`.
    - `verdict=ERROR` — **always print**: `[N/max] ERROR — reason={reason}, exit_code={ec}`.
    - `verdict=MALFORMED` — **always print**: `[N/max] MALFORMED — reason={reason}`.

16.5. **Save thread_id to state** (when wrapper produced a `session_id`): apply this rule to `state.codex_thread_id`:
    - `response.fallback_to_fresh === true` → always overwrite `state.codex_thread_id = response.session_id`. Log: "Thread <old> lost, switched to <new>."
    - Else if `thread_mode === "continue"` AND `state.codex_thread_id === null` AND `session_id !== null` → save (first iter in continue mode opens the persistent thread).
    - Else → leave unchanged.
    Write state immediately so Ctrl-C between iters preserves the thread for `--resume`.

17. **If `verdict == ERROR`** (handle BEFORE classification):
    - `reason=codex_nonzero_exit` AND stderr contains `ENOENT|auth|401|not logged in` → ABORT, suggest: "Run `codex login` (or `/codex:setup`) and re-run."
    - `reason=codex_empty_output` → ABORT (wrapper already retried once internally; `attempts=2`, `retried_empty=true` in the response).
    - `reason=prompt_unreadable` → ABORT (workspace bug; show path).
    - `reason=params_missing|params_unreadable|params_invalid_json|wrapper_exception` → ABORT (skill-internal bug; show JSON).
    - In all cases print stderr_tail and raw_stdout snippet. Skip classification/apply.

18. **If `verdict == MALFORMED`**: one retry (re-spawn same params; fresh thread, Codex may format better). If retry MALFORMED → ABORT, show raw_final_message. If retry succeeded → re-handle through 17.

19. **Update state** (any non-ABORT path): append current findings hashes to `findings_history`, drop oldest if length > 3.

20. **Dry-run classification** (only when `verdict=BLOCK` with non-empty findings): pipe `{plan_path, findings}` to `apply-fixes.mjs`. Read `classified[]`, `edit_plan[]`, `ledger_template[]`, `advisory_plan[]`, `invariant_summary`.

21. **Stop conditions** (priority order):
    a) `verdict == ALLOW` and findings empty → BREAK status=`converged`.
    a2) **Severity-aware polish-only stop** (default, see `severity_aware` setting): `severity_aware=true` AND `verdict=BLOCK` AND `findings.length>0` AND `count(critical) + count(major) === 0` → BREAK. Status branches on lenient: `lenient ? "converged-lenient" : "converged-with-polish"`.
       - **Hash sourcing**: build `state.polish_advisory = [...advisory_plan]` (covers ALL deduped findings including manual-classified, unlike `edit_plan[]`). Set `state.polish_only_terminal = true`.
       - **Ledger**: append `iteration_kind="normal"` entries, one per polish_advisory record: `{hash, severity, action: "advisory", note: "polish_only_terminal"}`.
       - **Apply phase NOT called.** Plan file is not modified at this stop.
       - Falls through to Phase D pre-gate (Opus may catch architectural issues Codex missed).
    b) Any classified finding with `classification=manual` → BREAK status=`manual-required`. **v0.2:** print the manual-flagged findings (severity, title, location, problem, suggested_fix) so the user can decide outside the skill — edit the plan manually and re-run, or re-run with different `--effort`. The legacy AskUserQuestion apply-A/apply-B/skip/abort UI is removed; MANUAL_PATTERNS regex in `apply-fixes.mjs` still flags findings (so they don't auto-apply).
    c) Any classified finding with `severity ∈ {critical, major}` AND `classification=deferred` → BREAK status=`manual-required` (same branch).
    d) `--lenient` set AND `BLOCK` with findings AND zero critical/major → BREAK status=`converged-lenient`. Checked AFTER b/c so lenient cannot bypass manual. Unreachable when `severity_aware=true` (a2 fires first).
    e) **Oscillation**: any finding hash in `findings_history[N-2]` but NOT `findings_history[N-1]` → BREAK status=`oscillating`.
    f) **Stuck**: `findings_history[N-1]` set equals current findings set → BREAK status=`stuck`.
    g) **Regression**: count(critical) in current > count(critical) in N-1 → BREAK status=`regressed`. Offer rollback to `iter{N-1}.bak`.
    h) `N === state.settings.max_iter` (last permitted iter in current cap) → **interactive continue-prompt** (do NOT break immediately). AskUserQuestion: "Reached max-iter limit ({max_iter}). Current findings: {C} critical, {M} major, {m} minor, {n} nit. Continue?" Options: "Continue +4", "Continue +N (custom)", "Stop here (status=max-iter-reached)", "Abort run".
       - On stop → BREAK status=`max-iter-reached`. On abort → BREAK status=`aborted-by-user`.
       - On continue: `new_max = max_iter + extra`. **Hard cap**: if `new_max > 12` → refuse with "Hard cap is 12. For larger budgets re-run with explicit `--max-iter <N>` (still capped at 12) or split the plan." Re-prompt with Stop/Abort only. Otherwise update `state.settings.max_iter`, write state, log "Continuing to iter {next} (new cap: {new_max})", fall through to step 22.
    (`ALLOW + findings` and `BLOCK + zero findings` are caught upstream by the parser as MALFORMED.)

22. **Apply phase** (only when classification produced edit_plan with at least one auto entry).

    **`apply-fixes.mjs` is a CLASSIFIER ONLY**: it returns metadata (`{hash, severity, file_path, location_hint, title, problem, suggested_fix, requested_file_path?}` + classification `auto`/`deferred`/`manual`). The orchestrator converts each classified finding into a real `Edit` call by interpreting Codex's natural-language `suggested_fix` against the plan text — there is no automatic translation from finding to old_string/new_string.

    - **Off-plan invariant check**: live `apply-fixes.mjs` always sets `edit_plan[i].file_path = plan_path` for non-manual entries (target is always the plan file). Off-plan findings are signaled via `edit_plan[i].requested_file_path !== null` AND/OR `invariant_summary.off_plan_count > 0` / `off_plan_blocking === true`. Detect off-plan via `requested_file_path`, NOT by comparing `file_path` to `plan_path` (always equal by construction).
      - For each `edit_plan[i]` with `requested_file_path !== null`:
        - severity ∈ {critical, major} → BREAK status=`off-plan-target`. Append ledger entries `iteration_kind="normal"`, `action="off_plan_blocked"`, fields `requested_file_path` and `suggested_fix`. Show user the list and stop.
        - severity ∈ {minor, nit} → log `action=deferred`, `note="off-plan-file target"` and `requested_file_path`, but continue applying in-plan entries.
      - Cross-check `invariant_summary.off_plan_blocking`: if true and we did not break above, that's a logic bug — abort status=`off-plan-target` and dump the full classified array.

    - **Apply** (per in-plan auto entry; process severity-first across the batch — critical → major → minor → nit):
      1. **Re-read plan content** before each finding (earlier Edits in this iter change the text).
      2. **Anchor search**: extract a unique anchor from `location_hint` or a quoted snippet inside `problem`/`suggested_fix`. Not found → `action=deferred`, `note="anchor_not_found"`. Ambiguous (>1 match without line-number disambiguation) → `action=deferred`, `note="anchor_ambiguous"`. Anchor clobbered by an earlier Edit this iter → `action=deferred`, `note="anchor_clobbered_by_earlier_edit"`. Unique → proceed.
      3. **Construct Edit** by interpreting `suggested_fix` against the matched section. Minimal `old_string`/`new_string`, tight scope (do not rewrite surrounding paragraphs). For non-mechanical intent ("add error handling" etc.), best interpretation that satisfies the intent; prefer additive over restructuring.
      4. **Execute Edit**. On error → `action=deferred`, `note="edit_tool_rejected: <error_short>"`. On success → `action=applied`, record `edit_summary` (e.g. "+5/-2 lines in §Phase B").
      5. **Verify**: re-grep the anchor area (defense against accidental no-op when old_string===new_string).
    - **Append ledger entries** to `~/.claude/plans/{slug}-tango.ledger.json` (create with skeleton on first write). Per-finding shape see [references/schemas.md](references/schemas.md).
    - **Update last_known_plan_hash**: `sha256(updated_plan_file)` → state.
    - **Refresh lock**: `lock.mjs refresh --slug <slug> --session <session_id> --plan-hash <new_hash>`. On `session_mismatch` → ABORT (someone took over).
    - **If quiet=false**: Print `[N/max] Applied {k} fixes (+{added}/-{removed} lines), deferred {d}. Starting iter {N+1}.`
23. **Increment iter**, loop.

# Phase D — Final Check (after loop break)

24. **Pre-gate (v0.2 — single rule):** run Opus full-mode if **both** clauses hold; otherwise skip:
    - **(a) status eligible:** see table below.
    - **(b) settings opt-in:** `state.settings.final_check === "always"` (single normalized output of `load-config.mjs`; CLI > config > default).

    Phase D does NOT re-inspect raw CLI flags or raw config values; the decision is settled in `state.settings.final_check`.

    | status | Opus runs when `final_check === "always"`? |
    |---|---|
    | `converged`, `converged-lenient`, `converged-with-polish` | YES (full mode) |
    | `manual-required`, `stuck`, `regressed`, `max-iter-reached`, `oscillating`, `off-plan-target`, `external-modification`, `build-failed`, `aborted-by-user`, `final-check-malformed`, `final-recheck-error`, `final-recheck-malformed` | NO |

25. _(Auto-gate keyword triggers — removed in v0.2; see [references/final-check.md](references/final-check.md) for historical detail.)_
26. **Run final check**: spawn `plan-tango:plan-final-checker` with `{plan_path, repo_root, repo_evidence_available, mode}`. Receive raw text output. Pipe through `parse-codex-verdict.mjs --from-text` via Bash. If parser returns `verdict=MALFORMED` → ONE retry of the subagent with reminder "Your last response did not start with ALLOW: or BLOCK:. Repeat with correct format". If retry MALFORMED → BREAK status=`final-check-malformed`, show raw output.
27. _(Diagnostic mode — removed in v0.2.)_ Pre-gate (step 24) makes non-converged statuses ineligible regardless of settings.
28. **Full mode** (converged-*):
    - **28a (clean)**: `verdict == ALLOW` AND findings empty → BREAK status=`converged-final`.
    - **28a-polish (Opus polish-only)**: `verdict == BLOCK` AND `findings.length > 0` AND `count(critical) + count(major) === 0` → BREAK status=`converged-final`. **No corrective iter.**
      1. Run dry-run classify on Opus findings via `apply-fixes.mjs`. Cross-check `invariant_summary.off_plan_blocking` — if true, BREAK status=`off-plan-target` per step 22 protocol; do NOT write polish_advisory.
      2. Build `opus_advisory = [...advisory_plan]`.
      3. Set `state.polish_only_terminal = true`. Merge `opus_advisory` into `state.polish_advisory` (append + dedupe by hash).
      4. Append ledger `iteration_kind="final-check-advisory"`, one row per opus_advisory entry: `{hash, severity, action: "advisory", note: "opus_polish_only"}`.
      5. Show: "Final-check found {n} polish findings (advisory, see §6 of report)".
    - **28b (critical or major)**: print "Final-check found {C} critical, {M} major. Running one corrective iteration..."
      1. Snapshot via `snapshot.mjs --iter final-fix`.
      2. Dry-run classify on Opus findings.
      3. If `manual` or critical/major `deferred` → BREAK status=`manual-required-after-final`.
      4. Reuse off-plan invariant from step 22 (check `requested_file_path !== null`). Failures → BREAK status=`off-plan-target` (ledger `iteration_kind="final-fix"`, `action="off_plan_blocked"`).
      5. Apply fixes (same as step 22 apply); append ledger with `iteration_kind="final-fix"`. Update last_known_plan_hash.
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
    - **§4** — "What Codex caught and fixed", numbered list. Source: ledger.json entries with `action ∈ {applied, deferred, manual, off_plan_blocked}`. By severity (critical → major → minor → nit), one line: `N. **{severity}** — {short title}.` Cap at ~12; "…and {K} more (see ledger)" suffix when over.
    - **§5** — 1-3 sentence convergence narrative. Render only when `verbose_report === true`.
    - **§6** — polish advisory list. Render only when `state.polish_only_terminal === true` AND `state.polish_advisory.length > 0`.

    **Skip rules**: §3+§4+§5 skipped only when N=0 (Phase A abort). §1+§2 always render when N≥1. §3+§5 also skipped when `verbose_report=false` (default).
30. **Release lock — ONLY if it was actually acquired.** The orchestrator MUST track `lock_acquired = false` from session start, set to `true` ONLY after a successful step 7 acquire (with `session_id` saved). Phase A aborts (validation, codex CLI, repo resolve) happen BEFORE step 7 — they MUST NOT call `lock.mjs release` (slug + session_id don't exist; placeholder values would crash with `invalid_slug` / `missing_session_id`, masking the real validation error).
    - **`lock_acquired === true`** → `lock.mjs release --slug <slug> --session <session_id>`. On `session_mismatch` log warning, do NOT delete (someone took over). On `lock_missing` no-op, fine.
    - **`lock_acquired === false`** (Phase A abort, or step 7 itself failed): skip release entirely.
    - This is the ONLY thing letting future runs start. Crash between iter and release with `lock_acquired === true` not having released → next run sees a 30-min stale window before allowed to acquire (or use --takeover sooner).
31. Optionally cleanup workspace: `workspace.mjs cleanup --slug <slug>` if status is terminal-success (`converged-final`, `converged`, `converged-lenient`, `converged-with-polish`). Keep workspace for failed runs so user can inspect.

</process>

<critical_invariants>
The orchestrator must enforce these during the run. Script-enforced and informational invariants (sandbox, subagent-no-Edit, style rules) live in [references/invariants.md](references/invariants.md).

- **Off-plan invariant** (steps 22, 28b): every Edit is preceded by an `edit_plan[i].requested_file_path !== null` check. The `file_path` field itself is always `plan_path` by classifier construction — do NOT confuse the two.
- **Thread invariant**: in `thread_mode=continue` (default), iter 1 opens a Codex thread (saved as `state.codex_thread_id`); iters 2..N call `codex exec resume <id>` AND inject the `<reset_iteration>` block to limit anchor bias. In `thread_mode=fresh` every iteration opens a new thread. On lost-session error the wrapper auto-fallbacks to fresh and reports `fallback_to_fresh:true`; orchestrator unconditionally overwrites `state.codex_thread_id` (step 16.5).
- **Lock invariant** (Phase B step 7 → Phase E step 30): exactly one lock per slug for the run's lifetime. `--resume` re-acquires (state remembers slug; session_id is regenerated each invocation). Release is gated on `lock_acquired === true`.
- **Integrity invariant** (step 10b): before every iteration, `sha256(plan)` MUST equal `state.last_known_plan_hash`. Mismatch = external modification = abort the cycle.
- **Resume-safety invariant** (Phase A step 1): `--resume` MUST NOT use the `--newest` fallback. Resume requires explicit slug/path or active plan in system prompt.
- **Max-iter hard cap invariant**: `state.settings.max_iter` MUST NOT exceed 12 — neither via initial `--max-iter` nor via the continue-prompt at step 21h.
- **Severity-aware invariant** (step 21 a2): when `severity_aware=true` (default), a BLOCK with zero critical+major is TERMINAL, NOT a corrective trigger. Polish findings persist to `state.polish_advisory` (sourced from `apply-fixes.mjs` `advisory_plan[]`, deduped, includes manual-classified) and render in Phase E §6 — never auto-applied. Status branches on `lenient`: true → `converged-lenient`, false → `converged-with-polish`. Step 21 (a2) is the single termination point under this mode; legacy step 21 (d) is unreachable.
</critical_invariants>

<diagnostics>
The skill prints one or two lines per iteration. Counter-progress is visible:
- Iteration count grows but findings counts don't drop → suspect oscillation; the detector should catch it but user can Ctrl-C earlier.
- ERROR at iter 1 with reason `codex_nonzero_exit` → first thing to check is `codex --version` (CLI installed?) and `codex login` status.
- Every snapshot is `~/.claude/plans/{slug}.iter{N}-*.bak` — manual rollback is `cp <bak> <plan>`.
</diagnostics>
