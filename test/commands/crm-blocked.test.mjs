// test/commands/crm-blocked.test.mjs — crm.mjs must distinguish a real scope block (401/403, no
// httpCode) from a non-auth API error reaching the same "blocked" state (any other non-2xx),
// same fix as sync.mjs / list.mjs. Covers: overview (JSON envelope + human display), the
// per-entity subcommand, and the location subcommand.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../commands/crm.mjs';
import { makeOut } from '../../lib/output.mjs';
import { SCHEMA_VERSION } from '../../lib/model.mjs';

const TMP_DIRS = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'sizmo-crm-')); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const LOC = 'L-TEST';
const NOW = Date.now();

function writeModel(entities) {
  const dir = tmpDir();
  writeFileSync(join(dir, `${LOC}.json`), JSON.stringify({
    schemaVersion: SCHEMA_VERSION, locationId: LOC, syncedAt: NOW, entities,
  }));
  return dir;
}

function makeCtx(dir, { json = false } = {}) {
  let printed = '';
  // crm.mjs reports blocked entities via ctx.out.warn() (stderr channel) — capture both
  // channels into the same buffer so the test sees exactly what a real terminal user would.
  const out = makeOut({ json, tty: !json, command: 'crm', location: LOC, write: s => printed += s, writeErr: s => printed += s });
  return { ctx: { out, cfg: { loc: LOC }, now: NOW, _modelDir: dir }, getPrinted: () => printed };
}

// crm.mjs only covers the original 6 core entities (pipelines/calendars/tags/fields/users/
// location) — the 6 extended ones (forms/surveys/products/links/businesses/objects) are
// `sizmo list`'s job, not crm.mjs's. Use `tags` here, not `links`.
test('crm <entity>: real scope block (401/403, no httpCode) → "needs <scope>"', async () => {
  const dir = writeModel({ tags: { blocked: true, scope: 'locations/tags.readonly', fetchedAt: NOW } });
  const { ctx, getPrinted } = makeCtx(dir);
  await run({ _: ['tags'] }, ctx);
  assert.match(getPrinted(), /needs locations\/tags\.readonly/);
});

test('crm <entity>: non-auth API error (httpCode) → reports the real error, not "needs <scope>"', async () => {
  const dir = writeModel({ tags: { blocked: true, scope: 'locations/tags.readonly', httpCode: 422, fetchedAt: NOW } });
  const { ctx, getPrinted } = makeCtx(dir);
  await run({ _: ['tags'] }, ctx);
  const out = getPrinted();
  assert.match(out, /API error 422/);
  assert.doesNotMatch(out, /needs locations\/tags\.readonly/);
});

test('crm overview (human): a non-auth API error on one entity shows the real error, not "needs <scope>"', async () => {
  const dir = writeModel({ links: { blocked: true, scope: 'links.readonly', httpCode: 422, fetchedAt: NOW } });
  const { ctx, getPrinted } = makeCtx(dir);
  await run({ _: [] }, ctx);
  const out = getPrinted();
  assert.match(out, /links\s+✖ API error 422/);
  assert.doesNotMatch(out, /links\s+✖ needs/);
});

test('crm overview --json: surfaces linksHttpCode distinct from a real scope block', async () => {
  const dir = writeModel({ links: { blocked: true, scope: 'links.readonly', httpCode: 422, fetchedAt: NOW } });
  const { ctx, getPrinted } = makeCtx(dir, { json: true });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.linksBlocked, true);
  assert.equal(envelope.data.linksHttpCode, 422);
});

test('crm location: non-auth API error on the location entity → real error, not "needs <scope>"', async () => {
  const dir = writeModel({ location: { blocked: true, scope: 'locations.readonly', httpCode: 500, fetchedAt: NOW } });
  const { ctx, getPrinted } = makeCtx(dir);
  await run({ _: ['location'] }, ctx);
  const out = getPrinted();
  assert.match(out, /API error 500/);
  assert.doesNotMatch(out, /needs locations\.readonly/);
});
