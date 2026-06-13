// test/commands/pipeline.test.mjs — value-asserting tests for pipeline command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// pipeline fetches:
//   GET /opportunities/pipelines?locationId=L-TEST
//   GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/pipeline.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/pipeline.json', import.meta.url);

test('pipeline: run returns 0 and envelope has expected keys + value assertions', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    'GET /opportunities/pipelines?locationId=L-TEST': {
      status: 200,
      j: {
        pipelines: [
          { id: 'p1', name: 'Main Pipeline', stages: [{ id: 's1', name: 'Lead' }, { id: 's2', name: 'Qualified' }] },
        ],
      },
    },
    'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1': {
      status: 200,
      j: {
        opportunities: [
          { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 5000, name: 'Deal A',
            contactId: 'c1', updatedAt: new Date(NOW - 10 * 86400000).toISOString() },
          { id: 'o2', pipelineId: 'p1', pipelineStageId: 's2', monetaryValue: 3000, name: 'Deal B',
            contactId: 'c2', updatedAt: new Date(NOW - 2 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ 'stuck-days': 7, top: 100 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  for (const k of ['location', 'totalValue', 'openCount', 'pipelines', 'stuck']) {
    assert.ok(k in envelope.data, `missing key: ${k}`);
  }
  // value assertions
  assert.equal(envelope.data.openCount, 2, 'openCount must be 2');
  assert.equal(envelope.data.totalValue, 8000, 'totalValue must be 5000+3000=8000');
  // Deal A updated 10d ago → stuck (>7d threshold); Deal B updated 2d ago → not stuck
  assert.equal(envelope.data.stuck.length, 1, 'exactly 1 stuck deal');
  assert.equal(envelope.data.stuck[0].name, 'Deal A', 'Deal A must be the stuck deal');
  // pipeline grouping
  assert.equal(envelope.data.pipelines.length, 1, 'one pipeline');
  assert.equal(envelope.data.pipelines[0].pipeline, 'Main Pipeline');
});

// M-4: money(Infinity) must not produce ₱Infinity
test('pipeline: Infinity monetaryValue formats as — not ₱Infinity', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    'GET /opportunities/pipelines?locationId=L-TEST': {
      status: 200,
      j: { pipelines: [{ id: 'p1', name: 'Test', stages: [{ id: 's1', name: 'Lead' }] }] },
    },
    'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1': {
      status: 200,
      j: {
        opportunities: [
          { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: Infinity,
            name: 'Inf Deal', contactId: 'c1', updatedAt: new Date(NOW - 2 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, json: false });
  const code = await run({ 'stuck-days': 7, top: 100 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const printed = getPrinted();
  assert.ok(!printed.includes('Infinity'), 'Infinity must not appear in TTY output');
});

test('pipeline: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'totalValue', 'openCount', 'pipelines', 'stuck']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});

// ── C2/C3 model path tests ────────────────────────────────────────────────────

test('C3-pipeline: injected FRESH model → name from resolver + no structure re-fetch', async () => {
  const NOW = 1_700_000_000_000;
  // Model with pipelines — stages have explicit position for sort test (I1)
  const freshModel = {
    schemaVersion: 1,
    locationId: 'L-TEST',
    syncedAt: NOW - 1000, // just synced
    offline: false,
    entities: {
      pipelines: {
        fetchedAt: NOW - 1000,
        items: [{
          id: 'p1', name: 'Sales Pipeline',
          stages: [
            { id: 's2', name: 'Qualified', position: 1 },
            { id: 's1', name: 'Lead', position: 0 },
          ],
        }],
      },
      calendars: { fetchedAt: NOW - 1000, items: [] },
      tags: { fetchedAt: NOW - 1000, items: [] },
      customFields: { fetchedAt: NOW - 1000, items: [] },
      users: { fetchedAt: NOW - 1000, items: [] },
      location: { fetchedAt: NOW - 1000, item: { id: 'L-TEST', name: 'Test', timezone: 'UTC', business: { currency: 'PHP' } } },
    },
  };
  // Fixture only has opps — NO structure endpoints (pipelines/stages). If pipeline.mjs
  // tries to re-fetch structure, the strict helper will throw 'unmocked request'.
  const fixture = {
    'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1': {
      status: 200,
      j: {
        opportunities: [
          { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 5000, name: 'Deal A',
            contactId: 'c1', updatedAt: new Date(NOW - 2 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted, getCalledPaths } = makeFakeCtx({ fixture, now: NOW, model: freshModel });
  const code = await run({ 'stuck-days': 7, top: 100 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  // Pipeline name from resolver (not raw pid)
  assert.equal(envelope.data.pipelines[0].pipeline, 'Sales Pipeline', 'pipeline name must come from model via resolver');
  // Stage name from resolver
  assert.equal(envelope.data.pipelines[0].stages[0].stage, 'Lead', 'stage name must come from model via resolver');
  // Structure endpoints must NOT have been called
  const called = getCalledPaths();
  assert.ok(!called.some(p => p.includes('/opportunities/pipelines')), 'pipelines structure endpoint must NOT be re-fetched when model is present');
  // modelMeta must be present in envelope
  assert.ok(envelope.data.modelMeta, 'modelMeta must be present in envelope');
  assert.ok(!envelope.data.modelMeta.stale, 'fresh model must have stale=false');
});

test('I1-pipeline: stages sorted by model position (not undefined .sid)', async () => {
  const NOW = 1_700_000_000_000;
  // Stages out of order in the items array — model position decides sort order
  const freshModel = {
    schemaVersion: 1,
    locationId: 'L-TEST',
    syncedAt: NOW - 1000,
    offline: false,
    entities: {
      pipelines: {
        fetchedAt: NOW - 1000,
        items: [{
          id: 'p1', name: 'Main',
          stages: [
            { id: 's3', name: 'Closed', position: 2 },
            { id: 's1', name: 'Lead',   position: 0 },
            { id: 's2', name: 'Qual',   position: 1 },
          ],
        }],
      },
      calendars: { fetchedAt: NOW - 1000, items: [] },
      tags: { fetchedAt: NOW - 1000, items: [] },
      customFields: { fetchedAt: NOW - 1000, items: [] },
      users: { fetchedAt: NOW - 1000, items: [] },
      location: { fetchedAt: NOW - 1000, item: { id: 'L-TEST', name: 'T', timezone: 'UTC', business: { currency: 'PHP' } } },
    },
  };
  const fixture = {
    'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1': {
      status: 200,
      j: {
        opportunities: [
          { id: 'o1', pipelineId: 'p1', pipelineStageId: 's3', monetaryValue: 1000, name: 'Closed Deal', contactId: 'c1', updatedAt: new Date(NOW - 1 * 86400000).toISOString() },
          { id: 'o2', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 2000, name: 'Lead Deal',   contactId: 'c2', updatedAt: new Date(NOW - 1 * 86400000).toISOString() },
          { id: 'o3', pipelineId: 'p1', pipelineStageId: 's2', monetaryValue: 3000, name: 'Qual Deal',   contactId: 'c3', updatedAt: new Date(NOW - 1 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, model: freshModel });
  const code = await run({ 'stuck-days': 7, top: 100 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const stages = envelope.data.pipelines[0].stages;
  // Must be in position order: Lead(0), Qual(1), Closed(2)
  assert.equal(stages[0].stage, 'Lead',   'first stage must be Lead (position 0)');
  assert.equal(stages[1].stage, 'Qual',   'second stage must be Qual (position 1)');
  assert.equal(stages[2].stage, 'Closed', 'third stage must be Closed (position 2)');
});

test('C2-pipeline: STALE model → modelMeta.stale=true + stage still resolved (age-stamped)', async () => {
  const NOW = 1_700_000_000_000;
  // Model is 2 days old (pipelines TTL = 24h — so it's stale)
  const staleModel = {
    schemaVersion: 1,
    locationId: 'L-TEST',
    syncedAt: NOW - 2 * 86400000,
    offline: false,
    entities: {
      pipelines: {
        fetchedAt: NOW - 2 * 86400000, // stale
        items: [{ id: 'p1', name: 'Old Pipeline', stages: [{ id: 's1', name: 'Old Stage', position: 0 }] }],
      },
      calendars: { fetchedAt: NOW - 1000, items: [] },
      tags: { fetchedAt: NOW - 1000, items: [] },
      customFields: { fetchedAt: NOW - 1000, items: [] },
      users: { fetchedAt: NOW - 1000, items: [] },
      location: { fetchedAt: NOW - 1000, item: { id: 'L-TEST', name: 'T', timezone: 'UTC', business: { currency: 'PHP' } } },
    },
  };
  const fixture = {
    'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1': {
      status: 200,
      j: {
        opportunities: [
          { id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', monetaryValue: 1000, name: 'Deal', contactId: 'c1', updatedAt: new Date(NOW - 1 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, model: staleModel });
  const code = await run({ 'stuck-days': 7, top: 100 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.ok(envelope.data.modelMeta, 'modelMeta must be present');
  assert.ok(envelope.data.modelMeta.stale === true, 'stale model must set modelMeta.stale=true');
  // Stage name still resolves (we use the stale model, not fabricate)
  assert.equal(envelope.data.pipelines[0].stages[0].stage, 'Old Stage', 'stale model still resolves names');
});

test('C3-pipeline: missing stage id → resolver returns unknown token, never fabricated', async () => {
  const NOW = 1_700_000_000_000;
  const freshModel = {
    schemaVersion: 1,
    locationId: 'L-TEST',
    syncedAt: NOW - 1000,
    offline: false,
    entities: {
      pipelines: {
        fetchedAt: NOW - 1000,
        items: [{ id: 'p1', name: 'Pipeline', stages: [{ id: 's1', name: 'Lead', position: 0 }] }],
      },
      calendars: { fetchedAt: NOW - 1000, items: [] },
      tags: { fetchedAt: NOW - 1000, items: [] },
      customFields: { fetchedAt: NOW - 1000, items: [] },
      users: { fetchedAt: NOW - 1000, items: [] },
      location: { fetchedAt: NOW - 1000, item: { id: 'L-TEST', name: 'T', timezone: 'UTC', business: { currency: 'PHP' } } },
    },
  };
  const fixture = {
    'GET /opportunities/search?location_id=L-TEST&status=open&limit=100&page=1': {
      status: 200,
      j: {
        opportunities: [
          // pipelineStageId 's-UNKNOWN' is not in the model — resolver must return '<unknown:...>'
          { id: 'o1', pipelineId: 'p1', pipelineStageId: 's-UNKNOWN', monetaryValue: 1000, name: 'Deal',
            contactId: 'c1', updatedAt: new Date(NOW - 8 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, model: freshModel });
  const code = await run({ 'stuck-days': 7, top: 100 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const stuckStage = envelope.data.stuck[0]?.stage ?? '';
  // Must contain the unknown token, not a fabricated name
  assert.ok(stuckStage.includes('unknown') || stuckStage.includes('s-UNKNOWN'), `stage for unknown id must be '<unknown:...>', got: "${stuckStage}"`);
  assert.ok(!stuckStage || stuckStage !== 'Lead', 'must not fabricate a name from wrong stage');
});
