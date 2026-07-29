// test/client/memory-concurrency.test.mjs
//
// lib/memory.mjs changes state by read-modify-write: load the whole file, change one key, write
// it back. writeAtomic makes each WRITE atomic — the file never lands corrupt — but an atomic
// write is not an atomic UPDATE. Two processes that both read before either writes each hold a
// stale copy, and the second write silently discards the first one's change.
//
// Measured 2026-07-30 with 12 REAL parallel `addSnooze` processes, each acking a different
// contact, three consecutive runs:
//     7/12 survived · 9/12 survived · 9/12 survived
// Every process exited 0, so the user read "snoozed c4" for a contact that was not snoozed.
//
// These tests spawn genuinely separate OS processes. An in-process test cannot see this bug at
// all: the whole read-modify-write is synchronous, so a single event loop can never interleave
// two of them. The concurrency has to be real or the test is theatre.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEMORY = join(REPO, 'lib', 'memory.mjs');

// Run N separate node processes that all mutate the SAME memory file at the same time.
// `body` is module source; each child gets its contact id via PROBE_CONTACT so nothing depends
// on argv positioning (a first draft passed it as argv[2], which lands nowhere under `-e`, so all
// 12 children wrote contactId `undefined` and the run "proved" a 1/12 result that was pure
// artifact — verify the probe before believing the probe).
async function fanOut(n, dir, body) {
  const src = `import * as M from ${JSON.stringify(MEMORY)};\n` +
              `const id = process.env.PROBE_CONTACT;\n` +
              `if (!id) { console.error('probe broken: no PROBE_CONTACT'); process.exit(9); }\n` +
              `const DIR = ${JSON.stringify(dir)};\n${body}\n`;
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise((res) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', src],
                    { stdio: ['ignore', 'ignore', 'inherit'],
                      env: { ...process.env, PROBE_CONTACT: `c${i}` } });
    p.on('exit', (code) => res(code));
  })));
}

const LOC = 'locCONCURRENT';
function snoozeKeys(dir) {
  const f = join(dir, `${LOC}.json`);
  if (!existsSync(f)) return [];
  return Object.keys(JSON.parse(readFileSync(f, 'utf8')).snoozes || {}).sort();
}
function tmp() { return mkdtempSync(join(tmpdir(), 'sizmo-mem-conc-')); }

// The lock file withLock actually creates. Note the LEADING DOT — a first draft of the two
// lock-behaviour tests below used `locCONCURRENT.json.lock` without it, so they planted a file the
// implementation never looks at. The stale-lock test then PASSED while testing nothing at all. The
// fresh-lock test is what exposed it, and is why both now derive the path from here: a wrong path
// cannot pass 'a FRESH lock ... is respected'.
const lockPath = (dir) => join(dir, `.${LOC}.json.lock`);

test('12 concurrent acks all survive — no lost updates', async () => {
  const dir = tmp();
  try {
    const codes = await fanOut(12, dir,
      `M.addSnooze('${LOC}', id, { reason: 'probe' }, Date.now(), DIR);`);
    assert.deepEqual(codes.filter(c => c !== 0), [],
      `a child failed — probe is broken, not the code (exit codes: ${codes.join(',')})`);
    const kept = snoozeKeys(dir);
    const expected = Array.from({ length: 12 }, (_, i) => `c${i}`).sort();
    assert.deepEqual(kept, expected,
      `${expected.length - kept.length} of 12 acks were silently lost. Every process exited 0, so ` +
      `the user was told the item was snoozed and it was not. Missing: ` +
      `${expected.filter(k => !kept.includes(k)).join(',')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a concurrent baseline write does not drop an ack', async () => {
  // recordRun reads existing.snoozes and writes it back, so an unlocked `brief` racing an `ack`
  // loses the ack just as surely as two acks racing each other. Half the children ack, half
  // record a baseline, all against one file.
  const dir = tmp();
  try {
    const codes = await fanOut(12, dir, `
      const n = Number(id.slice(1));
      if (n % 2 === 0) M.addSnooze('${LOC}', id, { reason: 'probe' }, Date.now(), DIR);
      else M.recordRun('${LOC}', { snapshot: { leads: n }, actions: [] }, Date.now(), DIR);
    `);
    assert.deepEqual(codes.filter(c => c !== 0), [], `a child failed: ${codes.join(',')}`);
    const kept = snoozeKeys(dir);
    const expected = ['c0', 'c10', 'c2', 'c4', 'c6', 'c8'];
    assert.deepEqual(kept, expected,
      `a baseline write clobbered acks made by another process. Missing: ` +
      `${expected.filter(k => !kept.includes(k)).join(',')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the file is always valid JSON under concurrent writers', async () => {
  // The inverse guard for the fix itself. A lock that serialises writes must not introduce a
  // window where a reader sees a partial file — writeAtomic's temp+rename is what prevents that,
  // and the lock must not have replaced it with a direct write.
  const dir = tmp();
  try {
    await fanOut(16, dir, `M.addSnooze('${LOC}', id, {}, Date.now(), DIR);`);
    const raw = readFileSync(join(dir, `${LOC}.json`), 'utf8');
    const db = JSON.parse(raw);            // throws if a partial write ever landed
    assert.equal(db.schemaVersion, 1);
    assert.equal(db.locationId, LOC);
    assert.equal(Object.keys(db.snoozes).length, 16);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no lock file is left behind after a successful mutation', async () => {
  // A leaked lock would make every later ack pay the full 10s stale-break before it could work.
  const dir = tmp();
  try {
    await fanOut(4, dir, `M.addSnooze('${LOC}', id, {}, Date.now(), DIR);`);
    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(dir).filter(f => f.endsWith('.lock'));
    assert.deepEqual(leftovers, [], `lock file(s) left behind: ${leftovers.join(',')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale lock is broken, not waited on forever', async () => {
  // If a process dies mid-update its lock file survives. Without stale-breaking, one crash makes
  // `sizmo ack` permanently unusable for that location — a worse outcome than the bug fixed here.
  const dir = tmp();
  try {
    const { writeFileSync, utimesSync, mkdirSync } = await import('node:fs');
    const lock = lockPath(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, '999999');
    const old = new Date(Date.now() - 60_000);      // 60s old: well past the 10s stale threshold
    utimesSync(lock, old, old);
    const { addSnooze } = await import('../../lib/memory.mjs');
    const started = Date.now();
    addSnooze(LOC, 'cStale', {}, Date.now(), dir);
    const elapsed = Date.now() - started;
    assert.deepEqual(snoozeKeys(dir), ['cStale'], 'the stale lock blocked the write entirely');
    assert.ok(elapsed < 2000,
      `waited ${elapsed}ms on a lock that was 60s old — a dead holder must be broken, not waited on`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a FRESH lock held by someone else is respected, not stolen', async () => {
  // The inverse of stale-breaking: if the threshold were dropped to zero, every racer would steal
  // every lock and the fix would do nothing. A fresh lock must make the caller wait and then fail
  // loudly, never proceed unlocked.
  const dir = tmp();
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath(dir), '999999');                   // mtime = now
    const { addSnooze } = await import('../../lib/memory.mjs');
    const { EXIT } = await import('../../lib/errors.mjs');
    assert.throws(() => addSnooze(LOC, 'cFresh', {}, Date.now(), dir),
      (e) => e.lockTimeout === true && e.code === EXIT.API && e.name === 'GhlError',
      'a held lock must fail loudly as a typed error (so ack renders a real envelope and exit ' +
      'code), never silently proceed unlocked');
    assert.deepEqual(snoozeKeys(dir), [],
      'the write went through despite a held lock — the lock is not actually gating anything');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
