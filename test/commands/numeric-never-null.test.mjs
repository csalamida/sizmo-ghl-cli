// test/commands/numeric-never-null.test.mjs
// A malformed numeric flag must be REFUSED, never coerced onto the wire.
//
// WHY: found 2026-07-27 by inducing failure paths on the update verbs. `Number('abc')` is NaN, and
// JSON.stringify(NaN) is `null`. So:
//     sizmo opp update <id> --value abc --confirm   →   PUT {"monetaryValue":null}
// which BLANKED the deal's real monetary value. The confirm preview made it worse, not better: it
// printed `value: abc` as though the input had been understood, so the user approved a destructive
// no-op they were shown as a normal edit.
//
// This is the sibling of the standing "unset flags must be OMITTED, never sent as null" rule. That
// rule was written for flags the user never passed; this is the same blanking bug reached through a
// flag the user DID pass, badly. Omission was already handled — coercion was not.
//
// invoice.mjs:31 had applied exactly this guard to --item amounts since 2.4.x. It was simply never
// applied to opp --value or calendar --slot-min. Nothing new was decided here; an existing decision
// was made consistent.
//
// These tests assert the outgoing REQUEST BODY, not just the exit code. An exit-code-only test
// passes even if the command exits 2 for an unrelated reason, and says nothing about what would
// have been transmitted.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runOpp } from '../../commands/opp.mjs';
import { run as runCalendar } from '../../commands/calendar.mjs';
import { run as runField } from '../../commands/field.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const MODEL = {
  schemaVersion: 1,
  locationId: 'L-TEST',
  syncedAt: 1_700_000_000_000,
  entities: {
    pipelines: {
      fetchedAt: 1_700_000_000_000,
      items: [{
        id: 'pl-001', name: 'Main Sales',
        stages: [{ id: 'st-001', name: 'New Lead', position: 0 }],
      }],
    },
  },
};

const PUT_OK = { 'PUT /opportunities/opp-1': { status: 200, j: { opportunity: { id: 'opp-1' } } } };

// Whatever a command sends, no key may carry null/NaN as the result of a numeric parse.
const assertNoNullNumerics = (body, label) => {
  for (const [k, v] of Object.entries(body ?? {})) {
    assert.ok(!(v === null || (typeof v === 'number' && Number.isNaN(v))),
      `${label}: key "${k}" would be transmitted as ${JSON.stringify(v)} — a null/NaN numeric ` +
      `overwrites the real stored value with a blank. Refuse the input instead of coercing it.`);
  }
};

// ── opp update --value ────────────────────────────────────────────────────────

for (const bad of ['abc', 'NaN', '12abc', '-50', 'Infinity']) {
  test(`opp update --value '${bad}': refused with USAGE, nothing sent`, async () => {
    const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, model: MODEL });
    await assert.rejects(
      () => runOpp({ _: ['update', 'opp-1'], value: bad }, ctx),
      (e) => e.code === EXIT.USAGE,
      `--value '${bad}' must be refused as USAGE, not coerced`);
    assert.deepEqual(getCalledWrites(), [],
      `--value '${bad}' was refused but a write still fired — validation must precede the request`);
  });
}

test('opp update --value 0 IS allowed — a deal can legitimately be worth nothing', async () => {
  // Deliberate divergence from invoice.mjs, which rejects amount <= 0 because a zero-amount line
  // item is meaningless. A won deal with no cash attached is a real thing, so 0 stays legal here.
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, model: MODEL, fixture: PUT_OK });
  const code = await runOpp({ _: ['update', 'opp-1'], value: '0' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.strictEqual(getCalledBodies()[0].body.monetaryValue, 0,
    'zero must survive as the number 0, not be dropped or blanked');
});

test('opp update --value: a valid number reaches the body as a NUMBER, not a string', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, model: MODEL, fixture: PUT_OK });
  await runOpp({ _: ['update', 'opp-1'], value: '5000' }, ctx);
  ctx.out.flush();
  const body = getCalledBodies()[0].body;
  assert.strictEqual(body.monetaryValue, 5000);
  assertNoNullNumerics(body, 'opp update');
});

test('opp update: an omitted --value is absent from the body entirely', async () => {
  // The original standing rule. Pinned alongside its coercion sibling so the two cannot drift.
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, model: MODEL, fixture: PUT_OK });
  await runOpp({ _: ['update', 'opp-1'], status: 'won' }, ctx);
  ctx.out.flush();
  const body = getCalledBodies()[0].body;
  assert.ok(!('monetaryValue' in body),
    'monetaryValue must be ABSENT when --value was not passed, never present-and-null');
  assertNoNullNumerics(body, 'opp update');
});

// ── opp create --value ────────────────────────────────────────────────────────

test('opp create --value abc: refused, no write fires', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, model: MODEL });
  await assert.rejects(
    () => runOpp({ _: ['create'], name: 'D', pipeline: 'Main Sales', stage: 'New Lead',
                   contact: 'c1', value: 'abc' }, ctx),
    (e) => e.code === EXIT.USAGE);
  assert.deepEqual(getCalledWrites(), []);
});

test('opp create --value 5000: lands as a number', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true, model: MODEL,
    fixture: { 'POST /opportunities/': { status: 200, j: { opportunity: { id: 'o-new' } } } },
  });
  await runOpp({ _: ['create'], name: 'D', pipeline: 'Main Sales', stage: 'New Lead',
                 contact: 'c1', value: '5000' }, ctx);
  ctx.out.flush();
  const body = getCalledBodies()[0].body;
  assert.strictEqual(body.monetaryValue, 5000);
  assertNoNullNumerics(body, 'opp create');
});

// ── calendar create --slot-min ────────────────────────────────────────────────

for (const bad of ['abc', '0', '-15', '12.5']) {
  test(`calendar create --slot-min '${bad}': refused with USAGE, nothing sent`, async () => {
    const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, model: MODEL });
    await assert.rejects(
      () => runCalendar({ _: ['create'], name: 'Discovery', 'slot-min': bad }, ctx),
      (e) => e.code === EXIT.USAGE,
      `--slot-min '${bad}' must be refused (non-integer or <= 0 minutes is not a duration)`);
    assert.deepEqual(getCalledWrites(), []);
  });
}

test('calendar create --slot-min 30: reaches the body as a number', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true, model: MODEL,
    fixture: { 'POST /calendars/': { status: 200, j: { calendar: { id: 'cal-1' } } } },
  });
  await runCalendar({ _: ['create'], name: 'Discovery', 'slot-min': '30' }, ctx);
  ctx.out.flush();
  const body = getCalledBodies()[0].body;
  assert.strictEqual(body.slotDuration, 30);
  assert.equal(body.slotDurationUnit, 'mins');
  assertNoNullNumerics(body, 'calendar create');
});

// ── the class-wide guard ──────────────────────────────────────────────────────

test('no write command coerces a numeric flag with a bare Number() into a request body', () => {
  // A source-level backstop. The per-command tests above only cover the two call sites that were
  // wrong; this catches the NEXT one, which would otherwise ship the same blanking bug in a command
  // nobody thought to test.
  //
  // Read commands are exempt by construction: they use the `Number(x) || 0` idiom, which cannot
  // produce null because the || collapses NaN to 0 for display. Only request bodies matter here.
  const CMD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands');
  const offenders = [];
  for (const f of readdirSync(CMD_DIR).filter(n => n.endsWith('.mjs'))) {
    // Strip comments so prose describing the bug does not trip its own guard — a real false
    // positive hit earlier this session when a scan matched an explanatory comment.
    const code = readFileSync(join(CMD_DIR, f), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    // `key: Number(x)` inside an object literal, WITHOUT a `|| 0` / `?? 0` collapse after it.
    //
    // The leading [{,] is load-bearing: without it this also matched the ALTERNATE branch of a
    // ternary — `typeof raw === 'number' ? raw : Number(raw)` reads as `raw: Number(raw)` to a
    // naive scan. That produced a false positive on transactions.mjs:102, which is display-only
    // and already NaN-guarded on the next line. An object key is always preceded by `{` or `,`.
    const re = /[{,]\s*(\w+)\s*:\s*Number\(([^)]*)\)\s*(?!\s*(\|\||\?\?))/g;
    let m;
    while ((m = re.exec(code)) !== null) offenders.push(`${f}: ${m[1]}: Number(${m[2]})`);
  }
  assert.deepEqual(offenders, [],
    `These build a request body with an unguarded Number(): ${offenders.join(' | ')}. ` +
    `Number('abc') is NaN and JSON.stringify(NaN) is null, so a typo blanks the stored value. ` +
    `Validate with Number.isFinite() and throw EXIT.USAGE before the confirm preview.`);
});

// ── field create/update --position and --max-files ───────────────────────────
// These two flags were NOT found by hand. The manual grep that found opp --value filtered on money
// words ('value|amount|price|total|monetary'), and neither 'position' nor 'max-files' matches — so
// both shipped with the same blanking bug. The class-wide source guard below found them.
//
// They are pinned BEHAVIOURALLY here, not just by that source guard, because mutation testing
// proved the source guard alone does not cover them: once the fix assigns to a local
// (`const position = parseNumericFlag(...)`) and the body uses shorthand `{ position }`, the
// `key: Number(` pattern no longer matches, so reverting the guard is invisible to it. The source
// scan catches the NEXT command written in the old inline style; these tests catch a regression
// in THIS one. Neither alone is sufficient.
const FIELD_BASE = '/locations/L-TEST/customFields';
const EXISTING_FIELD = {
  status: 200,
  j: { customField: { id: 'fld-1', name: 'Budget', dataType: 'TEXT', model: 'contact' } },
};

for (const [flag, bad] of [
  ['position',  'abc'], ['position',  '-1'],  ['position',  '2.5'],
  ['max-files', 'abc'], ['max-files', '0'],   ['max-files', '-3'],
]) {
  test(`field create --${flag} '${bad}': refused with USAGE, nothing sent`, async () => {
    const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true });
    await assert.rejects(
      () => runField({ _: ['create'], name: 'Budget', [flag]: bad }, ctx),
      (e) => e.code === EXIT.USAGE,
      `field create --${flag} '${bad}' must be refused, not coerced to null`);
    assert.deepEqual(getCalledWrites(), []);
  });

  test(`field update --${flag} '${bad}': refused, no PUT fires`, async () => {
    const { ctx, getCalledWrites } = makeFakeCtx({
      confirmed: true,
      fixture: { [`GET ${FIELD_BASE}/fld-1`]: EXISTING_FIELD },
    });
    await assert.rejects(
      () => runField({ _: ['update', 'fld-1'], [flag]: bad }, ctx),
      (e) => e.code === EXIT.USAGE,
      `field update --${flag} '${bad}' must be refused — on update, null BLANKS the stored value`);
    assert.deepEqual(getCalledWrites(), [],
      'no PUT may fire for input that was refused');
  });
}

test('field create --position 3 --max-files 5: both land as numbers', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true,
    fixture: { [`POST ${FIELD_BASE}`]: { status: 200, j: { customField: { id: 'fld-new' } } } },
  });
  await runField({ _: ['create'], name: 'Budget', position: '3', 'max-files': '5' }, ctx);
  ctx.out.flush();
  const body = getCalledBodies()[0].body;
  assert.strictEqual(body.position, 3);
  assert.strictEqual(body.maxNumberOfFiles, 5);
  assertNoNullNumerics(body, 'field create');
});

test('field create --position 0 IS allowed — position is an index, first slot is 0', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true,
    fixture: { [`POST ${FIELD_BASE}`]: { status: 200, j: { customField: { id: 'fld-new' } } } },
  });
  await runField({ _: ['create'], name: 'Budget', position: '0' }, ctx);
  ctx.out.flush();
  assert.strictEqual(getCalledBodies()[0].body.position, 0,
    'position 0 must survive as the number 0 — it is a valid index, not a missing value');
});

test('field update: omitted --position is ABSENT from the body, never null', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true,
    fixture: {
      [`GET ${FIELD_BASE}/fld-1`]: EXISTING_FIELD,
      [`PUT ${FIELD_BASE}/fld-1`]: { status: 200, j: { customField: { id: 'fld-1' } } },
    },
  });
  await runField({ _: ['update', 'fld-1'], placeholder: 'new hint' }, ctx);
  ctx.out.flush();
  const body = getCalledBodies().find(b => b.method === 'PUT').body;
  assert.ok(!('position' in body),
    'position must be ABSENT when --position was not passed, never present-and-null');
  assertNoNullNumerics(body, 'field update');
});

test('field update: a malformed numeric flag is refused BEFORE the fetch — zero API calls', async () => {
  // Asserts getCalledPaths(), not getCalledWrites(). The write-only assertion above passes even
  // when a wasted GET fires, because a GET is not a write — which is exactly how this shipped:
  // validation sat after the fetch, so `field update f1 --position 2.5` against a bad token
  // reported exit 3 (AUTH) instead of exit 2 (USAGE), blaming the token for a purely local typo.
  // A local input error must never depend on, or be masked by, a network result.
  const { ctx, getCalledPaths } = makeFakeCtx({
    confirmed: true,
    fixture: { [`GET ${FIELD_BASE}/fld-1`]: EXISTING_FIELD },
  });
  await assert.rejects(
    () => runField({ _: ['update', 'fld-1'], position: '2.5' }, ctx),
    (e) => e.code === EXIT.USAGE);
  assert.deepEqual(getCalledPaths(), [],
    'no request of any kind may fire for input that is invalid on its face');
});
