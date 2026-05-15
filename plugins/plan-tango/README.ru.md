# plan-tango

> Read in English: [README.md](README.md)

Авто-цикл review плана между Claude Code и Codex (gpt-5). Вместо ручного копипаста между вкладками — одна команда, и план гоняется через Codex review → Claude правит → ещё review → пока не получится чистый `ALLOW` или не сработает один из стоп-критериев.

## Когда использовать

Ты только что написал план в plan mode (Claude Code сохранил его в `~/.claude/plans/{slug}.md`) и хочешь укрепить его внешним AI-ревью перед имплементацией. Скилл сам:
- читает текущий plan-файл,
- гоняет до 6 (по дефолту, hard cap 12) итераций Codex review,
- применяет правки в plan-файл через Edit (только в нём, никогда в других файлах),
- опционально добавляет финальную проверку Opus subagent'ом для планов с runtime-контрактами (subagents/permissions/hooks/MCP).

Работает **прямо внутри plan mode** — не нужно выходить и заходить.

## Базовое использование

Вызывается как **`/plan-tango:run`** (или выбери из дропдауна slash-команд при наборе `/plan-tango`).

Без аргументов: возьмёт активный plan-файл из системного промпта, либо самый свежий по mtime в `~/.claude/plans/`.

С явным планом:
```
/plan-tango:run <slug-or-path>
/plan-tango:run sample-plan
/plan-tango:run ~/.claude/plans/foo.md
```

Wizard для постоянных настроек: **`/plan-tango:settings`**.

## Все опции

| Флаг | Дефолт | Что делает |
|---|---|---|
| `--max-iter N` | 6 (cap 12) | Лимит итераций. На достижении — interactive prompt: continue +4 / continue custom / stop / abort. Hard cap 12 не обходится даже через continue. |
| `--effort none\|minimal\|low\|medium\|high\|xhigh` | `high` | Reasoning-effort для Codex. ⚠️ `minimal` отвергается Codex API когда включены image_gen/web_search инструменты (default setup) — используй `low` если хочешь быстрее. |
| `--model <m>` | unset | Конкретная модель Codex. По умолчанию `--model` НЕ передаётся — Codex выбирает свою стандартную модель сам (из `~/.codex/config.toml`). Передай явно (например `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) если нужна конкретная. |
| `--lenient` | off | Останавливаться когда нет critical/major (вместо строгого ALLOW) |
| `--no-final-check` | off | Никогда не запускать Opus финал-чек. Взаимоисключающий с `--force-final-check`. |
| `--force-final-check` | off | Запустить Opus даже если auto-gate сказал "skip". Взаимоисключающий с `--no-final-check`. |
| `--resume` | off | Подхватить с сохранённого state (требует явный slug/path или активный план) |
| `--takeover` | off | Адопт corrupt lock'а после inspect (флаг ОБЯЗАТЕЛЕН). Stale lock'и (>30 мин) auto-removed без этого флага (warning в stderr). Свежие (≤30 мин) lock'и отказываются всегда — `--takeover` НЕ перехватывает их. Используй только для corrupt locks убедившись что параллельного запуска нет. |
| `--continue-thread` / `--fresh-each` | `continue` (built-in) | Thread mode override (взаимоисключающие). `continue` (default) — все итерации в одном Codex thread (`codex resume`), дешевле/быстрее, чище в Codex panel; iter ≥ 2 получают reset-prompt чтобы Codex не anchorился на прошлых выводах. `fresh` — каждая итерация новый thread (полностью независимый аудит). См. секцию «Thread mode» ниже. |
| `--fast` | off | Shortcut для `--service-tier fast`. Включает Codex priority processing tier (~1.5x скорость, +$). Требует `features.fast_mode = true` в `~/.codex/config.toml` (default). |
| `--service-tier <fast\|flex>` | unset | Явный выбор service tier (передаётся как `-c service_tier="<value>"`). |
| `--codex-profile <name>` | unset | Profile из `~/.codex/config.toml` (`-p <name>`). Загружается ДО `-c` overrides; canonical settings (effort, service_tier, model) выигрывают на конфликте. |
| `--quiet` | off | Заглушает per-iteration сообщения в Phase C (snapshot/spawn/ALLOW-BLOCK verdict-line/apply summary). Phase E §1-§5 (final report) печатается всегда. ERROR/MALFORMED verdict lines печатаются всегда. Bash IN/OUT панели не управляются скиллом — это рендер Claude Code. |

## Persistent defaults — `~/.claude/plan-tango/config.json`

Если не хочешь каждый раз набирать `--effort medium --max-iter 8` — положи дефолты в файл:

```bash
mkdir ~/.claude/plan-tango
cp "$(claude plugin path plan-tango)/skills/run/user-config.example.json" ~/.claude/plan-tango/config.json
# Если `claude plugin path` недоступен, путь обычно: ~/.claude/plugins/marketplaces/plan-tango/plugins/plan-tango/skills/run/user-config.example.json
# отредактируй
```

Поля (все опциональные, отсутствующие → built-in default):

```json
{
  "model": null,
  "effort": "high",
  "max_iter": 6,
  "thread_mode": "continue",
  "final_check": "never",
  "lenient": false,
  "service_tier": null,
  "codex_profile": null,
  "extra_codex_config": [],
  "quiet": false,
  "severity_aware": true,
  "verbose_report": false,
  "update_check": true
}
```

> `severity_aware` is **config-only** — no CLI flag (by design choice — see «Severity-aware convergence» section ниже). Чтобы выключить — выстави `false` в config.json или прогони wizard `/plan-tango:settings`.

**Precedence (старшее побеждает):**
```
CLI флаг > ~/.claude/plan-tango/config.json > built-in default
```

Валидация при загрузке: `effort` enum, `max_iter ≤ 12`, `thread_mode ∈ {fresh, continue}`, `service_tier ∈ {null, fast, flex}`, `final_check ∈ {never, always}` (старые `auto` / `force` принимаются и auto-мигрируются с warning'ом). На нарушении — abort с понятной ошибкой ДО старта прогона.

`extra_codex_config: ["key=val", ...]` — массив сырых `-c key=value` для проброса в Codex (для флагов которые plan-tango не surface'ит сам). Применяются ПОСЛЕ profile, но ДО canonical (effort/service_tier/model выигрывают на конфликте).

> Если запускаешь `/plan-tango:settings` — мастер сохраняет существующее значение `extra_codex_config` без изменений (нет UI для редактирования массива через AskUserQuestion). Чтобы добавить/удалить `-c key=value` строки — отредактируй `~/.claude/plan-tango/config.json` вручную.

## Thread mode

Дефолт встроенный — `continue`. Переключение через флаг или config.

| Mode | Поведение | Плюсы | Минусы |
|---|---|---|---|
| `continue` (default) | Iter 1 открывает thread, iter ≥ 2 делают `codex exec resume <id>` + reset-prompt в начале промпта | Дешевле (prompt cache hits на повторяющихся блоках), быстрее, один thread в Codex panel на весь run. Reset-prompt снижает anchor bias | Bias не устранён полностью — Codex видит свою прошлую историю |
| `fresh` | Каждая итерация — новый Codex thread (`codex exec` без resume) | Полностью независимые review, нет anchor bias | Дороже (нет prompt-cache hit), медленнее, засирает список сессий в Codex panel |

Switch: `--continue-thread` или `--fresh-each` (взаимоисключающие). Persistent — поле `thread_mode` в config.json.

**Lost-session fallback** — если в continue-mode codex не нашёл сохранённый thread (удалили через TUI, исчез из `~/.codex/sessions/`), wrapper автоматически делает один re-spawn в fresh, обновляет thread_id и продолжает. В логе: `Thread <id> lost, falling back to fresh.`

**⚠️ Migration note (для тех у кого уже есть config.json)**: если ты копировал `user-config.example.json` в `~/.claude/plan-tango/config.json` до сегодняшнего обновления — там скорее всего стоит `"thread_mode": "fresh"` (старый дефолт). Этот файл pin'ит старое поведение (precedence: user-config > built-in default). Чтобы перейти на новый дефолт `continue` — либо удали поле `thread_mode` из своего config.json (полностью), либо явно поставь `"continue"`.

## Severity-aware convergence (`severity_aware`)

Включён по умолчанию. Меняет реакцию на BLOCK verdicts по severity:

- **clean** — `ALLOW` + 0 findings → `converged` (как было)
- **polish-only** — `BLOCK` с only minor/nit (zero critical/major) → **terminal**, без corrective iter. Status: `converged-with-polish` (или `converged-lenient` если ты тоже передал `--lenient`). Polish findings рендерятся в §6 финального отчёта как advisory list.
- **blocking** — `BLOCK` с ≥1 critical/major → corrective iter (как было)

**Зачем**: на длинных прогонах loop переходит из «снижает риск» в «имитирует уверенность» — полировочные findings (стиль JSON-комментариев, формулировки invariants) гоняются через corrective iter с тем же весом что архитектурные баги, и сами правки вносят новые minor inconsistencies. Severity-aware terminate'ит на polish-only, оставляя список advisory в §6 — пользователь сам решает применять или нет.

**Точное поведение по комбинациям с `--lenient`** (сравнительная таблица):

| Config | `--lenient` | На polish-only BLOCK |
|---|---|---|
| `severity_aware: true` (default) | off | terminal, status=`converged-with-polish`, advisory в §6 |
| `severity_aware: true` (default) | on | terminal, status=`converged-lenient`, advisory в §6 (preserves --lenient downstream-metric semantic) |
| `severity_aware: false` (opt-out) | off | corrective iter (legacy behavior — гоняет polish-fixes) |
| `severity_aware: false` (opt-out) | on | terminal, status=`converged-lenient`, advisory **NE** rendered (legacy --lenient путь) |

**`--lenient` НЕ skip'ает Opus final-check** — `converged-lenient` остаётся в auto-gate-eligible row Phase D pre-gate. Если хочешь skip Opus — у тебя есть отдельный `--no-final-check`.

**Opt-out**: только через config.json. Поставь `"severity_aware": false` в `~/.claude/plan-tango/config.json` или прогони `/plan-tango:settings`. CLI флага намеренно нет (`--lenient` уже занимает explicit per-run polish-stop niche; пара флагов с пересекающейся семантикой смутила бы пользователя).

## Тихий режим (`--quiet`)

По умолчанию скилл печатает 1-2 строки на итерацию (Snapshot, Sending to Codex, verdict counts, Applied N fixes). Для длинных прогонов (8-12 итераций) это шумно.

`--quiet` или `quiet: true` в config.json — оставляет только:
- Phase A heads-up (контракт перед run) + deprecation warnings (если есть)
- Phase A lock-acquired подтверждение (когда `lock_took_over_stale=true`)
- **ERROR / MALFORMED verdict lines** — диагностика critical state changes (всегда печатаются, даже в quiet)
- AskUserQuestion (continue-prompt, manual-required)
- ABORT/error messages
- **Phase E §1-§5 — полный отчёт** (header + stats block + convergence table + what Codex caught + narrative)

**Что НЕ контролируется флагом**: Bash IN/OUT панели рисует сам Claude Code (включая когда Bash вызовы помечены как allowlisted). Чтобы убрать и эти панели — настрой allowlist через `/fewer-permission-prompts`, тогда Claude Code прячет одобренные вызовы.

CLI: `/plan-tango:run <slug> --quiet`
Persistent: добавь `"quiet": true` в `~/.claude/plan-tango/config.json` (или прогони `/plan-tango:settings`).

## Fast mode (priority service tier)

Codex поддерживает priority processing tier — ~1.5x скорость за более высокий per-token cost. Включается через `--fast` или `--service-tier fast`:

```
/plan-tango:run <slug> --fast
```

Под капотом: `-c service_tier="fast"` в `codex exec` argv. Это маппится в `service_tier: "priority"` для OpenAI Responses API.

**Требования:**
- `features.fast_mode = true` в `~/.codex/config.toml` (это default в текущем Codex CLI). Проверить:
  ```powershell
  codex features list | Select-String fast_mode    # Windows
  codex features list | grep fast_mode             # POSIX
  ```
- Если `fast_mode` выключен (`--disable fast_mode` или manual в config) — `service_tier=fast` будет проигнорирован Codex'ом silently.

**Биллинг**: priority tier идёт по более высокой ставке. Если важно — посмотри [Codex speed docs](https://developers.openai.com/codex/speed) и [OpenAI priority processing](https://developers.openai.com/api/docs/guides/priority-processing).

**Альтернатива** — постоянно через profile в `~/.codex/config.toml`:
```toml
[profiles.review-fast]
service_tier = "fast"
model_reasoning_effort = "high"
```
Затем: `/plan-tango:run <slug> --codex-profile review-fast`.

## Как идёт цикл

```
Phase A. Init (init.mjs — single Bash call)
   resolve plan-path → validate (size, location) → codex --version →
   resolve repo-root → load merged settings → acquire lock (session_id) →
   write/load state.json → ensure workspace dir → heads-up
   (lock acquired BEFORE any state/workspace write; init handles internal
    cleanup if a step after lock-acquire fails)

Phase C. Loop (max-iter раз)
   integrity check (sha256) → snapshot → prepare-iter.mjs (prompt+params+stub) →
   call run-codex-review.mjs → handle ERROR/MALFORMED → classify findings →
   check stop conditions → apply fixes via Edit → update last_known_hash → refresh lock

Phase D. Final (если status=converged* AND --final-check)
   pre-gate → Opus final-check → при critical/major: corrective iter →
   ОДИН Codex re-review

Phase E. Summary
   print stats → release lock (если acquired) → opt cleanup workspace
```

## Возможные финальные статусы

| Status | Что произошло | Что делать |
|---|---|---|
| `converged` | Codex дал чистый ALLOW | План готов |
| `converged-with-polish` | `severity_aware: true` (default), Codex дал BLOCK с only minor/nit | Список polish findings в §6 отчёта; применять вручную если нужно (auto-iter не запускался по design — см. «Severity-aware convergence») |
| `converged-lenient` | `--lenient` включён, остались только minor/nit (либо severity_aware+lenient путь) | Прочитать оставшиеся nits в ledger / §6, решить вручную |
| `converged-final` | После Opus final-check без критических замечаний | План готов, прошёл двойную проверку |
| `manual-required` | Codex предложил развилку (option A/B) или critical/major fix не применяется автоматически | Решить вручную, отредактировать план, опционально `--resume` |
| `manual-required-after-final` | Opus нашёл проблему, fix требует ручного решения | См. ledger, доделать вручную |
| `final-check-divergence` | Opus и Codex разошлись на финале | Прочитать оба набора findings, решить вручную |
| `stuck` | Две итерации подряд возвращают идентичные findings | Codex не понимает плана; перепиши проблемные секции вручную |
| `oscillating` | Codex флаппит между двумя оценками (X в N-2, Y в N-1, X в N) | Конфликтующие требования; разрешить вручную |
| `regressed` | Стало больше critical findings после применения правок | Откатиться через snapshot |
| `max-iter-reached` | Достигнут лимит итераций, на continue-prompt выбран "Stop here" | Прочитать findings, добить вручную или новый прогон с большим `--max-iter` (cap 12) |
| `aborted-by-user` | На continue-prompt выбран "Abort run" | Lock освобождён, ledger закрыт. State остался — можно сделать `--resume` если передумал |
| `off-plan-target` | Codex/Opus попросили править файл вне плана | Скилл это запрещает; внести правки в код вручную |
| `external-modification` | План был отредактирован вне скилла во время цикла | Решить — продолжать с новым состоянием или откатиться |
| `final-check-malformed` | Opus вернул не-ALLOW/BLOCK даже после retry | Запустить final-check вручную с тем же планом |
| `final-recheck-error` / `final-recheck-malformed` | Codex re-review после final-fix провалился | Глянь stderr_tail, повторить позже |

## Артефакты на диске

Все файлы лежат рядом с планом в `~/.claude/plans/`:

```
foo.md                              # сам план (его правит скилл)
foo.iter1-2026-...bak               # снапшот перед apply iter 1
foo.iter2-...bak                    # перед iter 2
...
foo-tango.state.json             # iter, hashes, settings, repo info
foo-tango.ledger.json            # все findings + actions по итерациям
foo-tango.lock                   # active lease (удаляется в Phase E)
foo-tango.workspace/             # temp prompts/params (cleanup при success)
  ├── iter1.prompt.md
  ├── iter1.params.json
  └── ...
```

**Ledger schema** — что какая запись означает:

| `iteration_kind` | Когда |
|---|---|
| `normal` | Обычная итерация Phase C |
| `final-fix` | Corrective итерация после Opus critical/major (Phase D 28b) |
| `final-check-ignored` | Opus нашёл только minor/nit — пропустили |
| `force-diagnostics` | `--force-final-check` на non-converged status |

| `action` | Когда |
|---|---|
| `applied` | Edit прошёл, план изменён |
| `deferred` | apply-fixes не смог применить (конфликт/ambiguity ИЛИ off-plan minor/nit) |
| `manual` | Codex предложил несколько вариантов |
| `ignored_minor_nit` | Final-check minor/nit, не блокирующие |
| `diagnostic` | Force-diagnostics findings, к плану не применяются |
| `off_plan_blocked` | Critical/major finding указывал на файл вне плана — заблокировано |

## Permissions при первом запуске

Скилл вызывает Bash для node-скриптов. Первый прогон попросит permission на:

```
Bash(node *plan-tango/scripts/init.mjs *)              # consolidated Phase A init
Bash(node *plan-tango/scripts/prepare-iter.mjs *)      # iter{N}.{prompt,params,last-message} builder
Bash(node *plan-tango/scripts/run-codex-review.mjs *)   # Codex wrapper (spawns codex exec)
Bash(node *plan-tango/scripts/parse-codex-verdict.mjs *)
Bash(node *plan-tango/scripts/parse-codex-jsonl.mjs *)
Bash(node *plan-tango/scripts/load-config.mjs *)
Bash(node *plan-tango/scripts/plan-paths.mjs *)
Bash(node *plan-tango/scripts/snapshot.mjs *)
Bash(node *plan-tango/scripts/workspace.mjs *)
Bash(node *plan-tango/scripts/lock.mjs *)
Bash(node *plan-tango/scripts/apply-fixes.mjs *)
Bash(codex --version)                                   # version check inside init.mjs
Edit(~/.claude/plans/*.md)
Read(~/.claude/plans/**)
Read(~/.claude/plan-tango/config.json)                  # persistent defaults (optional file)
Write(~/.claude/plans/*.iter*.bak)
Write(~/.claude/plans/*-tango.state.json)
Write(~/.claude/plans/*-tango.ledger.json)
Write(~/.claude/plans/*-tango.lock)
Write(~/.claude/plans/*-tango.workspace/**)
```

После первого прогона запусти `/fewer-permission-prompts` — он добавит allowlist в `~/.claude/settings.json`, и дальше прогоны будут без вопросов.

**Diagnostics:** при подозрении на проблемы (codex CLI not found, plans dir not writable, lock stuck) запусти `node ${CLAUDE_PLUGIN_ROOT}/skills/run/scripts/doctor.mjs` — проверит codex CLI, парсинг user-config, write-доступ к `~/.claude/plans/`, lock acquire/release цикл и контракт `run-codex-review.mjs` на bad input. Все проверки read-only / dry-run; пробные файлы убираются автоматически. Добавь `--json` для машинно-читаемого вывода.

### Plan mode + paths под `~/.claude/plans/` (важно)

В **plan mode** Claude Code применяет дополнительные ограничения: даже при `defaultMode: "acceptEdits"` и `skipAutoPermissionPrompt: true` любой `Edit`/`Write` на путь **вне текущего VS Code workspace folder ИЛИ вне `permissions.additionalDirectories`** требует approval prompt. Опция «Yes, allow all edits this session» в plan mode действует только на конкретный файл — следующий Write на другой файл снова прокидывает prompt.

Скилл пишет state/ledger/snapshot/workspace files под `~/.claude/plans/<slug>-tango.*`, что **обычно вне твоего рабочего workspace** (например, при работе из `D:\dev\my-project\` пути под `C:\Users\<you>\.claude\plans\` чужие). В plan mode это даёт по 5–10+ approval prompts за один прогон.

**One-time fix** в `~/.claude/settings.json` → `permissions`:

```json
{
  "permissions": {
    "additionalDirectories": ["~/.claude/plans"],
    "allow": [
      "Edit(~/.claude/plans/**)",
      "Write(~/.claude/plans/**)",
      "Read(~/.claude/plans/**)"
    ],
    "defaultMode": "acceptEdits"
  }
}
```

**Почему это нужно отдельно от обычного allowlist:**
- `additionalDirectories` расширяет scope `acceptEdits` за пределы workspace — **необходимо** для путей под `~/.claude/`, которые иначе попадают под protected-paths policy.
- `Edit(...)` rules покрывают built-in file-editing tools в целом — **важнее** чем `Write(...)`. Указывай оба для надёжности.
- Tilde-форма (`~/.claude/plans/**`) работает кросс-платформенно. Windows-форма `Edit(C:\\Users\\<you>\\.claude\\plans\\**)` — fallback, если tilde не resolve'ится.

**После применения patch'а нужен рестарт активной Claude Code сессии** — VS Code extension кеширует permissions при старте session, изменения settings.json не подхватываются на лету. Закрой окно VS Code (или re-open workspace) → новая сессия загрузит обновлённые permissions.

**Альтернатива** (если не хочешь править глобальные settings): запускай `/plan-tango:run` **вне** plan mode. Plan mode для скилла избыточен — план уже написан, дальше только review loop. Обычный режим с `defaultMode: "acceptEdits"` даёт silent flow без дополнительных настроек.

## Прерывание и возобновление

**Ctrl+C / прерывание**: state.json остаётся консистентным (обновляется после каждой apply-фазы). Lock остаётся на 30 минут — после этого считается stale и автоматически перехватывается следующим запуском.

**Возобновить с того же места**:
```
/plan-tango:run <slug-or-path> --resume
```
Скилл прочитает state, проверит что план не менялся вне скилла (через `last_known_plan_hash`), и продолжит с следующей итерации.

`--resume` БЕЗ явного slug/path откажется — это намеренно (защита от того что за время паузы появился новый план и `--resume` подхватит не тот файл).

## Troubleshooting

**"Lock held by another session"** — либо реально другой запуск работает, либо предыдущий упал и lock не успел истечь.
- Проверь: `node "${CLAUDE_PLUGIN_ROOT}/skills/run/scripts/lock.mjs" inspect --slug <slug>` (или абсолютный путь под ~/.claude/plugins/marketplaces/plan-tango/...)
- Если параллельного запуска точно нет → подожди до 30 мин (auto-stale) или передай `--takeover` после inspect.

**"Plan modified outside skill since last completed iteration"** — кто-то (или ты сам в редакторе) поменял план между итерациями.
- Если изменения важны → не делай `--resume`, начни новый прогон, скилл подхватит новое состояние.
- Если изменения случайные → откати через `cp foo.iter{N}.bak foo.md` и `--resume`.

**"Codex CLI not found on PATH"** — Codex CLI не установлен или не виден из текущей оболочки.
- Проверка: `codex --version` (должен напечатать версию).
- Установка: `npm install -g @openai/codex`.
- Авторизация: `codex login` (или `/codex:setup` из плагина openai-codex, если он установлен).

**`status=stuck` или `oscillating`** — Codex упёрся. Прочитай ledger, найди проблемную секцию, перепиши её вручную, затем новый прогон скилла.

**`status=off-plan-target`** — Codex/Opus попросили править файл вне плана.
- Нормально: скилл правит ТОЛЬКО plan-файл. Если finding осмысленный — внеси изменение в код руками отдельно.
- Если finding некорректный — он будет логирован в ledger как `off_plan_blocked` с `requested_file_path` и `suggested_fix`.

**Ничего не происходит после вызова run-codex-review.mjs** — Codex может думать 30-90 секунд на effort=high. Это норма.

## Структура plugin (для разработчика)

```
~/.claude/plugins/marketplaces/plan-tango/
├── .claude-plugin/
│   └── marketplace.json                      # marketplace manifest
└── plugins/plan-tango/
    ├── .claude-plugin/
    │   └── plugin.json                       # plugin manifest
    ├── README.md                             # этот файл (для пользователя)
    ├── agents/
    │   └── plan-final-checker.md             # opus, raw ALLOW/BLOCK → registered as plan-tango:plan-final-checker (Phase D only)
    └── skills/run/
        ├── SKILL.md                          # orchestrator instructions
        ├── user-config.example.json          # образец persistent defaults
        ├── scripts/
        │   ├── init.mjs                      # Phase A in one Bash call: validate + codex-cli check + repo + load-config + lock + state init/resume + workspace
        │   ├── doctor.mjs                    # diagnostics one-liner: codex CLI, config parse, plans dir writable, lock cycle, wrapper error path
        │   ├── load-config.mjs               # CLI flags + user-config + defaults → merged settings
        │   ├── prepare-iter.mjs              # builds iter{N}.{prompt.md,params.json,last-message.txt} in one Bash call
        │   ├── run-codex-review.mjs          # spawn() codex exec --json (resolves underlying codex.js); retries empty output once
        │   ├── parse-codex-jsonl.mjs         # JSONL events → session_id + diagnostics
        │   ├── parse-codex-verdict.mjs       # ALLOW/BLOCK + findings parser (text/file/json)
        │   ├── plan-paths.mjs                # validate/newest/list-recent/resolve-repo/hash
        │   ├── snapshot.mjs                  # fs.copyFileSync с timestamp+hash
        │   ├── workspace.mjs                 # ensure/cleanup с realpath+lstat guard
        │   ├── lock.mjs                      # lease-lock с session_id
        │   └── apply-fixes.mjs               # pure planner (auto/deferred/manual)
        └── references/
            ├── review-prompt-template.md     # XML промпт для Codex (с {{RESET_BLOCK}} для continue mode)
            └── verdict-contract.md           # формат verdict с примерами
```

**Persistent state** (вне plugin dir):
- `~/.claude/plan-tango/config.json` — пользовательские дефолты (опционально, копируется из `user-config.example.json`)
- `~/.claude/plans/<slug>.md` — планы
- `~/.claude/plans/<slug>-tango.{state,ledger,lock}.json` — runtime artefacts
- `~/.claude/plans/<slug>-tango.workspace/` — temp prompts/params (cleanup при success)

## Зависимости

- **Node.js** 18+ (любая версия с поддержкой `node:*` импортов).
- **Codex CLI** на PATH. Установка: `npm install -g @openai/codex`. Авторизация: `codex login`.
- (Опционально) Плагин `openai-codex` для Claude Code — даёт `/codex:setup` UX-обёртку для авторизации, но **не обязателен** для работы plan-tango: скил вызывает `codex exec` напрямую через resolve underlying `codex.js`.

---

**License:** MIT (см. [LICENSE](../../LICENSE)) · **Author:** Egor Sokolov · Telegram: [@neiroset_ne_vinovata](https://t.me/neiroset_ne_vinovata)
