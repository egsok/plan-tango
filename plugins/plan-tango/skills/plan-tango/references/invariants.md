# plan-tango — Script-enforced and informational invariants

These invariants are either enforced by helper-script code (orchestrator can't violate them by mis-reading SKILL.md) or are pure style / authoring conventions. They moved out of SKILL.md because the orchestrator does not need to re-read them on each invocation to behave correctly.

The orchestrator-enforced invariants — off-plan, thread, lock, integrity, resume-safety, max-iter cap, severity-aware — stay **inline** in SKILL.md `<critical_invariants>`. Those ones the orchestrator has to actively check.

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

## Style: skill modifies only the plan file

The orchestrator's `Edit` calls only target `plan_path`. All other writes (state, ledger, lock, snapshots, workspace artifacts) go through `Write` to paths under `~/.claude/plans/{slug}-tango*`. This is informational — the orchestrator's correctness depends on it but no script enforces it. Reviewers auditing the skill should flag any `Edit` to a path other than `plan_path` as a defect.

## Style: shell paths use `$HOME` / `$env:USERPROFILE`

No hardcoded `/Users/<name>` or `C:\Users\<name>\...` strings should appear in any helper script or in SKILL.md. POSIX scripts use `$HOME`; PowerShell uses `$env:USERPROFILE`. This keeps the skill portable across machines without user-specific patches.

## Style: error messages name the file or step

Every `ABORT` path in SKILL.md prints either the failing helper-script's `error`/`detail` or a sentence naming what went wrong (e.g. "Plan modified outside skill since last completed apply (expected hash X, got Y)"). Generic "operation failed" messages without a path or step name should not slip into the skill.
