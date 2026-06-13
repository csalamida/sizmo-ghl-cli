import { test } from 'node:test'; import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { makeCache } from '../../lib/cache.mjs';

test('set then get within TTL returns value + age; expired returns null', () => {
  const dir = mkdtempSync(join(tmpdir(),'c-')); let t=1000;
  const c = makeCache({ dir, ttlMs:60000, now:()=>t });
  c.set('k', { n:1 });
  let hit = c.get('k'); assert.equal(hit.value.n, 1); assert.equal(hit.ageMs, 0);
  t = 1000+30000; hit = c.get('k'); assert.equal(hit.value.n, 1); assert.equal(hit.ageMs, 30000); // fresh
  t = 1000+61000; assert.equal(c.get('k'), null); // expired
  rmSync(dir,{recursive:true});
});

test('missing/corrupt key → null, no throw', () => {
  const c = makeCache({ dir: join(tmpdir(),'nope-'+Math.random()), ttlMs:1, now:()=>1 });
  assert.equal(c.get('x'), null);
});
