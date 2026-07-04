// test/commands/sync-blocked.test.mjs — sync's human display + --json envelope must distinguish
// a real scope block (401/403) from a non-auth API error reaching the same "blocked" state (any
// other non-2xx). Conflating them tells a user with the scope already granted to go grant a scope
// they already have. Caught live: `links` 422'd on a bad `limit` param and was reported as
// "needs links.readonly" even with that scope on — a sizmo bug, not a permissions gap.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../commands/sync.mjs';
import { makeOut } from '../../lib/output.mjs';

const TMP_DIRS = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'sizmo-sync-')); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

// Every entity 200s except links, which 422s (mirrors the real bad-`limit`-param bug) —
// exercises syncModel's real classification + sync.mjs's real display together.
function makeCtx({ json = false } = {}) {
  let printed = '';
  const http = {
    get: async (path) => {
      if (path.includes('/links/')) return { code: 422, ok: false, j: { message: ['property limit should not exist'] }, txt: '' };
      return { code: 200, ok: true, j: {} };
    },
  };
  const out = makeOut({ json, tty: !json, command: 'sync', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const ctx = { http, out, cfg: { loc: 'L-TEST' }, now: Date.now(), _modelDir: tmpDir() };
  return { ctx, getPrinted: () => printed };
}

test('sync (human): a non-auth API error (422) on one entity shows the real error, not "needs <scope>"', async () => {
  const { ctx, getPrinted } = makeCtx();
  await run({ _: [] }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.match(out, /links\s+API error 422/);
  assert.doesNotMatch(out, /links\s+needs/, 'must not claim links.readonly is missing — the request reached real logic (422), it just sent a bad param');
});

test('sync --json: the envelope surfaces httpCode for a non-auth-blocked entity, not just scope', async () => {
  const { ctx, getPrinted } = makeCtx({ json: true });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  const linksEnt = envelope.data.entities.links;
  assert.equal(linksEnt.blocked, true);
  assert.equal(linksEnt.httpCode, 422, 'an agent piping --json must be able to tell this apart from a real scope block');
});
