import { test } from 'node:test';
import assert from 'node:assert';
import { makeOut } from '../../lib/output.mjs';

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
