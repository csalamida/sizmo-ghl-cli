import { test } from 'node:test';
import assert from 'node:assert';
import { makeOut, project, LIST_KEYS } from '../../lib/output.mjs';

// ── ndjson (1.1.0) ───────────────────────────────────────────────────────────
const ndjsonLines = (s) => s.split('\n').filter(Boolean).map(l => JSON.parse(l));

test('ndjson: leading meta line + one line per list item', () => {
  let printed = '';
  const out = makeOut({ ndjson: true, tty: false, command: 'receivables', location: 'L1', write: s => printed += s });
  out.data({ outstanding: 2, list: [{ id: 'c1', due: 5000 }, { id: 'c2', due: 3000 }] });
  out.flush();
  const lines = ndjsonLines(printed);
  assert.equal(lines.length, 3, 'meta line + 2 rows');
  assert.equal(lines[0]._meta, true);
  assert.equal(lines[0].command, 'receivables');
  assert.equal(lines[0].listKey, 'list');
  assert.equal(lines[0].count, 2);
  assert.equal(lines[0].data.outstanding, 2, 'non-list fields ride on the meta line');
  assert.equal(lines[1].id, 'c1');
  assert.equal(lines[2].id, 'c2');
});

test('ndjson HONESTY: a blocked source keeps degraded:true on the meta line (never dropped like CSV)', () => {
  let printed = ''; let warned = '';
  const out = makeOut({ ndjson: true, tty: false, command: 'receivables', location: 'L1',
    write: s => printed += s, writeErr: s => warned += s });
  out.warn('receivables blocked (403)', { degraded: true });
  out.data({ list: [] });   // empty because the source was blocked — NOT because there are no leaks
  out.flush();
  const meta = ndjsonLines(printed)[0];
  assert.equal(meta.degraded, true, 'degraded must survive into ndjson — the whole point vs CSV');
  assert.deepEqual(meta.warnings, ['receivables blocked (403)']);
  assert.equal(meta.count, 0);
});

test('ndjson: payload with no list → single envelope line, still carries degraded', () => {
  let printed = '';
  const out = makeOut({ ndjson: true, tty: false, command: 'doctor', location: 'L1', write: s => printed += s });
  out.warn('scope blocked', { degraded: true });
  out.data({ ok: false, scopes: { contacts: true } });   // object, no list key
  out.flush();
  const lines = ndjsonLines(printed);
  assert.equal(lines.length, 1, 'no streamable list → one line');
  assert.equal(lines[0].degraded, true);
  assert.equal(lines[0].data.ok, false);
});

test('ndjson respects --fields (rows projected)', () => {
  let printed = '';
  const out = makeOut({ ndjson: true, tty: false, command: 'segment', location: 'L1',
    fields: ['name'], write: s => printed += s });
  out.data({ sample: [{ name: 'Acme', phone: '123', email: 'a@b.co' }] });
  out.flush();
  const rows = ndjsonLines(printed).slice(1);
  assert.equal(rows[0].name, 'Acme');
  assert.ok(!('phone' in rows[0]) && !('email' in rows[0]), 'non-listed fields stripped');
});

test('ndjson suppresses the human card (machine mode)', () => {
  let printed = '';
  const out = makeOut({ ndjson: true, tty: false, command: 'brief', location: 'L1', write: s => printed += s });
  out.data({ actions: [] });
  out.card(() => out.line('HUMAN CARD SHOULD NOT APPEAR'));
  out.flush();
  assert.ok(!printed.includes('HUMAN CARD'), 'card is a no-op under ndjson');
});

test('LIST_KEYS covers every list-bearing recipe key (guard: --fields must not silently no-op)', () => {
  // The primary list key each list-bearing recipe emits. A new recipe with a new list key
  // MUST be added here AND to LIST_KEYS — this test fails loudly if they drift apart, which
  // is how the 1.0.x brief/pipeline gap (--fields silently doing nothing) is prevented.
  const recipeListKeys = {
    receivables: 'list', segment: 'sample', triage: 'threads', noshow: 'list',
    focus: 'ranked', crm: 'items', brief: 'actions', pipeline: 'stuck',
  };
  for (const [recipe, key] of Object.entries(recipeListKeys)) {
    assert.ok(LIST_KEYS.includes(key),
      `--fields will silently no-op on '${recipe}': key '${key}' missing from LIST_KEYS`);
  }
});

test('--fields projects brief.actions + pipeline.stuck (the 1.0.x gap, now closed)', () => {
  for (const [command, key] of [['brief', 'actions'], ['pipeline', 'stuck']]) {
    let printed = '';
    const out = makeOut({ json: true, tty: false, command, location: 'L1',
      fields: ['name'], write: s => printed += s });
    out.data({ [key]: [{ name: 'Acme', contactId: 'c9', money: 5000 }] });
    out.flush();
    const env = JSON.parse(printed);
    assert.equal(env.data[key][0].name, 'Acme', `${command}.${key} item kept name`);
    assert.ok(!('contactId' in env.data[key][0]), `${command}.${key} projected — contactId stripped`);
    assert.ok(!('money' in env.data[key][0]), `${command}.${key} projected — money stripped`);
  }
});

test('json mode emits frozen envelope', () => {
  let printed = ''; const out = makeOut({ json:true, tty:false, command:'snapshot', location:'L1', write:s=>printed+=s });
  out.data({ metrics:[1,2] });
  out.flush();
  const env = JSON.parse(printed);
  assert.equal(env.schemaVersion, 1); assert.equal(env.command, 'snapshot');
  assert.equal(env.location, 'L1'); assert.deepEqual(env.data.metrics, [1,2]);
  assert.equal(env.degraded, false);
});

test('warn with degraded flag sets envelope degraded + collects warning', () => {
  let printed=''; let err='';
  const out = makeOut({ json:true, tty:false, command:'brief', location:'L', write:s=>printed+=s, writeErr:s=>err+=s });
  out.warn('payments blocked', { degraded:true });
  out.data({}); out.flush();
  const env = JSON.parse(printed);
  assert.equal(env.degraded, true); assert.deepEqual(env.warnings, ['payments blocked']);
  assert.match(err, /payments blocked/);
});

test('tty card mode calls renderer, not json', () => {
  let printed=''; const out = makeOut({ json:false, tty:true, command:'x', location:'L', write:s=>printed+=s });
  out.card(() => out.line('hello')); out.flush();
  assert.match(printed, /hello/);
});

test('double flush in json mode emits exactly one envelope', () => {
  const writes = []; const out = makeOut({ json:true, tty:false, command:'brief', location:'L1', write:s=>writes.push(s) });
  out.data({ x:1 });
  out.flush();
  out.flush(); // second call must be a no-op
  // write() called exactly once — one JSON blob
  assert.equal(writes.length, 1);
  const env = JSON.parse(writes[0]);
  assert.equal(env.schemaVersion, 1);
});

// ── token-lean: project() + --fields projection ──────────────────────────────

test('project: returns only requested fields', () => {
  const obj = { id: 'c1', name: 'Alice', email: 'a@b.com', phone: '+1', tags: ['vip'] };
  const result = project(obj, ['id', 'name']);
  assert.deepStrictEqual(result, { id: 'c1', name: 'Alice' });
});

test('project: missing field is silently omitted', () => {
  const obj = { id: 'c1', name: 'Alice' };
  const result = project(obj, ['id', 'email']);
  assert.deepStrictEqual(result, { id: 'c1' }); // email absent from source
});

test('project: no-op on null/primitive', () => {
  assert.equal(project(null, ['id']), null);
  assert.equal(project('str', ['id']), 'str');
  assert.equal(project(42, ['id']), 42);
});

test('project: empty fields array is a no-op (returns original object)', () => {
  const obj = { id: 'c1', name: 'Alice' };
  const result = project(obj, []);
  // empty fields = no projection requested → return as-is
  assert.deepStrictEqual(result, obj);
});

test('--fields projects data.threads list items', () => {
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'triage', location: 'L1',
    fields: ['name', 'age'], write: s => printed += s });
  out.data({ threads: [
    { name: 'Alice', age: 3, waiting: '3d', contactId: 'c1' },
    { name: 'Bob',   age: 5, waiting: '5d', contactId: 'c2' },
  ]});
  out.flush();
  const env = JSON.parse(printed);
  for (const t of env.data.threads) {
    assert.ok('name' in t && 'age' in t, 'projected fields present');
    assert.ok(!('waiting' in t), 'unprojected field absent');
    assert.ok(!('contactId' in t), 'unprojected field absent');
  }
});

test('--fields: non-list keys are untouched (metadata preserved)', () => {
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'triage', location: 'L1',
    fields: ['name'], write: s => printed += s });
  out.data({ count: 5, threads: [{ name: 'Alice', contactId: 'c1' }] });
  out.flush();
  const env = JSON.parse(printed);
  assert.equal(env.data.count, 5, 'non-list scalar keys preserved');
  assert.equal(env.data.threads[0].name, 'Alice');
  assert.ok(!('contactId' in env.data.threads[0]), 'projected field stripped');
});
