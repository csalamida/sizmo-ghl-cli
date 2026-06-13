import { test } from 'node:test';
import assert from 'node:assert';
import { resolveCreds } from '../../lib/config.mjs';

test('env wins over profile', () => {
  const r = resolveCreds(
    { GHL_PIT:'pit-env', GHL_LOCATION_ID:'L-env' },
    { pit:'pit-prof', locationId:'L-prof', tz:'Asia/Manila' });
  assert.equal(r.pit, 'pit-env'); assert.equal(r.loc, 'L-env'); assert.equal(r.source, 'env GHL_PIT');
});

test('no creds anywhere → loc null (NO baked default)', () => {
  const r = resolveCreds({}, null);
  assert.equal(r.pit, null); assert.equal(r.loc, null);
});

test('profile used when no env', () => {
  const r = resolveCreds({}, { pit:'pit-p', locationId:'L-p' });
  assert.equal(r.pit, 'pit-p'); assert.equal(r.loc, 'L-p'); assert.equal(r.source, 'profile');
});
