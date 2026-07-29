// test/client/cache-token-scoping.test.mjs
//
// The read cache was keyed on the resolved URL alone. A comment in lib/http.mjs asserted that was
// safe — "includes locationId param → no cross-profile bleed" — but that reasoning only holds if
// each PIT maps to a distinct location. It does not: an agency PIT and a client-supplied PIT can
// both point at one location, and a rotated token with fewer scopes points at the same location as
// the token it replaced. The cache directory is one shared ~/.config/sizmo/cache for every profile.
//
// Verified 2026-07-28, two tokens on one location:
//     profile A (full scopes)        code=200 contacts=1
//     profile B (NO contacts scope)  code=200 contacts=1  serverAsked=0
// B read A's contact data, including an email address, holding a token that cannot read contacts —
// and B's own server was never contacted.
//
// SECURITY.md's central claim is "The PIT scope is the gate." A shared cache key bypassed that gate
// for the whole 60s TTL. This file pins the fix in both directions and pins that no credential
// reaches disk.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHttp } from '../../lib/http.mjs';
import { makeCache } from '../../lib/cache.mjs';

const withCacheDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'sizmo-cache-test-'));
  try { return await fn(dir, makeCache({ dir, ttlMs: 60_000 })); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

const QUERY = { query: { locationId: 'LOC-SHARED', limit: 100 } };

test('a DIFFERENT token on the SAME location does not read the first token\'s cached data', async () => {
  await withCacheDir(async (_dir, cache) => {
    const httpA = makeHttp({ pit: 'pit-AGENCY-full-scopes', cache,
      fetch: async () => ({ status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ contacts: [{ id: 'c1', email: 'ana@private.co' }] }) }) });

    let bAsked = 0;
    const httpB = makeHttp({ pit: 'pit-CLIENT-no-contacts-scope', cache,
      fetch: async () => { bAsked++; return { status: 401, headers: { get: () => null }, text: async () => '{}' }; } });

    await httpA.get('/contacts/', QUERY);
    const b = await httpB.get('/contacts/', QUERY);

    assert.equal(b.code, 401, 'the second token must be refused by ITS OWN server, not served from cache');
    assert.equal(bAsked, 1, 'the scope gate requires that the second token actually reaches the API');
    assert.ok(!b.j?.contacts?.length, 'no contact data may cross between tokens');
  });
});

test('the SAME token still hits its own cache — the fix must not disable caching', async () => {
  // The inverse guard. Over-scoping the key would silently turn the cache off and quietly multiply
  // every command's request count.
  await withCacheDir(async (_dir, cache) => {
    let hits = 0;
    const http = makeHttp({ pit: 'pit-SAME', cache,
      fetch: async () => { hits++; return { status: 200, headers: { get: () => null }, text: async () => '{"contacts":[]}' }; } });

    await http.get('/contacts/', QUERY);
    const second = await http.get('/contacts/', QUERY);
    assert.equal(hits, 1, 'the second identical call should be served from cache');
    assert.ok(second.cacheAge !== undefined, 'and should be marked as cached so age is visible');
  });
});

test('the raw PIT never reaches disk — not in a filename, not in a payload', async () => {
  // The fingerprint becomes part of a cache key, and keys are hashed into filenames. A raw token
  // must not enter that path.
  const PIT = 'pit-SECRET-abcdefghijklmnop';
  await withCacheDir(async (dir, cache) => {
    const http = makeHttp({ pit: PIT, cache,
      fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => '{"contacts":[]}' }) });
    await http.get('/contacts/', QUERY);

    const files = readdirSync(dir);
    assert.ok(files.length > 0, 'sanity: something was cached');
    for (const f of files) {
      assert.ok(!f.includes(PIT) && !f.includes('SECRET'), `raw PIT appeared in a cache filename: ${f}`);
      assert.ok(!readFileSync(join(dir, f), 'utf8').includes(PIT), `raw PIT appeared inside a cache payload: ${f}`);
    }
  });
});

test('two tokens on DIFFERENT locations remain independent (unchanged behaviour)', async () => {
  await withCacheDir(async (_dir, cache) => {
    let n = 0;
    const mk = (pit) => makeHttp({ pit, cache,
      fetch: async () => { n++; return { status: 200, headers: { get: () => null }, text: async () => '{"contacts":[]}' }; } });
    await mk('pit-1').get('/contacts/', { query: { locationId: 'LOC-A', limit: 100 } });
    await mk('pit-2').get('/contacts/', { query: { locationId: 'LOC-B', limit: 100 } });
    assert.equal(n, 2, 'different locations were already distinct keys and must stay so');
  });
});
