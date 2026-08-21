// test/commands/diff.test.mjs — location export diff (file vs live, file vs file).
import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, diffDocs } from '../../commands/diff.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

function doc(over = {}) {
  return {
    specVersion: 1,
    location: { id: 'L', name: 'Biz', timezone: 'Asia/Manila', currency: 'PHP', country: 'PH' },
    pipelines: [], calendars: [], customFields: [], customValues: [], tags: [], users: [],
    degraded: false, warnings: [],
    ...over,
  };
}

test('diffDocs: identical docs → identical:true, all zero', () => {
  const r = diffDocs(doc(), doc());
  assert.equal(r.identical, true);
  assert.deepEqual(r.summary, { added: 0, removed: 0, changed: 0, notComparable: 0 });
});

test('diffDocs: same data, different key order → identical (a saved export is key-sorted, live is not)', () => {
  // regression: a written export has recursively-sorted keys; a fresh live doc does not.
  // an order-sensitive equality check would report every multi-key object as "changed".
  const a = doc({ users: [{ id: 'u1', name: 'Sam', role: 'admin' }] });
  const b = doc({ users: [{ role: 'admin', id: 'u1', name: 'Sam' }] }); // same data, shuffled keys
  const r = diffDocs(a, b);
  assert.equal(r.identical, true, 'key order must not register as a change');
});

test('diffDocs: added / removed items counted per group', () => {
  const a = doc({ pipelines: [{ id: 'p1', name: 'Keep' }] });
  const b = doc({ pipelines: [{ id: 'p1', name: 'Keep' }, { id: 'p2', name: 'New' }] });
  const r = diffDocs(a, b);
  assert.equal(r.summary.added, 1);
  assert.equal(r.groups.pipelines.added[0].id, 'p2');
  // reverse = removed
  const r2 = diffDocs(b, a);
  assert.equal(r2.summary.removed, 1);
  assert.equal(r2.groups.pipelines.removed[0].id, 'p2');
});

test('diffDocs: changed item → field-level diff', () => {
  const a = doc({ customFields: [{ id: 'f1', name: 'Source', dataType: 'TEXT' }] });
  const b = doc({ customFields: [{ id: 'f1', name: 'Lead Source', dataType: 'TEXT' }] });
  const r = diffDocs(a, b);
  assert.equal(r.summary.changed, 1);
  const c = r.groups.customFields.changed[0];
  assert.equal(c.id, 'f1');
  assert.deepEqual(c.fields, [{ field: 'name', from: 'Source', to: 'Lead Source' }]);
});

test('diffDocs: location field change counts as a change', () => {
  const r = diffDocs(doc(), doc({ location: { id: 'L', name: 'Renamed', timezone: 'Asia/Manila', currency: 'PHP', country: 'PH' } }));
  assert.equal(r.identical, false);
  assert.ok(r.location.fields.some(f => f.field === 'name' && f.to === 'Renamed'));
});

test('diffDocs: a blocked group is NOT comparable (never guesses a delta on unknown data)', () => {
  const a = doc({ pipelines: { blocked: 'opportunities.readonly' } });
  const b = doc({ pipelines: [{ id: 'p1', name: 'X' }] });
  const r = diffDocs(a, b);
  assert.equal(r.groups.pipelines.comparable, false);
  assert.match(r.groups.pipelines.reason, /blocked/);
  assert.equal(r.summary.notComparable, 1);
});

test('diff run: file vs file → exit 0, json envelope carries summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sz-diff-'));
  const A = join(dir, 'a.json'), B = join(dir, 'b.json');
  writeFileSync(A, JSON.stringify(doc({ tags: [{ id: 't1', name: 'vip' }] })));
  writeFileSync(B, JSON.stringify(doc({ tags: [{ id: 't1', name: 'vip' }, { id: 't2', name: 'lead' }] })));
  const { ctx, getPrinted } = makeFakeCtx({});
  try {
    const code = await run({ _: [A, B] }, ctx);
    ctx.out.flush();
    assert.equal(code, EXIT.OK);
    const env = JSON.parse(getPrinted());
    assert.equal(env.data.summary.added, 1);
    assert.equal(env.data.groups.tags.added[0].id, 't2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diff run: <file> vs LIVE — builds live doc from the model, diffs it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sz-diff-'));
  const A = join(dir, 'a.json');
  // saved export claims NO tags; live model has one → diff shows +1 added
  writeFileSync(A, JSON.stringify(doc({ location: { id: 'L-TEST', name: 'Biz', timezone: null, currency: null, country: null } })));
  const model = {
    entities: {
      location: { item: { id: 'L-TEST', name: 'Biz' } },
      pipelines: { items: [] }, calendars: { items: [] }, customFields: { items: [] },
      tags: { items: [{ id: 't9', name: 'fresh' }] }, users: { items: [] },
    },
  };
  const fixture = { 'GET /locations/L-TEST/customValues': { status: 200, j: { customValues: [] } } };
  const { ctx, getPrinted } = makeFakeCtx({ model, fixture });
  try {
    const code = await run({ _: [A] }, ctx);
    ctx.out.flush();
    assert.equal(code, EXIT.OK);
    const env = JSON.parse(getPrinted());
    assert.equal(env.data.b, 'live');
    assert.equal(env.data.groups.tags.added[0].id, 't9', 'live tag not in the file → added');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diff run: missing file → NOTFOUND; no arg → USAGE', async () => {
  const { ctx } = makeFakeCtx({});
  await assert.rejects(() => run({ _: ['/nope/missing.json'] }, ctx), (e) => { assert.equal(e.code, EXIT.NOTFOUND); return true; });
  const { ctx: ctx2 } = makeFakeCtx({});
  await assert.rejects(() => run({ _: [] }, ctx2), (e) => { assert.equal(e.code, EXIT.USAGE); return true; });
});

// ── loadDoc error branches — currently zero coverage ──────────────────────────

test('diff run: invalid JSON file → EXIT.USAGE (not valid JSON message)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sz-diff-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, 'NOT { valid JSON }');
  const { ctx } = makeFakeCtx({});
  try {
    await assert.rejects(
      () => run({ _: [bad] }, ctx),
      (e) => e.code === EXIT.USAGE && /not valid JSON/.test(e.message)
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diff run: valid JSON but no specVersion → EXIT.USAGE (not a sizmo export document)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sz-diff-'));
  const notExport = join(dir, 'bare.json');
  writeFileSync(notExport, JSON.stringify({ some: 'thing' }));
  const { ctx } = makeFakeCtx({});
  try {
    await assert.rejects(
      () => run({ _: [notExport] }, ctx),
      (e) => e.code === EXIT.USAGE && /specVersion/.test(e.message)
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── diffGroup: B-side / httpCode / unavailable branches ───────────────────────

test('diffDocs: B-side group blocked → comparable:false, reason names side B', () => {
  // Only the A-side blocked branch was previously tested. B-side exercises the ternary that
  // picks `side` and `marker` based on which operand is the non-array.
  const a = doc({ tags: [{ id: 't1', name: 'vip' }] });
  const b = doc({ tags: { blocked: 'tags.readonly' } });
  const r = diffDocs(a, b);
  assert.equal(r.groups.tags.comparable, false);
  assert.match(r.groups.tags.reason, /B/);
  assert.equal(r.summary.notComparable, 1);
});

test('diffDocs: blocked group with httpCode → reason says "API error X", not "blocked (…)"', () => {
  // A 500 on the API call that fetches pipelines is a real error, not a missing scope —
  // the httpCode branch produces a different message so agents can distinguish the two.
  const a = doc({ calendars: { blocked: true, httpCode: 500 } });
  const r = diffDocs(a, doc());
  assert.equal(r.groups.calendars.comparable, false);
  assert.match(r.groups.calendars.reason, /API error 500/);
  assert.doesNotMatch(r.groups.calendars.reason, /blocked \(true\)/);
});

test('diffDocs: non-array group with no blocked property → reason says "unavailable"', () => {
  // An export created before a group entity was added may carry null for that group.
  // The `marker?.blocked` is undefined (falsy) → the ternary falls to "unavailable".
  const a = doc({ users: null });
  const r = diffDocs(a, doc());
  assert.equal(r.groups.users.comparable, false);
  assert.match(r.groups.users.reason, /unavailable/);
});

// ── keyOf: name-keyed items (no id) ───────────────────────────────────────────

test('diffDocs: items without id are keyed by name — add/remove/change all resolve correctly', () => {
  // Tags typically lack an id in GHL — keyOf falls back to name. This pins that the
  // fallback works for the full add/remove/match cycle, not just the "keyed" read path.
  const a = doc({ tags: [{ name: 'vip' }, { name: 'old' }] });
  const b = doc({ tags: [{ name: 'vip' }, { name: 'lead' }] });
  const r = diffDocs(a, b);
  assert.equal(r.groups.tags.added[0].name, 'lead', '"lead" is new → added');
  assert.equal(r.groups.tags.removed[0].name, 'old', '"old" is gone → removed');
  assert.equal(r.groups.tags.changed.length, 0, '"vip" matches both sides → not changed');
});

// ── human card render branches ────────────────────────────────────────────────

test('diff run: identical docs (file vs file) → card prints "identical — no differences"', async () => {
  // The card has an early-return path for identical:true that shows "✓ identical" and skips
  // all the per-group rendering. This pins that path in the rendered output.
  const dir = mkdtempSync(join(tmpdir(), 'sz-diff-'));
  const A = join(dir, 'a.json'), B = join(dir, 'b.json');
  const d = doc();
  writeFileSync(A, JSON.stringify(d));
  writeFileSync(B, JSON.stringify(d));
  const { ctx, getPrinted } = makeFakeCtx({ json: false });
  try {
    const code = await run({ _: [A, B] }, ctx);
    ctx.out.flush();
    assert.equal(code, EXIT.OK);
    assert.match(getPrinted(), /identical — no differences/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('diff run: not-comparable group → card shows group label + reason', async () => {
  // The !r.comparable branch in the card loop emits the reason string. Without this test,
  // a regression that silently dropped the reason line would pass all other assertions.
  //
  // NOTE: identical:true is computed as added===0 && removed===0 && changed===0 — notComparable
  // does NOT flip it. So a not-comparable group alone produces identical:true and the card
  // early-returns. We add a real tag difference to force identical:false so the loop runs.
  const dir = mkdtempSync(join(tmpdir(), 'sz-diff-'));
  const A = join(dir, 'a.json'), B = join(dir, 'b.json');
  writeFileSync(A, JSON.stringify(doc({ pipelines: { blocked: 'opportunities.readonly' } })));
  writeFileSync(B, JSON.stringify(doc({ tags: [{ name: 'lead' }] }))); // real difference → identical:false
  const { ctx, getPrinted } = makeFakeCtx({ json: false });
  try {
    const code = await run({ _: [A, B] }, ctx);
    ctx.out.flush();
    assert.equal(code, EXIT.OK);
    const out = getPrinted();
    assert.match(out, /Pipelines/, 'group label rendered');
    assert.match(out, /not comparable/, 'reason rendered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
