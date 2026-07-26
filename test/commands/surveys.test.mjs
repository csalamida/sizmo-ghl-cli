// test/commands/surveys.test.mjs
// surveys had zero test coverage. Structurally a twin of forms.mjs (list from model cache +
// live submissions feed), so it carries the same branch set: both blocked variants on the list
// path, and 4 HTTP status branches plus a defensive shape check on the submissions path.
//
// Covers: list (items, empty, blocked-scope, blocked-API), submissions (happy, empty, 401, 403,
// 404, 500, non-array response), --top default/clamp/garbage, and query-string construction.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/surveys.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const SURVEY_ID = 'svy-001';
const LOC = 'L-TEST';
const subUrl = (id = SURVEY_ID, limit = 20) =>
  `GET /surveys/submissions?locationId=${LOC}&surveyId=${id}&limit=${limit}`;

// ── list surveys ──────────────────────────────────────────────────────────────

test('surveys list: items from model → EXIT.OK + envelope', async () => {
  const model = {
    entities: {
      surveys: {
        items: [
          { id: 'svy-001', name: 'Intake Survey' },
          { id: 'svy-002', name: 'NPS' },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.entity, 'surveys');
  assert.equal(envelope.data.items.length, 2);
});

test('surveys list: empty array → EXIT.OK with zero items', async () => {
  const model = { entities: { surveys: { items: [] } } };
  const { ctx, getPrinted } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.items.length, 0);
});

test('surveys list: missing surveys entity entirely → EXIT.OK, zero items', async () => {
  // A model synced before surveys support existed has no `surveys` key at all — must not throw.
  const { ctx, getPrinted } = makeFakeCtx({ model: { entities: {} } });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.items.length, 0);
});

test('surveys list: blocked without httpCode → EXIT.AUTH (scope issue)', async () => {
  const model = { entities: { surveys: { blocked: true } } };
  const { ctx } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH);
});

test('surveys list: blocked WITH httpCode → EXIT.API (real error, not scope)', async () => {
  const model = { entities: { surveys: { blocked: true, httpCode: 500 } } };
  const { ctx } = makeFakeCtx({ model });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.API);
});

// ── submissions feed ──────────────────────────────────────────────────────────

test('surveys submissions: happy path → EXIT.OK + envelope', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: {
      [subUrl()]: {
        status: 200,
        j: {
          submissions: [
            { contactAttributes: { full_name: 'Ana Cruz', email: 'ana@x.com' }, createdAt: '2026-07-01T10:00:00Z' },
            { name: 'Bea Lim', email: 'bea@x.com', createdAt: '2026-07-02T10:00:00Z' },
          ],
        },
      },
    },
  });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.surveyId, SURVEY_ID);
  assert.equal(envelope.data.total, 2);
});

test('surveys submissions: empty list → EXIT.OK, total 0', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [subUrl()]: { status: 200, j: { submissions: [] } } },
  });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.total, 0);
});

test('surveys submissions: reads `data` key when `submissions` absent', async () => {
  // GHL has returned all three shapes; the fallback chain is real, so pin it.
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [subUrl()]: { status: 200, j: { data: [{ name: 'X' }] } } },
  });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.total, 1);
});

test('surveys submissions: reads `results` key as last fallback', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [subUrl()]: { status: 200, j: { results: [{ name: 'X' }, { name: 'Y' }] } } },
  });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.total, 2);
});

test('surveys submissions: non-array payload → EXIT.OK, degrades to empty (never throws)', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [subUrl()]: { status: 200, j: { submissions: { nope: 'object' } } } },
  });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.total, 0);
});

test('surveys submissions: 401 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({ fixture: { [subUrl()]: { status: 401, j: {} } } });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH);
});

test('surveys submissions: 403 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({ fixture: { [subUrl()]: { status: 403, j: {} } } });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.AUTH);
});

test('surveys submissions: 404 → EXIT.NOTFOUND', async () => {
  const { ctx } = makeFakeCtx({ fixture: { [subUrl()]: { status: 404, j: {} } } });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.NOTFOUND);
});

test('surveys submissions: 500 → EXIT.API', async () => {
  const { ctx } = makeFakeCtx({ fixture: { [subUrl()]: { status: 500, j: {} } } });
  const code = await run({ _: [SURVEY_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.API);
});

// ── --top handling ────────────────────────────────────────────────────────────

test('surveys --top: honored in the request URL', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [subUrl(SURVEY_ID, 5)]: { status: 200, j: { submissions: [] } } },
  });
  const code = await run({ _: [SURVEY_ID], top: 5 }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths()[0].endsWith('limit=5'));
});

test('surveys --top: clamped to MAX_TOP 100', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [subUrl(SURVEY_ID, 100)]: { status: 200, j: { submissions: [] } } },
  });
  const code = await run({ _: [SURVEY_ID], top: 9999 }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths()[0].endsWith('limit=100'), 'must clamp, not pass 9999 through');
});

test('surveys --top: non-numeric falls back to default 20', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [subUrl(SURVEY_ID, 20)]: { status: 200, j: { submissions: [] } } },
  });
  const code = await run({ _: [SURVEY_ID], top: 'abc' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths()[0].endsWith('limit=20'));
});

test('surveys submissions: surveyId is URL-encoded', async () => {
  const weird = 'svy 1/x';
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: {
      [`GET /surveys/submissions?locationId=${LOC}&surveyId=${encodeURIComponent(weird)}&limit=20`]:
        { status: 200, j: { submissions: [] } },
    },
  });
  const code = await run({ _: [weird] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths().every(p => !p.includes('svy 1/x')), 'raw id must never reach the URL');
});
