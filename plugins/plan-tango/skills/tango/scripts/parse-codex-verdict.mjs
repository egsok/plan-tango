#!/usr/bin/env node
// Parse Codex review output (text or JSON payload) into structured verdict JSON.
// Usage:
//   <text> | node parse-codex-verdict.mjs --from-text
//   <task --json output> | node parse-codex-verdict.mjs --from-codex-json
//   node parse-codex-verdict.mjs --from-file <path>
// Outputs one JSON object to stdout. Always exits 0 unless argv is invalid.

import { readFileSync } from "node:fs";

// Verdict line matcher. Tolerant of markdown wrapping so a reviewer that emits
// "**ALLOW:** ...", "## BLOCK: ...", "> ALLOW: ..." or "- BLOCK: ..." still
// parses. Leading blockquote/heading/bullet decoration is stripped, and bold
// (**) / italic (*) markers around the keyword and colon are tolerated in both
// "**ALLOW:**" and "**ALLOW**:" placements. Still anchored: the (decorated)
// line must START with the keyword + colon, so mid-prose "ALLOW" won't match.
const VERDICT_RE = /^\**\s*(ALLOW|BLOCK)\b\**\s*:\s*\**\s*(.*?)\s*\**\s*$/i;
// Finding header. Tolerates "N." and "N)" numbering, an optional leading
// bullet (*, -, +), and bold markers around the number and the [SEVERITY: …]
// token (e.g. "1) **[SEVERITY: major]** Title"). The literal [SEVERITY: …]
// token keeps this strict enough that plain prose is not misparsed.
const FINDING_HEADER_RE = /^\s*(?:[*\-+]\s+)?\**\s*(\d+)[.)]\**\s*\**\s*\[SEVERITY:\s*(critical|major|minor|nit)\]\**\s*(.+?)\s*$/i;
const FIELD_RE = /^\s*(File\/section|Problem|Suggested fix)\s*:\s*(.*)$/i;

// Strip leading markdown decoration (blockquote >, heading #, list bullets)
// from a line before verdict matching.
function stripLeadingMarkdown(line) {
  return line.replace(/^\s*(?:[#>]+\s*)?(?:[*\-+]\s+)?/, "");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function extractFromCodexJson(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "codex_json_parse_failed", error: String(err) };
  }
  const direct = typeof payload?.rawOutput === "string" ? payload.rawOutput : "";
  const nested = typeof payload?.result?.rawOutput === "string" ? payload.result.rawOutput : "";
  const text = direct || nested || "";
  if (!text) {
    return {
      ok: false,
      reason: "codex_no_raw_output",
      keys: Object.keys(payload ?? {}),
    };
  }
  return { ok: true, text };
}

function findVerdictLine(lines) {
  // Scan the first 5 NON-EMPTY lines (not just the very first) so a short
  // preamble before the verdict — a greeting, a "Here is my review:" line, a
  // markdown heading — does not force a MALFORMED re-review. Each ~30-180s
  // Codex re-review is expensive, so we parse leniently here.
  let seenNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const m = stripLeadingMarkdown(lines[i]).match(VERDICT_RE);
    if (m) return { idx: i, verdict: m[1].toUpperCase(), summary: m[2].trim() };
    seenNonEmpty++;
    if (seenNonEmpty >= 5) break;
  }
  return null;
}

function takeLines(lines, startIdx) {
  // Iterate from startIdx, accumulate findings.
  const findings = [];
  const warnings = [];
  let cursor = startIdx;
  while (cursor < lines.length) {
    const line = lines[cursor];
    const headerMatch = line.match(FINDING_HEADER_RE);
    if (!headerMatch) {
      cursor++;
      continue;
    }
    const finding = {
      n: Number(headerMatch[1]),
      severity: headerMatch[2].toLowerCase(),
      title: headerMatch[3].trim(),
      location: "",
      problem: "",
      fix: "",
    };
    cursor++;
    let activeField = null;
    while (cursor < lines.length) {
      const inner = lines[cursor];
      if (inner.match(FINDING_HEADER_RE)) break; // next finding
      const fieldMatch = inner.match(FIELD_RE);
      if (fieldMatch) {
        const label = fieldMatch[1].toLowerCase();
        if (label === "file/section") activeField = "location";
        else if (label === "problem") activeField = "problem";
        else if (label === "suggested fix") activeField = "fix";
        if (activeField) {
          finding[activeField] = fieldMatch[2].trim();
        }
        cursor++;
        continue;
      }
      // Continuation of an active field (indented continuation lines).
      if (activeField && inner.trim()) {
        finding[activeField] = (finding[activeField]
          ? finding[activeField] + " "
          : "") + inner.trim();
      }
      cursor++;
    }
    if (!finding.location) warnings.push(`finding_${finding.n}_missing_location`);
    if (!finding.problem) warnings.push(`finding_${finding.n}_missing_problem`);
    if (!finding.fix) warnings.push(`finding_${finding.n}_missing_fix`);
    findings.push(finding);
  }
  return { findings, warnings };
}

function parseText(text) {
  const lines = text.split(/\r?\n/);
  const head = findVerdictLine(lines);
  const nowIso = new Date().toISOString();
  if (!head) {
    return {
      verdict: "MALFORMED",
      reason: "no_verdict_line",
      raw_final_message: text,
      parsed_at: nowIso,
      parse_warnings: [],
    };
  }
  const { findings, warnings } = takeLines(lines, head.idx + 1);
  if (head.verdict === "ALLOW" && findings.length > 0) {
    return {
      verdict: "MALFORMED",
      reason: "allow_with_findings",
      summary: head.summary,
      findings,
      raw_final_message: text,
      parsed_at: nowIso,
      parse_warnings: warnings,
    };
  }
  if (head.verdict === "BLOCK" && findings.length === 0) {
    return {
      verdict: "MALFORMED",
      reason: "block_without_findings",
      summary: head.summary,
      findings: [],
      raw_final_message: text,
      parsed_at: nowIso,
      parse_warnings: warnings,
    };
  }
  return {
    verdict: head.verdict,
    summary: head.summary,
    findings,
    raw_final_message: text,
    parsed_at: nowIso,
    parse_warnings: warnings,
  };
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "--from-text";
  if (mode !== "--from-text" && mode !== "--from-codex-json" && mode !== "--from-file") {
    process.stderr.write(
      `Usage: parse-codex-verdict.mjs [--from-text | --from-codex-json | --from-file <path>]\n`,
    );
    process.exit(2);
  }
  let raw;
  if (mode === "--from-file") {
    const filePath = args[1];
    if (!filePath) {
      process.stderr.write(`--from-file requires a path argument\n`);
      process.exit(2);
    }
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      const out = {
        verdict: "ERROR",
        reason: "from_file_unreadable",
        path: filePath,
        details: String(err?.message || err),
        parsed_at: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }
  } else {
    raw = readStdin();
  }
  let text = raw;
  if (mode === "--from-codex-json") {
    const extracted = extractFromCodexJson(raw);
    if (!extracted.ok) {
      const out = {
        verdict: "ERROR",
        reason: extracted.reason,
        details: extracted.error || extracted.keys || null,
        raw_stdout_first_4kb: raw.slice(0, 4096),
        parsed_at: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }
    text = extracted.text;
  }
  const result = parseText(text);
  process.stdout.write(JSON.stringify(result) + "\n");
}

main();
