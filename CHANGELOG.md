# Changelog

All notable changes to plan-tango are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-07-11

### Breaking changes
- **`final_check` aliases removed.** The deprecated config values `auto`/`force` and the CLI flags `--no-final-check`/`--force-final-check` now fail with a hard error naming the replacement (`never`/`always`, `--final-check`). They had been warning-and-migrating since v0.2 with no external users left on them.

### Fixed
- **Mention-based off-plan detection removed** — merged [PR #1](https://github.com/egsok/plan-tango/pull/1) by @kreml9 (thanks!) plus follow-up cleanup. `detectOffPlanTarget` flagged any file path mentioned in a finding's `location`/`fix` text as an "edit outside the plan," but by contract `location` carries evidence citations ("repo evidence: etl/foo.py:891") and fix text legitimately names the files a plan is *about*. Field data across real converge sessions: 14 flagged / 14 false positives / 0 true — including one session that hit the blocking protocol 4 times and doubled its wall-clock on restarts. The real protection was always structural: `edit_plan[].file_path` is `plan_path` by classifier construction and the orchestrator only constructs Edits against plan text. `requested_file_path` is now always `null`, `invariant_summary` is the constant `{all_in_plan:true, off_plan_count:0, off_plan_blocking:false}`, and the `off-plan-target`/`off_plan_blocked` statuses are gone from the protocol.
- **Backslash plan paths no longer kill classification.** `apply-fixes.mjs` failed with `stdin_not_json` on every run whose piped JSON contained an unescaped Windows path; it now retries the parse with lone backslashes escaped. Forward slashes remain the documented convention.
- **Lenient Codex verdict parsing.** A preamble line before `ALLOW:`/`BLOCK:`, markdown-bold verdicts (`**BLOCK:**`), `N)` finding numbering, and bold severity headers no longer produce a MALFORMED verdict (each MALFORMED used to cost a full Codex re-review).
- **Stable finding hashes.** Hashes now derive from normalized `severity :: title` (fallback: normalized problem prefix) instead of a raw prose slice, so the stuck/oscillation detectors survive Codex re-phrasings of the same defect.
- **State integrity.** `state.json` writes are atomic (tmp+rename); a crash mid-write no longer bricks `--resume`.
- **Stale locks from crashed runs are reclaimed immediately** when the recorded PID is dead on the same host (TTL fallback unchanged).
- **Workspace cleanup survives EBUSY** when the current working directory sits inside the workspace (chdir out + one retry).

### Added
- **`commit-iter.mjs`** — deterministic, idempotent post-iteration bookkeeping (findings_history push, plan-hash recompute, thread-id persistence, iter bump, lock refresh) replacing the hand-rolled state updates the orchestrator previously improvised — one real session double-wrote `findings_history` and needed manual state surgery.
- **`evaluate-stop.mjs`** — deterministic stop-condition evaluation (converged / stuck / oscillating / regressed / manual-required / max-iter…) replacing the LLM-computed set arithmetic in step 21. Includes a fix for a false regression trigger: a severity jump right after a fresh-thread retry no longer counts as plan regression (a fresh reviewer is just more thorough).
- **Wrong-worktree pre-flight.** `init.mjs` now reports which files the plan references are missing under the resolved repo root; the skill warns and asks before burning iterations against the wrong checkout (one real session spent 51 minutes reviewing a plan against a sibling repo that lacked the target files).
- **Opus final check offered at max-iter.** When the loop exhausts its budget without converging, the skill now offers the Opus sanity check — in a real session it caught a major defect Codex had missed for 6 iterations.

### Removed
- `repo_evidence_available` plumbing (a constant `true` threaded through 5 scripts and the prompt template) and the final_check deprecation-alias machinery.

## [0.6.1] — 2026-05-28

### Fixed
- **Duplicate-hooks plugin error.** `claude doctor` on current Claude Code (2.1.x) reported `Hook load failed: Duplicate hooks file detected` for plan-tango. The manifest's `"hooks": "./hooks/hooks.json"` — added in 0.5.1 as belt-and-suspenders against then-flaky `hooks/hooks.json` auto-discovery — now collides with Claude Code's automatic loading of that same standard file (and newer 2.1.x added duplicate-detection on top). Removed the redundant manifest field; the standard `hooks/hooks.json` is auto-discovered and loads exactly once. Affected every install on a current Claude Code; impact was limited to the SessionStart update-notice hook failing to load plus the visible doctor error — the skills (`/plan-tango:tango`, `:settings`, `:update`) were unaffected.

## [0.6.0] — 2026-05-28

### Breaking changes
- **Renamed the main skill `run` → `tango`.** The plugin's primary command is now **`/plan-tango:tango`** (was `/plan-tango:run`). The old `/plan-tango:run` no longer resolves — update any scripts, notes, or muscle memory. The `skills/run/` directory moved to `skills/tango/`; all internal script paths, the SessionStart update hook (`hooks/check-update.mjs`), and the settings wizard's shared-script reference (`write-config.mjs` → `load-config.mjs`) were repointed to match. `/plan-tango:settings` and `/plan-tango:update` are unchanged.

### Why
The Claude Code **VS Code extension** was hiding `/plan-tango:run` from the slash-command autocomplete dropdown. The extension's picker deduplicates entries by leaf-name (the part after `:`), and `run` collided with Claude Code's built-in `run` skill ("Launch and drive this project's app") — so the built-in won and the plugin's entry was dropped. The command still ran if you typed it out in full, but it was invisible in the picker, which is how most VS Code users discover and launch it. (The terminal CLI was never affected — it resolves the fully-qualified name.) `tango` has no built-in collision, reads the same in English and Russian, and matches the plugin's Claude↔Codex "dance" — so the command shows up in the VS Code dropdown again.

### Migration
- Use **`/plan-tango:tango`** instead of `/plan-tango:run` — same positional arg and flags.
- After updating, reload plugins (terminal: `/reload-plugins`; VS Code: **Developer: Reload Window**, or restart Claude Code).

### Docs
- **README version badges** bumped to 0.6.0.

## [0.5.4] — 2026-05-15

### Docs
- **Feedback + Author section in root READMEs.** Telegram channel link split onto its own line. New "Author" section with a short bio (10 years in product at Sberbank, Rolf, Claustrophobia; writing and experimenting with AI), a branded link to the homepage, and a contextual link to the plan-tango deep-dive at [egorsokolov.ru/ai/plan-tango/](https://egorsokolov.ru/ai/plan-tango/).
- **README version badges** bumped to 0.5.4.

## [0.5.3] — 2026-05-15

### Changed
- **📦 emoji prefix on the update-notice message.** The notice text emitted by `update-check.mjs` (and surfaced via both the SessionStart hook's `systemMessage` and the `additionalContext` fallback) now leads with 📦 to stand out a little more inside Claude Code's `L SessionStart:startup says:` framing. Behavior unchanged.

## [0.5.2] — 2026-05-15

### Changed
- **`/plan-tango:update` confirm prompt — less technical.** The "Yes, update now" option's description used to say `Run git fetch + git reset --hard v<LATEST> in <MARKETPLACE_DIR>.` — exposing internals end users shouldn't have to parse. Now reads `Pull v<LATEST> from GitHub and overwrite the local plugin install.`. Behavior is unchanged.

## [0.5.1] — 2026-05-15

### Fixed
- **SessionStart update notice is now actually visible.** The 0.3.1 hook printed plain text to stdout, which Claude Code feeds to system-reminder context (visible only via Ctrl+O transcript) rather than the user-visible chat — users reported seeing nothing on session start despite an available update. The hook now emits a JSON response with `systemMessage` (Claude Code's user-visible "warning shown to the user" channel for hooks) plus a `hookSpecificOutput.additionalContext` fallback that instructs Claude to surface the notice in its first response if `systemMessage` doesn't render in the current client.

### Changed
- **Plugin manifest declares `hooks` explicitly.** Belt-and-suspenders against any flakiness in Claude Code 2.1.x auto-discovery of `hooks/hooks.json` — `plugin.json` now has `"hooks": "./hooks/hooks.json"`.
- **README version badge** unstuck from 0.2.1 → 0.5.1. (The 0.5.0 release fixed this too as a smoke-test for `/plan-tango:update`; 0.5.1 supersedes it with the actual visibility fix.)

## [0.5.0] — 2026-05-15

### Changed
- **README version badge** unstuck from 0.2.1 → 0.5.0. Wasn't bumped during 0.3.0/0.3.1/0.4.0 releases; tracker now part of the version-bump checklist.

### Notes
- This release was primarily an end-to-end smoke test of the `/plan-tango:update` self-update flow introduced in 0.4.0: bumped versions + README badges + pushed the `v0.5.0` tag and verified that `/plan-tango:update` running from a 0.4.0 install resets the marketplace clone to the new tag. No functional code or behavior changes. **Superseded by 0.5.1** — see the 0.5.1 entry for the actual visibility fix.

## [0.4.0] — 2026-05-15

### Added
- **`/plan-tango:update` skill** — self-update by pulling the latest release tag into the marketplace clone (`~/.claude/plugins/marketplaces/plan-tango/`). Parallels the `/gsd-update` UX: version-check, confirm, `git fetch + git reset --hard v<latest>`, reload reminder. Replaces the manual "/plugin → Marketplaces → plan-tango → Update" navigation for the common case. Flags: `--check` (print status only, no update), `--force` (skip clean-working-tree safety check).

### Fixed
- **Update-notice message** — the end-of-Phase-E check and the SessionStart hook used to suggest `run /plugin update plan-tango@plan-tango`, but Claude Code 2.x has no such slash command (already noted in the 0.2.1 changelog when the form was removed from README). Now suggests `/plan-tango:update`.

### Changed
- **Settings wizard — 7 questions instead of 8.** `lenient` moved out of the interactive flow into preserved-as-is. Rationale: with the default `severity_aware: true`, the loop already stops on polish-only verdicts (zero critical+major findings), and `lenient` then only changes the status label (`converged-with-polish` ↔ `converged-lenient`) without changing termination. The previous wizard description ("Loop until clean ALLOW") was misleading because it ignored severity_aware's effect. To toggle `lenient`, hand-edit `~/.claude/plan-tango/config.json` or use `--lenient` per run.
- **`severity_aware` wizard description rephrased** for clarity — explicitly states "no extra round on minor/nit-only BLOCK" to make the polish-skip semantics obvious.

## [0.3.1] — 2026-05-15

### Added
- **SessionStart hook for in-session update notice.** `hooks/check-update.mjs` runs at every new session and every resume, reusing the existing `update-check.mjs` cache (7-day TTL, silent-on-failure) — when a newer GitHub release tag exists, Claude Code surfaces a one-line "update available" hint as session context. Respects the same `update_check: false` opt-out as the Phase E check. Cache hits are sub-50ms; cache misses are bounded by a 3 s network timeout under the 5 s hook budget, so a slow network never blocks session startup.

### Changed
- **Settings wizard simplified — 8 questions instead of 11.** `model`, `codex_profile`, and `verbose_report` are no longer asked in the wizard; existing values are preserved from `~/.claude/plan-tango/config.json` (or defaults on fresh installs). These were "advanced" settings most users left at defaults, and asking them right before the confirm step added cognitive load. To change them, hand-edit the config file or use the corresponding CLI flag (`--model`, `--codex-profile`, `--verbose-report`).

### Docs
- **`/reload-plugins` install step clarified** — the slash command is available only in the terminal Claude Code. VS Code extension users need to run **Developer: Reload Window** from the Command Palette (or restart Claude Code) instead.

## [0.3.0] — 2026-05-15

### Breaking changes
- **Renamed skill `plan-tango` → `run`.** The plugin's main command is now `/plan-tango:run` (was `/plan-tango:plan-tango`). The bare-form `/plan-tango` dropdown shortcut still surfaces the plugin's commands in Claude Code's slash-command picker, but the resolved command is now `plan-tango:run`.
- **Renamed skill `config` → `settings`.** The config wizard is now invoked as `/plan-tango:settings` (was `/plan-tango:config`). Avoids the dropdown collision where Claude Code's built-in `/config` could be picked instead of the wizard.

### Why
Two confusing UX edges were in front of new users: `/plan-tango:plan-tango` stuttering tautology, and `/config` dropdown collision with the Claude Code built-in. Both are now gone — invocations are honest and unambiguous.

### Migration
- Existing `~/.claude/plan-tango/config.json` is unaffected — config path and schema unchanged. Just use the new command names.
- `update-check.mjs` GitHub release-tag polling continues to work; the new 0.3.0 tag will be the next "newer available" notice for anyone still on 0.2.x.
- Skill folders renamed via `git mv`, so file history is preserved.

## [0.2.1] — 2026-05-14

### Fixed
- **`--skip-git-repo-check` no longer gated** — `run-codex-review.mjs` now always passes the flag. The previous `repo_evidence_available`-based gate was dead code since v0.2 made the field permanently `true`, so Codex refused to run from non-git cwds with a confusing `Not inside a trusted directory` error at iter 1. Plan-tango now works from any directory.

### Docs
- **README install** — two slash commands split into separate code blocks with an explicit "send as separate messages" note (Claude Code treats one chat message as one command; pasting both at once jammed the second into the URL of the first). Step 3 now suggests `/reload-plugins` instead of a full session restart.
- **README update** — replaced the bogus `/plugin update plan-tango@plan-tango` slash command (Claude Code 2.x has no such form; it falls through to the `/plugin` UI) with the actual update flow via **Marketplaces → plan-tango → Update**.

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

[0.7.0]: https://github.com/egsok/plan-tango/releases/tag/v0.7.0
[0.6.1]: https://github.com/egsok/plan-tango/releases/tag/v0.6.1
[0.6.0]: https://github.com/egsok/plan-tango/releases/tag/v0.6.0
[0.5.4]: https://github.com/egsok/plan-tango/releases/tag/v0.5.4
[0.5.3]: https://github.com/egsok/plan-tango/releases/tag/v0.5.3
[0.5.2]: https://github.com/egsok/plan-tango/releases/tag/v0.5.2
[0.5.1]: https://github.com/egsok/plan-tango/releases/tag/v0.5.1
[0.5.0]: https://github.com/egsok/plan-tango/releases/tag/v0.5.0
[0.4.0]: https://github.com/egsok/plan-tango/releases/tag/v0.4.0
[0.3.1]: https://github.com/egsok/plan-tango/releases/tag/v0.3.1
[0.3.0]: https://github.com/egsok/plan-tango/releases/tag/v0.3.0
[0.2.1]: https://github.com/egsok/plan-tango/releases/tag/v0.2.1
[0.2.0]: https://github.com/egsok/plan-tango/releases/tag/v0.2.0
