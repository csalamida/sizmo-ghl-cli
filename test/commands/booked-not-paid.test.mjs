// test/commands/booked-not-paid.test.mjs — value-asserting tests for booked-not-paid command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// Trust-fix #2: transactions paginate to completion (tested via multi-page fixture).
// BNP fetches:
//   GET /calendars/?locationId=L-TEST
//   GET /calendars/events?locationId=L-TEST&calendarId=<id>&startTime=<ms>&endTime=<ms>
//   GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0
//   GET /payments/transactions?altId=L-TEST&altType=location&limit=100&offset=0&startAt=<date>
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/booked-not-paid.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/booked-not-paid.json', import.meta.url);

// Pre-compute deterministic keys for NOW=1_700_000_000_000, days=60
const NOW = 1_700_000_000_000;
const DAYS60_START = NOW - 60 * 86400000;                // 1694816000000
const PAY_LOOKBACK60 = DAYS60_START - 60 * 86400000;    // 1689632000000
const startAt60 = new Date(PAY_LOOKBACK60).toISOString().slice(0, 10); // '2023-07-17'

// Pre-compute for days=30
const DAYS30_START = NOW - 30 * 86400000;                // 1697408000000
const PAY_LOOKBACK30 = DAYS30_START - 60 * 86400000;    // 1692224000000
const startAt30 = new Date(PAY_LOOKBACK30).toISOString().slice(0, 10); // '2023-08-16'

test('booked-not-paid: run returns 0 and envelope has expected keys + value assertions', async () => {
  const fixture = {
    'GET /calendars/?locationId=L-TEST': {
      status: 200,
      j: { calendars: [{ id: 'cal1', name: 'Coaching' }] },
    },
    [`GET /calendars/events?locationId=L-TEST&calendarId=cal1&startTime=${DAYS60_START}&endTime=${NOW}`]: {
      status: 200,
      j: {
        events: [
          { id: 'e1', contactId: 'c1', contactName: 'Leak Client',
            appointmentStatus: 'confirmed',
            startTime: new Date(NOW - 10 * 86400000).toISOString() },
        ],
      },
    },
    'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0': { status: 200, j: { invoices: [] } },
    [`GET /payments/transactions?altId=L-TEST&altType=location&limit=100&offset=0&startAt=${startAt60}`]: { status: 200, j: { data: [] } },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 60, top: 15 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  for (const k of ['location', 'days', 'calendars', 'contactsWithSessions', 'neverBilled', 'billedUnpaid', 'billedUnpaidTotal', 'currency', 'settled', 'caveat']) {
    assert.ok(k in envelope.data, `missing key: ${k}`);
  }
  // c1 had a session, no invoice, no payment → neverBilled
  assert.equal(envelope.data.neverBilled.length, 1, 'c1 must be in neverBilled');
  assert.equal(envelope.data.neverBilled[0].contactId, 'c1');
  assert.equal(envelope.data.contactsWithSessions, 1, 'exactly 1 contact with sessions');
});

test('booked-not-paid: no sessions → empty buckets', async () => {
  const fixture = {
    'GET /calendars/?locationId=L-TEST': { status: 200, j: { calendars: [] } },
    // No calendars → no events → no sessions. With no byContact entries, BNP returns early
    // without fetching invoices/payments, so those keys are not needed here.
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 60, top: 15 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.contactsWithSessions, 0);
});

// C1: payments blocked → neverBilled suppressed, degraded:true, warning present
test('booked-not-paid: payments blocked → neverBilled suppressed + envelope degraded', async () => {
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Coaching' }] } };
    if (path === '/calendars/events')
      return { code: 200, ok: true, j: { events: [
        { id: 'e1', contactId: 'c1', contactName: 'Accused Client',
          appointmentStatus: 'confirmed',
          startTime: new Date(NOW - 5 * 86400000).toISOString() },
      ]}};
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    if (path === '/payments/transactions') return { code: 403, ok: false, j: { message: 'Forbidden' } };
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  // envelope must be degraded
  assert.equal(envelope.degraded, true, 'envelope must be degraded when payments blocked');
  // neverBilled must be empty (suppressed — can't know who paid via non-invoice routes)
  assert.equal(envelope.data.neverBilled.length, 0, 'neverBilled must be suppressed when payments blocked');
  // paymentsBlocked key present in data
  assert.ok(envelope.data.paymentsBlocked, 'data.paymentsBlocked must be set');
  // at least one warning about payments
  const warnings = envelope.warnings || [];
  assert.ok(warnings.length > 0, 'at least one warning must be present');
  assert.ok(warnings.some(w => /payment/i.test(w)), 'warning must mention payments');
});

// C1: invBlocked → ctx.out.warn emits degraded warn (machine-readable, not TTY-only)
test('booked-not-paid: invoices blocked → neverBilled suppressed + envelope degraded', async () => {
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Coaching' }] } };
    if (path === '/calendars/events')
      return { code: 200, ok: true, j: { events: [
        { id: 'e1', contactId: 'c2', contactName: 'Another Client',
          appointmentStatus: 'confirmed',
          startTime: new Date(NOW - 3 * 86400000).toISOString() },
      ]}};
    if (path === '/invoices/') return { code: 403, ok: false, j: { message: 'Forbidden' } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.degraded, true, 'envelope must be degraded when invoices blocked');
  assert.equal(envelope.data.neverBilled.length, 0, 'neverBilled must be suppressed when invoices blocked');
  const warnings = envelope.warnings || [];
  assert.ok(warnings.length > 0, 'at least one warning must be present');
  assert.ok(warnings.some(w => /invoice/i.test(w)), 'warning must mention invoices');
});

// C2 (booked-not-paid): one calendar's events return 500 → skippedCalendars≥1 + degraded
test('booked-not-paid: failed calendar events fetch → skippedCalendars + degraded', async () => {
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id:'cal1', name:'Good Cal' }, { id:'cal2', name:'Bad Cal' }] } };
    if (path === '/calendars/events' && query?.calendarId === 'cal1')
      return { code: 200, ok: true, j: { events: [
        { id:'e1', contactId:'c1', contactName:'Client A', appointmentStatus:'confirmed',
          startTime: new Date(NOW - 5*86400000).toISOString() }
      ]}};
    if (path === '/calendars/events' && query?.calendarId === 'cal2')
      return { code: 500, ok: false, j: null, txt: 'Server Error' };
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.degraded, true, 'skipped calendar must set degraded');
  assert.ok(envelope.data.skippedCalendars >= 1, 'skippedCalendars must be ≥1');
  const warnings = envelope.warnings || [];
  assert.ok(warnings.some(w => /Bad Cal|cal2/i.test(w)), 'warning must name the failed calendar');
});

// I-2: calendar returning 100 events → truncation warning + degraded
test('booked-not-paid: calendar with 100 events → truncation warning + degraded', async () => {
  const events100 = Array.from({ length: 100 }, (_, i) => ({
    id: `e${i}`, contactId: `c${i}`, contactName: `Client ${i}`,
    appointmentStatus: 'confirmed',
    startTime: new Date(NOW - (i + 1) * 3600000).toISOString(),
  }));
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Big Cal' }] } };
    if (path === '/calendars/events') return { code: 200, ok: true, j: { events: events100 } };
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
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
  assert.ok(warnings.some(w => /Big Cal/i.test(w)), 'warning must name the calendar');
});

// ── FIX 2: payment success synonyms — captured/paid/success/completed must count as paid ──

test('FIX2: payment status "captured" → contact treated as paid (not in neverBilled)', async () => {
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Coaching' }] } };
    if (path === '/calendars/events')
      return { code: 200, ok: true, j: { events: [
        { id: 'e1', contactId: 'c-captured', contactName: 'Captured Client',
          appointmentStatus: 'confirmed',
          startTime: new Date(NOW - 5 * 86400000).toISOString() },
      ]}};
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    // Transaction with status 'captured' — must count as paid
    if (path === '/payments/transactions')
      return { code: 200, ok: true, j: { data: [
        { id: 't1', status: 'captured', contactId: 'c-captured' },
      ]}};
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.data.neverBilled.length, 0, 'contact with captured payment must NOT be in neverBilled');
  assert.equal(envelope.data.settled, 1, 'captured contact must be counted as settled');
});

test('FIX2: payment status "paid" → contact treated as paid (not in neverBilled)', async () => {
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Coaching' }] } };
    if (path === '/calendars/events')
      return { code: 200, ok: true, j: { events: [
        { id: 'e2', contactId: 'c-paid', contactName: 'Paid Status Client',
          appointmentStatus: 'confirmed',
          startTime: new Date(NOW - 5 * 86400000).toISOString() },
      ]}};
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    if (path === '/payments/transactions')
      return { code: 200, ok: true, j: { data: [
        { id: 't2', status: 'paid', contactId: 'c-paid' },
      ]}};
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  assert.equal(envelope.data.neverBilled.length, 0, 'contact with "paid" status must NOT be in neverBilled');
  assert.equal(envelope.data.settled, 1, '"paid" contact must be counted as settled');
});

test('FIX2: all success synonyms (success, completed) accepted; "pending" still flags', async () => {
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const http = { get: async (path, { query } = {}) => {
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [{ id: 'cal1', name: 'Coaching' }] } };
    if (path === '/calendars/events')
      return { code: 200, ok: true, j: { events: [
        { id: 'e1', contactId: 'c-success',    contactName: 'Success',    appointmentStatus: 'confirmed', startTime: new Date(NOW - 2 * 86400000).toISOString() },
        { id: 'e2', contactId: 'c-completed',  contactName: 'Completed',  appointmentStatus: 'confirmed', startTime: new Date(NOW - 3 * 86400000).toISOString() },
        { id: 'e3', contactId: 'c-pending',    contactName: 'Pending',    appointmentStatus: 'confirmed', startTime: new Date(NOW - 4 * 86400000).toISOString() },
      ]}};
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    if (path === '/payments/transactions')
      return { code: 200, ok: true, j: { data: [
        { id: 't1', status: 'success',   contactId: 'c-success' },
        { id: 't2', status: 'completed', contactId: 'c-completed' },
        { id: 't3', status: 'pending',   contactId: 'c-pending' },
      ]}};
    return { code: 200, ok: true, j: {} };
  }};
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await run({ days: 30, top: 15 }, ctx);
  out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(printed);
  // c-success and c-completed are paid → settled; c-pending has no payment → neverBilled
  assert.equal(envelope.data.settled, 2, 'success+completed must be settled');
  assert.equal(envelope.data.neverBilled.length, 1, 'pending must still flag as neverBilled');
  assert.equal(envelope.data.neverBilled[0].contactId, 'c-pending', 'pending contact must be flagged');
});

test('booked-not-paid: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'days', 'calendars', 'contactsWithSessions', 'neverBilled', 'billedUnpaid', 'billedUnpaidTotal', 'currency', 'settled']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});
