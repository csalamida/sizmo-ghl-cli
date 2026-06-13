// test/commands/snapshot.test.mjs — value-asserting tests for snapshot command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// snapshot fetches:
//   GET /calendars/?locationId=L-TEST
//   GET /contacts/?locationId=L-TEST&limit=100          (page 1, cursor-based)
//   GET /payments/transactions?altId=L-TEST&altType=location&limit=100&offset=0
//   GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1
//   GET /conversations/search?locationId=L-TEST&limit=100   (single-page, no offset)
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/snapshot.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/snapshot.json', import.meta.url);

// Minimal fixture with exact keys — empty valid responses.
const emptyFixture = () => ({
  'GET /calendars/?locationId=L-TEST':                                            { status: 200, j: { calendars: [] } },
  'GET /contacts/?locationId=L-TEST&limit=100':                                   { status: 200, j: { contacts: [] } },
  'GET /payments/transactions?altId=L-TEST&altType=location&limit=100&offset=0': { status: 200, j: { data: [] } },
  'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1':   { status: 200, j: { opportunities: [] } },
  'GET /conversations/search?locationId=L-TEST&limit=100':                        { status: 200, j: { conversations: [] } },
});

test('snapshot: run returns 0 and produces well-formed envelope', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ fixture: emptyFixture() });
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0, 'run should return 0');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1, 'schemaVersion must be 1');
  assert.equal(envelope.command, 'test', 'command present');
  assert.ok(envelope.data, 'data present');
  assert.ok(Array.isArray(envelope.data.metrics), 'data.metrics is array');
  assert.equal(envelope.data.metrics.length, 6, 'exactly 6 metrics');
  const labels = envelope.data.metrics.map(m => m.label);
  assert.ok(labels.includes('Leads'), 'Leads metric present');
  assert.ok(labels.includes('Collected'), 'Collected metric present');
});

// C2 (snapshot): one calendar's events return 500 → degraded + skippedCalendars in bookings note
test('snapshot: failed calendar events fetch → degraded + skippedCalendars in bookings metric', async () => {
  const NOW = 1_700_000_000_000;
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id:'calOk', name:'OK Cal' }, { id:'calBad', name:'Bad Cal' }] } };
    if (path === '/calendars/events' && query?.calendarId === 'calOk')
      return { code: 200, ok: true, j: { events: [] } };
    if (path === '/calendars/events' && query?.calendarId === 'calBad')
      return { code: 500, ok: false, j: null, txt: 'Error' };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 7 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.degraded, true, 'skipped calendar must set degraded');
  const warnings = envelope.warnings || [];
  assert.ok(warnings.some(w => /Bad Cal|calBad/i.test(w)), 'warning must name the failed calendar');
  // bookings metric note must mention skipped
  const bookings = envelope.data.metrics.find(m => m.label === 'Bookings');
  assert.ok(bookings, 'Bookings metric must exist');
  assert.ok(bookings.skippedCalendars >= 1 || (bookings.note && /skipped/.test(bookings.note)), 'skippedCalendars must be surfaced in bookings metric');
});

// I3: 'captured' status counts as collected in snapshot
test('snapshot: captured transaction counts as collected', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    'GET /calendars/?locationId=L-TEST':                                            { status: 200, j: { calendars: [] } },
    'GET /contacts/?locationId=L-TEST&limit=100':                                   { status: 200, j: { contacts: [] } },
    'GET /payments/transactions?altId=L-TEST&altType=location&limit=100&offset=0': {
      status: 200,
      j: {
        data: [
          { id: 't1', status: 'captured', amount: 8000, currency: 'PHP',
            createdAt: new Date(NOW - 2 * 86400000).toISOString() },
          { id: 't2', status: 'succeeded', amount: 2000, currency: 'PHP',
            createdAt: new Date(NOW - 1 * 86400000).toISOString() },
        ],
      },
    },
    'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1':   { status: 200, j: { opportunities: [] } },
    'GET /conversations/search?locationId=L-TEST&limit=100':                        { status: 200, j: { conversations: [] } },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const collected = envelope.data.metrics.find(m => m.label === 'Collected');
  assert.ok(collected, 'Collected metric must exist');
  // Both captured + succeeded should be counted: 8000 + 2000 = 10000
  assert.ok(!collected.blocked, 'Collected must not be blocked');
  assert.ok(collected.value.includes('10'), 'captured + succeeded should total ₱10,000');
});

test('snapshot: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  // The golden is now the new-format envelope
  const data = golden.data ?? golden; // handle both envelope and raw-old format
  const requiredKeys = ['location', 'window', 'metrics'];
  for (const k of requiredKeys) {
    assert.ok(k in data, `golden.data must have key: ${k}`);
  }
});

test('snapshot: positional days arg works (args._[0])', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ fixture: emptyFixture() });
  // Positional: args._[0] = '14', no args.days
  const code = await run({ _: ['14'] }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.window.days, 14, 'positional days arg should set window.days=14');
});

// I-2: calendar returning 100 events → truncation warning + degraded (uses inline http to bypass strict key check)
test('snapshot: calendar with 100 events → truncation warning + degraded', async () => {
  const NOW = 1_700_000_000_000;
  const events100 = Array.from({ length: 100 }, (_, i) => ({
    id: `e${i}`, appointmentStatus: 'confirmed',
    startTime: new Date(NOW - i * 3600000).toISOString(),
  }));
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Busy Cal' }] } };
    if (path === '/calendars/events') return { code: 200, ok: true, j: { events: events100 } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 7 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.degraded, true, 'truncation at cap must set degraded');
  const warnings = envelope.warnings || [];
  assert.ok(warnings.some(w => /truncat|may be truncated/i.test(w)), 'truncation warning must be present');
  assert.ok(warnings.some(w => /Busy Cal/i.test(w)), 'warning must name the calendar');
});
