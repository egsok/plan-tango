#!/usr/bin/env node
// Lease-lock for plan-tango runs. One lock per slug.
//
// Lock file: ~/.claude/plans/{slug}-tango.lock (sibling of state/ledger)
//
// Usage:
//   node lock.mjs acquire --slug <s> --plan <abs-path> [--session <id>] [--takeover]
//   node lock.mjs refresh  --slug <s> --session <id> [--plan-hash <sha256>]
//   node lock.mjs release  --slug <s> --session <id>
//   node lock.mjs inspect  --slug <s>
//
// Lock JSON shape:
//   {
//     "version": 1,
//     "slug": "...",
//     "plan_path": "/abs/path/to/plan.md",
//     "plan_hash_at_acquire": "<sha256-or-null>",
//     "session_id": "...",
//     "host": "hostname",
//     "host_pid": 12345,
//     "created_at": "ISO timestamp",
//     "updated_at": "ISO timestamp"
//   }
//
// Behavior:
//   acquire — atomic create via fs.open(path, 'wx'). On EEXIST:
//     - read existing lock; compute age = now - updated_at
//     - PID liveness: if existing.host === this host AND the recorded
//       host_pid is definitively gone (process.kill(pid,0) → ESRCH), the lock
//       is treated as stale immediately regardless of age. This only ever
//       strengthens staleness; the age TTL below is the fallback and is never
//       weakened. Locks predating the `host` field skip this fast path.
//     - if not stale (age < STALE_THRESHOLD_MIN and owner alive) and !--takeover → error lock_held
//     - if stale (age >= STALE_THRESHOLD_MIN OR dead owner pid) → log warning, delete, retry create
//     - if --takeover and lock is still fresh (not stale) → error cannot_takeover_fresh_lock
//   refresh — read lock; require session_id match; update updated_at; atomic write via tmp+rename
//   release — read lock; require session_id match; rmSync
//   inspect — read lock; print contents

import { homedir, hostname } from "node:os";
import { closeSync, openSync, writeSync, readFileSync, renameSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const STALE_THRESHOLD_MIN = 30;
const VERSION = 1;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(reason, extra = {}) {
  emit({ ok: false, reason, ...extra });
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function plansRoot() {
  return path.join(homedir(), ".claude", "plans");
}

function lockPath(slug) {
  return path.join(plansRoot(), `${slug}-tango.lock`);
}

function ensureSlug(slug) {
  if (!slug || typeof slug !== "string") return null;
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  return slug;
}

function newSessionId() {
  return `${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function sha256OfFile(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function ageMinutes(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

// Liveness probe for a recorded PID. Returns:
//   true  — process exists (or exists but owned by another user: EPERM)
//   false — process definitively gone (ESRCH)
//   null  — unknown (bad pid, or any other error) → caller must fall back
// Only a `false` result is safe to act on for early staleness.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true;
    return null;
  }
}

function readLock(slug) {
  const lp = lockPath(slug);
  if (!existsSync(lp)) return null;
  try {
    const raw = readFileSync(lp, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return { _corrupt: true, error: String(err) };
  }
}

function writeLockAtomic(slug, payload) {
  const lp = lockPath(slug);
  const tmp = `${lp}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(payload, null, 2));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, lp);
}

function tryCreateExclusive(slug, payload) {
  const lp = lockPath(slug);
  const json = JSON.stringify(payload, null, 2);
  let fd;
  try {
    fd = openSync(lp, "wx");
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, reason: "exists" };
    return { ok: false, reason: "open_failed", error: String(err) };
  }
  try {
    writeSync(fd, json);
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

function acquireCmd(opts) {
  const slug = ensureSlug(opts.slug);
  if (!slug) fail("invalid_slug", { got: opts.slug ?? null });
  if (!opts.plan || typeof opts.plan !== "string") fail("missing_plan_path");
  // Make sure plans root exists (lock file lives there).
  const root = plansRoot();
  if (!existsSync(root)) {
    try {
      mkdirSync(root, { recursive: true });
    } catch (err) {
      fail("plans_root_unavailable", { error: String(err) });
    }
  }
  const sessionId = (typeof opts.session === "string" && opts.session) || newSessionId();
  const planHash = sha256OfFile(opts.plan);
  const now = new Date().toISOString();
  const payload = {
    version: VERSION,
    slug,
    plan_path: opts.plan,
    plan_hash_at_acquire: planHash,
    session_id: sessionId,
    host: hostname(),
    host_pid: process.pid,
    created_at: now,
    updated_at: now,
  };

  const first = tryCreateExclusive(slug, payload);
  if (first.ok) {
    emit({ ok: true, acquired: true, session_id: sessionId, lock_path: lockPath(slug), plan_hash: planHash });
    return;
  }
  if (first.reason !== "exists") {
    fail(first.reason, { error: first.error || null });
  }
  // EEXIST path — inspect existing lock.
  const existing = readLock(slug);
  if (!existing || existing._corrupt) {
    // Corrupt lock — treat as stale and overwrite if --takeover, else fail.
    if (opts.takeover) {
      try {
        rmSync(lockPath(slug), { force: true });
      } catch (err) {
        fail("corrupt_lock_remove_failed", { error: String(err) });
      }
      const retry = tryCreateExclusive(slug, payload);
      if (retry.ok) {
        emit({ ok: true, acquired: true, session_id: sessionId, lock_path: lockPath(slug), plan_hash: planHash, took_over_corrupt: true });
        return;
      }
      fail(retry.reason, { error: retry.error || null });
    }
    fail("lock_corrupt", { lock_path: lockPath(slug), corrupt_payload: existing });
  }
  const age = ageMinutes(existing.updated_at);
  // PID-liveness fast path: if the lock was written on THIS host and the
  // recorded owner PID is definitively gone (ESRCH), the lease is stale
  // immediately — no need to wait out the TTL. This only strengthens
  // staleness (never weakens it): the TTL age check remains the fallback,
  // and we only trust a `false` (definitely-dead) probe on a matching host.
  // Locks written before the `host` field existed simply skip this path.
  const sameHost = typeof existing.host === "string" && existing.host === hostname();
  const ownerDead = sameHost && pidAlive(existing.host_pid) === false;
  const staleByAge = age >= STALE_THRESHOLD_MIN;
  if (!staleByAge && !ownerDead) {
    if (opts.takeover) {
      fail("cannot_takeover_fresh_lock", {
        lock_age_minutes: Number(age.toFixed(2)),
        stale_threshold_minutes: STALE_THRESHOLD_MIN,
        existing_session: existing.session_id,
        existing_plan_path: existing.plan_path,
        existing_pid: existing.host_pid,
      });
    }
    fail("lock_held", {
      lock_age_minutes: Number(age.toFixed(2)),
      stale_threshold_minutes: STALE_THRESHOLD_MIN,
      existing_session: existing.session_id,
      existing_plan_path: existing.plan_path,
      existing_pid: existing.host_pid,
      hint: `Lock is held by another session less than ${STALE_THRESHOLD_MIN} min ago. Wait or pass --takeover after confirming no parallel run.`,
    });
  }
  // Stale lock: log and overwrite.
  const staleReason = ownerDead ? "dead_pid" : "age";
  process.stderr.write(
    `[plan-tango] WARNING: stale lock at ${lockPath(slug)} (reason ${staleReason}, age ${age.toFixed(1)} min, owner session ${existing.session_id}, pid ${existing.host_pid}). Overriding.\n`,
  );
  try {
    rmSync(lockPath(slug), { force: true });
  } catch (err) {
    fail("stale_remove_failed", { error: String(err) });
  }
  const retry = tryCreateExclusive(slug, payload);
  if (retry.ok) {
    emit({
      ok: true,
      acquired: true,
      session_id: sessionId,
      lock_path: lockPath(slug),
      plan_hash: planHash,
      took_over_stale: true,
      stale_reason: staleReason,
      previous_owner_session: existing.session_id,
      previous_age_minutes: Number(age.toFixed(2)),
    });
    return;
  }
  fail(retry.reason, { error: retry.error || null });
}

function refreshCmd(opts) {
  const slug = ensureSlug(opts.slug);
  if (!slug) fail("invalid_slug", { got: opts.slug ?? null });
  if (!opts.session || typeof opts.session !== "string") fail("missing_session_id");
  const existing = readLock(slug);
  if (!existing) fail("lock_missing");
  if (existing._corrupt) fail("lock_corrupt", { error: existing.error });
  if (existing.session_id !== opts.session) {
    fail("session_mismatch", {
      expected: opts.session,
      actual: existing.session_id,
    });
  }
  existing.updated_at = new Date().toISOString();
  if (opts["plan-hash"] && typeof opts["plan-hash"] === "string") {
    existing.plan_hash_latest = opts["plan-hash"];
  }
  try {
    writeLockAtomic(slug, existing);
    emit({ ok: true, refreshed: true, lock_path: lockPath(slug), updated_at: existing.updated_at });
  } catch (err) {
    fail("refresh_write_failed", { error: String(err) });
  }
}

function releaseCmd(opts) {
  const slug = ensureSlug(opts.slug);
  if (!slug) fail("invalid_slug", { got: opts.slug ?? null });
  if (!opts.session || typeof opts.session !== "string") fail("missing_session_id");
  const lp = lockPath(slug);
  if (!existsSync(lp)) {
    emit({ ok: true, released: false, note: "already_absent", lock_path: lp });
    return;
  }
  const existing = readLock(slug);
  if (existing._corrupt) fail("lock_corrupt", { error: existing.error });
  if (existing.session_id !== opts.session) {
    fail("session_mismatch", {
      expected: opts.session,
      actual: existing.session_id,
      hint: "Refusing to release a lock owned by a different session.",
    });
  }
  try {
    rmSync(lp, { force: true });
    emit({ ok: true, released: true, lock_path: lp });
  } catch (err) {
    fail("release_failed", { error: String(err) });
  }
}

function inspectCmd(opts) {
  const slug = ensureSlug(opts.slug);
  if (!slug) fail("invalid_slug", { got: opts.slug ?? null });
  const lp = lockPath(slug);
  if (!existsSync(lp)) {
    emit({ ok: true, present: false, lock_path: lp });
    return;
  }
  const existing = readLock(slug);
  if (!existing) {
    emit({ ok: true, present: true, lock_path: lp, _empty: true });
    return;
  }
  if (existing._corrupt) {
    emit({ ok: true, present: true, lock_path: lp, corrupt: true, error: existing.error });
    return;
  }
  const age = ageMinutes(existing.updated_at);
  emit({
    ok: true,
    present: true,
    lock_path: lp,
    payload: existing,
    age_minutes: Number(age.toFixed(2)),
    is_stale: age >= STALE_THRESHOLD_MIN,
    stale_threshold_minutes: STALE_THRESHOLD_MIN,
  });
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));
  if (cmd === "acquire") return acquireCmd(opts);
  if (cmd === "refresh") return refreshCmd(opts);
  if (cmd === "release") return releaseCmd(opts);
  if (cmd === "inspect") return inspectCmd(opts);
  process.stderr.write(
    "Usage: lock.mjs <acquire|refresh|release|inspect> --slug <s> [--plan <p>] [--session <id>] [--takeover] [--plan-hash <sha>]\n",
  );
  process.exit(2);
}

main();
