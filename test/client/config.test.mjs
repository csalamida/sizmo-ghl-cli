import { test } from 'node:test';
import assert from 'node:assert';
import { resolveCreds, pickProfileName } from '../../lib/config.mjs';

test('pickProfileName: flag > SIZMO_PROFILE env > default', () => {
  const db = { default: 'def', profiles: {} };
  // explicit flag wins over everything
  assert.equal(pickProfileName('flagp', { SIZMO_PROFILE: 'envp' }, db), 'flagp');
  // no flag → SIZMO_PROFILE env beats the saved default
  assert.equal(pickProfileName(null, { SIZMO_PROFILE: 'envp' }, db), 'envp');
  // no flag, no env → saved default
  assert.equal(pickProfileName(null, {}, db), 'def');
  // nothing anywhere → null (no baked default)
  assert.equal(pickProfileName(null, {}, { default: null }), null);
  assert.equal(pickProfileName(null, {}, undefined), null);
});

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
