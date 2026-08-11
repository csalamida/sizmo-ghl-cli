// test/commands/apply.test.mjs
//
// Phase 3 of location-as-file: export → diff → apply. CONFIRM-GATED, ADDITIVE ONLY.
//
// The two properties that shape everything here:
//
// 1. IT MATCHES ON NAME, NOT ID — and that is the whole reason it does not reuse diffDocs().
//    commands/diff.mjs keys items with `item.id ?? item.name`, i.e. by id. Correct for diff, which
//    compares one location against ITSELF over time where ids are stable. Wrong here: applying a
//    file into a DIFFERENT location means every id differs, so every item would read as missing and
//    a second run would duplicate the lot. Idempotence is the point of an apply.
//
// 2. IT CANNOT COPY A LOCATION, AND SAYS SO. Three of the six exported groups have no create path —
//    not unimplemented in sizmo, ABSENT FROM THE API. There is no create-pipeline operation, no
//    location-tag write, and no user operation at all. Doing three sixths of the job quietly would
//    be the exact dishonesty the rest of this codebase was spent removing.
import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, classify } from '../../commands/apply.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const LOCN = { id: 'L', name: 'N', timezone: 'Asia/Manila', currency: 'PHP', country: 'PH' };

function fileWith(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-test-'));
  const path = join(dir, 'loc.json');
  writeFileSync(path, JSON.stringify({
    specVersion: 1, location: { ...LOCN, id: 'L-SOURCE' },
    pipelines: [], calendars: [], customFields: [], customValues: [], tags: [], users: [],
    degraded: false, warnings: [], ...over,
  }));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mk({ confirmed = false, json = false, model = {}, customValues = [], postCode = 200 } = {}) {
  const h = makeFakeCtx({ json, confirmed });
  h.created = [];
  const entities = {
    location: { item: { ...LOCN, id: 'L-TEST' } },
    pipelines: { items: [] }, calendars: { items: [] }, customFields: { items: [] },
    tags: { items: [] }, users: { items: [] }, ...model,
  };
  h.ctx.ensureModel = async () => ({ entities });
  h.ctx.http.get = async (p) => p.includes('customValues')
    ? { code: 200, ok: true, txt: '{}', j: { customValues } }
    : { code: 200, ok: true, txt: '{}', j: {} };
  h.ctx.http.post = async (p, b) => {
    h.created.push({ path: p, body: b });
    return postCode === 200
      ? { code: 200, ok: true, txt: '{}', j: { id: 'new_' + h.created.length } }
      : { code: postCode, ok: false, txt: 'nope', j: null };
  };
  return h;
}

// ── classify(): the matching rule, tested directly ──────────────────────────

test('classify matches on NAME, ignoring ids that differ across locations', () => {
  const c = classify(
    [{ id: 'src_1', name: 'Budget', dataType: 'TEXT' }],
    [{ id: 'TOTALLY_DIFFERENT', name: 'Budget', dataType: 'TEXT' }],
  );
  assert.equal(c.create.length, 0, 'an id-keyed match would have queued a duplicate');
  assert.equal(c.present.length, 1);
});

test('classify is case- and whitespace-insensitive on the name', () => {
  // Creating a duplicate is worse than skipping one: apply cannot delete, so a duplicate it makes
  // is a duplicate the user cleans up by hand.
  const c = classify([{ id: 'a', name: '  budget ' }], [{ id: 'b', name: 'Budget' }]);
  assert.equal(c.create.length, 0);
});

test('classify separates DIFFERS from PRESENT', () => {
  const c = classify(
    [{ id: 'a', name: 'Brand', value: 'Sizmo' }],
    [{ id: 'b', name: 'Brand', value: 'SOMETHING ELSE' }],
  );
  assert.equal(c.create.length, 0, 'a name that exists is never created again');
  assert.equal(c.present.length, 0);
  assert.equal(c.differs.length, 1, 'same name, different content is its own category');
});

test('classify refuses to compare against a BLOCKED live group', () => {
  // The export's marker design exists so "blocked" cannot be mistaken for "empty". Treating a
  // blocked live group as empty would make apply create everything, blind.
  const c = classify([{ id: 'a', name: 'X' }], { blocked: 'locations/customFields.readonly' });
  assert.equal(c.comparable, false);
  assert.equal(c.create.length, 0);
  assert.match(c.reason, /refusing to create blind/);
});

test('classify refuses when the FILE side is a marker', () => {
  const c = classify({ unavailable: 'not synced' }, [{ id: 'a', name: 'X' }]);
  assert.equal(c.comparable, false);
  assert.equal(c.create.length, 0);
});

// ── the command ─────────────────────────────────────────────────────────────

test('nothing is created without --confirm', async () => {
  const f = fileWith({ customValues: [{ id: 'v1', name: 'Brand', value: 'Sizmo' }] });
  try {
    const h = mk();
    const code = await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    assert.equal(code, EXIT.CONFIRM);
    assert.equal(h.created.length, 0);
  } finally { f.cleanup(); }
});

test('the preview names what CANNOT be created, and why, BEFORE the confirm', async () => {
  // A limit shown only after approval is a limit the user approved without reading.
  const f = fileWith({
    pipelines: [{ id: 'p1', name: 'Sales', stages: [] }],
    tags: [{ id: 't1', name: 'vip' }],
    users: [{ id: 'u1', name: 'CJ', email: 'a@b.co' }],
  });
  try {
    const h = mk();
    await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    const out = h.getPrinted();
    assert.match(out, /CANNOT BE CREATED/);
    assert.match(out, /no create-pipeline operation/);
    assert.match(out, /location-level tags are not writable/);
    assert.match(out, /no user operations at all/);
    assert.match(out, /NOT be a full copy of the file/,
      'the user must be told the outcome is not a copy, in the text they approve');
  } finally { f.cleanup(); }
});

test('it is IDEMPOTENT across locations — a second location with the same names creates nothing', async () => {
  // The property the whole design exists for.
  const f = fileWith({
    customValues: [{ id: 'v_src', name: 'Brand', value: 'Sizmo' }],
    customFields: [{ id: 'f_src', name: 'Budget', dataType: 'NUMERICAL', fieldKey: 'budget' }],
    calendars: [{ id: 'c_src', name: 'Intro Call' }],
  });
  try {
    const h = mk({
      confirmed: true,
      customValues: [{ id: 'v_DIFFERENT', name: 'Brand', value: 'Sizmo' }],
      model: {
        customFields: { items: [{ id: 'f_DIFFERENT', name: 'Budget', dataType: 'NUMERICAL', fieldKey: 'budget' }] },
        calendars: { items: [{ id: 'c_DIFFERENT', name: 'Intro Call' }] },
      },
    });
    const code = await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    assert.equal(code, EXIT.OK);
    assert.equal(h.created.length, 0,
      'every id differs, so id-matching would have created 3 duplicates');
  } finally { f.cleanup(); }
});

test('a name that exists but DIFFERS is reported, not updated', async () => {
  // apply never updates. Reporting it only in the JSON payload would leave a terminal user believing
  // the location now agrees with their file.
  const f = fileWith({ customValues: [{ id: 'v1', name: 'Brand', value: 'Sizmo' }] });
  try {
    const h = mk({ customValues: [{ id: 'v_other', name: 'Brand', value: 'DIFFERENT' }] });
    await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    const out = h.getPrinted();
    assert.match(out, /already exist by name but DIFFER/);
    assert.match(out, /left unchanged \(apply never updates\)/);
    assert.equal(h.created.length, 0);
  } finally { f.cleanup(); }
});

test('a blocked live group is SKIPPED, never created blind', async () => {
  const f = fileWith({ customFields: [{ id: 'f1', name: 'Budget', dataType: 'TEXT' }] });
  try {
    const h = mk({ confirmed: true, model: { customFields: { blocked: 'locations/customFields.readonly' } } });
    await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    assert.equal(h.created.length, 0, 'it created into a group it could not read');
  } finally { f.cleanup(); }
});

test('--confirm creates through each command, and reports per step', async () => {
  const f = fileWith({ customValues: [{ id: 'v1', name: 'Brand', value: 'Sizmo' }] });
  try {
    const h = mk({ confirmed: true, json: true });
    const code = await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    assert.equal(code, EXIT.OK);
    assert.equal(h.created.length, 1);
    const d = JSON.parse(h.getPrinted()).data;
    assert.equal(d.applied, true);
    assert.equal(d.created, 1);
    assert.equal(d.isFullCopy, false, 'no apply is ever a full copy — the field must say so');
    assert.equal(d.results[0].ok, true);
  } finally { f.cleanup(); }
});

test('a failure HARD STOPS — later steps are not attempted', async () => {
  // Continuing past a failure leaves a half-applied location whose remaining errors are probably the
  // same one repeated, and the user cannot tell which happened.
  const f = fileWith({
    customValues: [{ id: 'v1', name: 'A', value: '1' }, { id: 'v2', name: 'B', value: '2' }, { id: 'v3', name: 'C', value: '3' }],
  });
  try {
    const h = mk({ confirmed: true, json: true, postCode: 500 });
    const code = await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    assert.equal(code, EXIT.API, 'a failed apply must not exit 0');
    const d = JSON.parse(h.getPrinted()).data;
    assert.equal(d.created, 0);
    assert.equal(d.notAttempted, 2, 'the two steps after the failure must be marked not attempted');
    assert.equal(d.results[1].attempted, false);
    assert.equal(d.results[1].skipped, 'a previous step failed');
  } finally { f.cleanup(); }
});

test('--only restricts to named groups and refuses uncreatable ones', async () => {
  const f = fileWith({
    customValues: [{ id: 'v1', name: 'Brand', value: 'S' }],
    customFields: [{ id: 'f1', name: 'Budget', dataType: 'TEXT' }],
  });
  try {
    const h = mk({ confirmed: true });
    await run({ _: [f.path], only: 'customValues' }, h.ctx);
    h.ctx.out.flush();
    assert.equal(h.created.length, 1, '--only must restrict what is created');

    const bad = mk();
    await assert.rejects(() => run({ _: [f.path], only: 'pipelines' }, bad.ctx), (e) => {
      assert.equal(e.code, EXIT.USAGE);
      assert.match(e.message, /cannot be created/);
      return true;
    });
  } finally { f.cleanup(); }
});

test('a file from a DEGRADED export is flagged', async () => {
  // Applying it is still valid — additive — but the file is a partial picture of its source, and the
  // user should know that before deciding the target now matches.
  const f = fileWith({ degraded: true, warnings: ['tags blocked'], customValues: [{ id: 'v1', name: 'B', value: '1' }] });
  try {
    const h = mk();
    await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    assert.match(h.getPrinted(), /DEGRADED read/);
  } finally { f.cleanup(); }
});

test('a missing or malformed file is refused with a way forward', async () => {
  const h = mk();
  await assert.rejects(() => run({ _: ['/nope/missing.json'] }, h.ctx), (e) => {
    assert.equal(e.code, EXIT.NOTFOUND);
    assert.match(e.remediation ?? '', /sizmo export --out/);
    return true;
  });

  const dir = mkdtempSync(join(tmpdir(), 'apply-bad-'));
  const bad = join(dir, 'bad.json');
  try {
    writeFileSync(bad, '{"not":"an export"}');
    const h2 = mk();
    await assert.rejects(() => run({ _: [bad] }, h2.ctx), (e) => {
      assert.equal(e.code, EXIT.USAGE);
      assert.match(e.message, /no specVersion/);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file from a NEWER sizmo is refused rather than half-understood', async () => {
  const f = fileWith({ specVersion: 99 });
  try {
    const h = mk();
    await assert.rejects(() => run({ _: [f.path] }, h.ctx), (e) => {
      assert.equal(e.code, EXIT.USAGE);
      assert.match(e.message, /newer sizmo/);
      return true;
    });
  } finally { f.cleanup(); }
});

test('apply never deletes', async () => {
  // v1 is additive only. An apply that could delete is a different tool with a different blast
  // radius, and "I ran it against the wrong location" has to stay recoverable.
  const f = fileWith({ customValues: [] });
  try {
    const h = mk({ confirmed: true, customValues: [{ id: 'v_live_only', name: 'OnlyHere', value: 'x' }] });
    let deleted = 0;
    h.ctx.http.delete = async () => { deleted++; return { code: 200, ok: true, j: {} }; };
    await run({ _: [f.path] }, h.ctx);
    h.ctx.out.flush();
    assert.equal(deleted, 0, 'a resource present live but absent from the file must be LEFT ALONE');
  } finally { f.cleanup(); }
});
