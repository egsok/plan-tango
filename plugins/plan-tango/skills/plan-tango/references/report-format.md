# plan-tango — Phase E report format detail

Detailed templates for Phase E §2 (stats block), §3 (convergence table), §5 (narrative), §6 (polish advisory).
SKILL.md links here from Phase E step 29 with a compact section skeleton inline.

§1 (header) and §4 (numbered list of caught items) are short enough to stay inline in SKILL.md. §3 + §5 are skipped by default in v0.2; opt in via `--verbose-report` (or `verbose_report: true` in config) when you want them rendered.

## §2 — Stats block (markdown code-fenced)

```
Final status: {status}{optional suffix}
Iterations: {N}
Codex review calls: {N}
Codex seconds (total): {T}s
MALFORMED retries (in-loop): {M}
Codex re-review calls (after final-fix): {0|1}
Final re-review MALFORMED retries: {0|1}
Opus final-check calls: {0|1} (final_check={never|always})
Opus final-check MALFORMED retries: {0|1}
Polish-only terminal: {true|false}                        # render only if state.polish_only_terminal===true
Polish advisory findings: {state.polish_advisory.length}  # render only if state.polish_only_terminal===true
Lenient deferred minor/nit: {n}
Plan size: {orig_bytes} → {new_bytes} bytes ({+/-pct}%)
Snapshots: {N}
Ledger: ~/.claude/plans/{slug}-tango.ledger.json
State:  ~/.claude/plans/{slug}-tango.state.json (intact for --resume)
```

## §3 — Convergence table

Render one row per completed iteration, even for N=1. Source: per-iter ledger entries; fall back to `findings_history` if ledger is unavailable.

```
| Iter | Verdict | Critical | Major | Minor | Nit |
|------|---------|----------|-------|-------|-----|
| 1    | BLOCK   | 1        | 4     | 2     | 0   |
| 2    | BLOCK   | 0        | 2     | 1     | 1   |
| 3    | ALLOW   | 0        | 0     | 0     | 0   |
```

For `ERROR` / `MALFORMED` rows put `—` in count columns:

```
| 2 | ERROR     | — | — | — | — |
| 3 | MALFORMED | — | — | — | — |
```

## §5 — Convergence narrative

1-3 sentences in plain prose (NOT bullet list). Match the user's chat language (Russian / English / etc.). Touch on, when relevant:

- When critical/major dropped to zero (which iter)
- Whether courtesy fixes were applied past the cap (status=`max-iter-reached`)
- For `oscillating` / `stuck` / `regressed` — what the conflict pattern was, citing finding hashes or titles
- One-sentence final verdict on plan quality

Examples (illustrative, not for verbatim reuse):

> Iter 1: BLOCK 1 critical + 4 major. Iter 2: BLOCK 0 critical + 2 major. Iter 3: BLOCK 0+0+1+1. Iter 4 (post-cap courtesy): BLOCK 0+0+2+0. Critical устранён за 1 итерацию. Major — за 3. Iter 4 принёс только minor — applied как courtesy.

> Hit the hard cap with 3 valuable major findings still open — see ledger. Worth one more `/plan-tango <slug> --resume --max-iter 4` pass before handing off.

## §6 — Polish recommendations (advisory, not applied)

Render only when `state.polish_only_terminal === true` AND `state.polish_advisory.length > 0`.

Lead-in paragraph (verbatim, language matches user):

> Codex/Opus reached polish-only severity (only minor/nit findings, zero critical/major). Per severity-aware convergence the loop terminated without applying these — further auto-iters tend to introduce new minor inconsistencies. Review and apply manually if relevant.

Followed by a numbered list, sourced from `state.polish_advisory[]`:

```
1. **{severity}** — {title}
   File/section: {location}
   Suggested fix: {fix}

2. **{severity}** — {title}
   File/section: {location}
   Suggested fix: {fix}
```

Cap at ~12 entries. If more, append: `… and {K} more (see ledger.json action=advisory entries)`.

## Quiet mode interaction

`--quiet` (state.settings.quiet=true) does NOT suppress Phase E. The full §1-§6 report is always printed. Quiet only affects per-iteration progress lines in Phase C.

## Skip rules

- N=0 (Phase A abort before any iter ran) — print only §1 + §2.
- §3 + §5 — skipped unless `state.settings.verbose_report === true`.
- §6 — skipped when `state.polish_only_terminal === false`.
- §1 + §2 + §4 — always rendered (when N ≥ 1).
