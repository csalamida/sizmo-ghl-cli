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
import { EXIT } from '../../lib/errors.mjs';
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
// CONTRACT CHANGE 2026-07-27: crm's blocked paths now THROW GhlError instead of printing a line
// and returning 1, matching commands/list.mjs and commands/surveys.mjs. Two reasons:
//   · a scope denial exited 1 (API — "the server broke, retry") instead of 3 (AUTH — "your token
//     lacks a scope"), so an agent branching on the exit code could not tell them apart and would
//     retry a missing scope forever;
//   · returning skips the CLI's error handler, so --json emitted a success-shaped envelope on
//     stdout with no error field.
// The message therefore moves from printed output into the thrown error. These assertions follow
// it; the distinction they were written to protect (scope block vs real API error) is unchanged
// and still asserted.
test('crm <entity>: real scope block (401/403, no httpCode) → throws AUTH naming the scope', async () => {
  const dir = writeModel({ tags: { blocked: true, scope: 'locations/tags.readonly', fetchedAt: NOW } });
  const { ctx } = makeCtx(dir);
  await assert.rejects(() => run({ _: ['tags'] }, ctx),
    (e) => e.code === EXIT.AUTH
        && /locations\/tags\.readonly/.test(e.message)
        && /Private Integrations/.test(e.remediation ?? ''));
});

test('crm <entity>: non-auth API error (httpCode) → throws API, and does NOT blame the scope', async () => {
  const dir = writeModel({ tags: { blocked: true, scope: 'locations/tags.readonly', httpCode: 422, fetchedAt: NOW } });
  const { ctx } = makeCtx(dir);
  await assert.rejects(() => run({ _: ['tags'] }, ctx),
    (e) => e.code === EXIT.API
        && /API error 422/.test(e.message)
        && !/lacks locations\/tags\.readonly/.test(e.message));
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

test('crm location: non-auth API error → throws API, and does NOT blame the scope', async () => {
  const dir = writeModel({ location: { blocked: true, scope: 'locations.readonly', httpCode: 500, fetchedAt: NOW } });
  const { ctx } = makeCtx(dir);
  await assert.rejects(() => run({ _: ['location'] }, ctx),
    (e) => e.code === EXIT.API
        && /API error 500/.test(e.message)
        && !/lacks locations\.readonly/.test(e.message));
});

test('crm location: a scope denial throws AUTH, not API', async () => {
  const dir = writeModel({ location: { blocked: true, scope: 'locations.readonly', fetchedAt: NOW } });
  const { ctx } = makeCtx(dir);
  await assert.rejects(() => run({ _: ['location'] }, ctx),
    (e) => e.code === EXIT.AUTH && /locations\.readonly/.test(e.message));
});
