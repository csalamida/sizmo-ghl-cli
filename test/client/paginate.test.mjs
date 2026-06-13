import { test } from 'node:test';
import assert from 'node:assert';
import { paginate } from '../../lib/paginate.mjs';

test('paginates page-number style to completion', async () => {
  const pages = { 1:{items:[1,2]}, 2:{items:[3,4]}, 3:{items:[]} };
  const out = [];
  for await (const x of paginate({
    fetchPage: async (p=1) => pages[p],
    getItems: r => r.items,
    nextCursor: (r, items, p=1) => items.length ? p+1 : null,
  })) out.push(x);
  assert.deepEqual(out, [1,2,3,4]);
});

test('stops at maxPages backstop', async () => {
  let n = 0;
  const out = [];
  for await (const x of paginate({
    fetchPage: async () => ({ items:[++n] }),
    getItems: r => r.items,
    nextCursor: () => 'more',
    maxPages: 3,
  })) out.push(x);
  assert.equal(out.length, 3);
});
