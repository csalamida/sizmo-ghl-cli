// test/commands/list-blocked.test.mjs — blockedExit must distinguish a real scope block
// (401/403, no httpCode) from a non-auth API error reaching the same "blocked" state
// (any other non-2xx — a bad request sizmo itself sent, a 404, a 5xx). Conflating them tells a
// user with the scope already granted to go grant a scope they already have, when the real
// problem is a bug in sizmo's own request. Caught live: the `links` entity 422'd on a `limit`
// param GHL doesn't accept, and was reported as "needs links.readonly" even with that scope on.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/list.mjs';
import { makeOut } from '../../lib/output.mjs';
import { EXIT } from '../../lib/errors.mjs';

function makeCtx(entities) {
  let printed = '';
  const out = makeOut({ json: false, tty: false, command: 'list', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const model = { entities };
  const ctx = { out, cfg: { loc: 'L-TEST' }, ensureModel: async () => model };
  return { ctx, getPrinted: () => printed };
}

test('list links: real scope block (401/403, no httpCode) → "needs <scope>", exit AUTH', async () => {
  const { ctx, getPrinted } = makeCtx({ links: { blocked: true, scope: 'links.readonly' } });
  const code = await run({ _: ['links'] }, ctx);
  assert.equal(code, EXIT.AUTH);
  assert.match(getPrinted(), /needs links\.readonly/);
});

test('list links: non-auth API error (httpCode present) → reports the real error, NOT "needs <scope>", exit API', async () => {
  const { ctx, getPrinted } = makeCtx({ links: { blocked: true, scope: 'links.readonly', httpCode: 422 } });
  const code = await run({ _: ['links'] }, ctx);
  assert.equal(code, EXIT.API, 'must NOT be EXIT.AUTH — this is not a permissions problem');
  const out = getPrinted();
  assert.match(out, /API error 422/);
  assert.doesNotMatch(out, /needs links\.readonly/, 'must not claim the scope is missing when the scope was actually reached');
});

test('list businesses: same distinction holds for a different entity (not links-specific)', async () => {
  const blocked = makeCtx({ businesses: { blocked: true, scope: 'businesses.readonly', httpCode: 500 } });
  const code = await run({ _: ['businesses'] }, blocked.ctx);
  assert.equal(code, EXIT.API);
  assert.match(blocked.getPrinted(), /API error 500/);
});

// Caught live 2026-07-05: the overview's row() reused ✖ (the exact glyph a real scope block
// renders as) for Custom Values simply because it has no precomputed count — it's fetched live
// on demand, never cached, so it was never "blocked" at all. Same conflation bug as above, just
// inside the overview renderer instead of blockedExit().
test('list overview: Custom Values shows a live-fetch marker, never the blocked ✖ — it is fetched live by design, not blocked', async () => {
  const { ctx, getPrinted } = makeCtx({
    pipelines: { items: [] }, calendars: { items: [] }, tags: { items: [] },
    customFields: { items: [] }, users: { items: [] }, forms: { items: [] },
    surveys: { items: [] }, products: { items: [] }, links: { items: [] },
    businesses: { items: [] }, objects: { items: [] },
  });
  const code = await run({ _: [] }, ctx);
  assert.equal(code, EXIT.OK);
  const out = getPrinted();
  assert.match(out, /Custom Values\s+·\s+sizmo list values/);
  assert.doesNotMatch(out, /Custom Values\s+✖/, 'must not render as blocked — it is not');
});
