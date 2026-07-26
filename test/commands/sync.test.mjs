// test/commands/sync.test.mjs
// sync had zero test coverage. It is the only command that writes to local disk, and every
// model-backed command's correctness depends on the blob it produces — so the counting logic
// matters: miscounting a network error as "blocked" tells the user to fix a scope when their
// wifi dropped, and miscounting either as "synced" reports a healthy cache that isn't.
//
// Writes go to an injected temp dir via ctx._modelDir — never the real ~/.config/sizmo/model.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../commands/sync.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const LOC = 'L-TEST';

// Every ENTITY_SPECS path, all healthy. Individual tests override entries to induce failures.
const okFixture = () => ({
  [`GET /opportunities/pipelines?locationId=${LOC}`]:      { status: 200, j: { pipelines: [{ id: 'p1', name: 'Sales' }] } },
  [`GET /calendars/?locationId=${LOC}`]:                   { status: 200, j: { calendars: [] } },
  [`GET /locations/${LOC}/tags`]:                          { status: 200, j: { tags: [] } },
  [`GET /locations/${LOC}/customFields?model=all`]:        { status: 200, j: { customFields: [] } },
  [`GET /users/?locationId=${LOC}`]:                       { status: 200, j: { users: [] } },
  [`GET /locations/${LOC}`]:                               { status: 200, j: { location: { id: LOC } } },
  [`GET /forms/?locationId=${LOC}&limit=100`]:             { status: 200, j: { forms: [] } },
  [`GET /surveys/?locationId=${LOC}&limit=50`]:            { status: 200, j: { surveys: [] } },
  [`GET /products/?locationId=${LOC}&limit=100`]:          { status: 200, j: { products: [] } },
  [`GET /links/?locationId=${LOC}`]:                       { status: 200, j: { links: [] } },
  [`GET /businesses/?locationId=${LOC}&limit=100`]:        { status: 200, j: { businesses: [] } },
  [`GET /objects/?locationId=${LOC}`]:                     { status: 200, j: { objects: [] } },
});

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sizmo-sync-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── argument validation (no network) ──────────────────────────────────────────

test('sync: unknown entity → exit 1, no request fired', async () => {
  await withTmpDir(async (dir) => {
    const { ctx, getCalledPaths } = makeFakeCtx({});
    ctx._modelDir = dir;
    const code = await run({ _: ['frobnicate'] }, ctx);
    ctx.out.flush();
    assert.equal(code, 1);
    assert.equal(getCalledPaths().length, 0, 'must reject before touching the network');
  });
});

test('sync: "fields" is accepted as an alias for customFields', async () => {
  // Users type `sizmo sync fields` because `sizmo list fields` exists. Without the alias this
  // errors on a name the rest of the CLI actively teaches.
  await withTmpDir(async (dir) => {
    const { ctx, getCalledPaths } = makeFakeCtx({ fixture: okFixture() });
    ctx._modelDir = dir;
    const code = await run({ _: ['fields'] }, ctx);
    ctx.out.flush();
    assert.equal(code, 0);
    assert.deepEqual(getCalledPaths(), [`GET /locations/${LOC}/customFields?model=all`],
      'alias must resolve to the customFields endpoint and sync ONLY that one');
  });
});

test('sync <entity>: syncs only the named entity, not all 12', async () => {
  await withTmpDir(async (dir) => {
    const { ctx, getCalledPaths } = makeFakeCtx({ fixture: okFixture() });
    ctx._modelDir = dir;
    await run({ _: ['tags'] }, ctx);
    ctx.out.flush();
    assert.deepEqual(getCalledPaths(), [`GET /locations/${LOC}/tags`]);
  });
});

// ── full sync + counting ──────────────────────────────────────────────────────

test('sync: all healthy → every entity counted as synced, zero blocked', async () => {
  await withTmpDir(async (dir) => {
    const { ctx, getPrinted } = makeFakeCtx({ fixture: okFixture() });
    ctx._modelDir = dir;
    await run({ _: [] }, ctx);
    ctx.out.flush();
    const d = JSON.parse(getPrinted()).data;
    assert.equal(d.synced, 12);
    assert.equal(d.blocked, 0);
    assert.equal(d.locationId, LOC);
    assert.ok(d.syncedAt, 'must stamp syncedAt so staleness checks work');
  });
});

test('sync: a 401 entity counts as blocked, not synced', async () => {
  await withTmpDir(async (dir) => {
    const fixture = okFixture();
    fixture[`GET /locations/${LOC}/tags`] = { status: 401, j: {} };
    const { ctx, getPrinted } = makeFakeCtx({ fixture });
    ctx._modelDir = dir;
    await run({ _: [] }, ctx);
    ctx.out.flush();
    const d = JSON.parse(getPrinted()).data;
    assert.equal(d.blocked, 1);
    assert.equal(d.synced, 11);
    assert.equal(d.entities.tags.blocked, true);
  });
});

test('sync: a 500 entity reports httpCode so agents do not blame the scope', async () => {
  // The recurring bug class in this repo: blocked-for-scope and blocked-by-server-error look
  // identical in the model. --json consumers need httpCode to tell them apart.
  await withTmpDir(async (dir) => {
    const fixture = okFixture();
    fixture[`GET /locations/${LOC}/tags`] = { status: 500, j: {} };
    const { ctx, getPrinted } = makeFakeCtx({ fixture });
    ctx._modelDir = dir;
    await run({ _: [] }, ctx);
    ctx.out.flush();
    const tags = JSON.parse(getPrinted()).data.entities.tags;
    assert.equal(tags.blocked, true);
    assert.equal(tags.httpCode, 500, 'a 500 must carry its status, not masquerade as a scope gap');
  });
});

test('sync: healthy entities report a count and fetchedAt', async () => {
  await withTmpDir(async (dir) => {
    const { ctx, getPrinted } = makeFakeCtx({ fixture: okFixture() });
    ctx._modelDir = dir;
    await run({ _: [] }, ctx);
    ctx.out.flush();
    const pipelines = JSON.parse(getPrinted()).data.entities.pipelines;
    assert.equal(pipelines.count, 1);
    assert.ok(pipelines.fetchedAt);
    assert.equal(pipelines.blocked, undefined);
  });
});

test('sync: singleton entity (location) counts as 1, not 0', async () => {
  // location returns { item } rather than { items } — a naive items.length would report 0
  // and make a perfectly synced location look empty.
  await withTmpDir(async (dir) => {
    const { ctx, getPrinted } = makeFakeCtx({ fixture: okFixture() });
    ctx._modelDir = dir;
    await run({ _: [] }, ctx);
    ctx.out.flush();
    assert.equal(JSON.parse(getPrinted()).data.entities.location.count, 1);
  });
});

test('sync: model blob is actually written to disk and re-readable', async () => {
  await withTmpDir(async (dir) => {
    const { ctx } = makeFakeCtx({ fixture: okFixture() });
    ctx._modelDir = dir;
    await run({ _: [] }, ctx);
    ctx.out.flush();
    const { loadModel } = await import('../../lib/model.mjs');
    const model = loadModel(LOC, dir); // (loc, dir) positional — the blob is keyed per location
    assert.ok(model, 'sync must leave a loadable model behind — otherwise every cached read fails');
    assert.equal(model.entities.pipelines.items.length, 1);
  });
});
