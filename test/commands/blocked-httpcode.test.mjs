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

test('business list: real scope block → throws AUTH naming businesses.readonly', async () => {
  // Contract changed 2026-07-27: business now THROWS GhlError like every other write command,
  // instead of printing and returning the code. Returning meant `--json` emitted a success-shaped
  // envelope (degraded:false, warnings:[], no error, no remediation) on a hard 401.
  const { ctx } = makeCtx({ businesses: { blocked: true, scope: 'businesses.readonly' } });
  await assert.rejects(
    () => runBusiness({ _: ['list'] }, ctx),
    (e) => e.code === EXIT.AUTH && /businesses\.readonly/.test(e.message));
});

test('business list: non-auth API error (httpCode) → throws API, never blames the scope', async () => {
  const { ctx } = makeCtx({ businesses: { blocked: true, scope: 'businesses.readonly', httpCode: 422 } });
  await assert.rejects(
    () => runBusiness({ _: ['list'] }, ctx),
    (e) => e.code === EXIT.API
        && /API error 422/.test(e.message)
        && !/needs businesses\.readonly/.test(e.message));
});

test('surveys: real scope block → throws AUTH naming the scope', async () => {
  // Contract changed 2026-07-27: reads throw GhlError like the writes do, so --json gets a real
  // error envelope. The scope travels in the error message now, not in printed output.
  const { ctx } = makeCtx({ surveys: { blocked: true, scope: 'surveys.readonly' } });
  await assert.rejects(() => runSurveys({ _: [] }, ctx),
    (e) => e.code === EXIT.AUTH && e.message.includes('surveys.readonly'));
});

test('surveys: non-auth API error (httpCode) → throws API, never blames the scope', async () => {
  const { ctx } = makeCtx({ surveys: { blocked: true, scope: 'surveys.readonly', httpCode: 422 } });
  await assert.rejects(() => runSurveys({ _: [] }, ctx),
    (e) => e.code === EXIT.API && e.message.includes('API error 422') && !e.message.includes('lacks surveys.readonly'));
});

test('forms: real scope block → throws AUTH naming the scope', async () => {
  const { ctx } = makeCtx({ forms: { blocked: true, scope: 'forms.readonly' } });
  await assert.rejects(() => runForms({ _: [] }, ctx),
    (e) => e.code === EXIT.AUTH && e.message.includes('forms.readonly'));
});

test('forms: non-auth API error (httpCode) → throws API, never blames the scope', async () => {
  const { ctx } = makeCtx({ forms: { blocked: true, scope: 'forms.readonly', httpCode: 422 } });
  await assert.rejects(() => runForms({ _: [] }, ctx),
    (e) => e.code === EXIT.API && e.message.includes('API error 422') && !e.message.includes('lacks forms.readonly'));
});
