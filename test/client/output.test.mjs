import { test } from 'node:test';
import assert from 'node:assert';
import { makeOut, project } from '../../lib/output.mjs';

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
