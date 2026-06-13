// test/commands/segment.test.mjs — value-asserting tests for segment command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// segment fetches:
//   GET /contacts/?locationId=L-TEST&limit=100   (page 1, no cursor)
//   GET /contacts/?locationId=L-TEST&limit=100&startAfter=<ts>&startAfterId=<id>  (page 2+)
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/segment.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/segment.json', import.meta.url);

test('segment: run returns 0 with --no-phone criteria + value assertions', async () => {
  const fixture = {
    'GET /contacts/?locationId=L-TEST&limit=100': {
      status: 200,
      j: {
        contacts: [
          { id: 'c1', email: 'a@test.com', tags: [], dateAdded: new Date(1_699_000_000_000).toISOString(), phone: null },
          { id: 'c2', email: 'b@test.com', tags: [], dateAdded: new Date(1_699_100_000_000).toISOString(), phone: '+639171234567' },
          { id: 'c3', email: 'c@test.com', tags: [], dateAdded: new Date(1_699_200_000_000).toISOString(), phone: null },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture });
  // --no-phone: c1 and c3 match; c2 has phone
  const code = await run({ 'no-phone': true }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  for (const k of ['location', 'criteria', 'scanned', 'matched', 'contactIds', 'sample']) {
    assert.ok(k in envelope.data, `missing key: ${k}`);
  }
  // value assertions
  assert.equal(envelope.data.scanned, 3, 'scanned must be 3');
  assert.equal(envelope.data.matched, 2, '--no-phone must match c1 and c3');
  assert.ok(envelope.data.contactIds.includes('c1'), 'c1 must be in contactIds');
  assert.ok(envelope.data.contactIds.includes('c3'), 'c3 must be in contactIds');
  assert.ok(!envelope.data.contactIds.includes('c2'), 'c2 must NOT be in contactIds (has phone)');
});

test('segment: no criteria returns exit code 2', async () => {
  const { ctx, getPrinted } = makeFakeCtx({});
  const code = await run({}, ctx);
  // no flush needed since data is null
  assert.equal(code, 2);
});

// I4: --top is now in meta.flags, parseArgs should accept it
test('segment: --top flag is declared in meta.flags and parseArgs accepts it', async () => {
  const { parseArgs } = await import('../../lib/cli.mjs');
  const { meta } = await import('../../commands/segment.mjs');
  // meta.flags must include --top
  const topFlag = meta.flags.find(f => f.name === '--top');
  assert.ok(topFlag, '--top must be in meta.flags');
  assert.equal(topFlag.type, 'int', '--top must be type int');
  assert.equal(topFlag.default, 20, '--top default must be 20');

  // parseArgs must parse --top 5 without throwing
  const parsed = parseArgs(['--no-phone', '--top', '5'], meta);
  assert.equal(parsed.top, 5, '--top 5 must parse to top:5');
  assert.equal(parsed['no-phone'], true);
});

// I4: sample is capped to --top
test('segment: --top limits sample size', async () => {
  const contacts = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`, email: `c${i}@test.com`, tags: [], phone: null,
    dateAdded: new Date(1_699_000_000_000 + i * 1000).toISOString(),
  }));
  const fixture = { 'GET /contacts/?locationId=L-TEST&limit=100': { status: 200, j: { contacts } } };
  const { ctx, getPrinted } = makeFakeCtx({ fixture });
  const code = await run({ 'no-phone': true, top: 3 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.matched, 10, 'all 10 contacts match no-phone');
  assert.equal(envelope.data.sample.length, 3, '--top 3 must cap sample to 3');
});

test('segment: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'criteria', 'scanned', 'matched', 'contactIds', 'sample']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});

// ── token-lean tests ──────────────────────────────────────────────────────────

test('segment: default lean sample has only id + name fields', async () => {
  const contacts = [
    { id: 'c1', contactName: 'Alice', email: 'a@test.com', phone: null, tags: ['vip'], dateAdded: new Date(1_699_000_000_000).toISOString() },
    { id: 'c2', contactName: 'Bob',   email: 'b@test.com', phone: null, tags: [],      dateAdded: new Date(1_699_100_000_000).toISOString() },
  ];
  const fixture = { 'GET /contacts/?locationId=L-TEST&limit=100': { status: 200, j: { contacts } } };
  const { ctx, getPrinted } = makeFakeCtx({ fixture });
  const code = await run({ 'no-phone': true }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const sample = envelope.data.sample;
  assert.ok(sample.length > 0, 'sample has items');
  for (const item of sample) {
    assert.ok('id' in item && 'name' in item, 'lean sample has id + name');
    assert.ok(!('email' in item), 'lean sample must not have email');
    assert.ok(!('phone' in item), 'lean sample must not have phone');
    assert.ok(!('tags' in item), 'lean sample must not have tags');
  }
  // count + IDs still intact
  assert.equal(envelope.data.matched, 2, 'matched count intact');
  assert.ok(envelope.data.contactIds.includes('c1'), 'contactIds intact');
});

test('segment --full: sample includes email, phone, tags', async () => {
  const contacts = [
    { id: 'c1', contactName: 'Alice', email: 'a@test.com', phone: null, tags: ['vip'], dateAdded: new Date(1_699_000_000_000).toISOString() },
  ];
  const fixture = { 'GET /contacts/?locationId=L-TEST&limit=100': { status: 200, j: { contacts } } };
  const { ctx, getPrinted } = makeFakeCtx({ fixture });
  const code = await run({ 'no-phone': true, full: true }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const item = envelope.data.sample[0];
  assert.ok('email' in item, '--full sample has email');
  assert.ok('phone' in item, '--full sample has phone');
  assert.ok('tags' in item, '--full sample has tags');
  assert.ok('id' in item && 'name' in item, '--full sample has id + name');
});

test('segment: --full flag declared in meta.flags', async () => {
  const { meta } = await import('../../commands/segment.mjs');
  const fullFlag = meta.flags.find(f => f.name === '--full');
  assert.ok(fullFlag, '--full must be in meta.flags');
  assert.equal(fullFlag.type, 'bool', '--full must be type bool');
});
