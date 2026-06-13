// lib/http.mjs — the one GHL HTTP client. Auth, 429 Retry-After + backoff+jitter, timeout.
// READ paths only are used by this CLI; method defaults to GET. fetch/sleep injectable for tests.
const DEFAULT_BASE = 'https://services.leadconnectorhq.com';

export function makeHttp({ pit, base = DEFAULT_BASE, version = '2021-07-28',
                           fetch = globalThis.fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
                           maxRetries = 4, timeoutMs = 15000, jitter = () => 0.5,
                           maxTimeoutRetries = 2, cache = null, fresh = false } = {}) {
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
        const ra = Number(res.headers.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(++attempt, jitter));
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
  return { get };
}
function backoff(attempt, jitter) { return Math.min(8000, 250 * 2 ** attempt) * (0.5 + jitter() * 0.5); }
