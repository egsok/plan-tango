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
//       { hash, severity, action: "applied"|"deferred"|"manual"|"off_plan_blocked",
//         note?, requested_file_path?, suggested_fix? }
//     ],
//     advisory_plan: [
//       { hash, severity, title, location, problem, fix }
//       // one entry per deduped unique finding REGARDLESS of classification
//       // (covers manual-classified findings excluded from edit_plan).
//       // Used by orchestrator polish-only branches (Phase C step 21 a2,
//       // Phase D step 28a-polish) to populate state.polish_advisory.
//     ],
//     invariant_summary: {
//       all_in_plan: bool,
//       off_plan_count: number,
//       off_plan_blocking: bool   // any critical/major off-plan?
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

function findingHash(finding) {
  const sev = String(finding.severity || "");
  const head = String(finding.problem || "").slice(0, 80);
  return createHash("sha1").update(`${sev}::${head}`).digest("hex").slice(0, 16);
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

// Heuristic: does the location/fix point at a file other than the plan?
// We look for substrings that look like file paths NOT pointing at the plan.
function detectOffPlanTarget(finding, planPath) {
  const planBasename = path.basename(planPath);
  const blob = `${finding.location || ""} ${finding.fix || ""}`;
  // Match common file-extension references.
  const fileRefs = blob.match(/[A-Za-z0-9_\-.\/\\]+\.(?:mjs|js|ts|tsx|jsx|md|json|py|go|rs|sh|ps1|yaml|yml|toml)/gi) || [];
  const offPlan = fileRefs.filter((f) => {
    const base = path.basename(f);
    return base !== planBasename;
  });
  if (offPlan.length === 0) return null;
  // Return the first non-plan file reference.
  return offPlan[0];
}

function classifyFinding(finding, planPath, locationCounts) {
  const hash = findingHash(finding);
  const severity = String(finding.severity || "minor");
  const offPlan = detectOffPlanTarget(finding, planPath);
  // Manual variant detected → manual (highest priority among non-off-plan).
  if (looksManual(finding)) {
    return {
      hash,
      severity,
      classification: "manual",
      note: "multiple_variants_in_suggested_fix",
      requested_file_path: offPlan || null,
    };
  }
  // Off-plan target → deferred (orchestrator will block on critical/major separately).
  if (offPlan) {
    return {
      hash,
      severity,
      classification: "deferred",
      note: "off-plan-file target",
      requested_file_path: offPlan,
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
    };
  }
  return {
    hash,
    severity,
    classification: "auto",
    note: null,
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

  const classified = unique.map((f) => classifyFinding(f, planPath, locationCounts));

  const edit_plan = [];
  const ledger_template = [];
  const advisory_plan = [];
  let off_plan_count = 0;
  let off_plan_blocking = false;

  for (let i = 0; i < unique.length; i++) {
    const finding = unique[i];
    const cls = classified[i];
    const isOffPlan = !!cls.requested_file_path;
    if (isOffPlan) off_plan_count++;
    if (isOffPlan && (cls.severity === "critical" || cls.severity === "major")) {
      off_plan_blocking = true;
    }
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
    // edit_plan entries:
    //   - For 'auto': file_path = plan_path, suggestion is from the finding
    //   - For 'deferred' off-plan: file_path = plan_path (defensive — orchestrator
    //     re-checks invariant), requested_file_path holds what Codex wanted
    //   - For 'manual': not added to edit_plan (skipped by orchestrator anyway,
    //     stop condition fires first)
    if (cls.classification !== "manual") {
      edit_plan.push({
        hash: cls.hash,
        severity: cls.severity,
        file_path: planPath,
        location_hint: finding.location || "",
        title: finding.title || "",
        problem: finding.problem || "",
        suggested_fix: finding.fix || "",
        requested_file_path: cls.requested_file_path || null,
      });
    }
    // ledger template — orchestrator overrides 'action' after real Edit:
    //   auto → applied (or deferred if Edit fails)
    //   deferred (in-plan conflict) → deferred
    //   deferred (off-plan, severity ≤ minor) → deferred (note set)
    //   deferred (off-plan, severity ≥ major) → off_plan_blocked
    //   manual → manual
    let templateAction = cls.classification;
    if (templateAction === "deferred" && isOffPlan && (cls.severity === "critical" || cls.severity === "major")) {
      templateAction = "off_plan_blocked";
    } else if (templateAction === "auto") {
      templateAction = "applied"; // optimistic; orchestrator may downgrade
    }
    ledger_template.push({
      hash: cls.hash,
      severity: cls.severity,
      action: templateAction,
      note: cls.note,
      requested_file_path: cls.requested_file_path || null,
      suggested_fix: finding.fix || null,
    });
  }

  return {
    plan_path: planPath,
    classified,
    edit_plan,
    ledger_template,
    advisory_plan,
    invariant_summary: {
      all_in_plan: off_plan_count === 0,
      off_plan_count,
      off_plan_blocking,
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
  } catch (err) {
    emit({ ok: false, reason: "stdin_not_json", error: String(err) });
    process.exit(2);
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
