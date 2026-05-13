<p align="center">
  <img src="docs/hero.png" alt="plan-tango — Claude and Codex dancing on one plan" width="280">
</p>

<h1 align="center">plan-tango</h1>

<p align="center">
  <em>Two AIs reviewing one plan in a loop.</em><br>
  Claude Code drafts → Codex (gpt-5) critiques → Claude applies fixes → repeat until clean <code>ALLOW</code>.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version 0.2.0">
  <a href="README.ru.md"><img src="https://img.shields.io/badge/lang-ru-red" alt="Read in Russian"></a>
</p>

---

Once a plan in plan mode is dense enough to feel risky, the usual workflow is: open Codex in a second terminal, paste the plan, wait for the review, paste the findings back into Claude, apply, switch back to Codex to see what's left. plan-tango runs that loop with one command.

The skill reads your active plan file under `~/.claude/plans/`, spawns `codex exec` with a structured review prompt, parses the verdict (`ALLOW` / `BLOCK` + findings), applies any fixes back into the plan via `Edit`, and iterates — default budget 6 iterations, hard cap 12. You stay in plan mode the whole time.

## Install

**Prerequisites:** Claude Code 2.x, Node.js 18+, Codex CLI on `PATH`:

```bash
npm install -g @openai/codex
codex login
```

**Add the marketplace and install the plugin:**

```
/plugin marketplace add egsok/plan-tango
/plugin install plan-tango@plan-tango
```

Then restart your Claude Code session — the plugin's skill, scripts, and agent are registered at session start, not live.

## Usage

```
/plan-tango                      # use the active plan from plan mode
/plan-tango <slug-or-path>       # or pass a specific plan file
/plan-tango --max-iter 10 --effort medium --lenient --quiet
```

Persistent defaults live in `~/.claude/plan-tango/config.json`. For an interactive wizard instead of hand-editing JSON: `/plan-tango:config`.

Full reference (flag list, status codes, architecture notes) — [plugins/plan-tango/README.md](plugins/plan-tango/README.md) (English) · [plugins/plan-tango/README.ru.md](plugins/plan-tango/README.ru.md) (Russian).

## Update

Manual:

```
/plugin update plan-tango@plan-tango
```

Auto-update is opt-in per marketplace: open `/plugin`, navigate to **Marketplaces → plan-tango → Enable auto-update**. Third-party marketplaces have auto-update off by default — that's Claude Code policy, not a plan-tango choice.

Independent of that, plan-tango itself checks GitHub releases at the end of each run (at most once per 7 days, fails silently on network issues) and prints a one-line notice if a newer tag is out. Opt out via `update_check: false` in `~/.claude/plan-tango/config.json`.

## Feedback

Issues and PRs: [github.com/egsok/plan-tango/issues](https://github.com/egsok/plan-tango/issues). I post about AI tooling and Claude Code in the Telegram channel [@neiroset_ne_vinovata](https://t.me/neiroset_ne_vinovata).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Egor Sokolov.
