// test/commands/triage.test.mjs — smoke + value-asserting tests for triage command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/triage.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/triage.json', import.meta.url);

test('triage: run returns 0, envelope shape + value assertions', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    // offset=0 — the exact key triage sends on first page
    'GET /conversations/search?locationId=L-TEST&limit=100&offset=0': {
      status: 200,
      j: {
        conversations: [
          { id: 'conv1', contactId: 'c1', contactName: 'Test User',
            lastMessageDate: NOW - 86400000,
            unreadCount: 3, lastMessageType: 'TYPE_SMS', email: 'test@test.com' },
        ],
      },
    },
    // messages endpoint with exact limit query triage sends
    'GET /conversations/conv1/messages?limit=20': {
      status: 200,
      j: { messages: { messages: [{ direction: 'inbound', body: 'hello test message' }] } },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ top: 10, days: 30 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  const requiredKeys = ['location', 'scanned', 'waiting', 'shown', 'threads'];
  for (const k of requiredKeys) assert.ok(k in envelope.data, `missing key: ${k}`);
  assert.ok(Array.isArray(envelope.data.threads));
  // value assertions: 1 conversation with unreadCount>0 → waiting=1
  assert.equal(envelope.data.scanned, 1, 'scanned must be 1');
  assert.equal(envelope.data.waiting, 1, 'waiting must be 1');
  assert.equal(envelope.data.threads.length, 1, 'shown thread count must be 1');
  assert.equal(envelope.data.threads[0].conversationId, 'conv1');
  assert.equal(envelope.data.threads[0].snippet, 'hello test message');
  assert.equal(envelope.data.threads[0].unread, 3);
});

test('triage: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'scanned', 'waiting', 'shown', 'threads']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});

test('triage: paginates all pages before applying --top cap', async () => {
  // Proves threads beyond position 100 are not missed.
  // Page 1: 100 convos with unreadCount=0 (not waiting).
  // Page 2: 1 convo with unreadCount=5 (the oldest-waiting thread that old single-page fetch would miss).
  const NOW = 1_700_000_000_000;

  // Build 100 read (non-waiting) convos for page 1
  const page1Convos = Array.from({ length: 100 }, (_, i) => ({
    id: `conv-p1-${i}`,
    contactId: `c-p1-${i}`,
    contactName: `User P1 ${i}`,
    lastMessageDate: NOW - (i + 1) * 3600000,
    unreadCount: 0,
    lastMessageType: 'TYPE_SMS',
  }));

  // Page 2: one waiting thread that only a paginating fetch will find
  const waitingConvo = {
    id: 'conv-deep',
    contactId: 'c-deep',
    contactName: 'Deep Waiter',
    lastMessageDate: NOW - 5 * 86400000, // 5 days ago — within 30d window
    unreadCount: 7,
    lastMessageType: 'TYPE_EMAIL',
  };

  const fixture = {
    'GET /conversations/search?locationId=L-TEST&limit=100&offset=0': {
      status: 200,
      j: { conversations: page1Convos },
    },
    'GET /conversations/search?locationId=L-TEST&limit=100&offset=100': {
      status: 200,
      j: { conversations: [waitingConvo] },
    },
    // messages endpoint — triage fetches with ?limit=20
    'GET /conversations/conv-deep/messages?limit=20': {
      status: 200,
      j: { messages: { messages: [{ direction: 'inbound', body: 'hello from deep page' }] } },
    },
  };

  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ top: 10, days: 30 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const data = envelope.data;

  // scanned must include all pages (100 + 1 = 101)
  assert.equal(data.scanned, 101, 'must have scanned all 101 convos across both pages');

  // the deep-page waiting thread must appear in results
  assert.equal(data.waiting, 1, 'exactly 1 waiting thread');
  assert.equal(data.threads.length, 1);
  assert.equal(data.threads[0].conversationId, 'conv-deep', 'deep-page thread must be found');
  assert.equal(data.threads[0].snippet, 'hello from deep page');
});
