// test/commands/brief-memory.test.mjs — integration tests for brief + memory (deltas + ack).
// Injected clock + temp dir. No GHL network. Verifies honest-baseline discipline.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run, collect } from '../../commands/brief.mjs';
import { makeOut } from '../../lib/output.mjs';
import { addSnooze, recordRun } from '../../lib/memory.mjs';

const NOW = 1_700_000_000_000;
const LOC = 'L-TEST';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'sizmo-brief-mem-test-')); }
function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// Returns a trivial all-clear http (no GHL calls needed for delta/snooze testing)
function makeAllClearHttp() {
  return { get: async (path) => {
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/calendars/events') return { code: 200, ok: true, j: { events: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [] } };
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    return { code: 200, ok: true, j: {} };
  }};
}

function makeCtx(http, dir, overrides = {}) {
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'test', location: LOC,
    write: s => printed += s, writeErr: () => {} });
  const ctx = {
    http,
    cfg: { loc: LOC, tz: 'Asia/Manila', currency: null },
    out,
    now: NOW,
    memoryDir: dir,
    ...overrides,
  };
  return { ctx, getPrinted: () => printed };
}

// ── A. Delta — first run ──────────────────────────────────────────────────────

test('brief+memory: first run → delta.firstRun:true in JSON, NOT "no change"', async () => {
  const dir = tmpDir();
  try {
    const { ctx, getPrinted } = makeCtx(makeAllClearHttp(), dir);
    await run({ days: 7 }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    assert.ok(data.delta, 'data.delta present');
    assert.equal(data.delta.firstRun, true, 'delta.firstRun must be true on first run');
    // Must never be "no change" on first run
    assert.ok(!data.delta.noChange, 'no noChange flag on first run');
  } finally { cleanup(dir); }
});

test('brief+memory: first run TTY line says "no baseline", not "no change"', async () => {
  const dir = tmpDir();
  try {
    let printed = '';
    const out = makeOut({ json: false, tty: false, command: 'test', location: LOC,
      write: s => printed += s, writeErr: () => {} });
    const ctx = { http: makeAllClearHttp(), cfg: { loc: LOC, tz: 'Asia/Manila', currency: null }, out, now: NOW, memoryDir: dir };
    await run({ days: 7 }, ctx);
    assert.ok(printed.includes('no baseline'), 'TTY must say "no baseline"');
    assert.ok(!printed.toLowerCase().includes('no change'), 'TTY must NOT say "no change"');
  } finally { cleanup(dir); }
});

// ── A. Delta — second run (after baseline exists) ────────────────────────────

test('brief+memory: second run → delta.firstRun:false, baselineAt set', async () => {
  const dir = tmpDir();
  try {
    // First run — write baseline
    const { ctx: ctx1 } = makeCtx(makeAllClearHttp(), dir);
    await run({ days: 7 }, ctx1);

    // Second run — same NOW (so snapshot unchanged)
    const { ctx: ctx2, getPrinted } = makeCtx(makeAllClearHttp(), dir, { now: NOW + 3600000 });
    await run({ days: 7 }, ctx2);
    ctx2.out.flush();
    const { data } = JSON.parse(getPrinted());

    assert.ok(data.delta, 'data.delta present on second run');
    assert.equal(data.delta.firstRun, false, 'not firstRun on second run');
    assert.ok(typeof data.delta.baselineAt === 'number', 'baselineAt is number');
    assert.ok(typeof data.delta.ageMs === 'number', 'ageMs present');
    assert.ok(data.delta.ageMs > 0, 'ageMs > 0');
  } finally { cleanup(dir); }
});

test('brief+memory: baseline age always shown in delta (not hidden)', async () => {
  const dir = tmpDir();
  try {
    const { ctx: ctx1 } = makeCtx(makeAllClearHttp(), dir);
    await run({ days: 7 }, ctx1);

    const { ctx: ctx2, getPrinted } = makeCtx(makeAllClearHttp(), dir, { now: NOW + 18 * 3600000 });
    await run({ days: 7 }, ctx2);
    ctx2.out.flush();
    const { data } = JSON.parse(getPrinted());
    assert.ok(data.delta.ageMs >= 18 * 3600000, 'ageMs reflects 18h age');
  } finally { cleanup(dir); }
});

test('brief+memory: stale baseline (>7d) → delta.baselineStale:true', async () => {
  const dir = tmpDir();
  try {
    // Write a baseline 9 days ago
    recordRun(LOC, { snapshot: { leads: 3, bookings: 1 }, actions: [] }, NOW - 9 * 86400000, dir);

    const { ctx, getPrinted } = makeCtx(makeAllClearHttp(), dir);
    await run({ days: 7 }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    assert.equal(data.delta.firstRun, false);
    assert.equal(data.delta.baselineStale, true, 'stale flag set for 9d old baseline');
  } finally { cleanup(dir); }
});

// ── A. --no-memory ────────────────────────────────────────────────────────────

test('brief+memory: --no-memory → no delta in output', async () => {
  const dir = tmpDir();
  try {
    const { ctx, getPrinted } = makeCtx(makeAllClearHttp(), dir, { noMemory: true });
    await run({ days: 7, 'no-memory': true }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    assert.ok(!('delta' in data), 'delta absent with --no-memory');
  } finally { cleanup(dir); }
});

test('brief+memory: --no-memory skips baseline record (file not created)', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(makeAllClearHttp(), dir);
    await run({ days: 7, 'no-memory': true }, ctx);
    const { loadLast } = await import('../../lib/memory.mjs');
    const loaded = loadLast(LOC, dir);
    assert.strictEqual(loaded, null, 'baseline must not be written with --no-memory');
  } finally { cleanup(dir); }
});

// ── B. Ack/snooze — filtering from brief ─────────────────────────────────────

test('brief+ack: snoozed contact does not appear in actions', async () => {
  const dir = tmpDir();
  try {
    // Set up a snooze for a specific contact
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);

    const http = { get: async (path) => {
      if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [{ id: 'p1', name: 'P', stages: [{ id: 's1', name: 'Lead' }] }] } };
      if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [
        { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 50000, name: 'BigDeal', contactId: 'd1',
          updatedAt: new Date(NOW - 21 * 86400000).toISOString() },
      ] } };
      if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
      if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
      if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
      if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
      if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
      return { code: 200, ok: true, j: {} };
    }};

    const { ctx, getPrinted } = makeCtx(http, dir);
    await run({ days: 7 }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());

    const contacts = (data.actions || []).map(a => a.contact);
    assert.ok(!contacts.includes('d1'), 'snoozed contact d1 must not appear in actions');
  } finally { cleanup(dir); }
});

test('brief+ack: snoozedCount > 0 when items are suppressed', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);

    const http = { get: async (path) => {
      if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [{ id: 'p1', name: 'P', stages: [{ id: 's1', name: 'Lead' }] }] } };
      if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [
        { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 50000, name: 'BigDeal', contactId: 'd1',
          updatedAt: new Date(NOW - 21 * 86400000).toISOString() },
      ] } };
      if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
      if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
      if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
      if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
      if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
      return { code: 200, ok: true, j: {} };
    }};

    const { ctx, getPrinted } = makeCtx(http, dir);
    await run({ days: 7 }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    assert.ok(data.snoozedCount > 0, 'snoozedCount must be > 0 when items suppressed');
  } finally { cleanup(dir); }
});

test('brief+ack: --show-acked reveals snoozed items', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);

    const http = { get: async (path) => {
      if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [{ id: 'p1', name: 'P', stages: [{ id: 's1', name: 'Lead' }] }] } };
      if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [
        { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 50000, name: 'BigDeal', contactId: 'd1',
          updatedAt: new Date(NOW - 21 * 86400000).toISOString() },
      ] } };
      if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
      if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
      if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
      if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
      if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
      return { code: 200, ok: true, j: {} };
    }};

    const { ctx, getPrinted } = makeCtx(http, dir, { showAcked: true });
    await run({ days: 7, 'show-acked': true }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    const contacts = (data.actions || []).map(a => a.contact);
    assert.ok(contacts.includes('d1'), '--show-acked must reveal d1');
  } finally { cleanup(dir); }
});

test('brief+ack: TTY footer shows snoozed count when items suppressed', async () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'd1', { snoozeMs: 7 * 86400000 }, NOW, dir);

    const http = { get: async (path) => {
      if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [{ id: 'p1', name: 'P', stages: [{ id: 's1', name: 'Lead' }] }] } };
      if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [
        { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 50000, name: 'BigDeal', contactId: 'd1',
          updatedAt: new Date(NOW - 21 * 86400000).toISOString() },
      ] } };
      if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
      if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
      if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
      if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
      if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
      return { code: 200, ok: true, j: {} };
    }};

    let printed = '';
    const out = makeOut({ json: false, tty: false, command: 'test', location: LOC, write: s => printed += s, writeErr: () => {} });
    const ctx = { http, cfg: { loc: LOC, tz: 'Asia/Manila', currency: null }, out, now: NOW, memoryDir: dir };
    await run({ days: 7 }, ctx);

    assert.ok(printed.includes('snoozed'), 'TTY must show snoozed footer');
    assert.ok(printed.includes('ack --list'), 'TTY must point to ack --list');
  } finally { cleanup(dir); }
});

test('brief+ack: expired snooze auto-resurfaces (item returns to actions)', async () => {
  const dir = tmpDir();
  try {
    // Snooze expires in 100ms
    addSnooze(LOC, 'd1', { snoozeMs: 100 }, NOW, dir);

    const http = { get: async (path) => {
      if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [{ id: 'p1', name: 'P', stages: [{ id: 's1', name: 'Lead' }] }] } };
      if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [
        { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 50000, name: 'BigDeal', contactId: 'd1',
          updatedAt: new Date(NOW - 21 * 86400000).toISOString() },
      ] } };
      if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
      if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
      if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
      if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
      if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
      return { code: 200, ok: true, j: {} };
    }};

    // Run 1s after snooze: expired
    const { ctx, getPrinted } = makeCtx(http, dir, { now: NOW + 1000 });
    await run({ days: 7 }, ctx);
    ctx.out.flush();
    const { data } = JSON.parse(getPrinted());
    const contacts = (data.actions || []).map(a => a.contact);
    assert.ok(contacts.includes('d1'), 'expired snooze: d1 must resurface');
  } finally { cleanup(dir); }
});

// ── brief existing tests still pass with memory wired in ─────────────────────

test('brief+memory: run() still returns 0', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(makeAllClearHttp(), dir);
    const code = await run({ days: 7 }, ctx);
    assert.equal(code, 0);
  } finally { cleanup(dir); }
});

test('brief+memory: default envelope still has data.snapshot + data.actions (no regression)', async () => {
  const dir = tmpDir();
  try {
    const { ctx, getPrinted } = makeCtx(makeAllClearHttp(), dir);
    await run({ days: 7 }, ctx);
    ctx.out.flush();
    const envelope = JSON.parse(getPrinted());
    assert.ok('snapshot' in envelope.data, 'data.snapshot present');
    assert.ok(Array.isArray(envelope.data.actions), 'data.actions is array');
    assert.ok(!('_sources' in envelope.data), 'data._sources must not leak');
  } finally { cleanup(dir); }
});
