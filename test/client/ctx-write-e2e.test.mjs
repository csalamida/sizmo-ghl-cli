// test/client/ctx-write-e2e.test.mjs
//
// REAL end-to-end write test — guards against the C1 class of bug where
// makeFakeCtx's http shape differs from production buildCtx's http shape,
// causing all write tests to be fake-green while writes are DOA in production.
//
// Pattern: drive route() through the REAL buildCtx with globalThis.fetch stubbed
// (same seam as cli.test.mjs / auth-check.test.mjs). No makeFakeCtx involved.
//
// This test MUST:
//   - FAIL if context.mjs does NOT forward post/put/delete onto ctx.http
//   - PASS after the fix wires them through
//
// Money stays OUT: only tag POST is exercised. No invoice/payment endpoint touched.

import { test } from 'node:test';
import assert from 'node:assert';
import { route } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

const CONTACT_ID = 'cid-e2e-001';
const TAG        = 'VIP';
const PIT        = 'pit-E2EWRITETEST001';
const LOC        = 'LOC_E2E_000';

// ── helpers (same pattern as auth-check.test.mjs) ────────────────────────────

function withEnv(pit, loc, fn) {
  const savedPit = process.env.GHL_PIT;
  const savedLoc = process.env.GHL_LOCATION_ID;
  process.env.GHL_PIT = pit;
  process.env.GHL_LOCATION_ID = loc;
  try { return fn(); }
  finally {
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit; else delete process.env.GHL_PIT;
    if (savedLoc !== undefined) process.env.GHL_LOCATION_ID = savedLoc; else delete process.env.GHL_LOCATION_ID;
  }
}

function withFetch(fakeFetch, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try { return fn(); } finally { globalThis.fetch = saved; }
}

// ── the guard test ────────────────────────────────────────────────────────────

test('e2e real-ctx write: tag add --confirm POSTs to contacts/tags endpoint and exits 0', async () => {
  // Track every fetch call made by the real http layer
  const fetchCalls = [];

  const fakeFetch = async (url, opts) => {
    fetchCalls.push({ url: url.toString(), method: opts?.method ?? 'GET' });
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ tags: [TAG] }),
    };
  };

  let code;

  await withEnv(PIT, LOC, () =>
    withFetch(fakeFetch, () =>
      route(
        ['tag', CONTACT_ID, '--add', TAG, '--confirm', '--json'],
        { write: () => {}, writeErr: () => {} },
      ).then(c => { code = c; })
    )
  );

  // 1. Correct exit code
  assert.equal(code, EXIT.OK, `expected exit 0 (OK), got ${code} — ctx.http.post not wired through buildCtx`);

  // 2. fetch was called at least once with POST (proves the write actually fired through real ctx)
  const postCalls = fetchCalls.filter(c => c.method === 'POST');
  assert.ok(
    postCalls.length >= 1,
    `expected at least one POST fetch call, got ${fetchCalls.length} calls: ${JSON.stringify(fetchCalls.map(c => c.method + ' ' + c.url))}`
  );

  // 3. The POST targeted the correct contacts/tags path
  const tagsCall = postCalls.find(c => c.url.includes(`/contacts/${CONTACT_ID}/tags`));
  assert.ok(
    tagsCall != null,
    `POST was not sent to /contacts/${CONTACT_ID}/tags — calls were: ${JSON.stringify(postCalls.map(c => c.url))}`
  );
});

// ── no-confirm still blocks (proves confirm gate works with real ctx too) ─────
// Note: ctx.out.flush() writes to process.stdout (not io.write) — this is by design
// in buildCtx (makeOut has no write seam at the route level). We assert what we CAN
// verify through this seam: exit code and zero POST calls.

test('e2e real-ctx write: tag add without --confirm exits CONFIRM (5) and does NOT POST', async () => {
  const fetchCalls = [];

  const fakeFetch = async (url, opts) => {
    fetchCalls.push({ url: url.toString(), method: opts?.method ?? 'GET' });
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ tags: [] }),
    };
  };

  let code;

  await withEnv(PIT, LOC, () =>
    withFetch(fakeFetch, () =>
      route(
        ['tag', CONTACT_ID, '--add', TAG, '--json'],
        { write: () => {}, writeErr: () => {} },
      ).then(c => { code = c; })
    )
  );

  // Exit CONFIRM (5) — gate blocked the write
  assert.equal(code, EXIT.CONFIRM, `expected exit ${EXIT.CONFIRM} (CONFIRM) without --confirm, got ${code}`);

  // No POST must have fired — the write was gated before reaching ctx.http.post
  const postCalls = fetchCalls.filter(c => c.method === 'POST');
  assert.equal(postCalls.length, 0, `no POST should fire without --confirm — got: ${JSON.stringify(postCalls)}`);
});
