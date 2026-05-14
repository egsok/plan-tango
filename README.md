<p align="center">
  <img src="docs/hero.png" alt="plan-tango — Claude and Codex dancing on one plan" width="280">
</p>

<h1 align="center">plan-tango</h1>

<p align="center">
  <em>A Claude Code plugin that runs a Claude ↔ Codex plan-review loop on its own.<br>
  Run one command, come back to a polished plan.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version 0.2.0">
  <a href="README.ru.md"><img src="https://img.shields.io/badge/lang-ru-red" alt="Read in Russian"></a>
</p>

---

**plan-tango** is a Claude Code plugin that runs a plan-review loop between Claude and Codex (gpt-5) with a single command.

More than once I've caught myself sending plans from Claude into Codex by hand. GPT's feedback is usually useful, and one round rarely closes it. So I'd write the plan, paste it into Codex, wait for the findings, bring them back to Claude, ask to apply, open Codex again to see what's left. And again. Between rounds you wait, sometimes lose track of which terminal has the latest verdict and is waiting on you.

plan-tango runs that loop on its own. Claude and Codex work as a pair; the plugin passes context between them and applies fixes to the plan. Default budget is 6 iterations, hard cap 12. The plugin will stop sooner if there's nothing important left to flag. You stay in plan mode and can step away to do something else; when a question comes up that needs your call, the plugin pauses and asks. For time-pressed runs (or just when you have Codex quota to spare), `--fast` flips on Codex's priority service tier (~1.5× faster).

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
