// test/commands/list.test.mjs
// list had zero test coverage despite being the "get me the ID" entry point every other write
// command depends on. Tests target the branching logic that carries real risk, not the table
// renderers: the three-way blocked/not-synced/empty distinction, the live-fetch values path,
// truncation + --all, and userMap resolution. A wrong answer here sends the user to the wrong id.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/list.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const LOC = 'L-TEST';
const valuesUrl = `GET /locations/${LOC}/customValues`;

// ── entity validation ─────────────────────────────────────────────────────────

test('list: unknown entity → EXIT.USAGE', async () => {
  const { ctx } = makeFakeCtx({ model: { entities: {} } });
  const code = await run({ _: ['frobnicate'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.USAGE);
});

test('list: no entity → overview, EXIT.OK', async () => {
  const model = { entities: { pipelines: { items: [{ id: 'p1', name: 'Sales' }] } } };
  const { ctx } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
});

// ── the three-way distinction: blocked-scope vs blocked-API vs not-synced ─────
// This exact distinction has produced repeat bugs across commands. Telling a user to add a
// scope when they actually hit a 500 sends them to fix permissions that are already correct.

test('list tags: blocked without httpCode → EXIT.AUTH and names the scope', async () => {
  const model = { entities: { tags: { blocked: true, scope: 'locations.readonly' } } };
  const { ctx, getPrinted } = makeFakeCtx({ model, json: false });
  const code = await run({ _: ['tags'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH);
  assert.ok(getPrinted().includes('locations.readonly'), 'must name the missing scope, not just say blocked');
});

test('list tags: blocked WITH httpCode → EXIT.API and does NOT blame scope', async () => {
  const model = { entities: { tags: { blocked: true, scope: 'locations.readonly', httpCode: 500 } } };
  const { ctx, getPrinted } = makeFakeCtx({ model, json: false });
  const code = await run({ _: ['tags'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.API);
  const printed = getPrinted();
  assert.ok(printed.includes('500'), 'must surface the real status');
  assert.ok(!printed.includes('needs locations.readonly'),
    'a 500 is not a scope problem — must not tell the user to add a scope');
});

test('list forms: entity absent from model → EXIT.OK with "run sizmo sync" (not an error)', async () => {
  // "Never synced" is not a failure — a model synced before forms support simply lacks the key.
  // Returning AUTH/API here would make a stale cache look like a permissions problem.
  const { ctx, getPrinted } = makeFakeCtx({ model: { entities: {} }, json: false });
  const code = await run({ _: ['forms'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(/sizmo sync/.test(getPrinted()), 'must tell the user to sync');
});

test('list forms: present but empty → EXIT.OK, zero items (distinct from not-synced)', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ model: { entities: { forms: { items: [] } } } });
  const code = await run({ _: ['forms'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.items.length, 0);
});

// ── truncation + --all ────────────────────────────────────────────────────────

test('list tags: truncates at 40 and flags truncated:true, items still complete', async () => {
  const items = Array.from({ length: 55 }, (_, i) => ({ name: `tag-${i}` }));
  const { ctx, getPrinted } = makeFakeCtx({ model: { entities: { tags: { items } } } });
  const code = await run({ _: ['tags'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.total, 55);
  assert.equal(d.truncated, true);
  assert.equal(d.items.length, 55, 'JSON payload must carry ALL items — truncation is display-only');
});

test('list tags --all: truncated:false', async () => {
  const items = Array.from({ length: 55 }, (_, i) => ({ name: `tag-${i}` }));
  const { ctx, getPrinted } = makeFakeCtx({ model: { entities: { tags: { items } } } });
  const code = await run({ _: ['tags'], all: true }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.truncated, false);
});

test('list tags: accepts string items as well as objects', async () => {
  // The tags entity has shipped both shapes; a renderer assuming .name would print blanks.
  const { ctx, getPrinted } = makeFakeCtx({
    model: { entities: { tags: { items: ['vip', 'lead'] } } }, json: false,
  });
  const code = await run({ _: ['tags'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const printed = getPrinted();
  assert.ok(printed.includes('vip') && printed.includes('lead'));
});

// ── calendars + userMap resolution ────────────────────────────────────────────

test('list calendars: resolves team member ids to user names via the model', async () => {
  const model = {
    entities: {
      users: { items: [{ id: 'u1', firstName: 'Ana', lastName: 'Cruz' }] },
      calendars: { items: [{ id: 'c1', name: 'Intro Call', teamMembers: [{ userId: 'u1' }] }] },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model, json: false });
  const code = await run({ _: ['calendars'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getPrinted().includes('Ana Cruz'), 'must show the name, not the raw user id');
});

test('list calendars: unknown team member id falls back to the raw id, not blank', async () => {
  const model = {
    entities: {
      users: { items: [] },
      calendars: { items: [{ id: 'c1', name: 'Intro Call', teamMembers: [{ userId: 'u-ghost' }] }] },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model, json: false });
  await run({ _: ['calendars'] }, ctx);
  ctx.out.flush();
  assert.ok(getPrinted().includes('u-ghost'), 'unresolvable id must stay visible, never render empty');
});

test('list calendars: no team members → em dash', async () => {
  const model = {
    entities: { users: { items: [] }, calendars: { items: [{ id: 'c1', name: 'Solo' }] } },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model, json: false });
  const code = await run({ _: ['calendars'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getPrinted().includes('—'));
});

// ── pipelines (nested stages) ─────────────────────────────────────────────────

test('list pipelines: emits stages nested under each pipeline', async () => {
  const model = {
    entities: {
      pipelines: {
        items: [{
          id: 'p1', name: 'Sales',
          stages: [{ id: 's1', name: 'New', position: 0 }, { id: 's2', name: 'Won', position: 1 }],
        }],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  const code = await run({ _: ['pipelines'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.items[0].stages.length, 2);
});

// ── values: the one live-fetch entity (not model-backed) ──────────────────────

test('list values: live fetch, never touches the model', async () => {
  const { ctx, getPrinted, getCalledPaths } = makeFakeCtx({
    model: { entities: {} },
    fixture: { [valuesUrl]: { status: 200, j: { customValues: [{ id: 'v1', name: 'Booking Link', value: 'https://x' }] } } },
  });
  const code = await run({ _: ['values'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.entity, 'customValues');
  assert.deepEqual(getCalledPaths(), [valuesUrl]);
});

test('list values: 401 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({
    model: { entities: {} },
    fixture: { [valuesUrl]: { status: 401, j: {} } },
  });
  const code = await run({ _: ['values'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH);
});

test('list values: 403 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({
    model: { entities: {} },
    fixture: { [valuesUrl]: { status: 403, j: {} } },
  });
  const code = await run({ _: ['values'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH);
});

test('list values: missing customValues key → EXIT.OK, empty (never throws)', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    model: { entities: {} },
    fixture: { [valuesUrl]: { status: 200, j: {} } },
  });
  const code = await run({ _: ['values'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.items.length, 0);
});

// ── objects ───────────────────────────────────────────────────────────────────

test('list objects: prefers labels.singular, falls back through label/key', async () => {
  const model = {
    entities: {
      objects: {
        items: [
          { key: 'pet', labels: { singular: 'Pet' }, fields: [{ id: 'f1' }] },
          { key: 'car' },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model, json: false });
  const code = await run({ _: ['objects'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const printed = getPrinted();
  assert.ok(printed.includes('Pet'), 'labels.singular wins when present');
  assert.ok(printed.includes('car'), 'falls back to key when no label');
});

// ── --all expanded ────────────────────────────────────────────────────────────

test('list --all with no entity: expands every section, EXIT.OK', async () => {
  const model = {
    entities: {
      pipelines: { items: [] }, calendars: { items: [] }, tags: { items: [] },
      customFields: { items: [] }, users: { items: [] }, forms: { items: [] },
      surveys: { items: [] }, products: { items: [] }, links: { items: [] },
      businesses: { items: [] }, objects: { items: [] },
    },
  };
  const { ctx } = makeFakeCtx({ model });
  const code = await run({ _: [], all: true }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
});
