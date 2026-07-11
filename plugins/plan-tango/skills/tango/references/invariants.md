# plan-tango — Script-enforced and informational invariants

These invariants are either enforced by helper-script code (orchestrator can't violate them by mis-reading SKILL.md) or are pure style / authoring conventions. They moved out of SKILL.md because the orchestrator does not need to re-read them on each invocation to behave correctly.

The orchestrator-enforced invariants — plan-only, thread, lock, integrity, resume-safety, max-iter cap, severity-aware — stay **inline** in SKILL.md `<critical_invariants>`. Those ones the orchestrator has to actively check.

## Sandbox invariant (script-enforced)

Every Codex spawn passes `--sandbox read-only` regardless of user config. The wrapper [scripts/run-codex-review.mjs](../scripts/run-codex-review.mjs) hardcodes the flag literal in its spawn args (line 156):

```js
"--sandbox", "read-only",
```

There is no code path that constructs a different sandbox value from user input. The setting is not exposed via `extra_codex_config`, `--codex-profile`, or any other flag. Codex review never gains write capability — apply-fixes happens in the orchestrator via the `Edit` tool, never inside Codex.

If the wrapper is modified in the future, this invariant must remain: any non-`read-only` sandbox value would change the security posture of the whole skill.

## Subagent does not edit the plan file (script-enforced via frontmatter)

The single remaining subagent declared in `agents/` has its tool list scoped to read-only operations:

| subagent                        | declared `tools`            | Edit/Write present? |
|---------------------------------|-----------------------------|---------------------|
| `plan-tango:plan-final-checker` | `Read, Glob, Grep`          | NO                  |

The Claude Code skill runtime enforces the `tools:` frontmatter — a subagent cannot call a tool not in its list. The orchestrator is the only agent in this skill with `Edit` access (declared in SKILL.md `allowed-tools`). All plan modifications go through the orchestrator after parsing the subagent's (or wrapper's) verdict.

If the subagent file is modified to add `Edit` or `Write`, this invariant is broken and a security review is required.

> **v0.2 note**: the former `plan-tango:plan-reviewer` subagent (sonnet, `Bash, Read` only) was removed in commit 4 of the operational-simplification sprint. Codex review now runs via direct Bash call to `run-codex-review.mjs` from the orchestrator — the subagent was a thin forwarder that only added Task-spawn overhead. The wrapper itself does not have `Edit`/`Write` access; it spawns Codex CLI in `--sandbox read-only` mode (see Sandbox invariant above).

## Plan-only invariant — off-plan detection removed (0.7.0, script-enforced)

The canonical statement lives inline in SKILL.md `<critical_invariants>`. The script-level facts behind it:

`apply-fixes.mjs` sets `edit_plan[i].file_path = plan_path` for every non-manual entry by construction — the classifier never emits any other target. Mention-based off-plan detection (scanning `suggested_fix` for foreign file paths) was **removed in 0.7.0**: across sessions it flagged 14 findings, all 14 false positives, 0 true. The real protection was never the heuristic — it is that the orchestrator only ever constructs `Edit` calls against the plan text.

Consequences the docs and orchestrator rely on:

- `requested_file_path` is retained in the output shape for compatibility but is **always `null`**.
- `invariant_summary` is the constant `{all_in_plan: true, off_plan_count: 0, off_plan_blocking: false}`.
- The `off_plan_blocked` ledger action no longer exists.
- No status `off-plan-target` is reachable.

## Deterministic bookkeeping — `commit-iter.mjs` (script-enforced)

Post-iteration state changes (bump `state.iter`, push `findings_history`, recompute `last_known_plan_hash`, persist `codex_thread_id`, stamp `updated_at`, refresh the lock lease) run through `commit-iter.mjs` in one atomic write (tmp file + `rename`), never hand-rolled by the orchestrator. An idempotency guard requires `state.iter === iter - 1`; a re-run with the same iter returns `{ok:false, reason:"iter_already_committed"}` (exit 0) rather than double-pushing `findings_history` (the exact bug this replaced). The lock is refreshed BEFORE the state write — a session mismatch aborts without committing. The ledger is deliberately out of scope: the orchestrator still appends per-finding ledger entries during apply.

## Deterministic stop conditions — `evaluate-stop.mjs` (script-enforced)

Stop-condition evaluation (severity counts, findings_history set-diffs, oscillation/stuck/regression detection) is a pure function in `evaluate-stop.mjs`, not LLM arithmetic. It receives the run state and returns one `{action, status, reason, human_note}` decision. Branch priority mirrors the historical step-21 ladder minus the off-plan branches. Regression is suppressed (→ continue, `reason:"regression_suppressed_fresh_thread"`) when the iteration ran on a fresh Codex thread (lost-session fallback) — a fresh reviewer being more thorough is not a regression.

## Style: skill modifies only the plan file

The orchestrator's `Edit` calls only target `plan_path`. All other writes (state, ledger, lock, snapshots, workspace artifacts) go through `Write` (or the helper scripts' atomic writes) to paths under `~/.claude/plans/{slug}-tango*`. This is informational — the orchestrator's correctness depends on it but no script forces it at Edit time. Reviewers auditing the skill should flag any `Edit` to a path other than `plan_path` as a defect.

## Style: shell paths use `$HOME` / `$env:USERPROFILE`

No hardcoded `/Users/<name>` or `C:\Users\<name>\...` strings should appear in any helper script or in SKILL.md. POSIX scripts use `$HOME`; PowerShell uses `$env:USERPROFILE`. This keeps the skill portable across machines without user-specific patches.

## Style: error messages name the file or step

Every `ABORT` path in SKILL.md prints either the failing helper-script's `error`/`detail` or a sentence naming what went wrong (e.g. "Plan modified outside skill since last completed apply (expected hash X, got Y)"). Generic "operation failed" messages without a path or step name should not slip into the skill.
