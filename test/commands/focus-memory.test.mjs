// test/commands/focus-memory.test.mjs — integration tests for focus + ack/snooze.
// Injected clock + temp dir. No GHL network.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run, collect } from '../../commands/focus.mjs';
import { makeOut } from '../../lib/output.mjs';
import { addSnooze } from '../../lib/memory.mjs';

const NOW = 1_700_000_000_000;
const LOC = 'L-TEST';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'sizmo-focus-mem-test-')); }
function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// A fixture with one stuck deal (d1) + one waiting thread (t1)
function makeHttp() {
  return { get: async (path) => {
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [{ id: 'p1', name: 'P', stages: [{ id: 's1', name: 'Lead' }] }] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [
      { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 50000, name: 'BigDeal', contactId: 'd1',
        updatedAt: new Date(NOW - 21 * 86400000).toISOString() },
    ] } };
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [
      { id: 'conv1', contactId: 't1', contactName: 'WaitingPerson', unreadCount: 1, lastMessageDate: NOW - 3 * 86400000, lastMessageType: 'TYPE_EMAIL' },
    ] } };
    if (path.startsWith('/conversations/') && path.endsWith('/messages')) return { code: 200, ok: true, j: { messages: { messages: [] } } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
}

function makeCtx(dir, overrides = {}) {
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: LOC,
    write: s => printed += s, writeErr: () => {} });
  const ctx = {
    http: makeHttp(),
    cfg: { loc: LOC, tz: 'Asia/Manila', currency: null },
    out,
    now: NOW,
    memoryDir: dir,
    ...overrides,
  };
  return { ctx, getPrinted: () => printed };
}

// ── Snooze filtering ──────────────────────────────────────────────────────────

test('focus+ack: snoozed contact removed from ranked', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);
    const { ctx, getPrinted } = makeCtx(dir);
    await run({}, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    const ids = (data.ranked || []).map(x => x.contact);
    assert.ok(!ids.includes('d1'), 'snoozed d1 must not appear in ranked');
  } finally { cleanup(dir); }
});

test('focus+ack: snoozed contact removed from unknownValue', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 't1', { snoozeMs: 7 * 86400000 }, NOW, dir);
    const { ctx, getPrinted } = makeCtx(dir);
    await run({}, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    const ids = (data.unknownValue || []).map(x => x.contact);
    assert.ok(!ids.includes('t1'), 'snoozed t1 must not appear in unknownValue');
  } finally { cleanup(dir); }
});

test('focus+ack: snoozedCount > 0 when items filtered', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);
    const { ctx, getPrinted } = makeCtx(dir);
    await run({}, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    assert.ok(data.snoozedCount > 0, 'snoozedCount must reflect filtered items');
  } finally { cleanup(dir); }
});

test('focus+ack: --show-acked reveals snoozed items', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);
    const { ctx, getPrinted } = makeCtx(dir, { showAcked: true });
    await run({ 'show-acked': true }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    const ids = (data.ranked || []).map(x => x.contact);
    assert.ok(ids.includes('d1'), '--show-acked must reveal d1');
  } finally { cleanup(dir); }
});

test('focus+ack: --no-memory disables filtering, all items visible', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);
    const { ctx, getPrinted } = makeCtx(dir, { noMemory: true });
    await run({ 'no-memory': true }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    const ids = (data.ranked || []).map(x => x.contact);
    assert.ok(ids.includes('d1'), '--no-memory must show all including snoozed');
  } finally { cleanup(dir); }
});

test('focus+ack: expired snooze auto-resurfaces', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 100 }, NOW, dir);
    // Run 1s later — snooze expired
    const { ctx, getPrinted } = makeCtx(dir, { now: NOW + 1000 });
    ctx.http = makeHttp(); // rebuild http with correct NOW implicit
    await run({}, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    const ids = (data.ranked || []).map(x => x.contact);
    assert.ok(ids.includes('d1'), 'expired snooze: d1 must resurface in ranked');
  } finally { cleanup(dir); }
});

test('focus+ack: TTY footer shows snoozed count', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);
    let printed = '';
    const out = makeOut({ json: false, tty: false, command: 'test', location: LOC, write: s => printed += s, writeErr: () => {} });
    const ctx = { http: makeHttp(), cfg: { loc: LOC, tz: 'Asia/Manila', currency: null }, out, now: NOW, memoryDir: dir };
    await run({}, ctx);
    assert.ok(printed.includes('snoozed'), 'TTY footer must mention snoozed');
    assert.ok(printed.includes('ack --list'), 'TTY footer must point to ack --list');
  } finally { cleanup(dir); }
});

test('focus+ack: snoozedCount=0 when no items filtered', async () => {
  const dir = tmpDir();
  try {
    const { ctx, getPrinted } = makeCtx(dir);
    await run({}, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    // snoozedCount should be 0 (or absent) when nothing is snoozed
    assert.ok(!data.snoozedCount || data.snoozedCount === 0, 'snoozedCount is 0 when nothing filtered');
  } finally { cleanup(dir); }
});

test('focus+ack: collect() returns snoozedCount in result object', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);
    const { ctx } = makeCtx(dir);
    const result = await collect({}, ctx);
    assert.ok('snoozedCount' in result, 'collect() returns snoozedCount');
    assert.ok(result.snoozedCount > 0, 'snoozedCount > 0 with active snooze');
  } finally { cleanup(dir); }
});

// ── No regression on basic focus tests ───────────────────────────────────────

test('focus+memory: run() returns 0 (no regression)', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    const code = await run({}, ctx);
    assert.equal(code, 0);
  } finally { cleanup(dir); }
});

test('focus+memory: envelope has data.ranked + data.unknownValue (no regression)', async () => {
  const dir = tmpDir();
  try {
    const { ctx, getPrinted } = makeCtx(dir);
    await run({}, ctx);
    ctx.out.flush();
    const envelope = JSON.parse(getPrinted());
    assert.ok(Array.isArray(envelope.data.ranked), 'data.ranked is array');
    assert.ok(Array.isArray(envelope.data.unknownValue), 'data.unknownValue is array');
  } finally { cleanup(dir); }
});
