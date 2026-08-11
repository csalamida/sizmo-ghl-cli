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

test('--fields projects EVERY array of objects, not a hand-written subset', () => {
  // REPLACES a guard that could not fail. The old version compared LIST_KEYS against a SECOND
  // hand-written table of recipe list keys — two lists checked against each other, neither derived
  // from the code — and both were missing the same four recipes. Measured 2026-07-30 against the real
  // payloads: booked-not-paid (neverBilled, billedUnpaid), snapshot (metrics), pipeline (pipelines,
  // where only `stuck` was covered) and ack (snoozes) all had --fields silently no-op.
  //
  // projectPayload no longer consults a whitelist, so this asserts the PROPERTY instead of a list:
  // any array of objects, whatever it is called, gets projected.
  let printed = '';
  const out = makeOut({ json: true, tty: false, command: 'x', location: 'L1', fields: ['id'],
                        write: s2 => printed += s2, writeErr: () => {} });
  // Keys deliberately absent from LIST_KEYS — the four real ones that were broken, plus an invented
  // key no whitelist could ever anticipate. Distinct ids so a mix-up would be visible.
  const EXPECT = {
    neverBilled: 'a', billedUnpaid: 'b', metrics: 'c',
    pipelines: 'd', snoozes: 'e', somethingNobodyHasWrittenYet: 'f',
  };
  out.data({
    ...Object.fromEntries(Object.entries(EXPECT).map(([k, id]) => [k, [{ id, drop: 'SHOULD BE GONE' }]])),
    scalar: 42,
    tagNames: ['vip', 'lead'],
  });
  out.flush();
  const d = JSON.parse(printed).data;
  for (const [k, id] of Object.entries(EXPECT)) {
    assert.deepEqual(d[k], [{ id }],
      `--fields silently no-opped on '${k}': got ${JSON.stringify(d[k])}, expected [{"id":"${id}"}]`);
  }
  assert.equal(d.scalar, 42, 'a non-array field must pass through untouched');
  assert.deepEqual(d.tagNames, ['vip', 'lead'],
    'an array of PRIMITIVES must pass through untouched — projecting it would blank every value');
});

test('LIST_KEYS still selects the ndjson primary row key', () => {
  // LIST_KEYS is no longer the projection list, but ndjson still needs to choose ONE array to stream
  // as rows. This pins that it kept that job when projection stopped using it.
  let printed = '';
  const out = makeOut({ ndjson: true, tty: false, command: 'receivables', location: 'L1',
                        write: s2 => printed += s2, writeErr: () => {} });
  out.data({ outstanding: 1, list: [{ id: 'c1' }], metrics: [{ id: 'm1' }] });
  out.flush();
  const lines = printed.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines[0].listKey, 'list', 'ndjson must still choose the LIST_KEYS-preferred array');
  assert.equal(lines[1].id, 'c1');
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

// ── the mode switch is --json/--ndjson, never the terminal ──────────────────
// The module header used to claim "TTY → human card; non-TTY/--json → frozen envelope". card() has
// never consulted tty — it gates on `machine = json || ndjson` — so redirecting a report to a file
// writes the full human card. That is the right behaviour (piping is not a request for machine
// output), but the comment described a rule that did not exist, and someone would plan around it.

test('the human card renders when piped, as long as no machine flag is set', () => {
  let buf = '';
  const out = makeOut({ command: 'brief', location: 'L', write: (s) => { buf += s; }, writeErr: () => {} });
  out.data({ x: 1 });
  out.card(() => out.line('HUMAN CARD'));
  out.flush();
  assert.match(buf, /HUMAN CARD/,
    'redirecting output must not silently switch the tool to machine mode — only --json/--ndjson do that');
  assert.ok(!buf.includes('schemaVersion'),
    'without a machine flag, flush must emit nothing to stdout');
});

test('makeOut exposes no colour flag', () => {
  // `color` was computed from tty and honoured NO_COLOR, but nothing ever read it and the codebase
  // emits zero ANSI escapes. A flag that promises something the layer does not do is worse than its
  // absence — it invites a caller to branch on it.
  const out = makeOut({ command: 'brief', location: 'L', write: () => {}, writeErr: () => {} });
  assert.ok(!('color' in out), 'the dead colour flag is back without an implementation behind it');
});

test('no ANSI escape sequences anywhere in the shipped source', async () => {
  // The claim above is only true while it stays true.
  //
  // Matching a real ESC BYTE is not enough, and a mutation proved it: adding
  // `const BOLD = '\x1b[1m'` to a command left this test green, because source code contains the
  // four-character ESCAPE FORM (backslash-x-1-b), not the byte itself. A guard that only sees the
  // byte can never catch colour added the normal way — which is the only way it would be added.
  // So both forms are checked, plus the other spellings of the same escape.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  // eslint-disable-next-line no-control-regex
  const RAW_BYTE = /\[/;                       // an actual ESC in the file
  const SOURCE_FORMS = /\\(x1[bB]|u001[bB]|033|e)\[/; // how a human would write it in JS
  const offenders = [];
  for (const dir of ['commands', 'lib', 'bin']) {
    for (const f of readdirSync(join(REPO, dir)).filter(f => f.endsWith('.mjs'))) {
      const src = readFileSync(join(REPO, dir, f), 'utf8');
      // CODE only — this very test's own explanation names the escape forms it looks for, and a
      // guard reading its own prose is a false positive this codebase has produced repeatedly.
      const code = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
      if (RAW_BYTE.test(code) || SOURCE_FORMS.test(code)) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these emit ANSI escapes with no colour support behind them: ${offenders.join(', ')}`);
});

// ── --fields must not GUT an array it does not fit ──────────────────────────
// Projecting every array with one flat field list emptied the arrays whose items carry none of the
// requested keys. Measured 2026-08-11 with `--fields name,total` against real payload shapes: four
// of six arrays came back as lists of EMPTY OBJECTS — the right length, carrying nothing. A consumer
// counting rows sees data; a consumer reading rows sees none, with nothing to say they disagree.
//
// Same rule as "a blocked source is UNKNOWN, never zero", one level up: fields that do not APPLY to
// an array must not render as an array of empties.

test('--fields leaves an array alone when NO item carries any requested field', () => {
  let buf = '';
  const out = makeOut({ json: true, command: 'pipeline', location: 'L', fields: ['name', 'total'],
                        write: (s) => { buf += s; }, writeErr: () => {} });
  // pipelines[] items are {pipeline, stages} — neither `name` nor `total` exists on them.
  out.data({ pipelines: [{ pipeline: 'Sales', stages: [{ stage: 'New', count: 2 }] }] });
  out.flush();
  const arr = JSON.parse(buf).data.pipelines;
  assert.deepEqual(arr, [{ pipeline: 'Sales', stages: [{ stage: 'New', count: 2 }] }],
    'an array the field list does not fit was gutted to empty objects instead of left intact');
});

test('--fields still projects the arrays it DOES fit — the inverse guard', () => {
  // The over-correction to guard against: bailing out of projection entirely would make --fields a
  // no-op, which is the bug this whole path already had once.
  let buf = '';
  const out = makeOut({ json: true, command: 'receivables', location: 'L', fields: ['name', 'total'],
                        write: (s) => { buf += s; }, writeErr: () => {} });
  out.data({ list: [{ name: 'Ana', total: 100, id: 'i1', status: 'sent' }] });
  out.flush();
  assert.deepEqual(JSON.parse(buf).data.list, [{ name: 'Ana', total: 100 }],
    '--fields stopped projecting an array it genuinely matches');
});

test('a PARTIAL match still projects — one matching item is enough', () => {
  // If any item carries a requested field, the field list applies to that array. An item lacking it
  // legitimately projects to {} — that is "this row has none of your fields", not a gutted array.
  let buf = '';
  const out = makeOut({ json: true, command: 'x', location: 'L', fields: ['name'],
                        write: (s) => { buf += s; }, writeErr: () => {} });
  out.data({ mixed: [{ name: 'has', other: 1 }, { other: 2 }] });
  out.flush();
  assert.deepEqual(JSON.parse(buf).data.mixed, [{ name: 'has' }, {}]);
});

test('arrays of primitives are never treated as gutted', () => {
  // project() returns non-objects unchanged, so a list of tag names has no keys to keep and would
  // look "all empty" to a naive check.
  let buf = '';
  const out = makeOut({ json: true, command: 'x', location: 'L', fields: ['name'],
                        write: (s) => { buf += s; }, writeErr: () => {} });
  out.data({ tags: ['vip', 'lead'], empty: [] });
  out.flush();
  const d = JSON.parse(buf).data;
  assert.deepEqual(d.tags, ['vip', 'lead']);
  assert.deepEqual(d.empty, [], 'an empty array stays empty — nothing to preserve or project');
});

test('project() leaves an ARRAY alone — a field list names keys, not indices', () => {
  // `typeof [] === 'object'`, so without an explicit guard an array item was rebuilt as {} and a
  // nested list silently became an empty object. Found by a mutation: deleting projectPayload's
  // `wasObjects` guard produced BETTER output than the code it was part of, which meant the guard
  // was masking this rather than fixing it.
  assert.deepEqual(project([1, 2], ['name']), [1, 2], 'an array must never be rebuilt as an object');
  assert.deepEqual(project({ a: 1, name: 'x' }, ['name']), { name: 'x' }, 'plain objects still project');
  assert.equal(project('str', ['name']), 'str');
  assert.equal(project(null, ['name']), null);
});

test('an array OF ARRAYS survives projection intact', () => {
  let buf = '';
  const out = makeOut({ json: true, command: 'x', location: 'L', fields: ['name'],
                        write: (s) => { buf += s; }, writeErr: () => {} });
  out.data({ matrix: [[1, 2], [3, 4]] });
  out.flush();
  assert.deepEqual(JSON.parse(buf).data.matrix, [[1, 2], [3, 4]]);
});
