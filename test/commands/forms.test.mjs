// test/commands/forms.test.mjs
// forms command had zero test coverage. Covers: list (model path), scope-blocked,
// submissions feed (happy + error codes), empty state, --top flag.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/forms.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const FORM_ID = 'frm-001';
const LOC     = 'L-TEST';

// ── list forms (no args) ──────────────────────────────────────────────────────

test('forms list: items from model → EXIT.OK + envelope', async () => {
  const model = {
    entities: {
      forms: {
        items: [
          { id: 'frm-001', name: 'Contact Form' },
          { id: 'frm-002', name: 'Registration' },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.entity, 'forms');
  assert.equal(envelope.data.items.length, 2);
});

test('forms list: empty forms array → EXIT.OK with zero items', async () => {
  const model = { entities: { forms: { items: [] } } };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.items.length, 0);
});

test('forms list: blocked (no httpCode) → EXIT.AUTH', async () => {
  const model = { entities: { forms: { blocked: true } } };
  const { ctx } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  assert.equal(code, EXIT.AUTH);
});

test('forms list: blocked with httpCode → EXIT.API', async () => {
  const model = { entities: { forms: { blocked: true, httpCode: 500 } } };
  const { ctx } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  assert.equal(code, EXIT.API);
});

// ── submissions feed ──────────────────────────────────────────────────────────

test('forms submissions: happy path → EXIT.OK + submissions in envelope', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=20`]: {
      status: 200,
      j: {
        submissions: [
          { contactAttributes: { full_name: 'Jane Doe', email: 'jane@test.com' }, createdAt: '2024-01-15T00:00:00Z' },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture });
  const code = await run({ _: [FORM_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.formId, FORM_ID);
  assert.equal(envelope.data.submissions.length, 1);
  assert.equal(envelope.data.total, 1);
});

test('forms submissions: empty list → "(no submissions yet)" in text output', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=20`]: {
      status: 200,
      j: { submissions: [] },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, json: false });
  const code = await run({ _: [FORM_ID] }, ctx);
  assert.equal(code, EXIT.OK);
  assert.ok(getPrinted().includes('no submissions yet'), 'must print "(no submissions yet)"');
});

test('forms submissions: 401 → EXIT.AUTH', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=20`]: { status: 401, j: {} },
  };
  const { ctx } = makeFakeCtx({ fixture });
  const code = await run({ _: [FORM_ID] }, ctx);
  assert.equal(code, EXIT.AUTH);
});

test('forms submissions: 403 → EXIT.AUTH', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=20`]: { status: 403, j: {} },
  };
  const { ctx } = makeFakeCtx({ fixture });
  const code = await run({ _: [FORM_ID] }, ctx);
  assert.equal(code, EXIT.AUTH);
});

test('forms submissions: 404 → EXIT.NOTFOUND', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=20`]: { status: 404, j: {} },
  };
  const { ctx } = makeFakeCtx({ fixture });
  const code = await run({ _: [FORM_ID] }, ctx);
  assert.equal(code, EXIT.NOTFOUND);
});

test('forms submissions: non-2xx non-auth → EXIT.API', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=20`]: { status: 500, j: {} },
  };
  const { ctx } = makeFakeCtx({ fixture });
  const code = await run({ _: [FORM_ID] }, ctx);
  assert.equal(code, EXIT.API);
});

test('forms submissions: --top respected → limit in request URL', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=5`]: {
      status: 200,
      j: { submissions: [] },
    },
  };
  const { ctx } = makeFakeCtx({ fixture });
  const code = await run({ _: [FORM_ID], top: '5' }, ctx);
  assert.equal(code, EXIT.OK);
});

test('forms submissions: --top > 100 clamped to 100', async () => {
  const fixture = {
    [`GET /forms/submissions?locationId=${LOC}&formId=${FORM_ID}&limit=100`]: {
      status: 200,
      j: { submissions: [] },
    },
  };
  const { ctx } = makeFakeCtx({ fixture });
  const code = await run({ _: [FORM_ID], top: '999' }, ctx);
  assert.equal(code, EXIT.OK);
});
