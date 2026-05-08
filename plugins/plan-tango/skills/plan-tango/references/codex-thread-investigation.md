# Codex Thread Persistence Investigation (Tier 5)

## Background

During the meta-run that produced `fancy-growing-turing.md` (the v0.2 plan), every Codex review iteration emitted this stderr line, despite `fallback_to_fresh: false` in the wrapper response:

```
2026-05-08T...Z ERROR codex_core::session: failed to record rollout items: thread <session_id> not found
```

Same `session_id` was passed across iters 2–5. It was unclear whether this was:
- **(A)** Cosmetic noise — session truly resumed, only rollout recording fails.
- **(B)** Continue-mode broken — every iter actually opens a fresh thread despite shared `session_id`.
- **(C)** Wrapper bug — `run-codex-review.mjs` passes `session_id` incorrectly.

Outcome (B) would have been a major finding, requiring rework of Tier 0 (build-prompt.mjs reset_block becomes dead code) and Tier 1 invariant classification (thread invariant becomes informational).

## Test method

### Test 1: Initial call

```
codex exec --json --sandbox read-only --skip-git-repo-check -c reasoning.effort=low \
  "I'm going to tell you a secret word: PURPLE-ELEPHANT-2026. Just acknowledge that you've heard it. Reply in one sentence." \
  < /dev/null
```

Captured `thread_id: 019e0910-d82b-7362-aabb-93f6730b150d`.

Output:
```json
{"type":"thread.started","thread_id":"019e0910-d82b-7362-aabb-93f6730b150d"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I've heard the secret word."}}
{"type":"turn.completed","usage":{"input_tokens":28860,"cached_input_tokens":3456,"output_tokens":74,"reasoning_output_tokens":62}}
```

stderr: `ERROR codex_core::session: failed to record rollout items: thread 019e0910-d82b-7362-aabb-93f6730b150d not found`

### Test 2: Resume with memory probe

```
codex exec resume --json --skip-git-repo-check -c reasoning.effort=low \
  019e0910-d82b-7362-aabb-93f6730b150d \
  "What was the secret word I told you?" \
  < /dev/null
```

Output:
```json
{"type":"thread.started","thread_id":"019e0910-d82b-7362-aabb-93f6730b150d"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"The secret word was `PURPLE-ELEPHANT-2026`."}}
{"type":"turn.completed","usage":{"input_tokens":57809,"cached_input_tokens":32000,"output_tokens":146,"reasoning_output_tokens":113}}
```

stderr: `ERROR codex_core::session: failed to record rollout items: thread 019e0910-d82b-7362-aabb-93f6730b150d not found`

## Conclusion: outcome (A) — cosmetic noise

Three pieces of evidence prove session resume works correctly:

1. **Same `thread_id` returned in `thread.started` event** — Codex acknowledges the resume.
2. **Memory works.** Test 2's reply correctly recalled `PURPLE-ELEPHANT-2026`. The model could not have answered this without access to Test 1's prompt context.
3. **Massive cache hit on resume.** `cached_input_tokens` went from 3,456 (Test 1) to 32,000 (Test 2) — a ~10× jump, consistent with prior turn's tokens being cached server-side under the resumed session.

The "thread not found" stderr error fires on **every** `codex exec` call — including the very first one, before any resume is possible. It's emitted by `codex_core::session::record_rollout_items` and is independent of session-resume functionality.

Verdict: **noise from a separate codex-cli internal subsystem (rollout recording). It does not affect `thread.started`, model memory, prompt cache, or any user-visible behavior.**

## Reproducibility note

Reproduced reliably with codex-cli `0.125.0` on Windows 11. Likely affects all platforms (the error path is in shared `codex_core::session` Rust code).

## Action: stderr filter in parse-codex-jsonl.mjs

Tier 5 follow-up: add a regex-based filter in `parse-codex-jsonl.mjs` to suppress this specific cosmetic line from the `stderr_tail` returned to the orchestrator. This prevents the line from appearing in:
- The orchestrator's per-iter ERROR/MALFORMED diagnostic output.
- Phase E §2 stats (where `Codex stderr` may be referenced for ERROR iterations).
- Any future debugging output.

The filter must be **specific** — match only this exact pattern, not all `ERROR` lines (which could mask legitimate errors).

Pattern: `/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR codex_core::session: failed to record rollout items: thread [0-9a-f-]+ not found\s*$/`

Filter is applied after JSONL parsing, before stderr_tail is included in the wrapper's response JSON.

## Upstream report

Worth filing an upstream issue with codex-cli ([github.com/openai/codex](https://github.com/openai/codex)) describing the consistent rollout-recording error on every successful `exec` and `exec resume` invocation. Functional impact zero, but log noise is non-trivial. Out of scope for v0.2 implementation.

## v0.2 plan implications

**No plan changes required.** Tier 0-4 proceed as designed:
- `build-prompt.mjs` `{{RESET_BLOCK}}` literal stays — reset_block IS doing useful work (anchor-bias suppression on a real resumed session).
- Tier 1 invariant classification stays — thread invariant remains orchestrator-enforced (the orchestrator manages `state.codex_thread_id` correctly; the model truly remembers prior turns under that ID).
- `thread_mode` config stays — `continue` mode is materially different from `fresh` (continue gets the cache hit + memory; fresh starts cold).

## Date

Investigated: 2026-05-08.
codex-cli version: 0.125.0.
