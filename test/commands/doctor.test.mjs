// test/commands/doctor.test.mjs — one-shot health diagnosis.
// Verifies: scope-missing (one lane 403 → named + correct recipe attribution),
// offline/unreachable (clean EXIT.AUTH, no crash, no fabricated green), stale model
// (age shown + flagged), and the --json shape.
//
// Style: builds the ctx directly with a controlled makeOut + fake http (mirrors
// brief.test.mjs / cache.test.mjs) — the established pattern for registry-command tests.
// Model freshness is driven via a temp _modelDir injected on ctx.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

// Track every temp model dir created here so the suite cleans up after itself (no /tmp leak).
const TMP_DIRS = [];
const tmpModelDir = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../commands/doctor.mjs';
import { makeOut } from '../../lib/output.mjs';
import { EXIT } from '../../lib/errors.mjs';
import { SCHEMA_VERSION } from '../../lib/model.mjs';

const NOW = Date.now();
const LOC = 'L-DOC';

// Fake http keyed by path prefix → { code }. transport:true makes get() reject (offline).
// Returns the {code, ok, j} shape the real http client returns.
function makeHttp(statusByPrefix = {}, { transport = false } = {}) {
  return {
    get: async (path) => {
      if (transport) return { code: 0, ok: false, j: null, txt: 'ECONNREFUSED' };
      let code = 200;
      for (const [prefix, c] of Object.entries(statusByPrefix)) {
        if (path.includes(prefix)) { code = c; break; }
      }
      return { code, ok: code >= 200 && code < 300, j: { location: { currency: 'PHP' }, contacts: [] }, txt: '{}' };
    },
  };
}

// Build a doctor ctx. modelDir defaults to a throwaway empty dir (→ no model).
function makeCtx(http, { modelDir, json = false, tty = true, profileName = null, pit = 'pit-DOCTOR99999', createdAt, updateCacheFile } = {}) {
  let printed = '';
  const out = makeOut({ json, tty, command: 'doctor', location: LOC, write: s => printed += s, writeErr: () => {} });
  const ctx = {
    http,
    cfg: { loc: LOC, tz: 'Asia/Manila', currency: null, pit, profileName, createdAt, label: null },
    out, now: NOW,
    _modelDir: modelDir ?? tmpModelDir('sizmo-doc-empty-'),
    // Point the version-check cache at a guaranteed-absent file so the CLI VERSION line is
    // deterministic (no dependency on whatever ~/.config/sizmo/update-check.json holds locally).
    _updateCacheFile: updateCacheFile ?? join(tmpModelDir('sizmo-doc-nocache-'), 'absent.json'),
  };
  return { ctx, getPrinted: () => printed };
}

function writeModelDir(model) {
  const dir = tmpModelDir('sizmo-doc-model-');
  writeFileSync(join(dir, `${LOC}.json`), JSON.stringify(model, null, 2));
  return dir;
}

// ── scope missing ───────────────────────────────────────────────────────────────

test('doctor: one scope 403 → named + traced + EXACTLY one blocked lane + exit 0 (degraded)', async () => {
  let payload = null;
  const { ctx, getPrinted } = makeCtx(makeHttp({ '/payments/transactions': 403 }));
  const orig = ctx.out.data.bind(ctx.out);
  ctx.out.data = (o) => { payload = o; orig(o); };
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.equal(code, EXIT.OK, 'degraded-but-reachable (non-contacts scope) → exit 0');
  assert.match(out, /✖ payments\/transactions\.readonly/, 'blocked scope named');
  assert.match(out, /reconcile/, 'blocked scope traced to reconcile');
  assert.match(out, /Private Integrations/, 'fix line present');
  assert.match(out, /DEGRADED/, 'verdict is degraded, never fake-green');
  assert.doesNotMatch(out, /ALL GREEN/, 'must NOT report all-green with a blocked lane');
  // tighten: precisely ONE lane blocked (catches a probe regression that over-blocks)
  assert.equal(payload.scopes.filter(s => !s.granted).length, 1, 'exactly one scope blocked');
  assert.ok(payload.scopes.filter(s => s.granted).length >= 11, 'the rest granted (≥11 with extended scopes)');
  assert.equal(payload.scopes.find(s => !s.granted).scope, 'payments/transactions.readonly', 'and it is payments');
});

test('doctor: contacts lane blocked → EXIT.AUTH (usability floor, matches `auth check`)', async () => {
  // contacts is the floor scope. If it's blocked the tool can't do its core job → AUTH,
  // not a mere degrade. This locks the doctor↔auth-check exit-contract alignment.
  let payload = null;
  const { ctx, getPrinted } = makeCtx(makeHttp({ '/contacts/': 403 }));
  const orig = ctx.out.data.bind(ctx.out);
  ctx.out.data = (o) => { payload = o; orig(o); };
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH, 'contacts blocked → AUTH (not OK)');
  assert.equal(payload.ok, false, 'ok:false when the floor scope is blocked');
  assert.doesNotMatch(getPrinted(), /ALL GREEN/, 'never green with contacts blocked');
});

// ── offline / unreachable ────────────────────────────────────────────────────────

test('doctor: offline → clean EXIT.AUTH, no crash, no fabricated green', async () => {
  const { ctx, getPrinted } = makeCtx(makeHttp({}, { transport: true }));
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.equal(code, EXIT.AUTH, 'offline → AUTH exit');
  assert.match(out, /OFFLINE|can't reach/i, 'offline surfaced loudly');
  assert.doesNotMatch(out, /ALL GREEN/, 'never green while offline');
});

test('doctor --json offline: location.reachable false, ok false, no granted-true fake-green', async () => {
  let payload = null;
  const { ctx } = makeCtx(makeHttp({}, { transport: true }), { json: true, tty: false });
  const orig = ctx.out.data.bind(ctx.out);
  ctx.out.data = (o) => { payload = o; orig(o); };
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH);
  assert.equal(payload.location.reachable, false, 'location not reachable offline');
  assert.equal(payload.ok, false, 'ok false offline');
  assert.ok(payload.scopes.every(s => s.granted === false), 'no fake-green scopes while offline');
});

// ── stale model ──────────────────────────────────────────────────────────────────

test('doctor: stale model → flagged with age shown, exit 0 (degraded)', async () => {
  const OLD = NOW - 5 * 86400000; // 5 days old — past every TTL
  const staleModel = {
    schemaVersion: SCHEMA_VERSION, locationId: LOC, syncedAt: OLD,
    entities: {
      pipelines: { fetchedAt: OLD, items: [] },
      calendars: { fetchedAt: OLD, items: [] },
      location:  { fetchedAt: OLD, item: { currency: 'PHP' } },
    },
    offline: false,
  };
  const modelDir = writeModelDir(staleModel);
  const { ctx, getPrinted } = makeCtx(makeHttp({}), { modelDir });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.equal(code, EXIT.OK, 'stale model is degraded, not fatal → exit 0');
  assert.match(out, /model is stale/i, 'staleness flagged');
  assert.match(out, /sizmo sync/, 'fix line names sizmo sync');
  assert.match(out, /\d+d old/, 'age is shown');
  assert.match(out, /DEGRADED/, 'verdict reflects stale model');
});

// ── json shape ───────────────────────────────────────────────────────────────────

test('doctor --json: full shape — profile, location, scopes[], model, rate, ok', async () => {
  const freshModel = {
    schemaVersion: SCHEMA_VERSION, locationId: LOC, syncedAt: NOW,
    entities: {
      // core 6
      pipelines:    { fetchedAt: NOW, items: [] },
      calendars:    { fetchedAt: NOW, items: [] },
      tags:         { fetchedAt: NOW, items: [] },
      customFields: { fetchedAt: NOW, items: [] },
      users:        { fetchedAt: NOW, items: [] },
      location:     { fetchedAt: NOW, item: { currency: 'PHP' } },
      // extended 6 (v2.4) — blocked is fine; absent → stale
      forms:        { fetchedAt: NOW, blocked: true, scope: 'forms.readonly' },
      surveys:      { fetchedAt: NOW, blocked: true, scope: 'surveys.readonly' },
      products:     { fetchedAt: NOW, blocked: true, scope: 'products.readonly' },
      links:        { fetchedAt: NOW, blocked: true, scope: 'links.readonly' },
      businesses:   { fetchedAt: NOW, blocked: true, scope: 'businesses.readonly' },
      objects:      { fetchedAt: NOW, blocked: true, scope: 'objects.readonly' },
    },
    offline: false,
  };
  const modelDir = writeModelDir(freshModel);
  let payload = null;
  const { ctx } = makeCtx(makeHttp({}), { modelDir, json: true, tty: false, profileName: 'main' });
  const orig = ctx.out.data.bind(ctx.out);
  ctx.out.data = (o) => { payload = o; orig(o); };
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const d = payload;
  assert.equal(d.profile, 'main', 'profile name surfaced');
  assert.ok(d.location && 'reachable' in d.location && 'latencyMs' in d.location, 'location shape');
  assert.ok(Array.isArray(d.scopes) && d.scopes.length >= 12, `≥12 scopes (got ${d.scopes?.length})`);
  for (const s of d.scopes) {
    assert.ok('scope' in s && 'granted' in s && Array.isArray(s.affects), 'each scope shape');
  }
  assert.ok(d.model && 'syncedAt' in d.model && 'ageMs' in d.model && 'stale' in d.model, 'model shape');
  assert.ok(d.rate && 'remaining' in d.rate, 'rate shape (omitted honestly = null)');
  assert.equal(d.rate.remaining, null, 'rate.remaining is null (never fabricated)');
  assert.equal(typeof d.ok, 'boolean', 'ok boolean');
  assert.equal(d.ok, true, 'all-green → ok true');
});

// ── no auth (router gate) ─────────────────────────────────────────────────────────
// buildCtx throws AUTH before doctor even runs when no PIT is resolved — exercised via
// the router. We assert the contract by confirming doctor itself returns AUTH when it can't
// reach GHL (above) and that the EXIT map is used (no invented codes).
test('doctor: uses EXIT.AUTH (3) for unreachable — never an invented code', () => {
  assert.equal(EXIT.AUTH, 3, 'AUTH is the documented unreachable/no-auth code');
});

// ── CLI version freshness (cache-read-only; never gates ok, never fetches) ──────────
test('doctor: no version cache → "update check pending", cli.latest null, never blocks', async () => {
  // makeHttp({}) is reachable, all scopes ok, but the default model dir is empty → degraded
  // (exit 0). The version check is cache-read-only and must NOT affect the exit code at all.
  const { ctx, getPrinted } = makeCtx(makeHttp({})); // default _updateCacheFile is absent
  let payload = null;
  const orig = ctx.out.data.bind(ctx.out);
  ctx.out.data = (o) => { payload = o; orig(o); };
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK, 'reachable + no model → degraded but exit 0; version check never changes exit');
  const out = getPrinted();
  assert.match(out, /CLI VERSION/, 'version section present');
  assert.match(out, /update check pending/, 'no cache → pending, not an error');
  assert.equal(payload.cli.latest, null, 'cli.latest null with no cache');
  assert.equal(payload.cli.updateAvailable, false, 'never claims an update without data');
  assert.equal(typeof payload.cli.current, 'string', 'current version surfaced');
});

test('doctor: cache shows a newer version → "available" nudge + cli.updateAvailable true', async () => {
  const cacheFile = join(mkdtempSync(join(tmpdir(), 'sizmo-doc-newer-')), 'update-check.json');
  // cache a version far above any real current → updateAvailable must be true
  writeFileSync(cacheFile, JSON.stringify({ checkedAt: NOW, latest: '999.0.0' }));
  const { ctx, getPrinted } = makeCtx(makeHttp({}), { updateCacheFile: cacheFile });
  let payload = null;
  const orig = ctx.out.data.bind(ctx.out);
  ctx.out.data = (o) => { payload = o; orig(o); };
  await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.match(getPrinted(), /sizmo 999\.0\.0 available/, 'human nudge shows the newer version');
  assert.equal(payload.cli.latest, '999.0.0');
  assert.equal(payload.cli.updateAvailable, true);
});
