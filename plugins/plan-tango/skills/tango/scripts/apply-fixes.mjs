#!/usr/bin/env node
// Pure-function classifier: given a list of Codex findings + the plan path,
// produce a fix plan that the orchestrator can act on. Does NOT modify any
// files. Reads JSON from stdin, writes JSON to stdout.
//
// Input shape (stdin):
//   { plan_path: "<abs canonical path>", findings: [parser findings...] }
//
// Output shape (stdout):
//   {
//     classified: [
//       { hash, severity, classification: "auto"|"deferred"|"manual",
//         note, requested_file_path?, ... }
//     ],
//     edit_plan: [
//       { hash, severity, file_path, location_hint, suggested_fix, requested_file_path? }
//     ],
//     ledger_template: [
//       { hash, severity, action: "applied"|"deferred"|"manual",
//         note?, requested_file_path: null, suggested_fix? }
//       // off-plan detection disabled (PR #1): action is never "off_plan_blocked",
//       // requested_file_path is always null.
//     ],
//     advisory_plan: [
//       { hash, severity, title, location, problem, fix }
//       // one entry per deduped unique finding REGARDLESS of classification
//       // (covers manual-classified findings excluded from edit_plan).
//       // Used by orchestrator polish-only branches (Phase C step 21 a2,
//       // Phase D step 28a-polish) to populate state.polish_advisory.
//     ],
//     invariant_summary: {
//       all_in_plan: true,        // constant — off-plan detection disabled (PR #1)
//       off_plan_count: 0,        // constant
//       off_plan_blocking: false  // constant
//     }
//   }
//
// Test-only env: if PLAN_TANGO_APPLY_FIXES_OVERRIDE is set to an absolute
// path, this script execs that override and exits with its result.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const OVERRIDE_ENV = "PLAN_TANGO_APPLY_FIXES_OVERRIDE";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function shortHash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

// Normalize a string for hashing: lowercase, strip punctuation/symbols,
// collapse whitespace. Makes the hash robust to trivial rewording.
function normalizeForHash(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip punctuation & symbols
    .replace(/\s+/g, " ")
    .trim();
}

// findingHash — stable identity of a finding across review iterations. It is
// the key used by the orchestrator's stuck/oscillation detection, which
// set-diffs findings_history across iterations. The old hash was
// sha1(severity + problem[:80]); Codex reliably REWORDS the `problem` prose
// between iterations (same defect, different sentence), so raw-problem hashing
// almost never matched across iterations and stuck/oscillation rarely fired.
// We instead hash `severity :: title` after normalization (lowercase, collapse
// whitespace, strip punctuation) — `title` is the most stable signal Codex
// emits for "the same issue". When a finding carries no title we fall back to
// the normalized first 80 chars of `problem` (still better than raw because of
// normalization).
function findingHash(finding) {
  const sev = normalizeForHash(finding.severity);
  const title = normalizeForHash(finding.title);
  const key = title || normalizeForHash(String(finding.problem || "").slice(0, 80));
  return createHash("sha1").update(`${sev} :: ${key}`).digest("hex").slice(0, 16);
}

// Heuristic: does the suggested_fix or problem text imply "pick one of multiple variants"?
const MANUAL_PATTERNS = [
  /\b(option [ab12]|variant [ab12]|approach [ab12])\b/i,
  /\beither\s+.+\s+or\s+.+/i,
  /\b(two|three|several)\s+(possible|valid)\s+(approaches|options|variants)\b/i,
  /\bchoose between\b/i,
  /\bpick one of\b/i,
];

function looksManual(finding) {
  const blob = `${finding.problem || ""}\n${finding.fix || ""}`;
  return MANUAL_PATTERNS.some((re) => re.test(blob));
}

// Off-plan detection by file-path MENTION is disabled entirely (PR #1).
//
// Category error: in a plan review every "change file X" fix translates to a
// plan-text edit, so a file mention can never distinguish "edit the plan"
// from "edit that file now" — mention-based detection produced 0 true /
// 14 false positives across two real converge sessions. The real protection
// against off-plan edits lives in the orchestrator (SKILL.md step 22): it
// constructs Edits against the plan file only, and an old_string absent from
// the plan simply fails. `requested_file_path` stays in the output contract
// for shape-compat but is ALWAYS null, and the invariant_summary is always
// {all_in_plan: true, off_plan_count: 0, off_plan_blocking: false}.

function classifyFinding(finding, locationCounts) {
  const hash = findingHash(finding);
  const severity = String(finding.severity || "minor");
  // Manual variant detected → manual (highest priority).
  if (looksManual(finding)) {
    return {
      hash,
      severity,
      classification: "manual",
      note: "multiple_variants_in_suggested_fix",
      requested_file_path: null,
    };
  }
  // Conflict: same location targeted by 2+ findings → can't auto-resolve atomically.
  const locKey = (finding.location || "").trim().toLowerCase();
  if (locKey && locationCounts.get(locKey) > 1) {
    return {
      hash,
      severity,
      classification: "deferred",
      note: "location_conflict_with_other_finding",
      requested_file_path: null,
    };
  }
  return {
    hash,
    severity,
    classification: "auto",
    note: null,
    requested_file_path: null,
  };
}

function buildOutput(input) {
  const planPath = input.plan_path;
  const findings = Array.isArray(input.findings) ? input.findings : [];
  // Count locations to detect conflicts.
  const locationCounts = new Map();
  for (const f of findings) {
    const k = (f.location || "").trim().toLowerCase();
    if (!k) continue;
    locationCounts.set(k, (locationCounts.get(k) || 0) + 1);
  }
  // Dedup by hash — if same hash appears twice, keep first and warn.
  const seen = new Map();
  for (const f of findings) {
    const h = findingHash(f);
    if (!seen.has(h)) seen.set(h, f);
  }
  const unique = Array.from(seen.values());

  const classified = unique.map((f) => classifyFinding(f, locationCounts));

  const edit_plan = [];
  const ledger_template = [];
  const advisory_plan = [];

  for (let i = 0; i < unique.length; i++) {
    const finding = unique[i];
    const cls = classified[i];
    // advisory_plan: one entry per deduped finding regardless of classification.
    // Used by orchestrator polish-only termination branches to populate
    // state.polish_advisory; specifically covers manual-classified findings
    // that are NOT in edit_plan (see edit_plan branch below).
    advisory_plan.push({
      hash: cls.hash,
      severity: cls.severity,
      title: finding.title || "",
      location: finding.location || "",
      problem: finding.problem || "",
      fix: finding.fix || "",
    });
    // edit_plan entries (target is always the plan file):
    //   - For 'auto' / 'deferred': file_path = plan_path, requested_file_path null.
    //   - For 'manual': not added to edit_plan (stop condition fires first).
    if (cls.classification !== "manual") {
      edit_plan.push({
        hash: cls.hash,
        severity: cls.severity,
        file_path: planPath,
        location_hint: finding.location || "",
        title: finding.title || "",
        problem: finding.problem || "",
        suggested_fix: finding.fix || "",
        requested_file_path: null,
      });
    }
    // ledger template — orchestrator overrides 'action' after real Edit:
    //   auto → applied (or deferred if Edit fails)
    //   deferred (in-plan conflict) → deferred
    //   manual → manual
    // Off-plan is disabled (PR #1), so action is never "off_plan_blocked".
    let templateAction = cls.classification;
    if (templateAction === "auto") {
      templateAction = "applied"; // optimistic; orchestrator may downgrade
    }
    ledger_template.push({
      hash: cls.hash,
      severity: cls.severity,
      action: templateAction,
      note: cls.note,
      requested_file_path: null,
      suggested_fix: finding.fix || null,
    });
  }

  return {
    plan_path: planPath,
    classified,
    edit_plan,
    ledger_template,
    advisory_plan,
    // Off-plan detection disabled (PR #1): the invariant is a constant.
    invariant_summary: {
      all_in_plan: true,
      off_plan_count: 0,
      off_plan_blocking: false,
    },
    findings_input_count: findings.length,
    findings_unique_count: unique.length,
    generated_at: new Date().toISOString(),
  };
}

async function main() {
  const override = process.env[OVERRIDE_ENV];
  if (override) {
    process.stderr.write(
      `[plan-tango] WARNING: ${OVERRIDE_ENV} set to ${override}; this is a test-only escape hatch and must NOT be used in production.\n`,
    );
    // Forward stdin to override script, forward its stdout, propagate exit code.
    await new Promise((resolve) => {
      let stdin = "";
      try {
        stdin = readFileSync(0, "utf8");
      } catch {
        stdin = "";
      }
      const child = spawn(process.execPath, [override], {
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.on("error", (err) => {
        process.stderr.write(`[plan-tango] override exec failed: ${err}\n`);
        process.exit(1);
      });
      child.on("close", (code) => {
        process.exit(code ?? 1);
      });
      child.stdin.end(stdin, "utf8");
      // Resolution unreached — process.exit() above terminates.
      resolve();
    });
    return;
  }

  // --dry-run is an alias for default behaviour (reading findings → classifying).
  // Currently this script only does dry-run; if we ever add an "apply" mode it
  // would be opt-in via --apply.
  const argv = process.argv.slice(2);
  if (argv.includes("--apply")) {
    process.stderr.write("apply mode not implemented — orchestrator does Edits\n");
    process.exit(2);
  }

  const raw = readStdin();
  if (!raw.trim()) {
    emit({ ok: false, reason: "stdin_empty", note: "expected JSON {plan_path, findings}" });
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (firstErr) {
    // Lenient retry: the orchestrator pipes JSON where plan_path carries
    // Windows backslashes that are not JSON-escaped (e.g. "C:\Users\...") →
    // "Bad escaped character in JSON". Escape any lone backslash (one not
    // already introducing a valid JSON escape) and retry once. Only surface
    // stdin_not_json if the repaired text still fails to parse.
    try {
      const repaired = raw.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      input = JSON.parse(repaired);
    } catch {
      emit({ ok: false, reason: "stdin_not_json", error: String(firstErr) });
      process.exit(2);
    }
  }
  if (!input.plan_path || typeof input.plan_path !== "string") {
    emit({ ok: false, reason: "missing_plan_path" });
    process.exit(2);
  }
  if (!Array.isArray(input.findings)) {
    emit({ ok: false, reason: "missing_findings_array" });
    process.exit(2);
  }
  const out = buildOutput(input);
  emit({ ok: true, ...out });
}

main().catch((err) => {
  emit({
    ok: false,
    reason: "unhandled_exception",
    error: String(err?.message || err),
    stack: String(err?.stack || "").slice(0, 1024),
  });
  process.exit(1);
});
