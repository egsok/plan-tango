#!/usr/bin/env node
// Deterministic stop-condition evaluation for the plan-tango convergence loop
// (SKILL.md Phase C step 21). Replaces the LLM computing severity counts and
// findings_history set-diffs by hand — that arithmetic is error-prone and this
// is a pure function over the run state.
//
// Reads JSON from stdin, writes ONE decision object to stdout, exit 0.
//
// Input (stdin JSON):
//   {
//     "verdict":   "ALLOW" | "BLOCK",           // REQUIRED (this iter's verdict)
//     "findings":  [ { "severity": "critical|major|minor|nit", ... } ],
//                                                // this iter's findings (verdict findings)
//     "classified":[ { "classification": "auto|deferred|manual",
//                      "severity": "...", "hash": "<hash>" } ],
//                                                // apply-fixes output for this iter.
//                                                // REQUIRED for manual/deferred and
//                                                // oscillation/stuck (hash) logic.
//     "settings":  { "severity_aware": true, "lenient": false, "max_iter": 6 },
//     "current_iter": <N>,                       // 1-based number of THIS iteration
//     "history":   [ ["h1","h2"], ["h3"] ],      // findings_history of PRIOR iterations,
//                                                // oldest first, NOT including this iter.
//     "prev_severity_counts": { "critical": 0, "major": 1, ... },
//                                                // prior iter's counts; enables regression.
//     "fresh_thread_fallback": false             // this iter used a fresh Codex thread
//   }
//
// Semantics (priority order, mirrors SKILL.md step 21 MINUS all off-plan
// branches — off-plan detection is disabled, PR #1):
//   a)  ALLOW & no findings                                   -> break converged
//   a2) severity_aware & BLOCK & findings>0 & (crit+maj)==0   -> break
//         converged-lenient (if lenient) else converged-with-polish
//   b)  any classified.classification == "manual"             -> break manual-required
//   c)  any classified deferred with severity crit|major      -> break manual-required
//   d)  lenient & BLOCK & findings>0 & (crit+maj)==0          -> break converged-lenient
//         (unreachable when severity_aware; kept for completeness)
//   e)  oscillation: a hash present two iters ago AND in this iter, but absent
//       the previous iter (a finding that came back)          -> break oscillating
//   f)  stuck: previous iter's hash set == this iter's set     -> break stuck
//   g)  regression: this iter's critical count > prior iter's  -> break regressed
//         EXCEPT when fresh_thread_fallback is true: a fresh reviewer being
//         more thorough is NOT a regression -> continue with a human_note.
//   h)  current_iter >= max_iter                               -> break max-iter-reached
//   else                                                       -> continue
//
// Output (stdout): { "ok": true, "action": "continue"|"break",
//                    "status": "<status>", "reason": "<machine code>",
//                    "human_note": "<string|null>" }
// Bad input: { "ok": false, "reason": "<code>" } with EXIT 2.

import { readFileSync } from "node:fs";

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

function badInput(reason, extra = {}) {
  emit({ ok: false, reason, ...extra });
  process.exit(2);
}

function decision(action, status, reason, human_note = null) {
  emit({ ok: true, action, status, reason, human_note });
  process.exit(0);
}

const SEVERITIES = ["critical", "major", "minor", "nit"];

function countSeverities(list) {
  const counts = { critical: 0, major: 0, minor: 0, nit: 0 };
  for (const item of Array.isArray(list) ? list : []) {
    const sev = String(item && item.severity || "").toLowerCase();
    if (SEVERITIES.includes(sev)) counts[sev]++;
  }
  return counts;
}

function hashSet(classified) {
  const s = new Set();
  for (const c of Array.isArray(classified) ? classified : []) {
    if (c && typeof c.hash === "string" && c.hash) s.add(c.hash);
  }
  return s;
}

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) badInput("stdin_empty");
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    badInput("stdin_not_json", { error: String(err) });
  }

  const verdict = input.verdict;
  if (verdict !== "ALLOW" && verdict !== "BLOCK") {
    badInput("invalid_verdict", { got: verdict, note: "expected ALLOW or BLOCK (ERROR/MALFORMED handled upstream)" });
  }
  const settings = input.settings && typeof input.settings === "object" ? input.settings : {};
  const severityAware = settings.severity_aware !== false; // default true
  const lenient = settings.lenient === true;
  const maxIter = Number(settings.max_iter);
  const curIter = Number(input.current_iter);
  if (!Number.isInteger(curIter) || curIter < 1) {
    badInput("invalid_current_iter", { got: input.current_iter });
  }

  const findings = Array.isArray(input.findings) ? input.findings : [];
  const classified = Array.isArray(input.classified) ? input.classified : [];
  const history = Array.isArray(input.history) ? input.history : [];
  const freshFallback = input.fresh_thread_fallback === true;

  // Severity counts prefer the verdict findings; fall back to classified.
  const counts = countSeverities(findings.length ? findings : classified);
  const blockingCount = counts.critical + counts.major;
  const curHashes = hashSet(classified);

  // a) clean converge
  if (verdict === "ALLOW" && findings.length === 0) {
    return decision("break", "converged", "allow_no_findings");
  }

  // a2) severity-aware polish-only stop
  if (severityAware && verdict === "BLOCK" && findings.length > 0 && blockingCount === 0) {
    const status = lenient ? "converged-lenient" : "converged-with-polish";
    return decision("break", status, "polish_only_no_critical_major",
      "Only minor/nit findings remain; stopping without a corrective iteration.");
  }

  // b) manual-classified variant
  if (classified.some((c) => c && c.classification === "manual")) {
    return decision("break", "manual-required", "manual_variant_finding",
      "A finding offers multiple variants; a human must pick one — edit the plan and re-run.");
  }

  // c) deferred blocking finding
  if (classified.some((c) => c && c.classification === "deferred" && (c.severity === "critical" || c.severity === "major"))) {
    return decision("break", "manual-required", "deferred_blocking_finding",
      "A critical/major finding could not be auto-applied (deferred); resolve it by hand.");
  }

  // d) explicit --lenient (unreachable when severity_aware; kept for completeness)
  if (lenient && verdict === "BLOCK" && findings.length > 0 && blockingCount === 0) {
    return decision("break", "converged-lenient", "lenient_no_critical_major");
  }

  // e) oscillation — a finding present two iters ago and again now, but gone in between.
  const prev = history.length >= 1 ? new Set(history[history.length - 1]) : null;
  const prevPrev = history.length >= 2 ? new Set(history[history.length - 2]) : null;
  if (prevPrev && curHashes.size > 0) {
    const oscillating = [...prevPrev].some((h) => curHashes.has(h) && (!prev || !prev.has(h)));
    if (oscillating) {
      return decision("break", "oscillating", "finding_reappeared_across_iters",
        "A finding was resolved then reappeared — the loop is oscillating rather than converging.");
    }
  }

  // f) stuck — this iteration's finding set is identical to the previous one.
  if (prev && curHashes.size > 0 && setEqual(prev, curHashes)) {
    return decision("break", "stuck", "identical_findings_two_iters",
      "Two consecutive iterations produced the same findings — no progress.");
  }

  // g) regression — critical count went up vs the prior iteration.
  let regressionNote = null;
  const prevCounts = input.prev_severity_counts;
  if (prevCounts && typeof prevCounts.critical === "number" && counts.critical > prevCounts.critical) {
    if (freshFallback) {
      regressionNote =
        "Severity increase not treated as regression: this iteration ran on a fresh Codex thread " +
        "(lost-session fallback), so the reviewer is simply more thorough, not regressing.";
      // fall through to remaining checks (do not break)
    } else {
      return decision("break", "regressed", "critical_count_increased",
        "Critical findings increased vs the previous iteration — consider rolling back to the prior snapshot.");
    }
  }

  // h) max-iter cap
  if (Number.isFinite(maxIter) && curIter >= maxIter) {
    return decision("break", "max-iter-reached", "reached_max_iter",
      regressionNote ||
      "Reached the max-iter cap; the orchestrator may offer an interactive continue (+N).");
  }

  // default: keep looping
  return decision("continue", "continue",
    regressionNote ? "regression_suppressed_fresh_thread" : "no_stop_condition",
    regressionNote);
}

main();
