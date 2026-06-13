import { test } from 'node:test';
import assert from 'node:assert';
import { GhlError, EXIT } from '../../lib/errors.mjs';

test('EXIT codes are the documented set', () => {
  assert.deepEqual(EXIT, { OK:0, API:1, USAGE:2, AUTH:3, NOTFOUND:4 });
});
test('GhlError carries code + remediation', () => {
  const e = new GhlError('no PIT', EXIT.AUTH, 'ghl config set --profile x --pit-stdin');
  assert.equal(e.code, 3);
  assert.equal(e.remediation, 'ghl config set --profile x --pit-stdin');
  assert.equal(e.message, 'no PIT');
});
