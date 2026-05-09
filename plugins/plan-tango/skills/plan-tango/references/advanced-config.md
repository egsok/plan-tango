# plan-tango — Advanced configuration

The flags and config fields below are supported by `load-config.mjs` and
`run-codex-review.mjs`, but hidden from the main SKILL.md `<context>` block
and `argument-hint` to keep the visible spec focused on the common flow.

If you don't need these — ignore this file. The skill works fine on
defaults.

## Thread mode override (`--continue-thread`, `--fresh-each`)

Default thread mode is `continue` — the orchestrator reuses one Codex
thread across iterations and injects a `<reset_iteration>` XML block at
iter ≥ 2 to suppress anchor bias on the prior verdict. This is what most
runs want.

Two flags override the default:

| Flag                | Effect                                                     |
|---------------------|------------------------------------------------------------|
| `--continue-thread` | Force `thread_mode=continue` (same as default — explicit). |
| `--fresh-each`      | Force `thread_mode=fresh` — every iter opens a new Codex thread. No reset block injected (the prior thread is gone, nothing to anchor on). |

When to use `--fresh-each`:

- You suspect the model is anchoring too hard on its previous findings
  even with the reset block (rare — measure before assuming).
- You're debugging the convergence loop and want each iter to be
  reproducible from the prompt alone.
- You're running on a Codex CLI version where `exec resume` has known
  reliability issues and want to bypass it.

If a `continue` resume fails for transient reasons (e.g. session lost),
the wrapper auto-falls back to a fresh thread for that iter and reports
`fallback_to_fresh: true` in the verdict JSON. The orchestrator updates
`state.codex_thread_id` accordingly. **You don't need `--fresh-each` to
recover from one bad resume.**

Config-file equivalent (in `~/.claude/plan-tango/config.json`):

```json
{ "thread_mode": "fresh" }
```

CLI flags take precedence over config.

## Service tier (`--service-tier`, `--fast`)

Pass an OpenAI service tier to the Codex CLI:

| Flag                       | Effect                                              |
|----------------------------|-----------------------------------------------------|
| `--service-tier fast`      | Apply `service_tier="fast"` to the spawn args.     |
| `--service-tier flex`      | Apply `service_tier="flex"`.                        |
| `--fast`                   | Alias for `--service-tier fast` (requires `features.fast_mode=true` in your Codex profile or org). |

`fast` tier costs more per token but completes faster — useful for
demo-grade runs where wall-clock matters more than budget. `flex` tier
is cheaper but slower and may queue. Standard tier (no flag) is the
sensible default for most usage.

Config-file equivalent:

```json
{ "service_tier": "fast" }
```

## Codex profile (`--codex-profile <name>`)

Apply a named profile from `~/.codex/config.toml` (or wherever your
Codex CLI looks for profiles). The wrapper passes `-p <name>` to
`codex exec`:

```bash
/plan-tango my-plan --codex-profile <profile-name>
```

Profile values are layered first; any `extra_codex_config` overrides
come next; canonical fields (effort, model, service_tier) win on
conflict. See `run-codex-review.mjs` `buildCodexArgs()` for exact
ordering.

Config-file equivalent:

```json
{ "codex_profile": "my-profile" }
```

## Extra Codex config (`extra_codex_config`)

Pass arbitrary `-c key=value` overrides to the Codex CLI. Config-only
(no CLI flag — too prone to mistakes for hot-path use):

```json
{
  "extra_codex_config": [
    "model_reasoning_summary=\"detailed\"",
    "tool_call_logging=true"
  ]
}
```

Each item is a single string the wrapper passes verbatim as `-c <item>`.
Quoting rules follow Codex CLI's TOML override syntax — strings need
their own quotes inside the value.

These are layered between the profile and the canonical fields, so
canonical settings (effort, model, service_tier) still win on conflict.

## Wrapper-only flags

| Flag                | Effect                                                     |
|---------------------|------------------------------------------------------------|
| `--verbose-output`  | Force `run-codex-review.mjs` to include `raw_final_message` and `raw_output_excerpt` even on clean ALLOW/BLOCK. Used by Phase E `--verbose-report` path when raw text is needed. Equivalent: env `PLAN_TANGO_WRAPPER_VERBOSE=1`. |

The orchestrator sets this automatically when `state.settings.verbose_report === true`. End users normally don't need to pass it directly.

## Debugging

| Env var                          | Effect                                              |
|----------------------------------|-----------------------------------------------------|
| `PLAN_TANGO_DEBUG_CODEX_ARGS=1`  | `run-codex-review.mjs` prints the resolved Codex entry path and full argv to stderr before each spawn. Useful when the wrapper picks the wrong `codex.cmd` shim. |
| `PLAN_TANGO_NO_INIT_HELPER=1`    | (Reserved — used after init.mjs lands.) Skip the consolidated init helper and run Phase A+B step-by-step in the orchestrator instead. Stabilization fallback. |
