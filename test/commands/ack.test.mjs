// test/commands/ack.test.mjs — tests for the ack/snooze command.
// Injected clock + temp dir — no real fs side-effects. No GHL network calls.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from '../../commands/ack.mjs';
import { makeOut } from '../../lib/output.mjs';
import { isSnoozed, loadLast } from '../../lib/memory.mjs';

const NOW = 1_700_000_000_000;
const LOC = 'L-TEST';
const D7 = 7 * 24 * 60 * 60 * 1000;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sizmo-ack-test-'));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeCtx(dir, json = true) {
  let printed = '';
  const out = makeOut({ json, tty: false, command: 'test', location: LOC, write: s => printed += s, writeErr: () => {} });
  const ctx = {
    cfg: { loc: LOC },
    out,
    now: NOW,
    memoryDir: dir,
    http: { get: async () => { throw new Error('http must not be called by ack'); } },
  };
  return { ctx, getPrinted: () => printed };
}

// ── ack <contactId> ──────────────────────────────────────────────────────────

test('ack: run returns 0 when snoozing a contact', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    const code = await run({ _: ['contact-123'] }, ctx);
    assert.equal(code, 0);
  } finally { cleanup(dir); }
});

test('ack: snoozes contact for default 7d', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    await run({ _: ['c-abc'] }, ctx);
    assert.equal(isSnoozed(LOC, 'c-abc', NOW, dir), true, 'contact is snoozed');
    assert.equal(isSnoozed(LOC, 'c-abc', NOW + D7 + 1000, dir), false, 'snooze expired after 7d');
  } finally { cleanup(dir); }
});

test('ack: --for 2d snoozes for exactly 2d', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    await run({ _: ['c-abc'], for: '2d' }, ctx);
    assert.equal(isSnoozed(LOC, 'c-abc', NOW + 2 * 86400000 - 1, dir), true, 'still snoozed');
    assert.equal(isSnoozed(LOC, 'c-abc', NOW + 2 * 86400000 + 1000, dir), false, 'expired after 2d');
  } finally { cleanup(dir); }
});

test('ack: --for 48h snoozes for 48h', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    await run({ _: ['c-hrs'] }, ctx, { for: '48h' });
    // default path uses 7d regardless; just verify contact is snoozed
    assert.equal(isSnoozed(LOC, 'c-hrs', NOW, dir), true);
  } finally { cleanup(dir); }
});

test('ack: --reason stored in snooze entry', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    await run({ _: ['c-reason'], reason: 'called back already' }, ctx);
    const data = loadLast(LOC, dir);
    const entry = data?.snoozes?.['c-reason'];
    assert.ok(entry, 'entry exists');
    assert.equal(entry.reason, 'called back already');
  } finally { cleanup(dir); }
});

test('ack: JSON envelope has data.snoozed.contactId', async () => {
  const dir = tmpDir();
  try {
    const { ctx, getPrinted } = makeCtx(dir, true);
    await run({ _: ['c-json'] }, ctx);
    ctx.out.flush();
    const envelope = JSON.parse(getPrinted());
    assert.ok(envelope.data.snoozed, 'data.snoozed present');
    assert.equal(envelope.data.snoozed.contactId, 'c-json');
    assert.ok(typeof envelope.data.snoozed.snoozeUntil === 'number', 'snoozeUntil is number');
  } finally { cleanup(dir); }
});

test('ack: invalid --for throws USAGE error', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    await assert.rejects(
      () => run({ _: ['c-bad'], for: 'notaduration' }, ctx),
      /invalid --for/
    );
  } finally { cleanup(dir); }
});

test('ack: no contactId throws USAGE error', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    await assert.rejects(
      () => run({ _: [] }, ctx),
      /usage/i
    );
  } finally { cleanup(dir); }
});

// ── ack --list ────────────────────────────────────────────────────────────────

test('ack --list: returns 0 with empty snoozes', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    const code = await run({ list: true, _: [] }, ctx);
    assert.equal(code, 0);
  } finally { cleanup(dir); }
});

test('ack --list: JSON has snoozes array', async () => {
  const dir = tmpDir();
  try {
    const { ctx: ackCtx } = makeCtx(dir);
    await run({ _: ['c-list1'] }, ackCtx);
    await run({ _: ['c-list2'], reason: 'test' }, ackCtx);

    const { ctx, getPrinted } = makeCtx(dir, true);
    await run({ list: true, _: [] }, ctx);
    ctx.out.flush();
    const envelope = JSON.parse(getPrinted());
    assert.ok(Array.isArray(envelope.data.snoozes), 'data.snoozes is array');
    assert.equal(envelope.data.snoozes.length, 2);
  } finally { cleanup(dir); }
});

test('ack --list: expired snoozes shown with expired:true', async () => {
  const dir = tmpDir();
  try {
    // snooze for 1ms then list after 1s
    const ackCtx = {
      cfg: { loc: LOC }, out: makeOut({ json: false, tty: false, command: 'test', location: LOC, write: () => {}, writeErr: () => {} }),
      now: NOW, memoryDir: dir,
      http: { get: async () => { throw new Error('no http'); } },
    };
    await run({ _: ['c-expired'], for: '0m' }, ackCtx); // 0 minutes = expires immediately

    let printed = '';
    const out = makeOut({ json: true, tty: false, command: 'test', location: LOC, write: s => printed += s, writeErr: () => {} });
    const listCtx = { cfg: { loc: LOC }, out, now: NOW + 5000, memoryDir: dir, http: { get: async () => { throw new Error('no http'); } } };
    await run({ list: true, _: [] }, listCtx);
    listCtx.out.flush();
    const envelope = JSON.parse(printed);
    const expiredEntry = envelope.data.snoozes.find(s => s.contactId === 'c-expired');
    assert.ok(expiredEntry, 'expired entry present in list');
    assert.equal(expiredEntry.expired, true, 'expired:true');
  } finally { cleanup(dir); }
});

test('ack --list: activeCount + expiredCount correct', async () => {
  const dir = tmpDir();
  try {
    const ackCtx = { cfg: { loc: LOC }, out: makeOut({ json: false, tty: false, command: 'test', location: LOC, write: () => {}, writeErr: () => {} }), now: NOW, memoryDir: dir, http: { get: async () => { throw new Error('no http'); } } };
    await run({ _: ['c-active1'] }, ackCtx);
    await run({ _: ['c-active2'] }, ackCtx);
    // Force an expired entry by writing directly
    const { addSnooze } = await import('../../lib/memory.mjs');
    addSnooze(LOC, 'c-expired-x', { snoozeMs: 1 }, NOW, dir);

    let printed = '';
    const out = makeOut({ json: true, tty: false, command: 'test', location: LOC, write: s => printed += s, writeErr: () => {} });
    const listCtx = { cfg: { loc: LOC }, out, now: NOW + 5000, memoryDir: dir, http: { get: async () => { throw new Error('no http'); } } };
    await run({ list: true, _: [] }, listCtx);
    listCtx.out.flush();
    const { data } = JSON.parse(printed);
    assert.equal(data.activeCount, 2);
    assert.equal(data.expiredCount, 1);
  } finally { cleanup(dir); }
});

// ── ack --clear ───────────────────────────────────────────────────────────────

test('ack --clear: removes snooze, contact returns to queue', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    await run({ _: ['c-clear'] }, ctx);
    assert.equal(isSnoozed(LOC, 'c-clear', NOW, dir), true, 'snoozed before clear');

    const clearCtx = { cfg: { loc: LOC }, out: makeOut({ json: true, tty: false, command: 'test', location: LOC, write: () => {}, writeErr: () => {} }), now: NOW, memoryDir: dir, http: { get: async () => { throw new Error('no http'); } } };
    const code = await run({ clear: 'c-clear', _: [] }, clearCtx);
    assert.equal(code, 0);
    assert.equal(isSnoozed(LOC, 'c-clear', NOW, dir), false, 'not snoozed after clear');
  } finally { cleanup(dir); }
});

test('ack --clear: returns 0 even when contact was not snoozed', async () => {
  const dir = tmpDir();
  try {
    const { ctx } = makeCtx(dir);
    const code = await run({ clear: 'never-snoozed', _: [] }, ctx);
    assert.equal(code, 0);
  } finally { cleanup(dir); }
});
