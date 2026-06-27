// test/commands/receivables.test.mjs — value-asserting tests for receivables command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// receivables fetches:
//   GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0   (page 1)
//   GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=100 (page 2, if needed)
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/receivables.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/receivables.json', import.meta.url);

test('receivables: run returns 0 and envelope has expected keys + value assertions', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0': {
      status: 200,
      j: {
        invoices: [
          { _id: 'inv1', invoiceNumber: 'INV-001', status: 'sent', currency: 'PHP',
            total: 10000, amountPaid: 0,
            contactDetails: { name: 'Client A' },
            dueDate: new Date(NOW - 20 * 86400000).toISOString() },
          { _id: 'inv2', invoiceNumber: 'INV-002', status: 'paid', currency: 'PHP',
            total: 5000, amountPaid: 5000,
            contactDetails: { name: 'Client B' },
            dueDate: new Date(NOW - 5 * 86400000).toISOString() },
          { _id: 'inv3', invoiceNumber: 'INV-003', status: 'overdue', currency: 'PHP',
            total: 8000, amountPaid: 2000,
            contactDetails: { name: 'Client C' },
            dueDate: new Date(NOW - 35 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  for (const k of ['location', 'scanned', 'outstanding', 'totalOwed', 'currency', 'list']) {
    assert.ok(k in envelope.data, `missing key: ${k}`);
  }
  // value assertions
  assert.equal(envelope.data.scanned, 3, 'scanned must be 3');
  // inv1 (sent, due=10000) + inv3 (overdue, due=8000-2000=6000) = outstanding=2, totalOwed=16000
  assert.equal(envelope.data.outstanding, 2, 'only sent + overdue invoices are outstanding');
  assert.equal(envelope.data.totalOwed, 16000, 'totalOwed must be 10000+6000=16000');
  assert.equal(envelope.data.currency, 'PHP');
  // list sorted by age (oldest first): inv3 (35d) before inv1 (20d)
  assert.equal(envelope.data.list.length, 2);
  assert.equal(envelope.data.list[0].age, 35, 'oldest invoice first');
});

// Aging: invoices beyond --top are not shown but outstanding count is full
test('receivables: --top limits list rows but outstanding count is full', async () => {
  const NOW = 1_700_000_000_000;
  const invoices = Array.from({ length: 5 }, (_, i) => ({
    _id: `inv${i}`, invoiceNumber: `INV-00${i}`, status: 'sent', currency: 'PHP',
    total: 1000, amountPaid: 0, contactDetails: { name: `Client ${i}` },
    dueDate: new Date(NOW - (i + 1) * 86400000).toISOString(),
  }));
  const fixture = {
    'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0': {
      status: 200,
      j: { invoices },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ top: 2 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.outstanding, 5, 'outstanding is full count, not capped by --top');
  assert.equal(envelope.data.list.length, 2, '--top 2 caps the list to 2 rows');
  assert.equal(envelope.data.totalOwed, 5000, 'totalOwed includes all 5 invoices');
});

test('receivables: human output prints a ready-to-run per-row action when contactId is known', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0': {
      status: 200,
      j: { invoices: [
        { _id: 'inv1', invoiceNumber: 'INV-001', status: 'sent', currency: 'PHP',
          total: 9000, amountPaid: 0, contactDetails: { name: 'Acme Co', id: 'cid-acme' },
          dueDate: new Date(NOW - 30 * 86400000).toISOString() },
      ] },
    },
  };
  // json:false → human card renders into getPrinted()
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, json: false });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.match(out, /→ sizmo send cid-acme --channel email --message/, 'per-row send command with the real contactId');
  assert.match(out, /sizmo open cid-acme/, 'per-row open command too');
});

test('receivables: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'scanned', 'outstanding', 'totalOwed', 'currency', 'list']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});
