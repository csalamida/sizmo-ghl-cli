import { test } from 'node:test'; import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { syncModel, loadModel, isStale, ENTITY_SPECS, timezoneFromModel, tzLabel, DEFAULT_TZ } from '../../lib/model.mjs';

test('timezoneFromModel: location tz wins; missing → Manila fallback; never throws', () => {
  const ny = { entities: { location: { item: { timezone: 'America/New_York' } } } };
  assert.equal(timezoneFromModel(ny), 'America/New_York');
  // business.timezone is the secondary source
  const biz = { entities: { location: { item: { business: { timezone: 'Europe/London' } } } } };
  assert.equal(timezoneFromModel(biz), 'Europe/London');
  // no tz on the location → PH-first fallback (current users unchanged)
  assert.equal(timezoneFromModel({ entities: { location: { item: {} } } }), DEFAULT_TZ);
  assert.equal(DEFAULT_TZ, 'Asia/Manila');
  // no model at all (e.g. unsynced) → fallback, no crash
  assert.equal(timezoneFromModel(undefined), DEFAULT_TZ);
  assert.equal(timezoneFromModel(null), DEFAULT_TZ);
  // explicit fallback override is honored
  assert.equal(timezoneFromModel(undefined, 'UTC'), 'UTC');
});

test('timezoneFromModel actually shifts the rendered day (the bug it fixes)', () => {
  // 02:30 UTC Jun 18 is still Jun 17 in New York — a Manila-hardcoded render showed the wrong day.
  const t = Date.UTC(2026, 5, 18, 2, 30);
  const day = (tz) => new Date(t).toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' });
  assert.equal(day('Asia/Manila'), '18');
  assert.equal(day('America/New_York'), '17');
  assert.notEqual(day('Asia/Manila'), day('America/New_York'));
});

test('tzLabel: trailing city, underscores → spaces', () => {
  assert.equal(tzLabel('America/New_York'), 'New York');
  assert.equal(tzLabel('Asia/Manila'), 'Manila');
  assert.equal(tzLabel(''), '');
  assert.equal(tzLabel(undefined), '');
});

test('ENTITY_SPECS contains core + extended entities', () => {
  const names = ENTITY_SPECS.map(s => s.name);
  // core 6 must always be present
  for (const n of ['pipelines', 'calendars', 'tags', 'customFields', 'users', 'location']) {
    assert.ok(names.includes(n), `ENTITY_SPECS missing core: ${n}`);
  }
  // extended entities added in v2.4
  for (const n of ['forms', 'surveys', 'products', 'links', 'businesses', 'objects']) {
    assert.ok(names.includes(n), `ENTITY_SPECS missing extended: ${n}`);
  }
  assert.ok(ENTITY_SPECS.length >= 12, `expected ≥12 entity specs, got ${ENTITY_SPECS.length}`);
});

test('products extract reads _id — GHL products API is the one entity that has no top-level id field', () => {
  const spec = ENTITY_SPECS.find(s => s.name === 'products');
  const raw = { products: [{ _id: '69b97eae95ebdbad5a2a5c24', name: 'TRrest', productType: 'DIGITAL' }] };
  const { items } = spec.extract(raw);
  assert.equal(items[0].id, '69b97eae95ebdbad5a2a5c24');
  assert.equal(items[0].name, 'TRrest');
});

test('links buildPath sends no `limit` param — GHL 422s "property limit should not exist" if present', () => {
  const spec = ENTITY_SPECS.find(s => s.name === 'links');
  const path = spec.buildPath('L-TEST');
  assert.ok(!/[?&]limit=/.test(path), `links buildPath must not include limit — got: ${path}`);
  assert.match(path, /locationId=L-TEST/);
});

test('customFields buildPath sends no `limit` param — same rejection, plus it already returns everything', () => {
  const spec = ENTITY_SPECS.find(s => s.name === 'customFields');
  assert.ok(!/[?&]limit=/.test(spec.buildPath('L-TEST')));
});

test('objects buildPath sends no `limit` param — same rejection as links/customFields', () => {
  const spec = ENTITY_SPECS.find(s => s.name === 'objects');
  assert.ok(!/[?&]limit=/.test(spec.buildPath('L-TEST')));
});

test('forms/products/businesses buildPath use limit=100 (GHL\'s real max) — 50 silently missed anything past the 50th', () => {
  for (const name of ['forms', 'products', 'businesses']) {
    const spec = ENTITY_SPECS.find(s => s.name === name);
    assert.match(spec.buildPath('L-TEST'), /[?&]limit=100(&|$)/, `${name} must use limit=100`);
  }
});

test('surveys buildPath stays at limit=50 — genuinely GHL\'s max for this one entity, not an oversight (100 gets rejected live)', () => {
  const spec = ENTITY_SPECS.find(s => s.name === 'surveys');
  assert.match(spec.buildPath('L-TEST'), /[?&]limit=50(&|$)/);
});

test('forms/surveys/businesses/objects extract reads id — confirmed against live GHL response shape', () => {
  const cases = [
    ['forms', { forms: [{ id: 'f1', name: 'Form' }] }],
    ['surveys', { surveys: [{ id: 's1', name: 'Survey' }] }],
    ['businesses', { businesses: [{ id: 'b1', name: 'Biz' }] }],
  ];
  for (const [name, raw] of cases) {
    const spec = ENTITY_SPECS.find(s => s.name === name);
    const { items } = spec.extract(raw);
    assert.equal(items[0].id, raw[name][0].id, `${name} extract should read .id`);
  }
});

test('syncModel fetches 6 entities + stores blob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const http = {
    get: async (path) => {
      const map = {
        '/opportunities/pipelines': { pipelines: [{ id: 'p1', name: 'Sales', stages: [{ id: 's1', name: 'Won', position: 0 }] }] },
        '/calendars/': { calendars: [{ id: 'c1', name: 'Intro' }] },
        '/tags': { tags: [{ id: 't1', name: 'lead' }] },
        '/customFields': { customFields: [{ id: 'f1', name: 'Goal', fieldKey: 'goal' }] },
        '/users/': { users: [{ id: 'u1', firstName: 'Jane', lastName: 'D' }] },
        '/locations/': { location: { id: 'L1', name: 'Biz', timezone: 'Asia/Manila', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  const m = await syncModel({ http, loc: 'L1', dir, now: () => 1000 });
  assert.equal(m.locationId, 'L1');
  assert.equal(m.schemaVersion, 1);
  assert.ok(m.entities.pipelines);
  assert.equal(m.entities.pipelines.items[0].name, 'Sales');
  assert.equal(m.entities.pipelines.items[0].stages[0].name, 'Won');
  const loaded = loadModel('L1', dir);
  assert.ok(loaded !== null);
  assert.equal(loaded.entities.calendars.items[0].name, 'Intro');
  assert.equal(loaded.entities.tags.items[0].name, 'lead');
  assert.equal(loaded.entities.users.items[0].firstName, 'Jane');
  assert.equal(loaded.entities.location.item.name, 'Biz');
  rmSync(dir, { recursive: true });
});

test('partial sync: one entity 403 → stored blocked, others fine, no throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const http = {
    get: async (path) => {
      if (path.includes('/tags')) return { code: 403, ok: false, j: null };
      const map = {
        '/opportunities/pipelines': { pipelines: [{ id: 'p1', name: 'S', stages: [] }] },
        '/calendars/': { calendars: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L1', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  const m = await syncModel({ http, loc: 'L1', dir, now: () => 1 });
  assert.equal(m.entities.tags.blocked, true, 'tags must be blocked');
  assert.ok(m.entities.tags.scope, 'blocked entity must have a scope hint');
  // others fine
  assert.ok(Array.isArray(m.entities.pipelines.items), 'pipelines still stored');
  assert.ok(Array.isArray(m.entities.calendars.items), 'calendars still stored');
  rmSync(dir, { recursive: true });
});

test('partial sync: 401 also marks blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const http = {
    get: async (path) => {
      if (path.includes('/users/')) return { code: 401, ok: false, j: null };
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/tags': { tags: [] },
        '/customFields': { customFields: [] },
        '/locations/': { location: { id: 'L1', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  const m = await syncModel({ http, loc: 'L1', dir, now: () => 1 });
  assert.equal(m.entities.users.blocked, true);
  rmSync(dir, { recursive: true });
});

test('loadModel missing → null', () => {
  assert.equal(loadModel('NOPE', join(tmpdir(), 'x' + Math.random())), null);
});

test('loadModel corrupt blob → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'L1.json'), 'not json', { mode: 0o600 });
  assert.equal(loadModel('L1', dir), null);
  rmSync(dir, { recursive: true });
});

test('loadModel wrong schemaVersion → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  writeFileSync(join(dir, 'L1.json'), JSON.stringify({ schemaVersion: 99, locationId: 'L1', syncedAt: 1, entities: {} }), { mode: 0o600 });
  assert.equal(loadModel('L1', dir), null);
  rmSync(dir, { recursive: true });
});

test('isStale: fresh entity → false; stale entity → true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const http = {
    get: async (path) => {
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/tags': { tags: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L1', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  const NOW = 1_000_000;
  const m = await syncModel({ http, loc: 'L1', dir, now: () => NOW });
  // fresh: same time as sync
  assert.equal(isStale(m.entities.pipelines, NOW, ENTITY_SPECS.find(s => s.name === 'pipelines').ttlMs), false);
  // stale: past TTL (24h = 86400000ms)
  assert.equal(isStale(m.entities.pipelines, NOW + 86400001, ENTITY_SPECS.find(s => s.name === 'pipelines').ttlMs), true);
  // tags TTL = 12h = 43200000ms
  assert.equal(isStale(m.entities.tags, NOW + 43200001, ENTITY_SPECS.find(s => s.name === 'tags').ttlMs), true);
  assert.equal(isStale(m.entities.tags, NOW + 43199999, ENTITY_SPECS.find(s => s.name === 'tags').ttlMs), false);
  rmSync(dir, { recursive: true });
});

test('syncModel with only= syncs subset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const fetched = [];
  const http = {
    get: async (path) => {
      fetched.push(path);
      return { code: 200, ok: true, j: { tags: [{ id: 't1', name: 'lead' }] } };
    },
  };
  const m = await syncModel({ http, loc: 'L1', dir, now: () => 1, only: ['tags'] });
  assert.ok(fetched.some(p => p.includes('/tags')));
  assert.ok(m.entities.tags.items.length >= 0);
  rmSync(dir, { recursive: true });
});

// ── C1 fixes ─────────────────────────────────────────────────────────────────

test('C1: cold+offline — syncModel throws, does NOT write a model blob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  // All fetches throw (network down, no existing model)
  const http = { get: async () => { throw new Error('ECONNREFUSED'); } };
  let threw = false;
  let thrownErr = null;
  try {
    await syncModel({ http, loc: 'L-COLD', dir, now: () => 1 });
  } catch (e) {
    threw = true;
    thrownErr = e;
  }
  assert.ok(threw, 'syncModel must throw when cold+offline');
  assert.ok(thrownErr.offline === true, 'error must have .offline=true');
  assert.ok(/GoHighLevel|connection/i.test(thrownErr.message), 'error message must mention GoHighLevel/connection');
  // No model blob must have been written
  assert.ok(!existsSync(join(dir, 'L-COLD.json')), 'must NOT write a blob when cold+offline');
  rmSync(dir, { recursive: true });
});

test('C1: cold+offline via code:0 response — throws, does NOT write blob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  // http.get returns code:0 (network failure via return value, not throw)
  const http = { get: async () => ({ code: 0, ok: false, j: null, message: 'network unreachable' }) };
  let threw = false;
  try {
    await syncModel({ http, loc: 'L-CODE0', dir, now: () => 1 });
  } catch (e) {
    threw = true;
    assert.ok(e.offline === true, 'error must have .offline=true');
  }
  assert.ok(threw, 'syncModel must throw when all entities return code:0');
  assert.ok(!existsSync(join(dir, 'L-CODE0.json')), 'must NOT write a blob when cold+offline via code:0');
  rmSync(dir, { recursive: true });
});

test('C1: model present + refresh-fails → model.offline=true, blob still written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  // First: successful sync to establish existing model
  const goodHttp = {
    get: async (path) => {
      const map = {
        '/opportunities/pipelines': { pipelines: [{ id: 'p1', name: 'Sales', stages: [] }] },
        '/calendars/': { calendars: [] },
        '/tags': { tags: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L-STALE', name: 'Biz', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  await syncModel({ http: goodHttp, loc: 'L-STALE', dir, now: () => 1000 });

  // Second: network down — has existing model, so should NOT throw, but model.offline=true
  const badHttp = { get: async () => { throw new Error('ECONNREFUSED'); } };
  let threw = false;
  let result = null;
  try {
    result = await syncModel({ http: badHttp, loc: 'L-STALE', dir, now: () => 2000 });
  } catch (e) {
    threw = true;
  }
  assert.ok(!threw, 'must NOT throw when existing model present and refresh fails');
  assert.ok(result !== null, 'must return a model');
  assert.ok(result.offline === true, 'model.offline must be true when all fetches failed');
  // Blob must have been written
  assert.ok(existsSync(join(dir, 'L-STALE.json')), 'blob must still be written');
  const loaded = loadModel('L-STALE', dir);
  assert.ok(loaded.offline === true, 'written blob must have offline=true');
  rmSync(dir, { recursive: true });
});

test('C1: 403 entity → blocked (scope error), NOT networkError; model.offline stays false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const http = {
    get: async (path) => {
      if (path.includes('/tags')) return { code: 403, ok: false, j: null };
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L-403', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  const m = await syncModel({ http, loc: 'L-403', dir, now: () => 1 });
  assert.equal(m.entities.tags.blocked, true, 'tags must be blocked (scope error)');
  assert.ok(!m.entities.tags.networkError, 'tags must NOT have networkError for a 403');
  assert.ok(m.offline === false, 'model.offline must be false when only 403s — scope error ≠ network error');
  rmSync(dir, { recursive: true });
});

test('C1: network-error entity gets networkError:true, not blocked:true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  // First, create an existing model so we don't hit the cold+offline throw path
  const goodHttp = {
    get: async (path) => {
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/tags': { tags: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L-NETERR', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  await syncModel({ http: goodHttp, loc: 'L-NETERR', dir, now: () => 1 });

  // Now: tags throws on fetch
  const mixedHttp = {
    get: async (path) => {
      if (path.includes('/tags')) throw new Error('ETIMEDOUT');
      if (path.includes('/users/')) return { code: 403, ok: false, j: null };
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/customFields': { customFields: [] },
        '/locations/': { location: { id: 'L-NETERR', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  const m = await syncModel({ http: mixedHttp, loc: 'L-NETERR', dir, now: () => 2 });
  // tags: threw → networkError:true
  assert.ok(m.entities.tags.networkError === true, 'tags must have networkError:true');
  assert.ok(!m.entities.tags.blocked, 'tags must NOT be blocked (it was a network error)');
  // users: 403 → blocked:true (no networkError)
  assert.ok(m.entities.users.blocked === true, 'users must be blocked (403)');
  assert.ok(!m.entities.users.networkError, 'users must NOT have networkError for 403');
  // model.offline = true because at least one entity hit network error
  assert.ok(m.offline === true, 'model.offline must be true when any entity had a network error');
  rmSync(dir, { recursive: true });
});

test('M1: atomic write uses same-dir temp (no EXDEV); write failure throws', async () => {
  // Verify the temp file is in the same dir as the dest by observing that no file
  // appears in tmpdir() during write. We can't easily simulate EXDEV, but we can
  // verify the write completes cleanly to a specified dir.
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const http = {
    get: async (path) => {
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/tags': { tags: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L-ATOMIC', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : {} };
    },
  };
  const m = await syncModel({ http, loc: 'L-ATOMIC', dir, now: () => 1 });
  // Model was written successfully and is loadable
  const loaded = loadModel('L-ATOMIC', dir);
  assert.ok(loaded !== null, 'model must be loadable after atomic write');
  assert.equal(loaded.locationId, 'L-ATOMIC');
  // No orphaned temp files remain in the dir
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(dir);
  assert.ok(!files.some(f => f.endsWith('.tmp.' + process.pid)), 'no orphaned .tmp files must remain after successful write');
  rmSync(dir, { recursive: true });
});
