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
