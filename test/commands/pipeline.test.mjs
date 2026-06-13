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
