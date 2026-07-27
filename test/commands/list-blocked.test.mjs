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

test('list links: real scope block (401/403, no httpCode) → throws AUTH naming the scope', async () => {
  // Contract changed 2026-07-27: blockedExit throws GhlError rather than printing and returning,
  // so --json gets {error, code, remediation} instead of a success-shaped envelope. The scope is
  // asserted on the error message and its remediation, not on printed output.
  const { ctx } = makeCtx({ links: { blocked: true, scope: 'links.readonly' } });
  await assert.rejects(() => run({ _: ['links'] }, ctx),
    (e) => e.code === EXIT.AUTH
        && e.message.includes('links.readonly')
        && String(e.remediation).includes('links.readonly'));
});

test('list links: non-auth API error (httpCode present) → throws API, never blames the scope', async () => {
  const { ctx } = makeCtx({ links: { blocked: true, scope: 'links.readonly', httpCode: 422 } });
  await assert.rejects(() => run({ _: ['links'] }, ctx),
    (e) => e.code === EXIT.API
        && e.message.includes('API error 422')
        && !e.message.includes('lacks links.readonly'));
});

test('list businesses: same distinction holds for a different entity (not links-specific)', async () => {
  const { ctx } = makeCtx({ businesses: { blocked: true, scope: 'businesses.readonly', httpCode: 500 } });
  await assert.rejects(() => run({ _: ['businesses'] }, ctx),
    (e) => e.code === EXIT.API && e.message.includes('API error 500'));
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
