<p align="center">
  <img src="docs/hero.png" alt="plan-tango — Claude and Codex dancing on one plan" width="400">
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

More than once I've caught myself sending plans from Claude into Codex by hand. GPT's feedback is usually useful, and one round rarely closes it. So I'd write the plan, paste it into Codex, wait for the findings, bring them back to Claude, ask to apply, send the updated plan to Codex for another round, wait for the next batch of findings, bring those back. And again. Between rounds you wait, sometimes lose track of which terminal has the latest verdict and is waiting on you.

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
/plan-tango --fast               # priority service tier (~1.5× faster)
/plan-tango --max-iter 10 --effort medium --lenient --quiet --fresh-each
```

Persistent defaults live in `~/.claude/plan-tango/config.json`. For an interactive wizard instead of hand-editing JSON: `/plan-tango:config`.

Full reference (flag list, status codes, architecture notes) — [plugins/plan-tango/README.md](plugins/plan-tango/README.md) (English) · [plugins/plan-tango/README.ru.md](plugins/plan-tango/README.ru.md) (Russian).

## What the plugin handles beyond the loop itself

- **Thread mode (continue / fresh).** By default all iterations share one Codex thread (`continue`): cheaper thanks to prompt-cache hits on repeated plan content, faster, and only one thread per run in the Codex panel. At iter ≥ 2 a reset block is injected into the prompt — a short "forget your previous verdicts on this plan and evaluate fresh" instruction — to keep Codex from anchoring on its earlier output. If you want a fully independent audit each round, pass `--fresh-each` or set `thread_mode: fresh` in config.
- **Severity-aware stop.** If a round leaves only cosmetic findings (formatting, wording nitpicks), the plugin doesn't trigger another corrective round — auto-applying cosmetic fixes usually makes them worse. Those findings render as an advisory list in the final report; apply manually if you want. Turn off via `severity_aware: false` in config.
- **Snapshots and hash integrity.** Every apply phase writes `.iter{N}.bak` next to the plan. Before each iteration the plan's sha256 is compared against `last_known`; if it changed outside the loop (an IDE save, another tool), the skill stops with a clear error rather than clobbering those edits.
- **Resume.** State is persisted after every apply phase; an interrupted run (Ctrl+C, Claude Code crash, machine reboot) picks up from the same iteration via `--resume`.

Plus the smaller stuff: per-plan lock file (two parallel runs on the same plan can't clobber each other; lock becomes stale after 30 min), off-plan guard (the plugin **only** edits the plan file — if Codex asks to change code in the repo, the finding is logged as `off_plan_blocked` and skipped), and an optional Opus final sanity-check via `--final-check` for plans that touch runtime contracts (subagents / permissions / hooks / MCP).

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
