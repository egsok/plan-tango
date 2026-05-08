#!/usr/bin/env node
// Parse `codex exec --json` JSONL stdout into a minimal structured summary.
// Goal: extract the Codex thread/session id and basic diagnostics. Verdict text is
// NOT extracted here — we expect the caller to pass `-o <file>` to codex and read
// the assistant's last message from that file (more robust + simpler).
//
// Usage:
//   <jsonl> | node parse-codex-jsonl.mjs
//   node parse-codex-jsonl.mjs --from-file <path>
//
// Output (stdout JSON):
//   {
//     "session_id":     "<uuid>" | null,
//     "events_count":   N,
//     "has_error":      true | false,
//     "error_message":  "<text>" | null,
//     "agent_text":     "<concatenated agent_message texts>" | null,
//     "usage":          { ... } | null
//   }
//
// Tested on Codex CLI events (May 2026):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":N,...}}
// Future-proofing: only well-known fields are touched; unknown event types are counted
// but otherwise ignored. If Codex adds `error` events or `session_id` aliases — extend
// the scanner here without breaking existing callers.

import { readFileSync } from "node:fs";

function readAll(input) {
  if (typeof input === "string") return input;
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseJsonl(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines silently — Codex sometimes prints diag rows mixed with JSONL.
      // The orchestrator can read full stderr if it needs more detail.
    }
  }
  return events;
}

function extractSessionId(events) {
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    // Primary form (verified): {"type":"thread.started","thread_id":"<uuid>"}
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      return ev.thread_id;
    }
    // Defensive aliases for forward-compat: session.created / session_id / sessionId fields.
    if ((ev.type === "session.created" || ev.type === "session.started") && typeof ev.session_id === "string") {
      return ev.session_id;
    }
    if (typeof ev.sessionId === "string") {
      return ev.sessionId;
    }
    if (typeof ev.thread_id === "string") {
      return ev.thread_id;
    }
  }
  return null;
}

function extractAgentText(events) {
  const parts = [];
  for (const ev of events) {
    if (!ev || ev.type !== "item.completed") continue;
    const item = ev.item;
    if (!item || item.type !== "agent_message") continue;
    if (typeof item.text === "string" && item.text.length) parts.push(item.text);
  }
  if (!parts.length) return null;
  return parts.join("\n\n");
}

function extractError(events) {
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "error" && (ev.message || ev.error)) {
      return String(ev.message || ev.error);
    }
    // turn.completed with explicit error field — defensive
    if (ev.type === "turn.completed" && ev.error) {
      return String(typeof ev.error === "string" ? ev.error : (ev.error?.message || JSON.stringify(ev.error)));
    }
  }
  return null;
}

function extractUsage(events) {
  for (const ev of events) {
    if (ev && ev.type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
      return ev.usage;
    }
  }
  return null;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function main() {
  const args = process.argv.slice(2);
  let raw;
  if (args[0] === "--from-file") {
    if (!args[1]) {
      process.stderr.write("--from-file requires a path argument\n");
      process.exit(2);
    }
    try {
      raw = readFileSync(args[1], "utf8");
    } catch (err) {
      emit({
        session_id: null,
        events_count: 0,
        has_error: true,
        error_message: `from_file_unreadable: ${err?.message || err}`,
        agent_text: null,
        usage: null,
      });
      return;
    }
  } else if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("Usage: parse-codex-jsonl.mjs [--from-file <path>]\nReads JSONL on stdin if no path given.\n");
    return;
  } else {
    raw = readAll();
  }

  const events = parseJsonl(raw);
  const session_id = extractSessionId(events);
  const errorMessage = extractError(events);
  emit({
    session_id,
    events_count: events.length,
    has_error: errorMessage !== null,
    error_message: errorMessage,
    agent_text: extractAgentText(events),
    usage: extractUsage(events),
  });
}

main();
