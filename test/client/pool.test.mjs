import { test } from 'node:test'; import assert from 'node:assert';
import { mapLimit } from '../../lib/pool.mjs';

test('runs all, caps concurrency, preserves order', async () => {
  let active=0, peak=0;
  const fn = async (x) => { active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,5)); active--; return x*2; };
  const out = await mapLimit([1,2,3,4,5,6,7,8], 3, fn);
  assert.deepEqual(out, [2,4,6,8,10,12,14,16]); // order preserved
  assert.ok(peak<=3, `peak ${peak} must be ≤3`);
});

test('a rejecting item rejects the whole call (or is catchable)', async () => {
  await assert.rejects(() => mapLimit([1,2], 2, async x => { if(x===2) throw new Error('boom'); return x; }));
});
