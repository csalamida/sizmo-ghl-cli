// test/commands/export.test.mjs — location-as-file export (deterministic, honest, secret-free).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, buildExportDoc, canonicalJSON } from '../../commands/export.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

// A full, readable location model (note: pipelines/fields intentionally OUT OF ORDER to test sorting).
function fullModel() {
  return {
    entities: {
      location: { item: { id: 'L-TEST', name: 'Biz', timezone: 'Asia/Manila', business: { currency: 'PHP' }, country: 'PH' } },
      pipelines: { items: [
        { id: 'p2', name: 'Bravo', stages: [{ id: 's2', name: 'Won', position: 1 }, { id: 's1', name: 'New', position: 0 }] },
        { id: 'p1', name: 'Alpha', stages: [] },
      ] },
      calendars: { items: [{ id: 'c1', name: 'Intro' }] },
      customFields: { items: [{ id: 'f2', name: 'Budget', dataType: 'MONETORY', fieldKey: 'contact.budget' }, { id: 'f1', name: 'Source', dataType: 'TEXT', fieldKey: 'contact.source' }] },
      tags: { items: [{ id: 't1', name: 'vip' }] },
      users: { items: [{ id: 'u1', firstName: 'Ada', lastName: 'L', email: 'ada@x.co', apiKey: 'SHOULD-NOT-EXPORT' }] },
    },
  };
}
const cvFixture = { 'GET /locations/L-TEST/customValues': { status: 200, j: { customValues: [{ id: 'v1', name: 'Link', value: 'https://x' }] } } };

test('export: canonical doc shape — specVersion, all resource groups, no timestamp', async () => {
  const { ctx } = makeFakeCtx({ model: fullModel(), fixture: cvFixture });
  const { doc, degraded } = await buildExportDoc(ctx);
  assert.equal(doc.specVersion, 1);
  assert.equal(degraded, false);
  for (const k of ['location', 'pipelines', 'calendars', 'customFields', 'customValues', 'tags', 'users']) assert.ok(k in doc, `missing ${k}`);
  // NO timestamp keys anywhere (determinism requirement)
  const s = canonicalJSON(doc);
  assert.ok(!/exportedAt|timestamp|fetchedAt|"date"/.test(s), 'doc must carry no timestamps');
});

test('export: deterministic — two builds are byte-identical', async () => {
  const { ctx: c1 } = makeFakeCtx({ model: fullModel(), fixture: cvFixture });
  const { ctx: c2 } = makeFakeCtx({ model: fullModel(), fixture: cvFixture });
  const a = canonicalJSON((await buildExportDoc(c1)).doc);
  const b = canonicalJSON((await buildExportDoc(c2)).doc);
  assert.equal(a, b, 'same location → identical bytes');
});

test('export: resources are sorted (pipelines by id, stages by position)', async () => {
  const { ctx } = makeFakeCtx({ model: fullModel(), fixture: cvFixture });
  const { doc } = await buildExportDoc(ctx);
  assert.deepEqual(doc.pipelines.map(p => p.id), ['p1', 'p2'], 'pipelines sorted by id');
  assert.deepEqual(doc.pipelines[1].stages.map(s => s.id), ['s1', 's2'], 'stages sorted by position');
  assert.deepEqual(doc.customFields.map(f => f.id), ['f1', 'f2'], 'fields sorted by id');
});

test('export: secret-free — user apiKey never exported', async () => {
  const { ctx } = makeFakeCtx({ model: fullModel(), fixture: cvFixture });
  const s = canonicalJSON((await buildExportDoc(ctx)).doc);
  assert.ok(!s.includes('SHOULD-NOT-EXPORT'), 'no user secret in the document');
  assert.ok(s.includes('ada@x.co'), 'but id/name/email are exported');
});

test('export HONESTY: a blocked entity → { blocked } marker + degraded, never an empty list', async () => {
  const m = fullModel();
  m.entities.pipelines = { blocked: true, scope: 'opportunities.readonly' };
  const { ctx } = makeFakeCtx({ model: m, fixture: cvFixture });
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  assert.deepEqual(doc.pipelines, { blocked: 'opportunities.readonly' }, 'blocked, not []');
  assert.equal(degraded, true);
  assert.ok(warnings.some(w => /opportunities\.readonly/.test(w)));
  assert.equal(doc.degraded, true, 'degrade signal rides inside the document');
});

test('export HONESTY: customValues 403 → blocked marker + degraded', async () => {
  const fixture = { 'GET /locations/L-TEST/customValues': { status: 403, j: {} } };
  const { ctx } = makeFakeCtx({ model: fullModel(), fixture });
  const { doc, degraded } = await buildExportDoc(ctx);
  assert.deepEqual(doc.customValues, { blocked: 'locations/customValues.readonly' });
  assert.equal(degraded, true);
});

test('export --out: writes valid canonical JSON to the file, exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sz-exp-'));
  const out = join(dir, 'loc.json');
  const { ctx } = makeFakeCtx({ model: fullModel(), fixture: cvFixture });
  try {
    const code = await run({ _: [], out }, ctx);
    ctx.out.flush();
    assert.equal(code, EXIT.OK);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(parsed.specVersion, 1);
    assert.equal(parsed.pipelines.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonicalJSON: keys are recursively sorted', () => {
  const s = canonicalJSON({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(s, '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}');
});

// ── entityGroup branches not yet covered ──────────────────────────────────────

test('export HONESTY: entity absent from model → { unavailable: "not synced" } + degraded', async () => {
  // An entity that was never synced doesn't appear in E at all. entityGroup receives undefined.
  // Must produce a { unavailable } marker, not an empty list — an empty list reads as "empty source".
  const m = fullModel();
  delete m.entities.tags;
  const { ctx } = makeFakeCtx({ model: m, fixture: cvFixture });
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  assert.deepEqual(doc.tags, { unavailable: 'not synced' });
  assert.equal(degraded, true);
  assert.ok(warnings.some(w => /not synced/.test(w)));
});

test('export HONESTY: entity has networkError → { unavailable: "network" } + degraded', async () => {
  // sync records networkError when GoHighLevel was unreachable for that entity during the sync run.
  const m = fullModel();
  m.entities.calendars = { networkError: true };
  const { ctx } = makeFakeCtx({ model: m, fixture: cvFixture });
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  assert.deepEqual(doc.calendars, { unavailable: 'network' });
  assert.equal(degraded, true);
  assert.ok(warnings.some(w => /could not reach GoHighLevel/.test(w)));
});

test('export HONESTY: entity blocked WITH httpCode → { blocked, httpCode } + "not a scope issue" warning', async () => {
  // httpCode present means a real API error (not a 401/403 scope gap) — the message must say so
  // to prevent users from wasting time adding a scope they already have.
  const m = fullModel();
  m.entities.pipelines = { blocked: true, httpCode: 500, scope: 'opportunities.readonly' };
  const { ctx } = makeFakeCtx({ model: m, fixture: cvFixture });
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  assert.equal(doc.pipelines.blocked, 'opportunities.readonly');
  assert.equal(doc.pipelines.httpCode, 500);
  assert.equal(degraded, true);
  assert.ok(warnings.some(w => /not a scope issue/.test(w)));
});

// ── customValues live-fetch branches not yet covered ─────────────────────────

test('export HONESTY: customValues network error (code 0) → { unavailable: "network" } + degraded', async () => {
  // code 0 is the sentinel the http layer uses for transport failures (DNS, timeout, socket).
  const { ctx } = makeFakeCtx({
    model: fullModel(),
    fixture: { 'GET /locations/L-TEST/customValues': { status: 0, j: {} } },
  });
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  assert.deepEqual(doc.customValues, { unavailable: 'network' });
  assert.equal(degraded, true);
  assert.ok(warnings.some(w => /could not reach GoHighLevel/.test(w)));
});

test('export HONESTY: customValues server error (500) → { unavailable: "http 500" } + degraded', async () => {
  // A non-auth, non-network failure: the values endpoint returned 500.
  // Must be { unavailable }, not blocked — the user can't fix this by adding a scope.
  const { ctx } = makeFakeCtx({
    model: fullModel(),
    fixture: { 'GET /locations/L-TEST/customValues': { status: 500, j: { message: 'boom' } } },
  });
  const { doc, degraded } = await buildExportDoc(ctx);
  assert.deepEqual(doc.customValues, { unavailable: 'http 500' });
  assert.equal(degraded, true);
});

// ── location.blocked branches ────────────────────────────────────────────────

test('export HONESTY: location blocked without httpCode → missing-scope warning + degraded', async () => {
  // When E.location.blocked is set but no httpCode, it's a scope gap.
  // The command still builds a location stub from empty fallbacks — doc.location must be present.
  const m = fullModel();
  m.entities.location = { blocked: true };
  const { ctx } = makeFakeCtx({ model: m, fixture: cvFixture });
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  assert.equal(degraded, true);
  assert.ok(warnings.some(w => w.includes('blocked (missing scope)')));
  assert.ok('id' in doc.location, 'location stub must still be present');
});

test('export HONESTY: location blocked with httpCode → API-error warning + degraded', async () => {
  // httpCode present = real error, not a scope issue — the warning text must say so.
  const m = fullModel();
  m.entities.location = { blocked: true, httpCode: 403 };
  const { ctx } = makeFakeCtx({ model: m, fixture: cvFixture });
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  assert.equal(degraded, true);
  assert.ok(warnings.some(w => /API error 403.*not a scope issue/.test(w)));
});

// ── run() output paths ────────────────────────────────────────────────────────

test('run without --out: canonical JSON printed to stdout, exits OK', async () => {
  // The human / pipe path: no file arg, so the command prints the document to stdout directly.
  // json:false required so out.card() isn't suppressed by machine mode.
  const { ctx, getPrinted } = makeFakeCtx({ model: fullModel(), fixture: cvFixture, json: false });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const printed = getPrinted();
  assert.ok(printed.includes('"specVersion": 1'), 'canonical doc must reach stdout when --out is absent');
  assert.ok(printed.includes('"pipelines"'), 'all resource groups must appear');
});

test('run --out write failure → throws GhlError EXIT.API', async () => {
  // writeFileSync throws when the parent directory doesn't exist.
  // The command must re-wrap it as GhlError(EXIT.API) — raw Node errors have no .code field and
  // break the CLI's error-envelope contract.
  const { ctx } = makeFakeCtx({ model: fullModel(), fixture: cvFixture });
  await assert.rejects(
    () => run({ _: [], out: '/no/such/dir/loc.json' }, ctx),
    (e) => e.code === EXIT.API && /could not write/.test(e.message),
  );
});
