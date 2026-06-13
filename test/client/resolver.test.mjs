import { test } from 'node:test'; import assert from 'node:assert';
import { makeResolver } from '../../lib/resolver.mjs';
import { ENTITY_SPECS } from '../../lib/model.mjs';

const TTL_24H = 24 * 60 * 60 * 1000;
const TTL_12H = 12 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

// Build a fresh model blob at NOW (all entities fetchedAt = NOW)
function freshModel() {
  return {
    schemaVersion: 1,
    locationId: 'L1',
    syncedAt: NOW,
    entities: {
      pipelines: {
        fetchedAt: NOW,
        items: [
          {
            id: 'p1', name: 'Sales',
            stages: [
              { id: 's1', name: 'Lead', position: 0 },
              { id: 's2', name: 'Won', position: 1 },
            ],
          },
          {
            id: 'p2', name: 'Onboarding',
            stages: [
              { id: 's3', name: 'Kickoff', position: 0 },
            ],
          },
        ],
      },
      calendars: { fetchedAt: NOW, items: [{ id: 'c1', name: 'Discovery Call' }] },
      tags: { fetchedAt: NOW, items: [{ id: 't1', name: 'hot-lead' }] },
      customFields: { fetchedAt: NOW, items: [{ id: 'f1', name: 'Monthly Revenue', fieldKey: 'monthly_revenue' }] },
      users: { fetchedAt: NOW, items: [{ id: 'u1', firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com' }] },
      location: { fetchedAt: NOW, item: { id: 'L1', name: 'Test Biz', timezone: 'Asia/Manila', business: { currency: 'PHP' } } },
    },
  };
}

test('resolve stage by id → hit', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('stage', 's1');
  assert.equal(result.status, 'hit');
  assert.equal(result.name, 'Lead');
});

test('resolve stage nested in second pipeline → hit', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('stage', 's3');
  assert.equal(result.status, 'hit');
  assert.equal(result.name, 'Kickoff');
});

test('resolve pipeline by id → hit', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('pipeline', 'p1');
  assert.equal(result.status, 'hit');
  assert.equal(result.name, 'Sales');
});

test('resolve calendar by id → hit', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('calendar', 'c1');
  assert.equal(result.status, 'hit');
  assert.equal(result.name, 'Discovery Call');
});

test('resolve tag by id → hit', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('tag', 't1');
  assert.equal(result.status, 'hit');
  assert.equal(result.name, 'hot-lead');
});

test('resolve customField by id → hit', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('customField', 'f1');
  assert.equal(result.status, 'hit');
  assert.equal(result.name, 'Monthly Revenue');
});

test('resolve user by id → hit, name includes first+last', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('user', 'u1');
  assert.equal(result.status, 'hit');
  assert.ok(result.name.includes('Jane'), `user name must include first name, got: ${result.name}`);
});

test('resolve unknown id → miss, name null, never fabricated', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('stage', 'NO_SUCH_ID');
  assert.equal(result.status, 'miss');
  assert.equal(result.name, null);
});

test('label on miss → includes unknown marker and hint', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const lbl = r.label('stage', 'NO_SUCH_ID');
  assert.ok(lbl.includes('<unknown:'), `miss label must include <unknown:, got: ${lbl}`);
  assert.ok(lbl.includes('sizmo sync'), `miss label must include sizmo sync hint, got: ${lbl}`);
});

test('label on hit → just the name', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  assert.equal(r.label('stage', 's2'), 'Won');
});

test('resolve stale model → status stale, name still returned', () => {
  const model = freshModel();
  // Make pipelines entity stale (past 24h TTL)
  model.entities.pipelines.fetchedAt = NOW - TTL_24H - 1;
  const r = makeResolver(model, { now: () => NOW });
  const result = r.resolve('stage', 's1');
  assert.equal(result.status, 'stale');
  assert.equal(result.name, 'Lead', 'stale but name still resolved (not fabricated — it was in the store)');
});

test('resolve stale — miss on stale model still returns miss not fabricated', () => {
  const model = freshModel();
  model.entities.pipelines.fetchedAt = NOW - TTL_24H - 1;
  const r = makeResolver(model, { now: () => NOW });
  const result = r.resolve('stage', 'FAKE_ID');
  assert.equal(result.status, 'miss');
  assert.equal(result.name, null);
});

test('makeResolver with null model → all resolves return miss', () => {
  const r = makeResolver(null, { now: () => NOW });
  const result = r.resolve('stage', 's1');
  assert.equal(result.status, 'miss');
  assert.equal(result.name, null);
});

test('resolve stage carries pipelineId + pipelineName', () => {
  const r = makeResolver(freshModel(), { now: () => NOW });
  const result = r.resolve('stage', 's1');
  assert.equal(result.pipelineId, 'p1');
  assert.equal(result.pipelineName, 'Sales');
});

test('entity not in model (missing key) → miss without throw', () => {
  const model = freshModel();
  delete model.entities.tags;
  const r = makeResolver(model, { now: () => NOW });
  const result = r.resolve('tag', 't1');
  assert.equal(result.status, 'miss');
  assert.equal(result.name, null);
});

test('blocked entity → miss without throw', () => {
  const model = freshModel();
  model.entities.tags = { blocked: true, scope: 'locations/tags.readonly' };
  const r = makeResolver(model, { now: () => NOW });
  const result = r.resolve('tag', 't1');
  assert.equal(result.status, 'miss');
  assert.equal(result.name, null);
});
