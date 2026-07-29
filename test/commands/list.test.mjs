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

test('list: unknown entity → throws USAGE (not a returned code)', async () => {
  // CONTRACT CHANGE 2026-07-27. list's AUTH/API paths were converted to GhlError earlier; this
  // USAGE path was missed, so `sizmo list frobnicate --json` printed a success-shaped envelope on
  // stdout while exiting 2. Now it throws, so --json gets {error, code, remediation} on stderr.
  const { ctx } = makeFakeCtx({ model: { entities: {} } });
  await assert.rejects(() => run({ _: ['frobnicate'] }, ctx),
    (e) => e.code === EXIT.USAGE && /frobnicate/.test(e.message));
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

test('list tags: blocked without httpCode → throws AUTH and names the scope', async () => {
  const model = { entities: { tags: { blocked: true, scope: 'locations.readonly' } } };
  const { ctx } = makeFakeCtx({ model, json: false });
  await assert.rejects(() => run({ _: ['tags'] }, ctx),
    (e) => e.code === EXIT.AUTH && e.message.includes('locations.readonly'));
});

test('list tags: blocked WITH httpCode → throws API and does NOT blame the scope', async () => {
  const model = { entities: { tags: { blocked: true, scope: 'locations.readonly', httpCode: 500 } } };
  const { ctx } = makeFakeCtx({ model, json: false });
  await assert.rejects(() => run({ _: ['tags'] }, ctx),
    (e) => e.code === EXIT.API
        && e.message.includes('500')
        && !e.message.includes('lacks locations.readonly'));
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

test('list tags: display truncates at 40, JSON carries all 55 and truncated stays false', async () => {
  // CONTRACT CHANGE 2026-07-30. This used to assert truncated:true when the TTY listing was cut,
  // while items still held everything — so a JSON caller saw items.length === total alongside
  // truncated:true, which contradicts itself. Everywhere else in this codebase (paginate, pipeline,
  // snapshot, noshow) truncated:true means "the DATA is incomplete, treat this as a floor", and
  // `crm` used the same field for the opposite fact again: it shipped only the 20-item subset.
  // Both commands now mean one thing. The items behaviour this test's old name defended is
  // unchanged and still asserted below; only the flag's meaning moved.
  const items = Array.from({ length: 55 }, (_, i) => ({ name: `tag-${i}` }));
  const { ctx, getPrinted } = makeFakeCtx({ model: { entities: { tags: { items } } } });
  const code = await run({ _: ['tags'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.total, 55);
  assert.equal(d.items.length, 55, 'JSON payload must carry ALL items — truncation is display-only');
  assert.equal(d.truncated, false,
    'items is complete, so truncated must be false — it describes the DATA, not the terminal');
});

test('list tags: the TTY listing is still cut at 40 with a hint — the inverse guard', async () => {
  // The display truncation must survive the flag change; dropping it would dump 55 lines into a
  // terminal, and the "… N more" hint is how a human learns --all exists.
  const items = Array.from({ length: 55 }, (_, i) => ({ name: `tag-${i}` }));
  // json:false is what makes out.line write — makeFakeCtx defaults json to TRUE, so a first draft
  // of this test asserted against the JSON envelope and "found" all 55 rows.
  const { ctx, getPrinted } = makeFakeCtx({ json: false, model: { entities: { tags: { items } } } });
  await run({ _: ['tags'] }, ctx);
  ctx.out.flush();
  const printed = getPrinted();
  assert.match(printed, /15 more/, 'the TTY must still say how many rows it hid');
  assert.ok(!printed.includes('tag-54'), 'row 55 must not be printed');
  assert.ok(printed.includes('tag-39'), 'the first 40 rows must be printed');
});

test('list tags --all: truncated:false and every row printed', async () => {
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
  await assert.rejects(() => run({ _: ['values'] }, ctx), (e) => e.code === EXIT.AUTH);
});

test('list values: 403 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({
    model: { entities: {} },
    fixture: { [valuesUrl]: { status: 403, j: {} } },
  });
  await assert.rejects(() => run({ _: ['values'] }, ctx), (e) => e.code === EXIT.AUTH);
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
