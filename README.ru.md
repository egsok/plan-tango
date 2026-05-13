# plan-tango

> Авто-сходимость плана Claude Code через итерации Codex (gpt-5) review — Codex критикует → Claude применяет правки → Codex re-review → пока не получится чистый `ALLOW` или не сработает hard cap.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Version](https://img.shields.io/badge/version-0.2.0-green) [![Read in English](https://img.shields.io/badge/lang-en-red)](README.md)

Когда ты только что написал нетривиальный план в plan mode и хочешь второе мнение от другой модели до имплементации, ручной копипаст между терминалами не масштабируется. `plan-tango` автоматизирует ping-pong: читает активный plan-файл под `~/.claude/plans/`, спавнит Codex CLI на структурированный review, применяет правки обратно в план через `Edit`, и зацикливает. Дефолтный бюджет — 6 итераций (hard cap 12). Работает прямо внутри plan mode — не нужно выходить и заходить.

## Установка

1. **Зависимости**: Claude Code 2.x, Node.js 18+, Codex CLI на `PATH`:
   ```
   npm install -g @openai/codex
   codex login
   ```

2. **Добавить marketplace и поставить плагин**:
   ```
   /plugin marketplace add egsok/plan-tango
   /plugin install plan-tango@plan-tango
   ```

3. **Рестарт Claude Code сессии** — чтобы плагин загрузил skills, scripts и agent в namespace.

## Использование

```
/plan-tango                   # использовать активный план из plan mode (или самый свежий в ~/.claude/plans/)
/plan-tango <slug-or-path>    # явный plan-файл
/plan-tango --max-iter 10 --effort medium --lenient --quiet
```

Опциональные постоянные настройки: `~/.claude/plan-tango/config.json` (запусти `/plan-tango:config` для интерактивного wizard'а, либо скопируй `plugins/plan-tango/skills/plan-tango/user-config.example.json` и отредактируй вручную).

Полная справка по флагам, статусам и архитектуре: [plugins/plan-tango/README.md](plugins/plan-tango/README.md) (English) · [plugins/plan-tango/README.ru.md](plugins/plan-tango/README.ru.md) (Russian).

## Обновление

Ручное:
```
/plugin update plan-tango@plan-tango
```

Авто-обновление (opt-in на marketplace): открой `/plugin`, выбери **Marketplaces → plan-tango → Enable auto-update**. У third-party marketplace'ов авто-обновление по умолчанию выключено — это политика Claude Code, не выбор plan-tango.

Независимо от этих двух механизмов, plan-tango сам проверяет GitHub release channel в конце каждого прогона: не чаще раза в 7 дней, silent на network failure, печатает одну строку когда доступна новая версия. Opt-out — `update_check: false` в `~/.claude/plan-tango/config.json`.

## Feedback

Issues, PR'ы, предложения: [github.com/egsok/plan-tango/issues](https://github.com/egsok/plan-tango/issues). Телеграм-канал про AI-инструменты и Claude Code: [@neiroset_ne_vinovata](https://t.me/neiroset_ne_vinovata).

## License

MIT — см. [LICENSE](LICENSE). Copyright (c) 2026 Egor Sokolov.
