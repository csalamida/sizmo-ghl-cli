// test/commands/crm.test.mjs — crm + sync command tests.
// Uses injected http + clock; no live calls.
import { test } from 'node:test'; import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { makeOut } from '../../lib/output.mjs';
import { run as runCrm } from '../../commands/crm.mjs';
import { run as runSync } from '../../commands/sync.mjs';

const NOW = 1_700_000_000_000;

function makeHttp(ok = true) {
  return {
    get: async (path) => {
      const map = {
        '/opportunities/pipelines': { pipelines: [{ id: 'p1', name: 'Sales', stages: [{ id: 's1', name: 'Lead', position: 0 }, { id: 's2', name: 'Won', position: 1 }] }] },
        '/calendars/': { calendars: [{ id: 'c1', name: 'Intro Call', calendarType: 'event', isActive: true }] },
        '/tags': { tags: [{ id: 't1', name: 'hot' }, { id: 't2', name: 'cold' }] },
        '/customFields': { customFields: [{ id: 'f1', name: 'Goal', fieldKey: 'goal', dataType: 'TEXT', model: 'contact' }] },
        '/users/': { users: [{ id: 'u1', firstName: 'Jane', lastName: 'D', email: 'jane@test.com' }] },
        '/locations/': { location: { id: 'L-TEST', name: 'Test Biz', timezone: 'Asia/Manila', business: { currency: 'PHP' }, country: 'PH' } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      if (ok && k) return { code: 200, ok: true, j: map[k] };
      return { code: k ? 200 : 404, ok: !!k && ok, j: k && ok ? map[k] : null };
    },
  };
}

function makeCtx(dir, http = makeHttp(), json = true) {
  let printed = '';
  const out = makeOut({ json, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  return {
    ctx: { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir },
    getPrinted: () => printed,
  };
}

test('sync: run returns 0 + writes model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const { ctx, getPrinted } = makeCtx(dir);
  const code = await runSync({}, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data, 'sync must return data');
  assert.ok(typeof envelope.data.synced === 'number' || envelope.data.synced >= 0, 'synced count present');
  rmSync(dir, { recursive: true });
});

test('sync: partial sync (one entity 403) → still returns 0, blocked count noted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = {
    get: async (path) => {
      if (path.includes('/tags')) return { code: 403, ok: false, j: null };
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L-TEST', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : null };
    },
  };
  const { ctx, getPrinted } = makeCtx(dir, http);
  const code = await runSync({}, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.ok(typeof envelope.data.blocked === 'number' && envelope.data.blocked >= 1, 'blocked count must be >= 1');
  rmSync(dir, { recursive: true });
});

test('crm overview: returns counts + ageMs in _meta (from freshly synced model)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  // First sync to build the model
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  // Now run crm overview
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({}, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data, 'crm must return data');
  assert.ok(envelope.data._meta, 'data must have _meta');
  assert.equal(envelope.data._meta.source, 'cache');
  assert.ok(typeof envelope.data._meta.syncedAt === 'number', 'syncedAt in _meta');
  assert.ok(typeof envelope.data._meta.ageMs === 'number', 'ageMs in _meta');
  assert.ok(typeof envelope.data._meta.stale === 'boolean', 'stale in _meta');
  // counts present
  assert.ok(typeof envelope.data.pipelines === 'number', 'pipeline count');
  assert.ok(typeof envelope.data.calendars === 'number', 'calendar count');
  assert.ok(typeof envelope.data.tags === 'number', 'tag count');
  assert.ok(typeof envelope.data.customFields === 'number', 'customField count');
  assert.ok(typeof envelope.data.users === 'number', 'user count');
  rmSync(dir, { recursive: true });
});

test('crm pipelines subcommand: lists pipelines+stages in JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({ _: ['pipelines'] }, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.ok(Array.isArray(envelope.data.items), 'pipelines subcommand must return items array');
  assert.ok(envelope.data.items.length >= 1, 'at least 1 pipeline');
  assert.equal(envelope.data.items[0].name, 'Sales');
  assert.ok(Array.isArray(envelope.data.items[0].stages), 'stages present');
  assert.ok(envelope.data._meta, '_meta present on subcommand');
  rmSync(dir, { recursive: true });
});

test('crm calendars subcommand: lists calendars in JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({ _: ['calendars'] }, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.ok(Array.isArray(envelope.data.items));
  assert.equal(envelope.data.items[0].name, 'Intro Call');
  rmSync(dir, { recursive: true });
});

test('crm location subcommand: shows location info', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({ _: ['location'] }, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.ok(envelope.data.item || envelope.data.location, 'location data present');
  rmSync(dir, { recursive: true });
});

test('crm: missing model → auto-syncs once, then returns data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  // No prior sync — model missing. crm must auto-sync.
  const http = makeHttp();
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({}, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.ok(envelope.data, 'crm auto-sync must still return data');
  assert.ok(envelope.data._meta, '_meta present after auto-sync');
  rmSync(dir, { recursive: true });
});

test('crm: stale model → serves with stale:true in _meta, does NOT auto-sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  // Sync at NOW
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  // Read at NOW + 24h + 1ms — all entities (24h TTL) are now stale
  const staleNow = NOW + 24 * 60 * 60 * 1000 + 1;
  let fetchCount = 0;
  const countingHttp = { get: async (path) => { fetchCount++; return http.get(path); } };
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const staleCtx = { http: countingHttp, cfg: { loc: 'L-TEST' }, out, now: staleNow, _modelDir: dir };
  const code = await runCrm({}, staleCtx);
  out.flush();
  assert.equal(code, 0);
  assert.equal(fetchCount, 0, 'crm must NOT re-fetch when stale (serve + banner only)');
  const envelope = JSON.parse(printed);
  assert.equal(envelope.data._meta.stale, true, 'stale must be true in _meta');
  rmSync(dir, { recursive: true });
});

test('crm: blocked entity shown in overview', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = {
    get: async (path) => {
      if (path.includes('/tags')) return { code: 403, ok: false, j: null };
      const map = {
        '/opportunities/pipelines': { pipelines: [] },
        '/calendars/': { calendars: [] },
        '/customFields': { customFields: [] },
        '/users/': { users: [] },
        '/locations/': { location: { id: 'L-TEST', name: 'B', timezone: 'UTC', business: { currency: 'PHP' } } },
      };
      const k = Object.keys(map).find(x => path.includes(x));
      return { code: k ? 200 : 404, ok: !!k, j: k ? map[k] : null };
    },
  };
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  await runCrm({}, crmCtx);
  out.flush();
  const envelope = JSON.parse(printed);
  // tags should be marked blocked in overview
  assert.ok(envelope.data.tagsBlocked === true || envelope.data.tags === null || envelope.data.tags === 0,
    'blocked tags entity must be indicated in crm overview');
  rmSync(dir, { recursive: true });
});

test('crm tags subcommand: lists tags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({ _: ['tags'] }, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.ok(Array.isArray(envelope.data.items));
  assert.ok(envelope.data.items.some(t => t.name === 'hot'));
  rmSync(dir, { recursive: true });
});

test('crm fields subcommand: lists customFields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({ _: ['fields'] }, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.ok(Array.isArray(envelope.data.items));
  assert.ok(envelope.data.items.some(f => f.name === 'Goal'));
  rmSync(dir, { recursive: true });
});

test('crm users subcommand: lists users', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({ _: ['users'] }, crmCtx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.ok(Array.isArray(envelope.data.items));
  assert.ok(envelope.data.items.some(u => u.firstName === 'Jane' || (u.name && u.name.includes('Jane'))));
  rmSync(dir, { recursive: true });
});

// ── C1 fixes ─────────────────────────────────────────────────────────────────

test('C1-crm: cold+offline → returns exit 1 + offline warning, no empty model emitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-c1-'));
  // No prior model; all fetches fail (network error)
  const http = { get: async () => { throw new Error('ECONNREFUSED'); } };
  let printed = '';
  let warnings = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: s => warnings += s });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({}, crmCtx);
  out.flush();
  // Must exit non-zero (exit 1)
  assert.notEqual(code, 0, 'cold+offline must not return exit 0');
  // No JSON output containing fresh-looking data (nothing emitted or an error envelope)
  // The key check: printed output must NOT contain a data object with counts
  if (printed) {
    // If anything was printed, it must not look like a fresh model
    const envelope = JSON.parse(printed);
    assert.ok(!envelope.data?.pipelines || envelope.data?.pipelines == null, 'cold+offline must not emit fresh pipeline counts');
  }
  rmSync(dir, { recursive: true });
});

test('C1-crm: _meta.offline=true when model has offline=true (refresh failed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-c1offline-'));
  // Sync successfully first
  const http = makeHttp();
  const { ctx: syncCtx } = makeCtx(dir, http);
  await runSync({}, syncCtx);

  // Now write a model blob with offline=true to simulate refresh-failed state
  const { loadModel: lm } = await import('../../lib/model.mjs');
  const { writeFileSync } = await import('node:fs');
  const existingModel = lm('L-TEST', dir);
  existingModel.offline = true;
  writeFileSync(join(dir, 'L-TEST.json'), JSON.stringify(existingModel, null, 2), { mode: 0o600 });

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runCrm({}, crmCtx);
  out.flush();
  assert.equal(code, 0, 'stale-with-offline-flag model must still return 0 (serving cache)');
  const envelope = JSON.parse(printed);
  assert.ok(envelope.data._meta.offline === true, '_meta.offline must be true');
  rmSync(dir, { recursive: true });
});

test('C1-crm: network-error entity → networkError flag in output, NOT blocked flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-netflag-'));
  // Build a model with tags having networkError:true (not blocked:true)
  const modelWithNetErr = {
    schemaVersion: 1,
    locationId: 'L-TEST',
    syncedAt: NOW,
    offline: true,
    entities: {
      pipelines: { fetchedAt: NOW, items: [] },
      calendars: { fetchedAt: NOW, items: [] },
      tags: { networkError: true, error: 'ETIMEDOUT', fetchedAt: NOW },
      customFields: { fetchedAt: NOW, items: [] },
      users: { fetchedAt: NOW, items: [] },
      location: { fetchedAt: NOW, item: { id: 'L-TEST', name: 'Test', timezone: 'UTC', business: { currency: 'PHP' } } },
    },
  };
  const { mkdirSync: mkd, writeFileSync: wf } = await import('node:fs');
  mkd(dir, { recursive: true });
  wf(join(dir, 'L-TEST.json'), JSON.stringify(modelWithNetErr, null, 2), { mode: 0o600 });

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http: makeHttp(), cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  await runCrm({}, crmCtx);
  out.flush();
  const envelope = JSON.parse(printed);
  // tags must show networkError, NOT tagsBlocked
  assert.ok(envelope.data.tagsNetworkError === true, 'tags network error must set tagsNetworkError in output');
  assert.ok(!envelope.data.tagsBlocked, 'tags network error must NOT set tagsBlocked');
  rmSync(dir, { recursive: true });
});

test('C1-crm: 403 scope-blocked entity → blocked line (not networkError line)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-403-'));
  // Build model with tags having blocked:true (scope error)
  const modelWith403 = {
    schemaVersion: 1,
    locationId: 'L-TEST',
    syncedAt: NOW,
    offline: false,
    entities: {
      pipelines: { fetchedAt: NOW, items: [] },
      calendars: { fetchedAt: NOW, items: [] },
      tags: { blocked: true, scope: 'locations/tags.readonly', fetchedAt: NOW },
      customFields: { fetchedAt: NOW, items: [] },
      users: { fetchedAt: NOW, items: [] },
      location: { fetchedAt: NOW, item: { id: 'L-TEST', name: 'Test', timezone: 'UTC', business: { currency: 'PHP' } } },
    },
  };
  const { mkdirSync: mkd, writeFileSync: wf } = await import('node:fs');
  mkd(dir, { recursive: true });
  wf(join(dir, 'L-TEST.json'), JSON.stringify(modelWith403, null, 2), { mode: 0o600 });

  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const crmCtx = { http: makeHttp(), cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  await runCrm({}, crmCtx);
  out.flush();
  const envelope = JSON.parse(printed);
  // tags must show blocked (scope), NOT networkError
  assert.ok(envelope.data.tagsBlocked === true, 'blocked tags must set tagsBlocked in output');
  assert.ok(!envelope.data.tagsNetworkError, 'scope-blocked tags must NOT set tagsNetworkError');
  rmSync(dir, { recursive: true });
});

test('sync <entity>: only= syncs one entity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-'));
  const http = makeHttp();
  let fetchPaths = [];
  const trackHttp = { get: async (path) => { fetchPaths.push(path); return http.get(path); } };
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'sync', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const ctx = { http: trackHttp, cfg: { loc: 'L-TEST' }, out, now: NOW, _modelDir: dir };
  const code = await runSync({ _: ['tags'] }, ctx);
  out.flush();
  assert.equal(code, 0);
  // Only tags path should have been fetched
  assert.ok(fetchPaths.some(p => p.includes('/tags')), 'tags must be fetched');
  // pipelines should NOT have been fetched in a tags-only sync
  assert.ok(!fetchPaths.some(p => p.includes('/pipelines')), 'pipelines must NOT be fetched in tags-only sync');
  rmSync(dir, { recursive: true });
});
