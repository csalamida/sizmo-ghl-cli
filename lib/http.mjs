// lib/http.mjs — the one GHL HTTP client. Auth, 429 Retry-After + backoff+jitter, timeout.
// READ paths only are used by this CLI; method defaults to GET. fetch/sleep injectable for tests.
const DEFAULT_BASE = 'https://services.leadconnectorhq.com';

// A server-supplied Retry-After is honoured but never blindly. Two bounds, both load-bearing:
//
//   1. It counts as an attempt. The original code read
//        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(++attempt, jitter));
//      where `++attempt` lives ONLY in the fallback arm — so whenever the server sent a usable
//      Retry-After (the entire reason that branch exists), `attempt` never advanced and
//      `attempt < maxRetries` stayed true forever. Verified 2026-07-28 with injected fetch/sleep:
//        GET,  Retry-After: 30   → 41 attempts, 1230s simulated sleep, still going (maxRetries=4)
//        POST, Retry-After: 30   → same, re-sending the body each time
//        GET,  no Retry-After    → code=429 after 5 attempts (correct)
//      The sole existing 429 test used `retry-after: 0`, which fails the `ra > 0` check and takes
//      the bounded arm, so the defective branch had no coverage at all.
//
//   2. It is capped. Without a ceiling, `Retry-After: 3600` is a silent one-hour sleep per
//      attempt. Capping means we may retry sooner than asked, but retries are finite and the
//      command then surfaces the 429 as EXIT.API — an honest failure beats an invisible hang.
//      For a CLI whose primary users are AI agents, a process that never returns is the worst
//      possible failure mode: the agent blocks forever instead of seeing a non-zero exit.
const MAX_RETRY_AFTER_MS = 60_000;

// Shared by write() and get() — the two retry loops were byte-identical duplicates, which is how
// one bug lived in two places. Returns the delay to sleep before the next attempt.
function retryDelayMs(res, nextAttempt, jitter) {
  const ra = Number(res.headers?.get?.('retry-after'));
  return Number.isFinite(ra) && ra > 0
    ? Math.min(ra * 1000, MAX_RETRY_AFTER_MS)
    : backoff(nextAttempt, jitter);
}

export function makeHttp({ pit, base = DEFAULT_BASE, version = '2021-07-28',
                           fetch = globalThis.fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
                           maxRetries = 4, timeoutMs = 15000, jitter = () => 0.5,
                           maxTimeoutRetries = 2, cache = null, fresh = false } = {}) {
  // ── write methods ────────────────────────────────────────────────────────────
  // post / put / delete mirror get: same auth header, same 429 Retry-After + backoff,
  // same timeout, same injectable fetch. Body serialised as JSON. Never called by any
  // money/invoice/payment command — only by the operational write commands.
  async function write(method, path, body, { query, version: v = version } = {}) {
    const url = new URL(base + path);
    if (query) for (const [k, val] of Object.entries(query)) if (val != null) url.searchParams.set(k, String(val));
    let attempt = 0;
    let timeoutAttempt = 0;
    while (true) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method,
          signal: ctl.signal,
          headers: { Authorization: `Bearer ${pit}`, Version: v, Accept: 'application/json', 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          if (timeoutAttempt++ < maxTimeoutRetries) { await sleep(backoff(timeoutAttempt, jitter)); continue; }
          return { code: 0, ok: false, j: null, txt: 'timeout' };
        }
        if (attempt++ < maxRetries) { await sleep(backoff(attempt, jitter)); continue; }
        return { code: 0, ok: false, j: null, txt: e.message };
      }
      clearTimeout(timer);
      if (res.status === 429 && attempt < maxRetries) {
        // `attempt` advances on EVERY 429, whichever delay we pick — see retryDelayMs.
        await sleep(retryDelayMs(res, ++attempt, jitter));
        continue;
      }
      if (res.status >= 500 && attempt < maxRetries) { await sleep(backoff(++attempt, jitter)); continue; }
      const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch {}
      return { code: res.status, ok: res.status >= 200 && res.status < 300, j, txt };
    }
  }

  async function get(path, { query, version: v = version } = {}) {
    const url = new URL(base + path);
    if (query) for (const [k, val] of Object.entries(query)) if (val != null) url.searchParams.set(k, String(val));
    // Cache check: full resolved URL as key (includes locationId param → no cross-profile bleed)
    const cacheKey = url.toString();
    if (cache && !fresh) {
      const hit = cache.get(cacheKey);
      if (hit) return { ...hit.value, cacheAge: hit.ageMs };
    }
    let attempt = 0;
    let timeoutAttempt = 0;
    while (true) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, { method: 'GET', signal: ctl.signal,
          headers: { Authorization: `Bearer ${pit}`, Version: v, Accept: 'application/json' } });
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          if (timeoutAttempt++ < maxTimeoutRetries) { await sleep(backoff(timeoutAttempt, jitter)); continue; }
          return { code: 0, ok: false, j: null, txt: 'timeout' };
        }
        if (attempt++ < maxRetries) { await sleep(backoff(attempt, jitter)); continue; }
        return { code: 0, ok: false, j: null, txt: e.message };
      }
      clearTimeout(timer);
      if (res.status === 429 && attempt < maxRetries) {
        // `attempt` advances on EVERY 429, whichever delay we pick — see retryDelayMs.
        await sleep(retryDelayMs(res, ++attempt, jitter));
        continue;
      }
      if (res.status >= 500 && attempt < maxRetries) { await sleep(backoff(++attempt, jitter)); continue; }
      const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch {}
      const result = { code: res.status, ok: res.status >= 200 && res.status < 300, j, txt };
      // Only cache 2xx responses — NEVER cache 4xx/5xx/blocked (fake-fresh bug class)
      if (cache && !fresh && result.ok) cache.set(cacheKey, result);
      return result;
    }
  }
  return {
    get,
    post:   (path, body, opts) => write('POST',   path, body, opts),
    put:    (path, body, opts) => write('PUT',    path, body, opts),
    delete: (path, body, opts) => write('DELETE', path, body, opts),
  };
}
function backoff(attempt, jitter) { return Math.min(8000, 250 * 2 ** attempt) * (0.5 + jitter() * 0.5); }
