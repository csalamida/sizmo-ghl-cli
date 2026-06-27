import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route, parseArgs, ghlAppUrl } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

// ── open verb (1.2.0) ────────────────────────────────────────────────────────

function withLoc(loc, fn) {
  const sp = process.env.GHL_PIT, sl = process.env.GHL_LOCATION_ID, sprof = process.env.SIZMO_PROFILE;
  process.env.GHL_LOCATION_ID = loc; delete process.env.SIZMO_PROFILE;
  try { return fn(); }
  finally {
    if (sp !== undefined) process.env.GHL_PIT = sp; else delete process.env.GHL_PIT;
    if (sl !== undefined) process.env.GHL_LOCATION_ID = sl; else delete process.env.GHL_LOCATION_ID;
    if (sprof !== undefined) process.env.SIZMO_PROFILE = sprof;
  }
}

test('ghlAppUrl: contact + opportunity paths, encodes loc/id, honors SIZMO_APP_URL', () => {
  assert.equal(ghlAppUrl('contact', 'L1', 'c1', {}),
    'https://app.gohighlevel.com/v2/location/L1/contacts/detail/c1');
  assert.equal(ghlAppUrl('opportunity', 'L1', 'c1', {}),
    'https://app.gohighlevel.com/v2/location/L1/opportunities/list?contactId=c1');
  assert.equal(ghlAppUrl('contact', 'L1', 'c1', { SIZMO_APP_URL: 'https://crm.acme.com/' }),
    'https://crm.acme.com/v2/location/L1/contacts/detail/c1');
  assert.ok(ghlAppUrl('contact', 'L1', 'a/b', {}).endsWith('/contacts/detail/a%2Fb'));
});

test('open --url: prints the contact URL, no browser launch', async () => {
  let out = '';
  const code = await withLoc('LOC1', () => route(['open', 'cid-9', '--url'], { write: s => out += s }));
  assert.equal(code, EXIT.OK);
  assert.equal(out.trim(), 'https://app.gohighlevel.com/v2/location/LOC1/contacts/detail/cid-9');
});

test('open --json --url: structured, opened:false', async () => {
  let out = '';
  await withLoc('LOC1', () => route(['open', 'cid-9', '--url', '--json'], { write: s => out += s }));
  const o = JSON.parse(out);
  assert.equal(o.command, 'open'); assert.equal(o.kind, 'contact'); assert.equal(o.id, 'cid-9');
  assert.equal(o.opened, false);
  assert.match(o.url, /contacts\/detail\/cid-9$/);
});

test('open --opp --url: opportunity URL', async () => {
  let out = '';
  await withLoc('LOC1', () => route(['open', 'cid-9', '--opp', '--url'], { write: s => out += s }));
  assert.match(out, /opportunities\/list\?contactId=cid-9/);
});

test('open: no id → USAGE', async () => {
  let err = '';
  const code = await withLoc('LOC1', () => route(['open'], { writeErr: s => err += s }));
  assert.equal(code, EXIT.USAGE);
  assert.match(err, /usage:.*open/i);
});

test('help <command>: shows summary + flags + runnable examples', async () => {
  let out = '';
  const code = await route(['help', 'receivables'], { write: s => out += s });
  assert.equal(code, EXIT.OK);
  assert.match(out, /sizmo receivables —/);
  assert.match(out, /Flags:/);
  assert.match(out, /--top/);
  assert.match(out, /Examples:/);
  assert.match(out, /sizmo receivables --ndjson/);
});

test('<command> --help: intercepts before the parser (no "unknown flag" error)', async () => {
  let out = '';
  const code = await route(['receivables', '--help'], { write: s => out += s });
  assert.equal(code, EXIT.OK);
  assert.match(out, /sizmo receivables —/);
  assert.match(out, /Examples:/);
});

test('help <router-verb>: works for open (not a registry command)', async () => {
  let out = '';
  const code = await route(['help', 'open'], { write: s => out += s });
  assert.equal(code, EXIT.OK);
  assert.match(out, /GoHighLevel web app/);
  assert.match(out, /sizmo open <contactId> --url/);
});

test('help <bogus>: USAGE + unknown-command message', async () => {
  let err = '';
  const code = await route(['help', 'frobnicate'], { writeErr: s => err += s });
  assert.equal(code, EXIT.USAGE);
  assert.match(err, /unknown command/i);
});

test('completions zsh: emits a #compdef script with the command list + a flag', async () => {
  let out = '';
  const code = await route(['completions', 'zsh'], { write: s => out += s });
  assert.equal(code, EXIT.OK);
  assert.match(out, /^#compdef sizmo/);
  assert.ok(out.includes('receivables') && out.includes('open') && out.includes('brief'), 'commands present');
  assert.ok(out.includes('--json'), 'global flags present');
  assert.ok(out.includes('_describe'), 'is a real zsh completion function');
});

test('completions bash: emits a complete -F script with the command list', async () => {
  let out = '';
  const code = await route(['completions', 'bash'], { write: s => out += s });
  assert.equal(code, EXIT.OK);
  assert.ok(out.includes('complete -F _sizmo sizmo'), 'registers the completion');
  assert.ok(out.includes('receivables') && out.includes('compgen'), 'commands + compgen present');
});

test('completions: missing/unknown shell → USAGE', async () => {
  let err = '';
  assert.equal(await route(['completions'], { writeErr: s => err += s }), EXIT.USAGE);
  assert.equal(await route(['completions', 'fish'], { writeErr: s => err += s }), EXIT.USAGE);
  assert.match(err, /usage:.*completions/i);
});

test('open: no location resolved → AUTH', async () => {
  // Isolate from the machine's real ~/.config/sizmo (a saved default profile would resolve a loc).
  const sX = process.env.XDG_CONFIG_HOME, sl = process.env.GHL_LOCATION_ID, sprof = process.env.SIZMO_PROFILE;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'sz-cfg-'));
  delete process.env.GHL_LOCATION_ID; delete process.env.SIZMO_PROFILE;
  let err = '';
  try {
    const code = await route(['open', 'cid-9', '--url'], { writeErr: s => err += s });
    assert.equal(code, EXIT.AUTH);
    assert.match(err, /no location/i);
  } finally {
    if (sX !== undefined) process.env.XDG_CONFIG_HOME = sX; else delete process.env.XDG_CONFIG_HOME;
    if (sl !== undefined) process.env.GHL_LOCATION_ID = sl;
    if (sprof !== undefined) process.env.SIZMO_PROFILE = sprof;
  }
});

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
