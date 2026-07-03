// test/client/diagnose.test.mjs
// Tests for probeLanes — the shared scope-lane probe used by BOTH `auth check` and `doctor`.
// Regression guard for the transport-error fake-green: a code:0 (unreachable) lane must NEVER
// report ok:true. http.get returns code:0 on a transport error (it does not throw), so the
// `ok` computation — not the catch block — is the live path that has to get this right.

import { test } from 'node:test';
import assert from 'node:assert';
import { probeLanes, buildLanes } from '../../lib/diagnose.mjs';

const LOC = 'LOC_TEST_000';

test('probeLanes: code:0 (transport error) → ok:false for EVERY lane (no fake-green offline)', async () => {
  // http.get returns {code:0} on a network failure — it never throws, so probeLanes must
  // treat code:0 as "could not verify" = not ok. This is the bug that let `auth check`
  // report "N/N readable" while genuinely offline.
  const http = { get: async () => ({ code: 0, ok: false, j: null, txt: 'ECONNREFUSED' }) };
  const lanes = await probeLanes(http, LOC);
  assert.equal(lanes.length, buildLanes(LOC).length);
  for (const l of lanes) {
    assert.equal(l.ok, false, `lane ${l.name} must be ok:false on code:0`);
    assert.equal(l.code, 0);
  }
});

test('probeLanes: 401/403 → ok:false (scope missing); 200/400/404 → ok:true (reached = present)', async () => {
  // Map each lane path to a status so we can assert the rule precisely.
  const byPath = {
    '/contacts/': 200,                 // granted
    '/conversations/search': 401,      // missing
    '/opportunities/search': 403,      // missing
    '/calendars/': 400,                // param error but REACHED → present
    '/invoices/': 404,                 // reached → present
    '/payments/transactions': 200,     // granted
  };
  const http = {
    get: async (path) => {
      const hit = Object.entries(byPath).find(([p]) => path.includes(p));
      const code = hit ? hit[1] : 200;
      return { code, ok: code >= 200 && code < 300, j: {}, txt: '{}' };
    },
  };
  const lanes = await probeLanes(http, LOC);
  const ok = Object.fromEntries(lanes.map(l => [l.name, l.ok]));
  assert.equal(ok.contacts, true);
  assert.equal(ok.conversations, false, '401 → missing');
  assert.equal(ok.opportunities, false, '403 → missing');
  assert.equal(ok.calendars, true, '400 param error → reached → present');
  assert.equal(ok.invoices, true, '404 → reached → present');
  assert.equal(ok.payments, true);
});

test('buildLanes: core + extended lanes present, scope strings verbatim, loc encoded', () => {
  const lanes = buildLanes('a/b?c');
  assert.ok(lanes.length >= 6, `expected ≥6 lanes, got ${lanes.length}`);
  // loc must be URL-encoded into the probe path (no raw &/?/ leaking into the request)
  for (const l of lanes) assert.ok(l.path.includes('a%2Fb%3Fc'), `lane ${l.name} must encode loc`);
  const scopes = lanes.map(l => l.scope);
  // core brief scopes must be present
  assert.ok(scopes.includes('payments/transactions.readonly'));
  assert.ok(scopes.includes('contacts.readonly'));
  assert.ok(scopes.includes('conversations.readonly'));
  // extended scopes must be present
  assert.ok(scopes.includes('forms.readonly'));
  assert.ok(scopes.includes('businesses.readonly'));
});
