<p align="center">
  <img src="docs/hero.png" alt="plan-tango — Claude и Codex танцуют над одним планом" width="400">
</p>

<h1 align="center">plan-tango</h1>

<p align="center">
  <em>плагин для Claude Code: отправляет план на ревью в Codex и итерирует, пока все не будут довольны.<br>
  Запускаешь одной командой, возвращаешься к отполированному плану.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version 0.2.0">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-en-red" alt="Read in English"></a>
</p>

---

**plan-tango** — плагин для Claude Code: запускает ревью-цикл между Claude и Codex (gpt-5) одной командой.

Несколько раз ловил себя на том, что отправляю план от Claude в Codex руками. Фидбек от GPT обычно полезный, и в одну итерацию это закрывается редко. Написал план, скопировал в Codex, дождался findings, перенёс обратно в Claude, попросил применить, отправил обновлённый план в Codex на следующий раунд, дождался новых findings, перенёс назад. И ещё раз. Между раундами ждёшь, периодически теряешь, в каком из терминалов сейчас актуальный вердикт и требуется действие.

plan-tango прогоняет этот цикл сам. Claude и Codex работают как пара, плагин передает контекст между ними и применяет правки в плане. По дефолту бюджет — 6 итераций, hard cap 12. Плагин остановится раньше, если не будет важных замечаний. Ты остаёшься в plan mode и можешь уйти заниматься другими делами; когда возникнет вопрос, требующий тебя, плагин остановится и спросит. Для срочных прогонов (или просто если есть свободные лимиты в Codex) — `--fast` (priority service tier Codex, ~1.5× быстрее).

## Установка

**Зависимости.** Claude Code 2.x, Node.js 18+, Codex CLI на `PATH`:

```bash
npm install -g @openai/codex
codex login
```

**Подключи marketplace и поставь плагин:**

```
/plugin marketplace add egsok/plan-tango
/plugin install plan-tango@plan-tango
```

Рестартни сессию Claude Code — плагин регистрирует skill, scripts и agent на старте сессии, на лету это не подхватится.

## Использование

```
/plan-tango                      # активный план из plan mode
/plan-tango <slug-or-path>       # или явный путь к файлу
/plan-tango --fast               # priority service tier (~1.5× быстрее)
/plan-tango --max-iter 10 --effort medium --lenient --quiet --fresh-each
```

Постоянные настройки лежат в `~/.claude/plan-tango/config.json`. Если не хочется редактировать JSON руками — интерактивный wizard: `/plan-tango:config`.

Полная документация по флагам, статусам и архитектуре — [plugins/plan-tango/README.md](plugins/plan-tango/README.md) (English) · [plugins/plan-tango/README.ru.md](plugins/plan-tango/README.ru.md) (Russian).

## Что плагин делает помимо самого цикла

- **Thread mode (continue / fresh).** По дефолту все итерации идут в одном Codex thread (`continue`): дешевле за счёт prompt-cache hits на повторяющихся блоках плана, быстрее, и в Codex panel один thread на весь прогон. На iter ≥ 2 в промпт подсыпается reset-блок — короткая инструкция «забудь свои прошлые выводы по этому плану и оценивай заново», чтобы Codex не упирался в собственный прошлый вердикт (anchor bias). Если хочется полностью независимый аудит каждый раунд — `--fresh-each` или `thread_mode: fresh` в config.
- **Severity-aware остановка.** Если в раунде остались только косметические findings (форматирование, нитпики формулировок), плагин не запускает следующий corrective-раунд: косметика, прогнанная автоматическими правками, обычно делает хуже. Финдинги уходят в advisory-список в финальном отчёте — применяешь руками что хочешь. Отключить — `severity_aware: false` в config.
- **Снапшоты и hash-integrity.** Перед каждой apply-фазой пишется `.iter{N}.bak` рядом с планом. Перед каждой итерацией sha256 плана сверяется с last_known; если план поменялся снаружи цикла (IDE-сейв, другой инструмент), скилл останавливается с понятной ошибкой, не затирая чужие правки.
- **Resume.** State пишется после каждой apply-фазы; прерванный прогон (Ctrl+C, краш Claude Code, перезагрузка машины) продолжается с того же места через `--resume`.

Плюс по мелочи: lock-файл на план (два параллельных запуска не клобберят друг друга; через 30 минут lock считается stale), off-plan-защита (плагин **только** правит plan-файл — если Codex предложит править код в репо, finding логируется как `off_plan_blocked` и не применяется), опциональный Opus финал-чек через `--final-check` для планов с runtime-контрактами (subagents/permissions/hooks/MCP).

## Обновление

Вручную:

```
/plugin update plan-tango@plan-tango
```

Авто-обновление включается отдельно: `/plugin → Marketplaces → plan-tango → Enable auto-update`. У third-party маркетплейсов авто-апдейт по дефолту выключен — это политика Claude Code, не plan-tango.

Независимо от этого plan-tango в конце каждого прогона сам смотрит GitHub releases (не чаще раза в 7 дней, тихо падает при проблемах с сетью) и допечатывает одну строку, если есть свежий тэг. Отключить — `update_check: false` в `~/.claude/plan-tango/config.json`.

## Фидбек

Issues и PR — [github.com/egsok/plan-tango/issues](https://github.com/egsok/plan-tango/issues). Про AI-инструменты и Claude Code я пишу в Telegram-канал [@neiroset_ne_vinovata](https://t.me/neiroset_ne_vinovata).

## License

MIT — см. [LICENSE](LICENSE). Copyright (c) 2026 Egor Sokolov.
