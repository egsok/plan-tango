# plan-tango — Schemas

Reference for the JSON shapes the orchestrator and helper scripts read or write.
SKILL.md links here from Phase B step 8 (state), Phase C step 13 (params), and Phase C step 22 (ledger).

## state.json

Path: `~/.claude/plans/{slug}-tango.state.json`. One file per slug. Updated after every iteration; intact for `--resume`.

```json
{
  "iter": 0,
  "original_plan_hash": "<sha256>",
  "last_known_plan_hash": "<sha256>",
  "last_verdict": null,
  "findings_history": [[], [], []],
  "settings": {
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
    "severity_aware": true
  },
  "settings_sources": {
    "max_iter": "default",
    "effort": "default",
    "...": "..."
  },
  "repo_root": "<absolute path>",
  "repo_evidence_available": true,
  "codex_thread_id": null,
  "codex_version": "codex-cli 0.125.0",
  "polish_only_terminal": false,
  "polish_advisory": []
}
```

Field notes:
- `iter` — count of *completed* iterations. Increments AFTER apply phase succeeds.
- `findings_history` — rolling window of last three iters' finding-hash sets (oldest first). Used for oscillation/stuck detection in Phase C step 21 e/f.
- `settings` — populated by `load-config.mjs` (Phase B step 8.5). Orchestrator-only keys live here, NOT in `iter{N}.settings.json`.
- `settings_sources` — per-key origin: `"cli" | "config" | "default"`. Diagnostic only.
- `codex_thread_id` — non-null only after iter 1 in `thread_mode=continue`. Reset on `fallback_to_fresh`.
- `polish_only_terminal` + `polish_advisory` — set when severity-aware stop fires (Phase C step 21 a2 or Phase D step 28a-polish). Drives Phase E §6.

## iter{N}.params.json

Path: `~/.claude/plans/{slug}-tango.workspace/iter{N}.params.json`. Built by `prepare-iter.mjs` (replaces legacy `build-params.mjs`). Consumed by `run-codex-review.mjs`.

```json
{
  "prompt_file":              "<workspace>/iter{N}.prompt.md",
  "repo_root":                "<repo_root>",
  "repo_evidence_available":  true,
  "iter":                     1,
  "slug":                     "<slug>",
  "output_last_message_file": "<workspace>/iter{N}.last-message.txt",
  "settings": {
    "effort":             "high",
    "model":              "<optional>",
    "service_tier":       "<optional>",
    "codex_profile":      "<optional>",
    "extra_codex_config": ["key=value", "..."]
  },
  "thread_mode":      "continue",
  "resume_thread_id": "<state.codex_thread_id>"
}
```

Rules enforced by `prepare-iter.mjs`:
- `settings.*` is the codex-relevant subset only. Orchestrator-only keys (`max_iter`, `thread_mode`, `final_check`, `lenient`, `quiet`, `verbose_report`, `severity_aware`) are rejected with an error if passed.
- Optional keys (`model`, `service_tier`, `codex_profile`, `extra_codex_config` when empty array) are omitted from output when null/empty. `effort` is always included.
- `resume_thread_id` is set only when ALL three hold: `thread_mode === "continue"` AND `iter >= 2` AND a non-null UUID was passed. Otherwise `null` — wrapper opens a fresh thread.
- The reset-block (in `iter{N}.prompt.md`) is gated by the same predicate as `resume_thread_id`.

## state.settings codex-relevant subset (passed inline to prepare-iter)

The orchestrator passes the subset INLINE via `prepare-iter.mjs --state-settings '<json>'` — there is no per-iter `iter{N}.settings.json` file in v0.2 (commit 5 of the operational-simplification sprint removed the orchestrator Write step):

```json
{
  "effort":             "<state.settings.effort>",
  "model":              "<state.settings.model or omitted>",
  "service_tier":       "<state.settings.service_tier or omitted>",
  "codex_profile":      "<state.settings.codex_profile or omitted>",
  "extra_codex_config": ["key=value", "..."]
}
```

Always omit any optional key whose value is null/empty array. Always include `effort`. ~5 lines, so a Write tool call is cheap.

## ledger.json

Path: `~/.claude/plans/{slug}-tango.ledger.json`. Append-only per-iteration entries.

```json
{
  "slug":         "<slug>",
  "iterations":   [
    {
      "iter":             1,
      "iteration_kind":   "normal",
      "verdict":          "BLOCK",
      "codex_seconds":    25.69,
      "session_id":       "<uuid>",
      "fallback_to_fresh": false,
      "findings_count":   1,
      "severity_counts":  { "critical": 1, "major": 0, "minor": 0, "nit": 0 },
      "entries": [
        {
          "hash":                "<finding-hash>",
          "severity":            "critical",
          "action":              "applied | deferred | manual | off_plan_blocked | advisory | build_script_failed | error",
          "note":                "<optional>",
          "requested_file_path": "<optional>",
          "suggested_fix":       "<optional>",
          "edit_summary":        "<optional, when action=applied>"
        }
      ]
    }
  ],
  "final_status": "<from Phase E>"
}
```

`iteration_kind` values: `normal`, `final-fix`, `final-check-advisory`. Phase E §4 ("What Codex caught") pulls from `iterations[*].entries` filtered by action.

## verdict shape (run-codex-review.mjs output, consumed in Phase C step 16)

The wrapper returns one JSON object on stdout. Orchestrator does NOT re-parse the verdict text — it reads these fields directly:

```json
{
  "verdict":            "ALLOW | BLOCK | ERROR | MALFORMED",
  "summary":            "<one-line, present on ALLOW/BLOCK>",
  "findings":           [ /* finding objects, present on BLOCK */ ],
  "raw_final_message":  "<full text Codex emitted>",
  "session_id":         "<uuid|null>",
  "fallback_to_fresh":  false,
  "last_message_path":  "<absolute path>",
  "codex_seconds":      25.69,
  "codex_stderr_tail":  "<tail of stderr, rollout-noise filtered>",
  "exit_code":          0,
  "raw_output_excerpt": "<first ~2KB of JSONL stream>",
  "warnings":           [],
  "reason":             "<present on ERROR/MALFORMED>",
  "parsed_at":          "<ISO-8601>"
}
```

Each finding object:
```json
{
  "n":        1,
  "severity": "critical | major | minor | nit",
  "title":    "<short>",
  "location": "<plan section / line hint>",
  "problem":  "<what's wrong>",
  "fix":      "<suggested correction>"
}
```

For the full input/output contract Codex produces, see `references/verdict-contract.md`.
