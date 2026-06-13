import { test } from 'node:test';
import assert from 'node:assert';
import { buildCtx } from '../../lib/context.mjs';
import { EXIT } from '../../lib/errors.mjs';

test('throws AUTH when no creds resolved', () => {
  assert.throws(() => buildCtx({ creds:{ pit:null, loc:null }, globals:{} }),
    e => e.code === EXIT.AUTH);
});
test('assembles ctx with http, cfg, out, now', () => {
  const ctx = buildCtx({ creds:{ pit:'pit-x', loc:'L', tz:'Asia/Manila', currency:null, source:'profile' },
    globals:{ json:true, tty:false, command:'snapshot' }, now: 1000 });
  assert.equal(ctx.now, 1000); assert.equal(ctx.cfg.loc, 'L');
  assert.equal(typeof ctx.http.get, 'function'); assert.equal(typeof ctx.out.data, 'function');
});
