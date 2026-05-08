#!/usr/bin/env node
// Tier 0.1 — Build iter{N}.prompt.md by substituting three placeholders into
// the review prompt template. Replaces the orchestrator's Write tool path
// (which forced Claude to GENERATE 280 lines of output text per iteration,
// costing ~1-2 minutes of LLM-output-bound wall-clock per call).
//
// This script does pure deterministic string substitution. Runtime ~50ms.
//
// CLI:
//   node build-prompt.mjs \
//     --template <abs path to review-prompt-template.md> \
//     --plan <abs path to plan file> \
//     --repo-evidence <true|false> \
//     --reset-block <true|false> \
//     --out <abs path for iter{N}.prompt.md>
//
// Output (stdout, success):
//   {"ok":true,"out":"<path>","lines":N,"bytes":B}
// Output (stdout, failure) AND non-zero exit:
//   {"ok":false,"error":"<code>","detail":"<message>"}
//
// The two text variants for {{REPO_EVIDENCE_NOTE}} and the {{RESET_BLOCK}}
// XML are constants embedded in this script as literals — they MUST match
// the strings the orchestrator was previously substituting in SKILL.md
// Phase C step 13. See references/build-prompt-compat.md for the byte-level
// diff harness that locks this in.

import { readFileSync, writeFileSync } from "node:fs";

const REPO_EVIDENCE_NOTE_TRUE =
  "Repository state is available via your tools at cwd. Inspect referenced files when checking claims.";
const REPO_EVIDENCE_NOTE_FALSE =
  "Repository state is NOT available. Review the plan as text only — do not invent claims about repo state. Mark findings that would need repo-evidence to verify as such.";

// Trailing blank line is intentional — matches the layout the orchestrator
// previously produced (Reset block followed by an empty line before <task>).
const RESET_BLOCK_LITERAL =
  "<reset_iteration>\n" +
  "You are reviewing this plan again. IGNORE your previous verdicts and findings from earlier\n" +
  "turns in this thread — the plan may have changed substantively. Read the plan from scratch\n" +
  "as if you were a new auditor. Do not anchor on prior conclusions.\n" +
  "</reset_iteration>\n\n";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(error, detail) {
  emit({ ok: false, error, detail });
  process.exit(1);
}

function parseArgs(argv) {
  const args = { template: null, plan: null, repoEvidence: null, resetBlock: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case "--template": args.template = val; i++; break;
      case "--plan": args.plan = val; i++; break;
      case "--repo-evidence": args.repoEvidence = val; i++; break;
      case "--reset-block": args.resetBlock = val; i++; break;
      case "--out": args.out = val; i++; break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: build-prompt.mjs --template <path> --plan <path> --repo-evidence <true|false> --reset-block <true|false> --out <path>\n"
        );
        process.exit(0);
        break;
      default:
        if (flag.startsWith("--")) fail("unknown_flag", `unknown flag: ${flag}`);
    }
  }
  return args;
}

function parseBool(name, val) {
  if (val === "true") return true;
  if (val === "false") return false;
  fail("invalid_arg", `${name} must be "true" or "false", got: ${JSON.stringify(val)}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.template) fail("missing_arg", "--template is required");
  if (!args.plan) fail("missing_arg", "--plan is required");
  if (args.repoEvidence === null) fail("missing_arg", "--repo-evidence is required");
  if (args.resetBlock === null) fail("missing_arg", "--reset-block is required");
  if (!args.out) fail("missing_arg", "--out is required");

  const repoEvidence = parseBool("--repo-evidence", args.repoEvidence);
  const resetBlock = parseBool("--reset-block", args.resetBlock);

  let template;
  try {
    template = readFileSync(args.template, "utf8");
  } catch (err) {
    fail("template_unreadable", `cannot read template at ${args.template}: ${err?.message || err}`);
  }

  let plan;
  try {
    plan = readFileSync(args.plan, "utf8");
  } catch (err) {
    fail("plan_unreadable", `cannot read plan at ${args.plan}: ${err?.message || err}`);
  }

  // Pure deterministic substitution. Each placeholder appears exactly once in
  // the template (verified by references/build-prompt-compat.md). Use plain
  // String.prototype.replace with the literal placeholder string — NOT a regex
  // — so any regex-special characters in {{PLAN_BODY}} (like $1, $&) are NOT
  // re-interpreted. This is a critical correctness rule.
  let out = template
    .replace("{{RESET_BLOCK}}", resetBlock ? RESET_BLOCK_LITERAL : "")
    .replace("{{REPO_EVIDENCE_NOTE}}", repoEvidence ? REPO_EVIDENCE_NOTE_TRUE : REPO_EVIDENCE_NOTE_FALSE);

  // {{PLAN_BODY}} is replaced AFTER the other two so that nothing inside the
  // plan body can be confused with a placeholder. Using a function value
  // ensures regex-special sequences in the plan ($1, $&, etc.) are NOT
  // interpreted as backreferences.
  out = out.replace("{{PLAN_BODY}}", () => plan);

  try {
    writeFileSync(args.out, out, "utf8");
  } catch (err) {
    fail("out_unwritable", `cannot write to ${args.out}: ${err?.message || err}`);
  }

  emit({ ok: true, out: args.out, lines: out.split("\n").length, bytes: Buffer.byteLength(out, "utf8") });
}

main();
