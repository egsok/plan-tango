<p align="center">
  <img src="docs/hero.png" alt="plan-tango — Claude и Codex танцуют над одним планом" width="280">
</p>

<h1 align="center">plan-tango</h1>

<p align="center">
  <em>Два AI ревьюят один план в цикле.</em><br>
  Claude Code пишет → Codex (gpt-5) разносит → Claude применяет фиксы → пока Codex не скажет <code>ALLOW</code>.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version 0.2.0">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-en-red" alt="Read in English"></a>
</p>

---

Когда план в plan mode становится плотным настолько, что за него страшно браться, обычный ход выглядит так: открыть Codex в соседнем терминале, скопировать план туда, дождаться ревью, перетащить findings обратно в Claude, применить, снова в Codex — посмотреть, что осталось. plan-tango гоняет этот цикл одной командой.

Скилл читает активный plan-файл под `~/.claude/plans/`, спавнит `codex exec` со структурированным review-промптом, парсит вердикт (`ALLOW` или `BLOCK` + findings), применяет правки обратно в план через `Edit`, и повторяет — по дефолту до 6 итераций, hard cap 12. Из plan mode выходить не нужно.

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
/plan-tango --max-iter 10 --effort medium --lenient --quiet
```

Постоянные настройки лежат в `~/.claude/plan-tango/config.json`. Если не хочется редактировать JSON руками — интерактивный wizard: `/plan-tango:config`.

Полная документация по флагам, статусам и архитектуре — [plugins/plan-tango/README.md](plugins/plan-tango/README.md) (English) · [plugins/plan-tango/README.ru.md](plugins/plan-tango/README.ru.md) (Russian).

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
