// lib/cache.mjs — honest on-disk TTL cache.
// Guardrails: short TTL, age always tracked, atomic write (temp+rename), 0700 dir / 0600 files.
// NEVER stores whether a response is healthy/degraded — callers only cache 2xx (see http.mjs).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function keyFile(dir, key) {
  const h = createHash('sha256').update(key).digest('hex');
  return join(dir, h + '.json');
}

export function makeCache({ dir, ttlMs, now = Date.now }) {
  return {
    set(key, value) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const payload = JSON.stringify({ ts: now(), value });
        // atomic: write to tmp then rename
        const tmp = join(tmpdir(), 'ghl-cache-' + createHash('sha256').update(key + now()).digest('hex').slice(0, 16) + '.tmp');
        writeFileSync(tmp, payload, { mode: 0o600 });
        renameSync(tmp, keyFile(dir, key));
      } catch { /* best-effort — cache write failures are non-fatal */ }
    },
    get(key) {
      try {
        const raw = readFileSync(keyFile(dir, key), 'utf8');
        const { ts, value } = JSON.parse(raw);
        const ageMs = now() - ts;
        if (ageMs > ttlMs) return null; // expired
        return { value, ageMs };
      } catch { return null; } // missing or corrupt → null, no throw
    },
  };
}
