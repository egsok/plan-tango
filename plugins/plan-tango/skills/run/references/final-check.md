# plan-tango — Final-check (Opus) historical context

This file documents the v0.1 auto-gate that v0.2 removed. SKILL.md links here from Phase D step 25.

The current (v0.2) decision rule lives **inline** in SKILL.md Phase D step 24 — orchestrator-enforced runtime behavior, not historical. Two clauses, both must hold:
1. Status ∈ `{converged, converged-lenient, converged-with-polish}`
2. `state.settings.final_check === "always"` (normalized by `load-config.mjs`)

The status-eligibility table also stays inline in SKILL.md (it's runtime classification logic).

## What was removed in v0.2

### The keyword auto-gate

v0.1 ran Opus automatically whenever the plan body contained any of these strings:

```
permission, settings.json, tools:, allowed-tools, hook, MCP, subagent, model:
```

This list was meant to flag "runtime-contract" plans (skills, hooks, MCP servers, agent definitions) that benefited from a second-pass review. In practice it fired on practically every Claude Code plan because those terms are ambient in the ecosystem. Effective default: Opus on every run, +30-60s wall-clock + extra Opus tokens, with no explicit user opt-in.

### The iter≤2 fast-convergence trigger

v0.1 also auto-ran Opus when convergence happened in ≤2 iterations on a plan with `repo_evidence_available=true`. Rationale: a fast ALLOW with repo evidence might mean Codex skimmed the repo too quickly. In practice this overlapped heavily with the keyword gate (any non-trivial Claude Code plan had the keywords AND tended to converge fast), making the iter rule largely redundant.

### Diagnostic mode for non-converged statuses

v0.1's `--force-final-check` ran Opus in **read-only diagnostic mode** when status was non-converged (`manual-required`, `stuck`, `regressed`, `max-iter-reached`, `oscillating`, `off-plan-target`). The output was advisory only — no corrective iteration followed. Removed because: when status is `manual-required` or `off-plan-target`, the user already has actionable findings from Codex; running Opus produces parallel findings without changing the user's next step (resolve manually, then re-run). The diagnostic mode rarely helped and added a status-table row that complicated Phase D.

## What v0.2 kept

- Full mode on converged statuses, gated by `final_check === "always"` (single normalized setting; `load-config.mjs` resolves CLI > config > default).
- `28a-polish` Opus polish-only branch (BLOCK with zero critical/major from Opus → terminal `converged-final`, advisory only — no corrective iter).
- `28b` corrective iter (Opus finds critical/major → ONE corrective Codex re-review).

## Why the change

Two reasons:

1. **The auto-gate fired too aggressively.** When something is "auto" but actually fires on >90% of inputs, it's not auto — it's default-on-with-extra-steps. Making it opt-in via `--final-check` (or config `final_check: "always"`) puts the choice in the user's hands and removes the implicit cost from runs where they didn't ask for it.

2. **Defaults should be cheap.** A skill that adds 30-60s + Opus tokens by default for marginal benefit on most runs trains users to dread invoking it. Default behavior is now: Codex review loop, no Opus, fast finish. Users opt in when they want the extra layer.

## Migration

| v0.1 input                                | v0.2 behavior                                           |
|-------------------------------------------|---------------------------------------------------------|
| no flag, no config                        | `final_check="never"` (skip Opus)                       |
| `--force-final-check`                     | accepted alias → `final_check="always"`, prints warning |
| `--no-final-check`                        | accepted alias → `final_check="never"`, prints warning  |
| config `final_check: "auto"`              | migrated to `"never"`, prints warning                   |
| config `final_check: "force"`             | migrated to `"always"`, prints warning                  |
| `--final-check` (canonical)               | `final_check="always"`, no warning                      |
| `--no-final-check` (canonical disable)    | `final_check="never"`, no warning (will be dropped v0.3) |

All deprecation warnings render once per run via the `warnings: []` array returned by `load-config.mjs` and printed by SKILL.md step 8.5. The orchestrator never re-inspects raw CLI flags or raw config values — `load-config.mjs` resolves precedence (CLI > config > default) into the single normalized `state.settings.final_check`.
