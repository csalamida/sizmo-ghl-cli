import { test } from 'node:test';
import assert from 'node:assert';
import { buildSchema } from '../../lib/schema.mjs';

test('buildSchema emits command tree from metas', async () => {
  const fakeRegistry = { snapshot: async () => ({ meta:{ name:'snapshot', summary:'card', flags:[{name:'--days',type:'int'}], readOnly:true } }) };
  const s = await buildSchema(fakeRegistry, { OK:0, API:1, USAGE:2, AUTH:3, CONFIRM:4, NOTFOUND:5 });
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.commands[0].name, 'snapshot');
  assert.deepEqual(s.exitCodes, { OK:0, API:1, USAGE:2, AUTH:3, CONFIRM:4, NOTFOUND:5 });
});
