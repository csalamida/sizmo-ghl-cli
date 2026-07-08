// test/commands/opp.test.mjs
// Tests opp create / move / update.
// Name→id resolution via injected model. Unknown name → exit 3.
// No-confirm → exit 5 (CONFIRM) + envelope, no write fired.
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
  assert.equal(code, EXIT.CONFIRM, 'exit must be CONFIRM (5)');
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

test('opp create: request body includes locationId and pipelineStageId (NOT stageId) — verified live against the real API', async () => {
  const fixture = { 'POST /opportunities/': { status: 200, j: { opportunity: { id: 'opp-new-001' } } } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, loc: 'L-TEST', model: MODEL, fixture });
  await run({ _: ['create'], name: 'Deal A', pipeline: 'Main Sales', stage: 'New Lead', contact: 'cid-x' }, ctx);
  const body = getCalledBodies().find(b => b.method === 'POST').body;
  assert.equal(body.locationId, 'L-TEST', 'GHL rejects create with 422 "locationId can\'t be undefined" if missing');
  assert.equal(body.pipelineStageId, 'st-001', 'GHL rejects create with 422 "property stageId should not exist" — field is pipelineStageId');
  assert.equal(body.stageId, undefined, 'must NOT send the wrong field name');
});

// A model miss now falls back to a live fetch (2026-07-05 fix) before declaring NOTFOUND —
// mirror MODEL's content so the "genuinely unknown" tests below still prove nothing found live.
const LIVE_PIPELINES_FIXTURE = {
  'GET /opportunities/pipelines?locationId=L-TEST': {
    status: 200, j: { pipelines: [
      { id: 'pl-001', name: 'Main Sales', stages: [
        { id: 'st-001', name: 'New Lead', position: 0 },
        { id: 'st-002', name: 'Won', position: 1 },
      ] },
    ] },
  },
};

// ── opp create — unknown pipeline → exit NOTFOUND ────────────────────────────

test('opp create: unknown pipeline → falls back to a live fetch, still NOTFOUND when truly absent there too', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL, fixture: LIVE_PIPELINES_FIXTURE });
  await assert.rejects(
    () => run({ _: ['create'], name: 'X', pipeline: 'Unknown Pipeline', stage: 'New Lead', contact: 'c' }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); assert.ok(/unknown pipeline/i.test(e.message)); return true; }
  );
});

test('opp create: resolves a pipeline the model does NOT have via the live fallback', async () => {
  const fixture = {
    'GET /opportunities/pipelines?locationId=L-TEST': {
      status: 200, j: { pipelines: [{ id: 'pl-999', name: 'Brand New Pipeline', stages: [{ id: 'st-999', name: 'Intake', position: 0 }] }] },
    },
    'POST /opportunities/': { status: 200, j: { opportunity: { id: 'opp-live-1' } } },
  };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  const code = await run({ _: ['create'], name: 'X', pipeline: 'Brand New Pipeline', stage: 'Intake', contact: 'c' }, ctx);
  assert.equal(code, EXIT.OK);
  const body = getCalledBodies().find(b => b.path === '/opportunities/').body;
  assert.equal(body.pipelineId, 'pl-999');
  assert.equal(body.pipelineStageId, 'st-999');
});

// ── opp create — unknown stage → exit NOTFOUND ───────────────────────────────

test('opp create: unknown stage → falls back to a live fetch, still NOTFOUND when truly absent there too', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL, fixture: LIVE_PIPELINES_FIXTURE });
  await assert.rejects(
    () => run({ _: ['create'], name: 'X', pipeline: 'Main Sales', stage: 'Nonexistent Stage', contact: 'c' }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); assert.ok(/unknown stage/i.test(e.message)); return true; }
  );
});

test('opp create: resolves a stage the model does NOT have (existing pipeline, new stage) via the live fallback', async () => {
  const fixture = {
    'GET /opportunities/pipelines?locationId=L-TEST': {
      status: 200, j: { pipelines: [
        { id: 'pl-001', name: 'Main Sales', stages: [
          { id: 'st-001', name: 'New Lead', position: 0 },
          { id: 'st-002', name: 'Won', position: 1 },
          { id: 'st-003', name: 'Brand New Stage', position: 2 },
        ] },
      ] },
    },
    'POST /opportunities/': { status: 200, j: { opportunity: { id: 'opp-live-2' } } },
  };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  const code = await run({ _: ['create'], name: 'X', pipeline: 'Main Sales', stage: 'Brand New Stage', contact: 'c' }, ctx);
  assert.equal(code, EXIT.OK);
  const body = getCalledBodies().find(b => b.path === '/opportunities/').body;
  assert.equal(body.pipelineStageId, 'st-003');
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

test('opp move: request body uses pipelineStageId (NOT stageId) — verified live, stageId 422s the real API', async () => {
  const fixture = { 'PUT /opportunities/opp-123': { status: 200, j: {} } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  await run({ _: ['move', 'opp-123'], stage: 'Won' }, ctx);
  const body = getCalledBodies().find(b => b.method === 'PUT').body;
  assert.equal(body.pipelineStageId, 'st-002');
  assert.equal(body.stageId, undefined, 'must NOT send the wrong field name');
});

// ── opp move — unknown stage ──────────────────────────────────────────────────

test('opp move: unknown stage → falls back to a live fetch, still NOTFOUND when truly absent there too', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL, fixture: LIVE_PIPELINES_FIXTURE });
  await assert.rejects(
    () => run({ _: ['move', 'opp-123'], stage: 'Ghost Stage' }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); assert.ok(/unknown stage/i.test(e.message)); return true; }
  );
});

test('opp move: resolves a stage the model does NOT have via the live fallback', async () => {
  const fixture = {
    'GET /opportunities/pipelines?locationId=L-TEST': {
      status: 200, j: { pipelines: [
        { id: 'pl-001', name: 'Main Sales', stages: [
          { id: 'st-001', name: 'New Lead', position: 0 },
          { id: 'st-002', name: 'Won', position: 1 },
          { id: 'st-003', name: 'Brand New Stage', position: 2 },
        ] },
      ] },
    },
    'PUT /opportunities/opp-123': { status: 200, j: {} },
  };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  const code = await run({ _: ['move', 'opp-123'], stage: 'Brand New Stage' }, ctx);
  assert.equal(code, EXIT.OK);
  const body = getCalledBodies().find(b => b.method === 'PUT').body;
  assert.equal(body.pipelineStageId, 'st-003');
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

// ── delete — single-target, fetch-first ─────────────────────────────────────

test('opp delete: no id → USAGE (never bulk)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['delete'] }, ctx), /exactly one id/i);
});

test('opp delete: wrong id → NOTFOUND, nothing deleted', async () => {
  const fixture = { 'GET /opportunities/nope': { status: 404, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['delete', 'nope'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); return true; });
  assert.equal(getCalledWrites().filter(w => w.startsWith('DELETE')).length, 0, 'no DELETE on a bad id');
});

test('opp delete: --confirm → fetch-then-delete, names it, single DELETE', async () => {
  const fixture = {
    'GET /opportunities/opp-9': { status: 200, j: { opportunity: { id: 'opp-9', name: 'Big Deal' } } },
    'DELETE /opportunities/opp-9': { status: 200, j: {} },
  };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['delete', 'opp-9'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites().filter(w => w.startsWith('DELETE')), ['DELETE /opportunities/opp-9']);
  assert.equal(JSON.parse(getPrinted()).data.name, 'Big Deal');
});

test('opp delete: no --confirm → CONFIRM (5), names the target, no DELETE', async () => {
  const fixture = { 'GET /opportunities/opp-9': { status: 200, j: { opportunity: { id: 'opp-9', name: 'Big Deal' } } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false, fixture });
  const code = await run({ _: ['delete', 'opp-9'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().filter(w => w.startsWith('DELETE')).length, 0);
  assert.ok(JSON.parse(getPrinted()).data.changes.some(c => /Delete opportunity "Big Deal"/.test(c)));
});
