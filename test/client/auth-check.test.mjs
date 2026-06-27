// test/client/auth-check.test.mjs
// Tests for the multi-lane `auth check` scope diagnostic.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

// Point config resolution at an empty temp dir so the machine's real saved profiles (a default
// profile) can't leak into "no creds" assertions. Returns a restore fn.
function isolateConfig() {
  const sX = process.env.XDG_CONFIG_HOME, sP = process.env.SIZMO_PROFILE;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'sz-cfg-'));
  delete process.env.SIZMO_PROFILE;
  return () => {
    if (sX !== undefined) process.env.XDG_CONFIG_HOME = sX; else delete process.env.XDG_CONFIG_HOME;
    if (sP !== undefined) process.env.SIZMO_PROFILE = sP; else delete process.env.SIZMO_PROFILE;
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function capture() {
  let out = ''; let err = '';
  const io = { write: s => { out += s; }, writeErr: s => { err += s; } };
  return { io, get out() { return out; }, get err() { return err; } };
}

// Build a fake fetch that maps URL path prefixes to HTTP status codes.
// statusMap: { '/contacts/': 200, '/conversations/search': 403, ... }
// Unmatched paths default to 200.
function makeFakeFetch(statusMap) {
  return async (url) => {
    const urlStr = url.toString();
    let status = 200;
    for (const [prefix, code] of Object.entries(statusMap)) {
      if (urlStr.includes(prefix)) { status = code; break; }
    }
    return {
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify({ contacts: [], conversations: [], meta: {} }),
    };
  };
}

// Inject fake fetch via globalThis — the http.mjs module reads globalThis.fetch as
// its default. We save/restore around each test.
function withFetch(fakeFetch, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try { return fn(); } finally { globalThis.fetch = saved; }
}

// Inject creds via env vars (simplest seam — no profiles file needed for these tests).
function withCreds(pit, loc, fn) {
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

// ── no creds guard ────────────────────────────────────────────────────────────

test('auth check: no PIT → exit AUTH (3)', async () => {
  const restore = isolateConfig();
  const savedPit = process.env.GHL_PIT;
  const savedLoc = process.env.GHL_LOCATION_ID;
  delete process.env.GHL_PIT;
  delete process.env.GHL_LOCATION_ID;
  const cap = capture();
  let code;
  try {
    code = await route(['auth', 'check'], cap.io);
  } finally {
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit;
    if (savedLoc !== undefined) process.env.GHL_LOCATION_ID = savedLoc;
    restore();
  }
  assert.equal(code, EXIT.AUTH, 'no PIT → AUTH exit');
  assert.match(cap.err, /no credentials/i);
});

test('auth check: PIT present but no location → exit AUTH (3)', async () => {
  const restore = isolateConfig();
  const savedPit = process.env.GHL_PIT;
  const savedLoc = process.env.GHL_LOCATION_ID;
  process.env.GHL_PIT = 'pit-NOLOC1234';
  delete process.env.GHL_LOCATION_ID;
  const cap = capture();
  let code;
  try {
    code = await route(['auth', 'check'], cap.io);
  } finally {
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit; else delete process.env.GHL_PIT;
    if (savedLoc !== undefined) process.env.GHL_LOCATION_ID = savedLoc;
    restore();
  }
  assert.equal(code, EXIT.AUTH, 'no location → AUTH exit');
  assert.match(cap.err, /no location/i);
});

// ── all lanes OK ──────────────────────────────────────────────────────────────

test('auth check: all 6 lanes return 200 → exit 0, all ✅', async () => {
  const cap = capture();
  const fake = makeFakeFetch({});  // everything 200
  let code;
  withCreds('pit-ALLOK123456', 'LOC_TEST_000', () => {
    return withFetch(fake, () => {
      return route(['auth', 'check'], cap.io).then(c => { code = c; });
    });
  });
  // route returns a promise — await outside
  await new Promise(r => setTimeout(r, 200)); // let microtasks settle
  // Re-run properly awaited:
  const cap2 = capture();
  let code2;
  await withCreds('pit-ALLOK123456', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check'], cap2.io).then(c => { code2 = c; })
    )
  );
  assert.equal(code2, EXIT.OK, 'all 200 → exit 0');
  // Should have 6 ✅ lines in stdout
  const checkmarks = (cap2.out.match(/✅/g) || []).length;
  assert.equal(checkmarks, 6, 'should show 6 ✅ lines');
  assert.match(cap2.out, /6\/6 lanes readable/);
});

// ── one lane blocked ──────────────────────────────────────────────────────────

test('auth check: conversations returns 403 → flagged missing, exit 0 (contacts ok)', async () => {
  const cap = capture();
  const fake = makeFakeFetch({ '/conversations/search': 403 });
  let code;
  await withCreds('pit-CONVBLK1234', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.OK, 'contacts ok → exit 0 even when conversations blocked');
  // ✖ on conversations in stderr
  assert.match(cap.err, /✖ conversations/i, 'should flag conversations missing');
  // scope name in the error line
  assert.match(cap.err, /conversations\.readonly/, 'should name the missing scope');
  // summary shows 5/6
  assert.match(cap.err, /5\/6 lanes/, 'summary should show 5/6');
});

test('auth check: payments returns 401 → flagged missing, exit 0 (contacts ok)', async () => {
  const cap = capture();
  const fake = makeFakeFetch({ '/payments/transactions': 401 });
  let code;
  await withCreds('pit-PAYBLK1234', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.OK, 'contacts ok → exit 0 even when payments blocked');
  assert.match(cap.err, /✖ payments/i, 'should flag payments missing');
  assert.match(cap.err, /payments\/transactions\.readonly/, 'should name the missing scope');
});

test('auth check: 400 param error treated as scope PRESENT (authorized)', async () => {
  const cap = capture();
  // 400 = bad params but authorized — should count as ok
  const fake = makeFakeFetch({ '/invoices/': 400 });
  let code;
  await withCreds('pit-INVBAD12345', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.OK);
  // invoices should show ✅ (400 = authorized, bad params only)
  assert.match(cap.out, /✅ invoices/, '400 should show invoices as ✅');
});

// ── contacts blocked → exit AUTH ─────────────────────────────────────────────

test('auth check: contacts returns 403 → exit AUTH (3)', async () => {
  const cap = capture();
  const fake = makeFakeFetch({ '/contacts/': 403 });
  let code;
  await withCreds('pit-CTCTBLK1234', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.AUTH, 'contacts blocked → AUTH exit (tool not usable)');
  assert.match(cap.err, /✖ contacts/i);
});

// ── multiple lanes blocked ────────────────────────────────────────────────────

test('auth check: conversations + opportunities + payments blocked → exit 0, 3 ✖ lines', async () => {
  const cap = capture();
  const fake = makeFakeFetch({
    '/conversations/search': 403,
    '/opportunities/search': 403,
    '/payments/transactions': 401,
  });
  let code;
  await withCreds('pit-MULTI123456', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.OK, 'contacts ok → exit 0 despite 3 blocked lanes');
  const xmarks = (cap.err.match(/✖/g) || []).length;
  assert.ok(xmarks >= 3, `should have ≥3 ✖ lines, got ${xmarks}`);
  assert.match(cap.err, /3\/6 lanes/i, 'summary should show 3/6');
});

// ── --json mode ───────────────────────────────────────────────────────────────

test('auth check --json: returns lanes array with per-lane ok flags', async () => {
  const cap = capture();
  const fake = makeFakeFetch({ '/conversations/search': 403 });
  let code;
  // --json is a global flag that must come AFTER the command word in argv
  // (the global-flag parser sets json=true but also re-pushes --json into rest,
  // so argv order matters: command comes before --json or flag order is irrelevant
  // only for global flags BEFORE the command — safest: put command first).
  await withCreds('pit-JSONTEST123', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check', '--json'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.OK, 'contacts ok → exit 0');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(cap.out); }, 'output must be valid JSON');
  assert.ok(Array.isArray(parsed.lanes), 'lanes must be an array');
  assert.equal(parsed.lanes.length, 6, 'must have 6 lanes');
  const conv = parsed.lanes.find(l => l.name === 'conversations');
  assert.ok(conv, 'conversations lane must be present');
  assert.equal(conv.ok, false, 'conversations should be ok:false');
  assert.equal(conv.scope, 'conversations.readonly', 'scope name must match');
  const contacts = parsed.lanes.find(l => l.name === 'contacts');
  assert.equal(contacts.ok, true, 'contacts should be ok:true');
  assert.ok(typeof parsed.summary === 'string', 'summary must be present');
  assert.equal(parsed.usable, true, 'usable must be true when contacts ok');
});

test('auth check --json: contacts blocked → usable:false + exit AUTH', async () => {
  const cap = capture();
  const fake = makeFakeFetch({ '/contacts/': 401 });
  let code;
  await withCreds('pit-JSONAUTH123', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check', '--json'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.AUTH, 'contacts blocked → AUTH exit in JSON mode');
  const parsed = JSON.parse(cap.out);
  assert.equal(parsed.usable, false);
  const contacts = parsed.lanes.find(l => l.name === 'contacts');
  assert.equal(contacts.ok, false);
});

test('auth check --json: all lanes present, summary shows 6/6', async () => {
  const cap = capture();
  const fake = makeFakeFetch({});
  let code;
  await withCreds('pit-JSONFULL123', 'LOC_TEST_000', () =>
    withFetch(fake, () =>
      route(['auth', 'check', '--json'], cap.io).then(c => { code = c; })
    )
  );
  assert.equal(code, EXIT.OK);
  const parsed = JSON.parse(cap.out);
  assert.match(parsed.summary, /6\/6/);
  assert.equal(parsed.usable, true);
  assert.ok(parsed.lanes.every(l => l.ok), 'all lanes ok');
});
