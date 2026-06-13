import { test } from 'node:test';
import assert from 'node:assert';
import { route, parseArgs } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

test('version returns 0', async () => {
  let out=''; const code = await route(['version'], { write:s=>out+=s });
  assert.equal(code, 0); assert.match(out, /\d+\.\d+\.\d+/);
});
test('unknown command → exit 2', async () => {
  let err=''; const code = await route(['bogus'], { writeErr:s=>err+=s });
  assert.equal(code, 2);
});

test('parseArgs throws USAGE when value flag has no following arg', () => {
  assert.throws(
    () => parseArgs(['--days'], { flags: [{ name: '--days', type: 'int' }] }),
    e => e.code === EXIT.USAGE
  );
});

// ── api verb ─────────────────────────────────────────────────────────────────

test('api: missing path → exit 2 (usage)', async () => {
  let err = '';
  const code = await route(['api'], { writeErr: s => err += s });
  assert.equal(code, EXIT.USAGE, 'no path → USAGE');
  assert.match(err, /usage:.*api/i);
});

test('api: path not starting with / → exit 2 (usage)', async () => {
  let err = '';
  const code = await route(['api', 'contacts'], { writeErr: s => err += s });
  assert.equal(code, EXIT.USAGE, 'path without leading / → USAGE');
});

test('api: 401 response → exit 3 (AUTH) with scope message', async () => {
  const savedPit = process.env.GHL_PIT;
  const savedLoc = process.env.GHL_LOCATION_ID;
  const savedFetch = globalThis.fetch;
  process.env.GHL_PIT = 'pit-AUTHFAIL001';
  delete process.env.GHL_LOCATION_ID;

  globalThis.fetch = async () => ({
    status: 401,
    headers: new Map(),
    text: async () => '{"message":"Unauthorized"}',
  });

  let err = '';
  let code;
  try {
    code = await route(['api', '/contacts/'], { write: () => {}, writeErr: s => err += s });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit; else delete process.env.GHL_PIT;
    if (savedLoc !== undefined) process.env.GHL_LOCATION_ID = savedLoc;
  }

  assert.equal(code, EXIT.AUTH, '401 → AUTH exit code');
  assert.match(err, /401|scope/i, 'error must mention 401 or scope');
});

// --max-pages validation
test('api: --paginate --max-pages abc → exit 2 (USAGE)', async () => {
  const savedPit = process.env.GHL_PIT;
  process.env.GHL_PIT = 'pit-MAXPAGES001';
  let err = '';
  let code;
  try {
    code = await route(['api', '/x', '--paginate', '--max-pages', 'abc'], { write: () => {}, writeErr: s => err += s });
  } finally {
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit; else delete process.env.GHL_PIT;
  }
  assert.equal(code, EXIT.USAGE, '--max-pages abc must exit USAGE');
  assert.match(err, /max-pages/i, 'error must mention max-pages');
});

test('api: --paginate --max-pages 0 → exit 2 (USAGE)', async () => {
  const savedPit = process.env.GHL_PIT;
  process.env.GHL_PIT = 'pit-MAXPAGES002';
  let err = '';
  let code;
  try {
    code = await route(['api', '/x', '--paginate', '--max-pages', '0'], { write: () => {}, writeErr: s => err += s });
  } finally {
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit; else delete process.env.GHL_PIT;
  }
  assert.equal(code, EXIT.USAGE, '--max-pages 0 must exit USAGE');
});

// config set --loc "" rejection
test('config set: --loc "" → exit 2 (USAGE, empty value rejected)', async () => {
  const savedPit = process.env.GHL_PIT;
  delete process.env.GHL_PIT;
  let err = '';
  let code;
  try {
    code = await route(['config', 'set', '--profile', 'test-m2', '--loc', ''], { write: () => {}, writeErr: s => err += s });
  } finally {
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit;
  }
  assert.equal(code, EXIT.USAGE, '--loc "" must exit USAGE');
  assert.match(err, /--loc|non-empty/i, 'error must mention --loc or non-empty');
});

test('api: valid path + GHL_PIT + mocked fetch → exit 0 + JSON output', async () => {
  const savedPit = process.env.GHL_PIT;
  const savedLoc = process.env.GHL_LOCATION_ID;
  const savedFetch = globalThis.fetch;
  process.env.GHL_PIT = 'pit-TESTAPIVRB1';
  process.env.GHL_LOCATION_ID = 'LOC_TEST_000';

  let fetchCalled = false;
  globalThis.fetch = async (url, opts) => {
    fetchCalled = true;
    return {
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify({ contacts: [], meta: {} }),
    };
  };

  let out = ''; let err = '';
  let code;
  try {
    code = await route(['api', '/contacts/?limit=1'], { write: s => out += s, writeErr: s => err += s });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit; else delete process.env.GHL_PIT;
    if (savedLoc !== undefined) process.env.GHL_LOCATION_ID = savedLoc; else delete process.env.GHL_LOCATION_ID;
  }

  assert.equal(code, EXIT.OK, 'valid path + creds → exit 0');
  assert.ok(fetchCalled, 'fetch must have been called');
  const parsed = JSON.parse(out);
  assert.ok(typeof parsed === 'object', 'output must be JSON');
});
