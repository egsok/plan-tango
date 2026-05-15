#!/usr/bin/env node
// Check GitHub for a newer plan-tango release. Designed for end-of-Phase-E
// invocation by the main SKILL — fully silent on network failure, throttled
// to once per 7 days via on-disk cache.
//
// CLI:
//   node update-check.mjs --current-version <vX.Y.Z> [--ttl-days N] [--repo <owner/name>]
//
//   --current-version   Required. Plan-tango's currently-installed semver, e.g. "0.2.0".
//                       Leading "v" tolerated. Required because the script
//                       does not know its own version (lives inside the plugin).
//   --ttl-days N        Optional. Default 7. Cache freshness window.
//   --repo owner/name   Optional. Default "egsok/plan-tango". Override for testing.
//
// Output (always stdout JSON, always exit 0 unless --help):
//   {
//     "status": "newer-available" | "ok" | "skipped" | "error",
//     "current": "<semver>",
//     "latest":  "<semver>" | null,
//     "message": "<one-line user-facing string OR diagnostic>",
//     "cache_path": "<abs path>",
//     "cache_age_seconds": <int> | null,
//     "from_cache": <bool>
//   }
//
// status meanings:
//   "newer-available" — remote latest > current. Orchestrator prints message.
//   "ok"              — remote latest <= current. Orchestrator prints nothing.
//   "skipped"         — within TTL window OR network failed silently. Nothing to print.
//   "error"           — invariant violation (bad --current-version, etc.). Nothing to print.
//
// Cache:
//   ~/.claude/plan-tango/.update-cache.json — { last_check_ts, latest_remote }
//   Written on every fresh git ls-remote success. Read at startup; if newer than TTL,
//   skip the network call entirely.
//
// Design notes:
//   - No throws escape main(): every failure path falls through to a `skipped`/`error`
//     JSON record and exit 0. The orchestrator MUST tolerate this (no parsing of
//     stderr, no exit-code branching).
//   - Network timeout 3s — fast enough to not delay Phase E perceptibly. On timeout
//     the cache value (if any) is preserved.
//   - Semver comparator is intentionally small (no semver npm dep). Pre-release tags
//     ("-rc1", "-alpha") are recognized but always lose to their stable counterpart.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_REPO = "egsok/plan-tango";
const DEFAULT_TTL_DAYS = 7;
const NETWORK_TIMEOUT_MS = 3000;

function cachePath() {
  return path.join(homedir(), ".claude", "plan-tango", ".update-cache.json");
}

function parseArgs(argv) {
  const args = { ttlDays: DEFAULT_TTL_DAYS, repo: DEFAULT_REPO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--current-version") args.currentVersion = argv[++i];
    else if (a === "--ttl-days") args.ttlDays = parseInt(argv[++i], 10);
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

// Normalize a semver-ish string: strip leading "v", trim, lowercase.
// Returns null if the result doesn't look like X.Y.Z[-pre].
function normalizeSemver(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^v/i, "").toLowerCase();
  if (!/^\d+\.\d+\.\d+(-[0-9a-z.+-]+)?$/.test(s)) return null;
  return s;
}

// Compare two normalized semver strings: returns -1, 0, 1.
// Pre-release (e.g. "1.0.0-rc1") always loses to its stable counterpart ("1.0.0").
function compareSemver(a, b) {
  const [aMain, aPre] = a.split("-");
  const [bMain, bPre] = b.split("-");
  const aParts = aMain.split(".").map(Number);
  const bParts = bMain.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) return aParts[i] < bParts[i] ? -1 : 1;
  }
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) {
    if (aPre < bPre) return -1;
    if (aPre > bPre) return 1;
  }
  return 0;
}

function readCache(cp) {
  if (!existsSync(cp)) return null;
  try {
    const raw = readFileSync(cp, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.last_check_ts === "number" &&
      (parsed.latest_remote === null || typeof parsed.latest_remote === "string")
    ) {
      return parsed;
    }
  } catch {
    // unreadable / unparseable cache — treat as missing
  }
  return null;
}

function writeCache(cp, payload) {
  try {
    const dir = path.dirname(cp);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch {
    // cache write failure is non-fatal — next run will retry
  }
}

// Run `git ls-remote --tags <url>` with a hard timeout. Returns the stdout
// string on success, or null on any failure (timeout, non-zero exit, missing
// git binary, etc.).
function gitLsRemoteTags(repoUrl) {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = "";
    let child;
    try {
      child = spawn("git", ["ls-remote", "--tags", repoUrl], {
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(null);
    }, NETWORK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", () => { /* ignore stderr */ });
    child.on("error", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
  });
}

// Parse `git ls-remote --tags` output into a sorted list of semver tags
// (highest first). Ignores annotated-tag-dereference lines ("^{}") and
// any tag that doesn't normalize as semver.
function parseTags(output) {
  if (!output) return [];
  const tags = new Set();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/refs\/tags\/(\S+?)(\^\{\})?$/);
    if (!m) continue;
    const norm = normalizeSemver(m[1]);
    if (norm) tags.add(norm);
  }
  const sorted = [...tags].sort((a, b) => -compareSemver(a, b));
  return sorted;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cp = cachePath();

  if (args.help) {
    process.stdout.write(
      "Usage: update-check.mjs --current-version <vX.Y.Z> [--ttl-days N] [--repo owner/name]\n" +
      "See header comment for output schema.\n"
    );
    process.exit(0);
  }

  const current = normalizeSemver(args.currentVersion);
  if (!current) {
    emit({
      status: "error",
      current: args.currentVersion ?? null,
      latest: null,
      message: `Invalid --current-version (expected semver like 0.2.0, got: ${JSON.stringify(args.currentVersion)})`,
      cache_path: cp,
      cache_age_seconds: null,
      from_cache: false,
    });
  }

  const ttlDays = Number.isInteger(args.ttlDays) && args.ttlDays > 0 ? args.ttlDays : DEFAULT_TTL_DAYS;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cache = readCache(cp);
  const cacheAgeMs = cache ? now - cache.last_check_ts : null;
  const cacheAgeSeconds = cacheAgeMs !== null ? Math.floor(cacheAgeMs / 1000) : null;

  // Fast path: cache is fresh — use it without network.
  if (cache && cacheAgeMs < ttlMs) {
    const latest = cache.latest_remote;
    if (latest && compareSemver(latest, current) > 0) {
      emit({
        status: "newer-available",
        current,
        latest,
        message: `📦 plan-tango v${latest} is available — run \`/plan-tango:update\` (you're on v${current}).`,
        cache_path: cp,
        cache_age_seconds: cacheAgeSeconds,
        from_cache: true,
      });
    }
    emit({
      status: "ok",
      current,
      latest: latest ?? null,
      message: latest ? `Cache fresh (${cacheAgeSeconds}s old); latest = v${latest}, current = v${current}.` : `Cache fresh (${cacheAgeSeconds}s old); no remote semver seen.`,
      cache_path: cp,
      cache_age_seconds: cacheAgeSeconds,
      from_cache: true,
    });
  }

  // Slow path: network check.
  const repoUrl = `https://github.com/${args.repo}.git`;
  const stdout = await gitLsRemoteTags(repoUrl);
  if (stdout === null) {
    // Network failed; preserve previous cache (if any) and report skipped.
    emit({
      status: "skipped",
      current,
      latest: cache ? cache.latest_remote : null,
      message: "Remote check failed (network/timeout/git unavailable); retaining cached value.",
      cache_path: cp,
      cache_age_seconds: cacheAgeSeconds,
      from_cache: !!cache,
    });
  }

  const tags = parseTags(stdout);
  const latest = tags.length > 0 ? tags[0] : null;
  writeCache(cp, { last_check_ts: now, latest_remote: latest });

  if (latest && compareSemver(latest, current) > 0) {
    emit({
      status: "newer-available",
      current,
      latest,
      message: `📦 plan-tango v${latest} is available — run \`/plan-tango:update\` (you're on v${current}).`,
      cache_path: cp,
      cache_age_seconds: 0,
      from_cache: false,
    });
  }

  emit({
    status: "ok",
    current,
    latest,
    message: latest ? `Up to date (current v${current}, latest v${latest}).` : `No semver tags on remote yet.`,
    cache_path: cp,
    cache_age_seconds: 0,
    from_cache: false,
  });
}

main().catch(() => {
  // Defensive: if anything truly unexpected slips through, fail silently.
  process.stdout.write(JSON.stringify({
    status: "error",
    current: null,
    latest: null,
    message: "Unexpected internal error in update-check.mjs.",
    cache_path: cachePath(),
    cache_age_seconds: null,
    from_cache: false,
  }) + "\n");
  process.exit(0);
});
