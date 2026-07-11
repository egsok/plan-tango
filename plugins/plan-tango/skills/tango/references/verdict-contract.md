# Verdict contract for plan-tango

This document specifies the exact text format that Codex (and Opus final-checker)
must produce when reviewing a plan. The parser at `scripts/parse-codex-verdict.mjs`
implements this contract.

## Top-level structure

```
<VERDICT>: <one-sentence summary>
[blank line]
<numbered findings list, only if BLOCK>
```

## Verdict line

The very first non-empty line MUST match this regex:

```
^(ALLOW|BLOCK):\s*(.+)$
```

- `ALLOW: <summary>` — zero defects of any severity. The plan is clean.
- `BLOCK: <summary>` — at least one defect found. Followed by a numbered list.

Anything else → parser returns `verdict: "MALFORMED", reason: "no_verdict_line"`.

> **Parser leniency (0.7.0):** the reviewer should still emit the verdict as the first line, but `parse-codex-verdict.mjs` is tolerant — it scans the first 5 non-empty lines for the verdict and strips markdown decoration (bold, backticks). Finding headers likewise tolerate `N)`, bullet markers, and bold around the `[SEVERITY: …]` prefix. Producing the exact format above is still the contract; the leniency only absorbs cosmetic drift.

## Findings list (only when BLOCK)

Each finding follows this exact structure:

```
N. [SEVERITY: <critical|major|minor|nit>] <one-line title>
   File/section: <where in the plan>
   Problem: <2-3 sentences explaining the defect>
   Suggested fix: <2-3 sentences with the proposed correction>
```

Where:
- `N` — sequential number starting at 1
- Severity must be one of the four values (lowercase)
- Title fits on one line (no line breaks)
- Three labeled fields are required: `File/section:`, `Problem:`, `Suggested fix:`

## Severity definitions

- `critical` — implementation will fail or produce wrong behavior; must fix before shipping
- `major` — significant correctness/design issue; should fix before shipping
- `minor` — small problem (clarity, edge case); nice to fix but not blocking
- `nit` — stylistic preference; orchestrator may ignore

## Validity rules (parser enforces)

- `ALLOW: <summary>` with any findings → `MALFORMED`, reason `allow_with_findings`
- `BLOCK: <summary>` with zero findings → `MALFORMED`, reason `block_without_findings`
- Severity not in the four-value set → finding is dropped with parse_warning
- Missing required field → finding kept but with empty string for that field + parse_warning

## Examples

### Clean ALLOW

```
ALLOW: Plan covers all requirements with no missing steps.
```

### BLOCK with one critical finding

```
BLOCK: Step ordering bug breaks the apply phase.

1. [SEVERITY: critical] Step 4 references file not yet created in step 2
   File/section: Phase C step 4
   Problem: The plan references config.json on disk during step 4, but
     the step that creates that file is step 6. Implementation will fail
     with ENOENT when run in declared order.
   Suggested fix: Move file creation to step 2, or guard step 4 with a
     creation-if-missing block. Align step numbering with actual ordering.
```

### Multiple findings, mixed severity

```
BLOCK: Plan has one critical correctness issue and two style/edge concerns.

1. [SEVERITY: critical] Missing error path for network timeout
   File/section: Phase B step 8
   Problem: The fetch call in step 8 has no timeout handling. Real network
     calls can hang indefinitely on flaky connections.
   Suggested fix: Wrap in AbortController with 30s timeout and add retry
     with exponential backoff for transient failures.

2. [SEVERITY: minor] Variable name `tmp` is unclear
   File/section: Phase C step 12
   Problem: `tmp` does not convey what is stored. Future maintainers will
     not know if this is bytes, parsed JSON, or partial state.
   Suggested fix: Rename to something descriptive like `pendingPayload`.

3. [SEVERITY: nit] Inconsistent capitalization in headers
   File/section: throughout
   Problem: Some sub-headers use Title Case, others use sentence case.
   Suggested fix: Pick one and apply throughout.
```

## Parser output shape

For a successful parse, the parser returns:

```json
{
  "verdict": "ALLOW" | "BLOCK",
  "summary": "...",
  "findings": [
    {
      "n": 1,
      "severity": "critical",
      "title": "...",
      "location": "...",
      "problem": "...",
      "fix": "..."
    }
  ],
  "raw_final_message": "<full original text>",
  "parsed_at": "<ISO timestamp>",
  "parse_warnings": []
}
```

For MALFORMED:

```json
{
  "verdict": "MALFORMED",
  "reason": "no_verdict_line" | "allow_with_findings" | "block_without_findings",
  "raw_final_message": "<full original text>",
  "parsed_at": "<ISO timestamp>",
  "parse_warnings": [...]
}
```
