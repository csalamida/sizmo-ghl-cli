// test/commands/business.test.mjs
// business had zero test coverage — and PR #7 changed its confirm behavior (replaced two manual
// ctx.confirmed checks with requireConfirm()) while it was still untested. These tests pin that
// behavior, especially --dry-run, which was the actual bug: it exited 5 instead of 0 and printed
// prose instead of the JSON confirm envelope, contradicting README's "works on all writes" claim.
//
// Covers: list (model path, empty, both blocked branches), create (usage, confirm gate, dry-run,
// confirm-fires, outgoing body shape, auth/API errors, id-missing fallback), delete
// (usage, fetch-first 401/404/error, confirm gate, dry-run, confirm-fires, delete-side errors).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/business.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const LOC = 'L-TEST';
const BIZ_ID = 'biz-001';

// ── list ──────────────────────────────────────────────────────────────────────

test('business list: items from model → EXIT.OK + envelope', async () => {
  const model = {
    entities: {
      businesses: {
        items: [
          { id: 'biz-001', name: 'Acme Corp', website: 'https://acme.com' },
          { id: 'biz-002', name: 'Globex' },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.entity, 'businesses');
  assert.equal(envelope.data.items.length, 2);
});

test('business list: default subcommand is list (no args at all)', async () => {
  const model = { entities: { businesses: { items: [{ id: 'b1', name: 'Solo' }] } } };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  // parsed._ omitted entirely — exercises the `parsed._?.[0] ?? 'list'` default
  const code = await run({}, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.items.length, 1);
});

test('business list: empty array → EXIT.OK with zero items', async () => {
  const model = { entities: { businesses: { items: [] } } };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  const code = await run({ _: ['list'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.items.length, 0);
});

test('business list: blocked without httpCode → throws AUTH (scope issue)', async () => {
  // Contract changed 2026-07-27: business throws GhlError like every other write command. The old
  // return-style meant --json emitted a success-shaped envelope on a hard 401.
  const model = { entities: { businesses: { blocked: true } } };
  const { ctx } = makeFakeCtx({ model });
  await assert.rejects(() => run({ _: ['list'] }, ctx), (e) => e.code === EXIT.AUTH);
});

test('business list: blocked WITH httpCode → throws API (real API error, not scope)', async () => {
  // The distinction matters: sync marks both the same way, but a 500 is not a missing scope and
  // telling the user to add a scope would send them down the wrong path.
  const model = { entities: { businesses: { blocked: true, httpCode: 500 } } };
  const { ctx } = makeFakeCtx({ model });
  await assert.rejects(() => run({ _: ['list'] }, ctx), (e) => e.code === EXIT.API);
});

// ── unknown subcommand ────────────────────────────────────────────────────────

test('business: unknown subcommand → EXIT.USAGE', async () => {
  const { ctx } = makeFakeCtx({});
  const code = await run({ _: ['frobnicate'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.USAGE);
});

// ── create ────────────────────────────────────────────────────────────────────

test('business create: missing --name → EXIT.USAGE, no write fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({});
  const code = await run({ _: ['create'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.USAGE);
  assert.equal(getCalledWrites().length, 0);
});

test('business create: whitespace-only --name → EXIT.USAGE (trimmed, not truthy)', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({});
  const code = await run({ _: ['create'], name: '   ' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.USAGE);
  assert.equal(getCalledWrites().length, 0);
});

test('business create: no --confirm → EXIT.CONFIRM envelope, no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({});
  const code = await run({ _: ['create'], name: 'Acme Corp' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');
  assert.equal(envelope.data.command, 'business create');
  assert.match(envelope.data.confirmCommand, /--confirm$/);
  assert.equal(getCalledWrites().length, 0, 'must not write without --confirm');
});

test('business create: --dry-run → EXIT.OK, dry_run envelope, still no write', async () => {
  // This is the PR #7 bug, pinned: business.mjs bypassed requireConfirm and checked ctx.confirmed
  // directly, so --dry-run fell through to exit 5 with prose instead of exit 0 with the envelope.
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true });
  const code = await run({ _: ['create'], name: 'Acme Corp' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK, '--dry-run must exit 0, not 5');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
  assert.equal(getCalledWrites().length, 0, 'dry run must never write');
});

test('business create: --confirm fires POST with the exact expected body', async () => {
  const { ctx, getPrinted, getCalledBodies } = makeFakeCtx({
    confirmed: true,
    fixture: { 'POST /businesses/': { status: 200, j: { business: { id: BIZ_ID, name: 'Acme Corp' } } } },
  });
  const code = await run({
    _: ['create'], name: 'Acme Corp', email: 'hi@acme.com', phone: '+15550101', website: 'https://acme.com',
  }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);

  // Assert the real outgoing shape — a wrong field name is invisible if you only check "a call happened".
  const [wrote] = getCalledBodies();
  assert.equal(wrote.method, 'POST');
  assert.equal(wrote.path, '/businesses/');
  assert.deepEqual(wrote.body, {
    name: 'Acme Corp',
    locationId: LOC,
    email: 'hi@acme.com',
    phone: '+15550101',
    website: 'https://acme.com',
  });
  assert.equal(JSON.parse(getPrinted()).data.id, BIZ_ID);
});

test('business create: optional fields omitted entirely when not passed', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true,
    fixture: { 'POST /businesses/': { status: 200, j: { business: { id: BIZ_ID } } } },
  });
  await run({ _: ['create'], name: 'Bare' }, ctx);
  ctx.out.flush();
  const [wrote] = getCalledBodies();
  assert.deepEqual(Object.keys(wrote.body).sort(), ['locationId', 'name'],
    'absent optional flags must not appear as undefined/null keys');
});

test('business create: 401 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({
    confirmed: true,
    fixture: { 'POST /businesses/': { status: 401, j: {} } },
  });
  await assert.rejects(() => run({ _: ['create'], name: 'Acme' }, ctx), (e) => e.code === EXIT.AUTH);
});

test('business create: 403 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({
    confirmed: true,
    fixture: { 'POST /businesses/': { status: 403, j: {} } },
  });
  await assert.rejects(() => run({ _: ['create'], name: 'Acme' }, ctx), (e) => e.code === EXIT.AUTH);
});

test('business create: 422 → EXIT.API', async () => {
  const { ctx } = makeFakeCtx({
    confirmed: true,
    fixture: { 'POST /businesses/': { status: 422, j: { message: 'name taken' } } },
  });
  await assert.rejects(() => run({ _: ['create'], name: 'Acme' }, ctx), (e) => e.code === EXIT.API);
});

test('business create: 200 but no id in response → still EXIT.OK, id null', async () => {
  // GHL has returned bodies without an id here; the command deliberately degrades to a hint
  // rather than failing, so pin that rather than assuming an id is always present.
  const { ctx, getPrinted } = makeFakeCtx({
    confirmed: true,
    fixture: { 'POST /businesses/': { status: 200, j: {} } },
  });
  const code = await run({ _: ['create'], name: 'Acme' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.id, null);
});

// ── delete ────────────────────────────────────────────────────────────────────

test('business delete: missing id → EXIT.USAGE, nothing fetched or written', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({});
  const code = await run({ _: ['delete'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.USAGE);
  assert.equal(getCalledPaths().length, 0);
});

test('business delete: fetch 404 → EXIT.NOTFOUND, no DELETE fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({
    confirmed: true,
    fixture: { [`GET /businesses/${BIZ_ID}`]: { status: 404, j: {} } },
  });
  await assert.rejects(() => run({ _: ['delete', BIZ_ID] }, ctx), (e) => e.code === EXIT.NOTFOUND);
  assert.equal(getCalledWrites().length, 0);
});

test('business delete: fetch 401 → EXIT.AUTH, no DELETE fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({
    confirmed: true,
    fixture: { [`GET /businesses/${BIZ_ID}`]: { status: 401, j: {} } },
  });
  await assert.rejects(() => run({ _: ['delete', BIZ_ID] }, ctx), (e) => e.code === EXIT.AUTH);
  assert.equal(getCalledWrites().length, 0);
});

test('business delete: fetch 500 → EXIT.API, no DELETE fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({
    confirmed: true,
    fixture: { [`GET /businesses/${BIZ_ID}`]: { status: 500, j: {} } },
  });
  await assert.rejects(() => run({ _: ['delete', BIZ_ID] }, ctx), (e) => e.code === EXIT.API);
  assert.equal(getCalledWrites().length, 0);
});

test('business delete: no --confirm → EXIT.CONFIRM after fetch, no DELETE fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({
    fixture: { [`GET /businesses/${BIZ_ID}`]: { status: 200, j: { business: { id: BIZ_ID, name: 'Acme Corp' } } } },
  });
  const code = await run({ _: ['delete', BIZ_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');
  assert.equal(envelope.data.command, 'business delete');
  // The resolved NAME must reach the preview, not just the raw id — that's the point of fetch-first.
  assert.ok(envelope.data.changes.some(c => c.includes('Acme Corp')),
    'preview must show the resolved business name so the human confirms the right record');
  assert.equal(getCalledWrites().length, 0);
});

test('business delete: --dry-run → EXIT.OK, dry_run envelope, no DELETE fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({
    dryRun: true,
    fixture: { [`GET /businesses/${BIZ_ID}`]: { status: 200, j: { business: { id: BIZ_ID, name: 'Acme Corp' } } } },
  });
  const code = await run({ _: ['delete', BIZ_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK, '--dry-run must exit 0, not 5');
  assert.equal(JSON.parse(getPrinted()).data.status, 'dry_run');
  assert.equal(getCalledWrites().length, 0, 'dry run must never delete');
});

test('business delete: --confirm fires DELETE and reports the name', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({
    confirmed: true,
    fixture: {
      [`GET /businesses/${BIZ_ID}`]:    { status: 200, j: { business: { id: BIZ_ID, name: 'Acme Corp' } } },
      [`DELETE /businesses/${BIZ_ID}`]: { status: 200, j: { succeded: true } },
    },
  });
  const code = await run({ _: ['delete', BIZ_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites(), [`DELETE /businesses/${BIZ_ID}`]);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.deleted, true);
  assert.equal(envelope.data.name, 'Acme Corp');
});

test('business delete: DELETE returns 404 → EXIT.NOTFOUND (already deleted)', async () => {
  const { ctx } = makeFakeCtx({
    confirmed: true,
    fixture: {
      [`GET /businesses/${BIZ_ID}`]:    { status: 200, j: { business: { id: BIZ_ID, name: 'Acme Corp' } } },
      [`DELETE /businesses/${BIZ_ID}`]: { status: 404, j: {} },
    },
  });
  await assert.rejects(() => run({ _: ['delete', BIZ_ID] }, ctx), (e) => e.code === EXIT.NOTFOUND);
});

test('business delete: DELETE returns 403 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({
    confirmed: true,
    fixture: {
      [`GET /businesses/${BIZ_ID}`]:    { status: 200, j: { business: { id: BIZ_ID, name: 'Acme Corp' } } },
      [`DELETE /businesses/${BIZ_ID}`]: { status: 403, j: {} },
    },
  });
  await assert.rejects(() => run({ _: ['delete', BIZ_ID] }, ctx), (e) => e.code === EXIT.AUTH);
});

test('business delete: id is URL-encoded in both fetch and delete paths', async () => {
  // A raw id with a slash or space would otherwise silently hit the wrong endpoint.
  const weird = 'biz 001/x';
  const enc = encodeURIComponent(weird);
  const { ctx, getCalledPaths } = makeFakeCtx({
    confirmed: true,
    fixture: {
      [`GET /businesses/${enc}`]:    { status: 200, j: { business: { id: weird, name: 'Weird' } } },
      [`DELETE /businesses/${enc}`]: { status: 200, j: {} },
    },
  });
  const code = await run({ _: ['delete', weird] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths().every(p => !p.includes('biz 001/x')), 'raw id must never reach the URL');
});
