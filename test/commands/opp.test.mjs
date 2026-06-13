// test/commands/opp.test.mjs
// Tests opp create / move / update.
// Name→id resolution via injected model. Unknown name → exit 3.
// No-confirm → exit 4 + envelope, no write fired.
// --confirm → write fires once, exit 0.
// 401/403 → exit 3.
// --dry-run → dry_run, no write.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/opp.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

// Minimal model with one pipeline + two stages
const MODEL = {
  schemaVersion: 1,
  locationId: 'L-TEST',
  syncedAt: 1_700_000_000_000,
  entities: {
    pipelines: {
      fetchedAt: 1_700_000_000_000,
      items: [
        {
          id: 'pl-001',
          name: 'Main Sales',
          stages: [
            { id: 'st-001', name: 'New Lead',  position: 0 },
            { id: 'st-002', name: 'Won',        position: 1 },
          ],
        },
      ],
    },
  },
};

// ── opp create — no --confirm ─────────────────────────────────────────────────

test('opp create: no --confirm → exit 4 + envelope, no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false, model: MODEL });
  const code = await run({ _: ['create'], name: 'Deal A', pipeline: 'Main Sales', stage: 'New Lead', contact: 'cid-x' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM, 'exit must be CONFIRM (4)');
  assert.equal(getCalledWrites().length, 0, 'no http write without --confirm');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');
  assert.ok(envelope.data.changes.some(c => /Deal A/.test(c)));
  assert.ok(envelope.data.changes.some(c => /Main Sales/.test(c)));
  assert.ok(envelope.data.changes.some(c => /New Lead/.test(c)));
  assert.ok(envelope.data.confirmCommand.includes('--confirm'));
});

// ── opp create — --confirm → write fires ─────────────────────────────────────

test('opp create: --confirm → POST fires once, exit 0', async () => {
  const fixture = { 'POST /opportunities/': { status: 200, j: { opportunity: { id: 'opp-new-001' } } } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  const code = await run({ _: ['create'], name: 'Deal A', pipeline: 'Main Sales', stage: 'New Lead', contact: 'cid-x' }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST')).length, 1);
});

// ── opp create — unknown pipeline → exit AUTH ─────────────────────────────────

test('opp create: unknown pipeline → exit AUTH (exit 3)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL });
  await assert.rejects(
    () => run({ _: ['create'], name: 'X', pipeline: 'Unknown Pipeline', stage: 'New Lead', contact: 'c' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/unknown pipeline/i.test(e.message)); return true; }
  );
});

// ── opp create — unknown stage → exit AUTH ────────────────────────────────────

test('opp create: unknown stage → exit AUTH (exit 3)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL });
  await assert.rejects(
    () => run({ _: ['create'], name: 'X', pipeline: 'Main Sales', stage: 'Nonexistent Stage', contact: 'c' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/unknown stage/i.test(e.message)); return true; }
  );
});

// ── opp create — 401/403 scope floor ─────────────────────────────────────────

test('opp create: 401 → exit AUTH + scope message', async () => {
  const fixture = { 'POST /opportunities/': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  await assert.rejects(
    () => run({ _: ['create'], name: 'D', pipeline: 'Main Sales', stage: 'New Lead', contact: 'c' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/opportunities\.write/.test(e.message)); return true; }
  );
});

// ── opp move — no --confirm ───────────────────────────────────────────────────

test('opp move: no --confirm → exit 4, no write fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: false, model: MODEL });
  const code = await run({ _: ['move', 'opp-123'], stage: 'Won' }, ctx);
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
});

// ── opp move — --confirm → write fires ───────────────────────────────────────

test('opp move: --confirm → PUT fires once, exit 0', async () => {
  const fixture = { 'PUT /opportunities/opp-123': { status: 200, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  const code = await run({ _: ['move', 'opp-123'], stage: 'Won' }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('PUT')).length, 1);
});

// ── opp move — unknown stage ──────────────────────────────────────────────────

test('opp move: unknown stage → exit AUTH', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL });
  await assert.rejects(
    () => run({ _: ['move', 'opp-123'], stage: 'Ghost Stage' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/unknown stage/i.test(e.message)); return true; }
  );
});

// ── opp move — 403 scope floor ────────────────────────────────────────────────

test('opp move: 403 → exit AUTH', async () => {
  const fixture = { 'PUT /opportunities/opp-123': { status: 403, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  await assert.rejects(
    () => run({ _: ['move', 'opp-123'], stage: 'Won' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); return true; }
  );
});

// ── opp update — no --confirm ─────────────────────────────────────────────────

test('opp update: no --confirm → exit 4, no write fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['update', 'opp-456'], value: '9000' }, ctx);
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
});

// ── opp update — --confirm → write fires ─────────────────────────────────────

test('opp update: --confirm → PUT fires once, exit 0', async () => {
  const fixture = { 'PUT /opportunities/opp-456': { status: 200, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['update', 'opp-456'], value: '9000' }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('PUT')).length, 1);
});

// ── opp update — invalid status ───────────────────────────────────────────────

test('opp update: invalid status → USAGE error', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false });
  await assert.rejects(
    () => run({ _: ['update', 'opp-x'], status: 'closed' }, ctx),
    /invalid.*status/i
  );
});

// ── opp update — 401 scope floor ─────────────────────────────────────────────

test('opp update: 401 → exit AUTH + scope message', async () => {
  const fixture = { 'PUT /opportunities/opp-456': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: ['update', 'opp-456'], status: 'won' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/opportunities\.write/.test(e.message)); return true; }
  );
});

// ── --dry-run across subtypes ──────────────────────────────────────────────────

test('opp create: --dry-run → status dry_run, no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true, model: MODEL });
  const code = await run({ _: ['create'], name: 'D', pipeline: 'Main Sales', stage: 'New Lead', contact: 'c' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().length, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
});

test('opp update: --dry-run → status dry_run, no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true });
  const code = await run({ _: ['update', 'opp-x'], value: '100' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().length, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
});

// ── usage errors ──────────────────────────────────────────────────────────────

test('opp: no subcommand → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [] }, ctx), /usage/i);
});

test('opp create: missing --name → USAGE error', async () => {
  const { ctx } = makeFakeCtx({ model: MODEL });
  await assert.rejects(() => run({ _: ['create'], pipeline: 'Main Sales', stage: 'New Lead', contact: 'c' }, ctx), /--name/i);
});

test('opp move: missing --stage → USAGE error', async () => {
  const { ctx } = makeFakeCtx({ model: MODEL });
  await assert.rejects(() => run({ _: ['move', 'opp-x'] }, ctx), /--stage/i);
});

test('opp update: no --value or --status → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: ['update', 'opp-x'] }, ctx), /--value|--status/i);
});
