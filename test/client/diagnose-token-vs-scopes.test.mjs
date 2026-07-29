// test/client/diagnose-token-vs-scopes.test.mjs
//
// probeLanes classifies every 401/403 as "this scope is missing". That is right when SOME lanes
// fail and wrong when ALL of them do, because an invalid/expired/revoked PIT is denied on every
// lane. Verified 2026-07-28:
//     PIT expired, every lane 401     -> 12 lanes reported missing -> "12 scope(s) missing"
//     token valid, 2 scopes missing   -> 2 lanes reported missing  -> correct
// Both produced the same KIND of output; only the count differed. So a user holding a dead token
// was told to add twelve scopes — a remedy that cannot work, aimed at a token that no longer
// exists — and doctor printed "add it in GHL" twelve times while its own verdict said otherwise.
import { test } from 'node:test';
import assert from 'node:assert';
import { probeLanes, diagnoseLanes } from '../../lib/diagnose.mjs';

const http = (fn) => ({ get: fn });
const ALL_401 = http(async () => ({ code: 401, ok: false, j: {} }));
const ALL_OK = http(async () => ({ code: 200, ok: true, j: {} }));
const ALL_DEAD = http(async () => ({ code: 0, ok: false, j: null }));
const someDenied = (paths) => http(async (p) =>
  paths.some(d => String(p).startsWith(d)) ? { code: 403, ok: false, j: {} } : { code: 200, ok: true, j: {} });

test('every lane denied → diagnosed as a TOKEN problem, not N missing scopes', async () => {
  const v = diagnoseLanes(await probeLanes(ALL_401, 'L-1'));
  assert.equal(v.kind, 'token');
  assert.match(v.headline, /points at the TOKEN/);
  assert.match(v.remediation, /invalid, expired or revoked/);
  assert.match(v.remediation, /cannot fix a token/,
    'the remediation must say plainly that adding scopes will not help');
});

test('the token verdict admits the OTHER possibility — a live token with no scopes', async () => {
  // "Every lane denied" is genuinely ambiguous from out here: a brand-new PIT created with zero
  // scopes looks identical to a dead one. Rather than pick, the diagnosis names both and the
  // remediation resolves both. Standing rule: when introspection is ambiguous, document the
  // uncertainty instead of guessing silently.
  const v = diagnoseLanes(await probeLanes(ALL_401, 'L-1'));
  assert.match(v.remediation, /no scopes at all/,
    'a live token created without scopes must not be misdiagnosed as a dead one either');
});

test('SOME lanes denied → still diagnosed as missing scopes, and names them', async () => {
  // The inverse guard. The common, actionable case must not be swallowed by the new branch.
  const v = diagnoseLanes(await probeLanes(someDenied(['/payments/transactions']), 'L-1'));
  assert.equal(v.kind, 'scopes');
  assert.match(v.headline, /1 of \d+ scope\(s\) missing/);
  assert.ok(v.missing.length === 1, 'and lists exactly the missing scope');
  assert.match(v.remediation, /add:/);
});

test('no lanes denied → ok', async () => {
  assert.equal(diagnoseLanes(await probeLanes(ALL_OK, 'L-1')).kind, 'ok');
});

test('every lane a transport error → unreachable, NOT a token or scope verdict', async () => {
  // A network failure must not be reported as a credential problem — that sends someone to
  // re-create a perfectly good token.
  const v = diagnoseLanes(await probeLanes(ALL_DEAD, 'L-1'));
  assert.equal(v.kind, 'unreachable');
  assert.match(v.remediation, /network/);
});

test('no lanes at all → no verdict invented', async () => {
  assert.equal(diagnoseLanes([]).kind, 'unknown');
  assert.equal(diagnoseLanes(undefined).kind, 'unknown');
});

test('doctor: a dead token prints the token verdict and STOPS advising per-scope fixes', async () => {
  // The contradiction that shipped: the verdict said "adding individual scopes cannot fix a token
  // that no longer works" while the section above it printed "add it in GHL" twelve times.
  const { run } = await import('../../commands/doctor.mjs');
  const { makeFakeCtx } = await import('../_helpers.mjs');
  const { ctx, getPrinted } = makeFakeCtx({ json: false });
  ctx.http.get = async () => ({ code: 401, ok: false, j: {}, txt: '' });
  ctx.ensureModel = async () => ({ entities: {} });

  await run({}, ctx);
  ctx.out.flush();
  const out = getPrinted();

  assert.match(out, /points at the TOKEN/, 'the verdict must name the token as the cause');
  assert.equal((out.match(/add it in GHL/g) || []).length, 0,
    'no per-scope "add it" advice may appear when the token itself is the problem — printing it ' +
    'alongside the verdict gives one screen two contradictory instructions');
});

test('doctor: a genuine single missing scope STILL gets its per-scope fix line', async () => {
  // Guards against overcorrecting: the per-lane remedy is the useful output in the common case.
  const { run } = await import('../../commands/doctor.mjs');
  const { makeFakeCtx } = await import('../_helpers.mjs');
  const { ctx, getPrinted } = makeFakeCtx({ json: false });
  ctx.http.get = async (path) => (String(path).startsWith('/payments/transactions')
    ? { code: 403, ok: false, j: {}, txt: '' }
    : { code: 200, ok: true, j: {}, txt: '{}' });
  ctx.ensureModel = async () => ({ entities: {} });

  await run({}, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.ok((out.match(/add it in GHL/g) || []).length >= 1,
    'a real missing scope must still tell the user exactly where to add it');
  assert.ok(!/points at the TOKEN/.test(out), 'and must not be misreported as a dead token');
});
