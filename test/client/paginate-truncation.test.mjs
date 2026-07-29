// test/client/paginate-truncation.test.mjs
//
// paginate() had exactly one way to finish — `return` — so a caller could not distinguish:
//   · the server ran out of data                        (COMPLETE)
//   · maxPages was reached with more still available     (TRUNCATED)
//
// Verified 2026-07-28 against a server with unlimited pages and maxPages: 20:
//     yielded 2000 items, caller told: nothing
//
// commands/pipeline.mjs and snapshot's pipelineValue both cap at 20 pages of 100, so an account
// with 2,500 open deals reported the value of 2,000 of them AS THE WHOLE PIPELINE — a 20%
// understatement of a money figure with nothing in the output to hint at it.
import { test } from 'node:test';
import assert from 'node:assert';
import { paginate } from '../../lib/paginate.mjs';

const endlessServer = () => ({
  fetchPage: async (p = 1) => ({ page: p, items: Array.from({ length: 100 }, (_, i) => ({ id: `${p}-${i}` })) }),
  getItems: (r) => r.items,
  nextCursor: (r, items, p = 1) => (items.length < 100 ? null : p + 1),
});

const finiteServer = (totalPages) => ({
  fetchPage: async (p = 1) => ({ page: p, items: Array.from({ length: p < totalPages ? 100 : 7 }, (_, i) => ({ id: `${p}-${i}` })) }),
  getItems: (r) => r.items,
  nextCursor: (r, items, p = 1) => (items.length < 100 ? null : p + 1),
});

const drain = async (opts) => { let n = 0; for await (const _ of paginate(opts)) n++; return n; };

test('hitting maxPages sets truncated:true — the caller can tell it got a floor', async () => {
  const stats = {};
  const n = await drain({ ...endlessServer(), maxPages: 20, startCursor: 1, stats });
  assert.equal(n, 2000);
  assert.equal(stats.truncated, true,
    'the cap stopped the scan while more data existed — that is not a complete result');
  assert.equal(stats.pages, 20);
});

test('running out of data leaves truncated:false — a complete result is not flagged', async () => {
  // The inverse guard. If this were wrong, every small account would be warned about truncation
  // that never happened, and the warning would stop meaning anything.
  const stats = {};
  const n = await drain({ ...finiteServer(3), maxPages: 20, startCursor: 1, stats });
  assert.equal(n, 207, '2 full pages + a short final page');
  assert.equal(stats.truncated, false, 'a null cursor is the honest end of the data');
  assert.equal(stats.pages, 3);
});

test('a result that exactly fills the last allowed page but has no more is NOT truncated', async () => {
  // The boundary that is easy to get wrong: pages === maxPages AND the data genuinely ended.
  const stats = {};
  await drain({ ...finiteServer(20), maxPages: 20, startCursor: 1, stats });
  assert.equal(stats.pages, 20);
  assert.equal(stats.truncated, false,
    'reaching the cap is only a truncation when a live cursor remained');
});

test('stats is optional — callers that do not pass it still work', async () => {
  const n = await drain({ ...finiteServer(2), maxPages: 20, startCursor: 1 });
  assert.equal(n, 107);
});

test('pipeline surfaces truncation as degraded + a warning, and carries it in the payload', async () => {
  const { run } = await import('../../commands/pipeline.mjs');
  const { makeFakeCtx } = await import('../_helpers.mjs');
  const { ctx, getPrinted } = makeFakeCtx({
    json: true,
    model: { entities: { pipelines: { items: [{ id: 'p1', name: 'Sales', stages: [{ id: 's1', name: 'New', position: 0 }] }] } } },
  });
  // A server that never runs out of opportunities.
  ctx.http.get = async (path) => {
    if (path.includes('/opportunities/search')) {
      return { code: 200, ok: true, txt: '{}', j: {
        opportunities: Array.from({ length: 100 }, (_, i) => ({
          id: `o${i}`, pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 10, status: 'open',
        })),
      } };
    }
    return { code: 200, ok: true, j: { pipelines: [] }, txt: '{}' };
  };
  await run({ _: [] }, ctx);
  ctx.out.flush();
  const env = JSON.parse(getPrinted());
  assert.equal(env.data.truncated, true, 'the payload must admit the scan was capped');
  assert.equal(env.degraded, true, 'a floor presented as a total is a degraded answer');
  assert.ok(env.warnings.some(w => /truncat/i.test(w)),
    `expected a truncation warning, got: ${JSON.stringify(env.warnings)}`);
  assert.ok(env.data.totalValue > 0, 'the partial data returned is still real and still reported');
});
