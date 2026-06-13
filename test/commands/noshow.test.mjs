// test/commands/noshow.test.mjs — value-asserting tests for noshow command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// noshow fetches:
//   GET /calendars/?locationId=L-TEST
//   GET /calendars/events?locationId=L-TEST&calendarId=<id>&startTime=<ms>&endTime=<ms>
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/noshow.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/noshow.json', import.meta.url);

test('noshow: run returns 0 and envelope has expected keys + value assertions', async () => {
  const NOW = 1_700_000_000_000;
  const DAYS = 30;
  const START = NOW - DAYS * 24 * 60 * 60 * 1000; // 1697408000000
  const fixture = {
    'GET /calendars/?locationId=L-TEST': {
      status: 200,
      j: { calendars: [{ id: 'cal1', name: 'Main Calendar' }] },
    },
    [`GET /calendars/events?locationId=L-TEST&calendarId=cal1&startTime=${START}&endTime=${NOW}`]: {
      status: 200,
      j: {
        events: [
          { id: 'e1', contactId: 'c1', contactName: 'Jane Doe',
            appointmentStatus: 'noshow', startTime: new Date(NOW - 5 * 86400000).toISOString() },
          { id: 'e2', contactId: 'c2', contactName: 'John Smith',
            appointmentStatus: 'noshow', startTime: new Date(NOW - 10 * 86400000).toISOString() },
          { id: 'e3', contactId: 'c3', contactName: 'Alice Lee',
            appointmentStatus: 'confirmed', startTime: new Date(NOW - 3 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: DAYS, top: 15 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  for (const k of ['location', 'calendars', 'noshows', 'shown', 'list']) {
    assert.ok(k in envelope.data, `missing key: ${k}`);
  }
  // value assertions: 2 noshows (e1+e2), e3 is confirmed so not counted
  assert.equal(envelope.data.noshows, 2, 'noshows must be 2');
  assert.equal(envelope.data.list.length, 2, 'list must have 2 entries');
  // sorted newest-first: e1 (5d ago) before e2 (10d ago)
  assert.equal(envelope.data.list[0].contactId, 'c1', 'newest noshow first');
  assert.equal(envelope.data.list[1].contactId, 'c2', 'older noshow second');
  assert.equal(envelope.data.calendars, 1);
});

// C2: one calendar's events return 500 → skippedCalendars≥1 + degraded
test('noshow: failed calendar events fetch → skippedCalendars + degraded', async () => {
  const NOW = 1_700_000_000_000;
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/')
      return { code: 200, ok: true, j: { calendars: [{ id:'calA', name:'Works' }, { id:'calB', name:'Broken' }] } };
    if (path === '/calendars/events' && query?.calendarId === 'calA')
      return { code: 200, ok: true, j: { events: [
        { id:'e1', contactId:'c1', contactName:'No Show Jane', appointmentStatus:'noshow',
          startTime: new Date(NOW - 3*86400000).toISOString() }
      ]}};
    if (path === '/calendars/events' && query?.calendarId === 'calB')
      return { code: 500, ok: false, j: null, txt: 'Internal Server Error' };
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.degraded, true, 'partial calendar scan must set degraded');
  assert.ok(envelope.data.skippedCalendars >= 1, 'skippedCalendars must be ≥1');
  const warnings = envelope.warnings || [];
  assert.ok(warnings.some(w => /Broken|calB/i.test(w)), 'warning must name the failed calendar');
});

// I-2: calendar returning 100 events → truncation warning + degraded
test('noshow: calendar with 100 events → truncation warning + degraded', async () => {
  const NOW = 1_700_000_000_000;
  const events100 = Array.from({ length: 100 }, (_, i) => ({
    id: `e${i}`, contactId: `c${i}`, contactName: `Contact ${i}`,
    appointmentStatus: 'noshow',
    startTime: new Date(NOW - (i + 1) * 3600000).toISOString(),
  }));
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Busy Cal' }] } };
    if (path === '/calendars/events') return { code: 200, ok: true, j: { events: events100 } };
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.degraded, true, 'truncation at cap must set degraded');
  const warnings = envelope.warnings || [];
  assert.ok(warnings.some(w => /truncat|may be truncated/i.test(w)), 'truncation warning must be present');
  assert.ok(warnings.some(w => /Busy Cal/i.test(w)), 'warning must name the calendar');
});

test('noshow: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'calendars', 'noshows', 'shown', 'list']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});
