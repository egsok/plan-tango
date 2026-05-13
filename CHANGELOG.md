# Changelog

All notable changes to plan-tango are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — first public release

First version published to GitHub as a Claude Code plugin marketplace.

### Added
- **`/plan-tango:config` wizard** — interactive `~/.claude/plan-tango/config.json` editor (`AskUserQuestion` flow + atomic write via `write-config.mjs`).
- **Severity-aware convergence** — when Codex returns BLOCK with only minor/nit findings, the loop now terminates with `converged-with-polish` (or `converged-lenient` when `--lenient` is also set) instead of running another corrective iteration. Polish findings render as advisory in §6 of the Phase E report. Opt-out via `severity_aware: false` in config.
- **`--quiet`** flag (and `quiet: true` config field) — suppresses per-iteration progress lines in Phase C; Phase E final report still always renders.
- **`--verbose-report`** flag (and `verbose_report: true` config field) — opts into §3 (per-iter convergence table) and §5 (narrative) of the Phase E report. Default off; §1, §2, §4 (and §6 when polish-only) always render.
- **`init.mjs`** — consolidates Phase A (plan validation + Codex CLI check + repo resolve + config load + lock acquire + state init/resume + workspace ensure) into a single Bash call with internal cleanup on partial failure.
- **`doctor.mjs`** — single-command diagnostics (`--json` for machine-readable output): checks Codex CLI presence, user-config parse, `~/.claude/plans/` write access, lock acquire/release cycle, and `run-codex-review.mjs` error path.
- **End-of-run update notice** — opt-out via `update_check: false` in config. `update-check.mjs` queries `git ls-remote --tags` against the GitHub release channel at most once per 7 days (cached at `~/.claude/plan-tango/.update-cache.json`), fully silent on network failure, prints one line at the end of Phase E when a newer release is available.
- **LICENSE** (MIT, 2026, Egor Sokolov).
- **CHANGELOG.md** (this file).

### Changed
- **`final_check` config vocabulary** — canonical values are now `never` (new default) and `always`. Old `auto` and `force` are still accepted by the loader but auto-migrated with a one-line warning. The `--final-check` flag (canonical for `final_check="always"`) replaces the deprecated `--force-final-check`; `--no-final-check` continues to work as a per-run override with a deprecation notice.
- **`thread_mode` default** — flipped from `fresh` to `continue` (iter 1 opens a Codex thread; iter ≥ 2 calls `codex exec resume <id>` with a `<reset_iteration>` block to limit anchor bias). Result: cheaper (prompt-cache hits), faster, single thread per run in the Codex panel. Override per-run with `--fresh-each`.
- **Phase A consolidation** — formerly 11 stepped operations are now a single `init.mjs` Bash call.
- **Wrapper output is lean by default** — `run-codex-review.mjs` no longer dumps `raw_final_message` / `raw_output_excerpt` for clean ALLOW/BLOCK verdicts (full text remains on disk at `last_message_path`). Pass `--verbose-output` or set `PLAN_TANGO_WRAPPER_VERBOSE=1` when needed.

### Removed
- **`plan-reviewer.md`** subagent — wrapper is called directly via Bash now (`apply-fixes.mjs` is a classifier; the orchestrator does the actual Edits).
- **Auto-gate keyword triggers** for Opus final-check — Phase D pre-gate now reads `final_check === "always"` as the single rule.
- **Diagnostic mode** for Opus final-check on non-converged statuses.

### Notes
- Plugin layout matches Claude Code marketplace convention: `.claude-plugin/marketplace.json` at repo root, plugin sources at `plugins/plan-tango/`.
- Persistent user config: `~/.claude/plan-tango/config.json` (optional; copy from `user-config.example.json`).
- Runtime artefacts live alongside the plan file under `~/.claude/plans/<slug>-tango.*`.

[0.2.0]: https://github.com/egsok/plan-tango/releases/tag/v0.2.0
