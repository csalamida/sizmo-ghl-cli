// test/commands/blocked-httpcode.test.mjs — business.mjs / surveys.mjs / forms.mjs must
// distinguish a real scope block (401/403, no httpCode) from a non-auth API error reaching the
// same "blocked" state (any other non-2xx) — same fix as sync.mjs/list.mjs/crm.mjs/export.mjs.
// Conflating them tells an operator who already granted the scope to go look for a permissions
// problem that doesn't exist; the bug is sizmo's, not theirs.
import { test } from 'node:test';
import assert from 'node:assert';
import { run as runBusiness } from '../../commands/business.mjs';
import { run as runSurveys } from '../../commands/surveys.mjs';
import { run as runForms } from '../../commands/forms.mjs';
import { makeOut } from '../../lib/output.mjs';
import { EXIT } from '../../lib/errors.mjs';

function makeCtx(entities) {
  let printed = '';
  const out = makeOut({ json: false, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const ctx = { out, cfg: { loc: 'L-TEST' }, ensureModel: async () => ({ entities }) };
  return { ctx, getPrinted: () => printed };
}

test('business list: real scope block → "needs businesses.readonly scope", exit AUTH', async () => {
  const { ctx, getPrinted } = makeCtx({ businesses: { blocked: true, scope: 'businesses.readonly' } });
  const code = await runBusiness({ _: ['list'] }, ctx);
  assert.equal(code, EXIT.AUTH);
  assert.match(getPrinted(), /needs businesses\.readonly scope/);
});

test('business list: non-auth API error (httpCode) → real error, not "needs <scope>", exit API', async () => {
  const { ctx, getPrinted } = makeCtx({ businesses: { blocked: true, scope: 'businesses.readonly', httpCode: 422 } });
  const code = await runBusiness({ _: ['list'] }, ctx);
  assert.equal(code, EXIT.API);
  const out = getPrinted();
  assert.match(out, /API error 422/);
  assert.doesNotMatch(out, /needs businesses\.readonly/);
});

test('surveys: real scope block → "needs surveys.readonly scope", exit AUTH', async () => {
  const { ctx, getPrinted } = makeCtx({ surveys: { blocked: true, scope: 'surveys.readonly' } });
  const code = await runSurveys({ _: [] }, ctx);
  assert.equal(code, EXIT.AUTH);
  assert.match(getPrinted(), /needs surveys\.readonly scope/);
});

test('surveys: non-auth API error (httpCode) → real error, not "needs <scope>", exit API', async () => {
  const { ctx, getPrinted } = makeCtx({ surveys: { blocked: true, scope: 'surveys.readonly', httpCode: 500 } });
  const code = await runSurveys({ _: [] }, ctx);
  assert.equal(code, EXIT.API);
  const out = getPrinted();
  assert.match(out, /API error 500/);
  assert.doesNotMatch(out, /needs surveys\.readonly/);
});

test('forms: real scope block → "needs forms.readonly scope", exit AUTH', async () => {
  const { ctx, getPrinted } = makeCtx({ forms: { blocked: true, scope: 'forms.readonly' } });
  const code = await runForms({ _: [] }, ctx);
  assert.equal(code, EXIT.AUTH);
  assert.match(getPrinted(), /needs forms\.readonly scope/);
});

test('forms: non-auth API error (httpCode) → real error, not "needs <scope>", exit API', async () => {
  const { ctx, getPrinted } = makeCtx({ forms: { blocked: true, scope: 'forms.readonly', httpCode: 404 } });
  const code = await runForms({ _: [] }, ctx);
  assert.equal(code, EXIT.API);
  const out = getPrinted();
  assert.match(out, /API error 404/);
  assert.doesNotMatch(out, /needs forms\.readonly/);
});
