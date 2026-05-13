# plan-tango

> Auto-converge a Claude Code plan against Codex (gpt-5) review iterations — Codex critiques → Claude applies fixes → Codex re-reviews → repeat until clean `ALLOW` or hard-cap.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Version](https://img.shields.io/badge/version-0.2.0-green) [![Read in Russian](https://img.shields.io/badge/lang-ru-red)](README.ru.md)

When you've drafted a non-trivial plan in Claude Code's plan mode and want a second opinion from a different model before implementation, manual copypaste between terminals doesn't scale. `plan-tango` automates the ping-pong: it reads your active plan file under `~/.claude/plans/`, spawns Codex CLI for a structured review, applies the suggested fixes back into the plan via `Edit`, and loops. Default budget is 6 iterations (hard cap 12). Works inside plan mode without leaving it.

## Install

1. **Prerequisites**: Claude Code 2.x, Node.js 18+, Codex CLI on `PATH`:
   ```
   npm install -g @openai/codex
   codex login
   ```

2. **Add the marketplace and install the plugin**:
   ```
   /plugin marketplace add egsok/plan-tango
   /plugin install plan-tango@plan-tango
   ```

3. **Restart your Claude Code session** so the plugin's skills, scripts, and agent register.

## Usage

```
/plan-tango                   # use the active plan from plan mode (or newest under ~/.claude/plans/)
/plan-tango <slug-or-path>    # explicit plan file
/plan-tango --max-iter 10 --effort medium --lenient --quiet
```

Optional persistent defaults: `~/.claude/plan-tango/config.json` (run `/plan-tango:config` for an interactive wizard, or copy `plugins/plan-tango/skills/plan-tango/user-config.example.json` and hand-edit).

Full flag reference, status codes, and architecture notes: [plugins/plan-tango/README.md](plugins/plan-tango/README.md) (English) · [plugins/plan-tango/README.ru.md](plugins/plan-tango/README.ru.md) (Russian).

## Update

Manual:
```
/plugin update plan-tango@plan-tango
```

Auto-update (opt-in per marketplace): open `/plugin`, select **Marketplaces → plan-tango → Enable auto-update**. Third-party marketplaces have auto-update off by default — this is a Claude Code policy, not a plan-tango choice.

Independent of those two, plan-tango itself runs an end-of-Phase-E version check against the GitHub release channel: at most once per 7 days, silently skipped on network failure, prints one line when a newer release is available. Opt out via `update_check: false` in `~/.claude/plan-tango/config.json`.

## Feedback

Issues, PRs, suggestions: [github.com/egsok/plan-tango/issues](https://github.com/egsok/plan-tango/issues). Telegram channel where I post about AI tools and Claude Code: [@neiroset_ne_vinovata](https://t.me/neiroset_ne_vinovata).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Egor Sokolov.
