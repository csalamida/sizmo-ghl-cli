// lib/cache.mjs — honest on-disk TTL cache.
// Guardrails: short TTL, age always tracked, atomic write (temp+rename), 0700 dir / 0600 files.
// NEVER stores whether a response is healthy/degraded — callers only cache 2xx (see http.mjs).
//
// TWO THINGS THIS FILE GOT WRONG, both verified 2026-07-30 and both fixed here.
//
// 1. The temp file was created in os.tmpdir() and renamed into the cache dir. rename(2) cannot
//    cross a filesystem boundary, and those two paths are on different filesystems on any setup
//    where /tmp is a tmpfs and $HOME is not — the common Linux and container default. Proven with
//    a real second filesystem (a 4MB HFS+ RAM disk as TMPDIR):
//        rename threw: EXDEV | EXDEV: cross-device link not permitted
//        cache.get() right after set(): null
//        files in the cache dir: 0
//        orphaned .tmp files in tmpdir: 1
//    So the failure was not a crash — `set` swallows errors by design — it was a cache that
//    SILENTLY never worked, plus one abandoned temp file per write, each holding a full API
//    response body (contact names, emails, phone numbers) and never cleaned up.
//    The temp now lives in the destination directory, so the rename can never cross a device.
//    lib/config.mjs and lib/memory.mjs already did it that way; this file was the odd one out.
//
// 2. Nothing was ever deleted. `get` returned null past the TTL but left the file in place, so
//    entries expired logically and persisted physically. Measured: 50 entries written, read back
//    ten years later, `get` correctly returned null — and all 50 files were still on disk with
//    their contact PII intact. Over months of use the directory only grows. There was also no way
//    for a user to clear it: the module exported exactly one function, and no command touched it.
//    Now an expired entry is unlinked when it is read, a once-per-process sweep removes expired
//    entries nobody reads again (paginated URLs are never requested twice), and `clear()` backs
//    `sizmo config cache-clear`.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function keyFile(dir, key) {
  const h = createHash('sha256').update(key).digest('hex');
  return join(dir, h + '.json');
}

// Expiry is decided from the entry's own `ts` field — the SAME clock `get` uses. A first draft
// compared the injected `now()` against the file's mtime, which is real wall-clock time; with an
// injected clock the two are unrelated numbers and the sweep silently removed nothing. Reading
// each small file costs a fraction of a millisecond and runs once per process, which is a fair
// price for the sweep and `get` agreeing on what "expired" means.
//
// Temp files are the exception: an abandoned temp has no `ts` to read, so age comes from mtime.
// A successful write renames its temp away immediately, so anything still sitting there past the
// TTL belongs to a process that died mid-write. The threshold keeps the sweep from deleting a
// concurrent writer's live temp.
function sweepExpired(dir, ttlMs, nowMs) {
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (f.endsWith('.tmp')) {
        if (Date.now() - statSync(p).mtimeMs > ttlMs) { unlinkSync(p); removed++; }
        continue;
      }
      if (!f.endsWith('.json')) continue;
      let ts = null;
      try { ts = JSON.parse(readFileSync(p, 'utf8')).ts; } catch { /* corrupt → useless either way */ }
      if (typeof ts !== 'number' || nowMs - ts > ttlMs) { unlinkSync(p); removed++; }
    } catch { /* vanished or unreadable — nothing to do */ }
  }
  return removed;
}

export function makeCache({ dir, ttlMs, now = Date.now }) {
  let swept = false;                     // one directory scan per process, not one per write
  return {
    set(key, value) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const payload = JSON.stringify({ ts: now(), value });
        // Temp file in the DESTINATION directory: same filesystem by construction, so the rename
        // below cannot fail with EXDEV. Suffixed with the pid so two processes cannot collide.
        const tmp = keyFile(dir, key) + '.' + process.pid + '.tmp';
        try {
          writeFileSync(tmp, payload, { mode: 0o600 });
          renameSync(tmp, keyFile(dir, key));
        } finally {
          // If the rename failed the temp still holds a full response body. Never leave it.
          try { unlinkSync(tmp); } catch { /* already renamed away — expected */ }
        }
        if (!swept) { swept = true; try { sweepExpired(dir, ttlMs, now()); } catch { /* ignore */ } }
      } catch { /* best-effort — cache write failures are non-fatal */ }
    },
    get(key) {
      const file = keyFile(dir, key);
      try {
        const raw = readFileSync(file, 'utf8');
        const { ts, value } = JSON.parse(raw);
        const ageMs = now() - ts;
        if (ageMs > ttlMs) {
          // Expired means gone, not merely ignored. Leaving it kept response bodies on disk
          // indefinitely for every URL the tool had ever fetched.
          try { unlinkSync(file); } catch { /* ignore */ }
          return null;
        }
        return { value, ageMs };
      } catch { return null; } // missing or corrupt → null, no throw
    },
    /**
     * clear() → { removed } — delete every cached response. Backs `sizmo config cache-clear`.
     * A missing directory is success with removed: 0, not an error.
     */
    clear() {
      let removed = 0;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.json') && !f.endsWith('.tmp')) continue;
          try { unlinkSync(join(dir, f)); removed++; } catch { /* ignore */ }
        }
      } catch { /* no directory yet — nothing cached */ }
      return { removed };
    },
    /** sweep() → { removed } — drop expired entries only. Exposed for tests and for doctor. */
    sweep() {
      try { return { removed: sweepExpired(dir, ttlMs, now()) }; }
      catch { return { removed: 0 }; }
    },
  };
}
