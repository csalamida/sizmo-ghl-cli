// test/commands/ask.test.mjs — the risk-bearing logic downstream of the LLM call: entity
// resolution (contact/opportunity live search, local field/calendar/business lookup), dedupe,
// per-command step building, and hard-stop-on-failure execution. The LLM call itself
// (lib/llm.mjs) is a thin fetch wrapper verified live in a real session, not mocked here —
// everything ask.mjs does with whatever the LLM returns is what's under test.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concretize, executeSteps } from '../../commands/ask.mjs';
import { saveLastContact } from '../../lib/ask-memory.mjs';
import { makeOut } from '../../lib/output.mjs';
import { EXIT } from '../../lib/errors.mjs';

const TMP_DIRS = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'sizmo-ask-mem-')); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const NOW = 1_800_000_000_000;
const LOC = 'L-ASK';

const FAKE_MODEL = {
  entities: {
    customFields: { items: [{ id: 'fld_1', name: 'Lead Source' }, { id: 'fld_dup', name: 'Dup' }, { id: 'fld_dup2', name: 'Dup' }] },
    calendars:    { items: [{ id: 'cal_1', name: 'Discovery Calls' }] },
    businesses:   { items: [{ id: 'biz_1', name: 'Acme Co' }] },
    pipelines:    { items: [
      { id: 'pl_1', name: 'Sales', stages: [{ id: 'st_won', name: 'Won' }, { id: 'st_prop', name: 'Proposal' }] },
      { id: 'pl_2', name: 'Growth', stages: [{ id: 'st_won2', name: 'Won' }] },
    ] },
  },
};

// contactsByQuery: { "ana": [{...}] } — one http fake serving both /contacts/ search and
// /opportunities/search, call-counted so dedupe can be asserted.
function makeCtx({ contactsByQuery = {}, oppsByContact = {}, confirmed = false, askMemoryDir, httpOverrides = {} } = {}) {
  let contactCalls = 0;
  let printed = '';
  const http = {
    get: async (path, opts) => {
      if (path === '/contacts/') {
        contactCalls++;
        const q = opts.query.query;
        const contacts = contactsByQuery[q] ?? [];
        return { code: 200, ok: true, j: { contacts } };
      }
      if (path === '/opportunities/search') {
        const cid = opts.query.contact_id;
        const opps = oppsByContact[cid] ?? [];
        return { code: 200, ok: true, j: { opportunities: opps } };
      }
      if (httpOverrides.get) return httpOverrides.get(path, opts);
      return { code: 200, ok: true, j: {} };
    },
    post: httpOverrides.post ?? (async () => ({ code: 200, ok: true, j: {} })),
    put: httpOverrides.put ?? (async () => ({ code: 200, ok: true, j: {} })),
    delete: httpOverrides.delete ?? (async () => ({ code: 200, ok: true, j: {} })),
  };
  const out = makeOut({ json: false, tty: false, command: 'ask', location: LOC, write: s => printed += s, writeErr: () => {} });
  const ctx = {
    http, out, now: NOW, confirmed,
    cfg: { loc: LOC },
    _askMemoryDir: askMemoryDir,
    ensureModel: async () => FAKE_MODEL,
  };
  return { ctx, getPrinted: () => printed, getContactCalls: () => contactCalls };
}

// ── concretize: contact resolution ──────────────────────────────────────────────────────────

test('concretize: single contact match resolves and builds the tag step correctly', async () => {
  const { ctx } = makeCtx({ contactsByQuery: { 'Ana Cruz': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }] } });
  const steps = [{ command: 'tag', contactQuery: 'Ana Cruz', fields: { add: 'VIP' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.concrete[0].parsed, { _: ['c1'], add: 'VIP' });
  assert.equal(r.concrete[0].isWrite, true);
  assert.equal(r.resolvedContact.id, 'c1');
});

test('concretize: no contact match aborts the whole batch — never partially resolves', async () => {
  const { ctx } = makeCtx({ contactsByQuery: {} });
  const steps = [
    { command: 'tag', contactQuery: 'Ghost', fields: { add: 'VIP' } },
    { command: 'note', contactQuery: 'Ghost', fields: { text: 'hi' } },
  ];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /no contact found/);
});

test('concretize: multiple contact matches abort with candidate list, never guesses', async () => {
  const { ctx } = makeCtx({ contactsByQuery: { 'Ana': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }, { id: 'c2', firstName: 'Ana', lastName: 'Reyes' }] } });
  const steps = [{ command: 'tag', contactQuery: 'Ana', fields: { add: 'VIP' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 2);
});

test('concretize: dedupes identical contactQuery text across steps — one live search, not two', async () => {
  const { ctx, getContactCalls } = makeCtx({ contactsByQuery: { 'Ana Cruz': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }] } });
  const steps = [
    { command: 'tag', contactQuery: 'Ana Cruz', fields: { add: 'VIP' } },
    { command: 'note', contactQuery: 'Ana Cruz', fields: { text: 'follow up' } },
  ];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.equal(getContactCalls(), 1, 'expected exactly one live contact search for two identical queries');
  assert.deepEqual(r.concrete[0].parsed._, ['c1']);
  assert.deepEqual(r.concrete[1].parsed._, ['c1']);
});

// ── <recent-contact> placeholder: LLM never sees the real name/id ──────────────────────────

test('concretize: <recent-contact> resolves from local memory, no live search performed', async () => {
  const dir = tmpDir();
  saveLastContact(LOC, { id: 'c9', name: 'Marco Reyes' }, NOW - 1000, dir);
  const { ctx, getContactCalls } = makeCtx({ askMemoryDir: dir });
  const steps = [{ command: 'tag', contactQuery: '<recent-contact>', fields: { add: 'follow-up' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.concrete[0].parsed, { _: ['c9'], add: 'follow-up' });
  assert.equal(getContactCalls(), 0, 'the placeholder must resolve locally, never via a live search');
});

test('concretize: <recent-contact> with no memory (expired or first-run) fails closed', async () => {
  const dir = tmpDir();
  const { ctx } = makeCtx({ askMemoryDir: dir });
  const steps = [{ command: 'tag', contactQuery: '<recent-contact>', fields: { add: 'VIP' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /no recent contact remembered/);
});

// ── opportunity resolution ───────────────────────────────────────────────────────────────────

test('concretize: opp move resolves contact then the single open opportunity', async () => {
  const { ctx } = makeCtx({
    contactsByQuery: { 'Ana Cruz': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }] },
    oppsByContact: { c1: [{ id: 'o1', name: 'Website Package', pipelineId: 'pl_1', pipelineStageId: 'st_prop' }] }, // real GHL shape — id refs only, no inline names
  });
  const steps = [{ command: 'opp', subcommand: 'move', oppQuery: 'Ana Cruz', fields: { stage: 'Won' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.concrete[0].parsed, { _: ['move', 'o1'], stage: 'Won' });
});

test('concretize: opp move with zero open opportunities aborts cleanly', async () => {
  const { ctx } = makeCtx({ contactsByQuery: { 'Ana Cruz': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }] }, oppsByContact: {} });
  const steps = [{ command: 'opp', subcommand: 'move', oppQuery: 'Ana Cruz', fields: { stage: 'Won' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /no open opportunities/);
});

test('concretize: opp move with multiple opportunities and no pipeline hint aborts with candidates', async () => {
  const { ctx } = makeCtx({
    contactsByQuery: { 'Ana Cruz': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }] },
    oppsByContact: { c1: [
      { id: 'o1', name: 'Website', pipelineId: 'pl_1' },
      { id: 'o2', name: 'Upsell', pipelineId: 'pl_2' },
    ] },
  });
  const steps = [{ command: 'opp', subcommand: 'move', oppQuery: 'Ana Cruz', fields: { stage: 'Won' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 2);
  assert.match(r.candidates[0], /Sales/, 'candidate list must show the resolved pipeline NAME, not just the raw pipelineId');
});

test('concretize: opp move pipeline hint disambiguates multiple opportunities', async () => {
  const { ctx } = makeCtx({
    contactsByQuery: { 'Ana Cruz': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }] },
    oppsByContact: { c1: [
      { id: 'o1', name: 'Website', pipelineId: 'pl_1' },
      { id: 'o2', name: 'Upsell', pipelineId: 'pl_2' },
    ] },
  });
  const steps = [{ command: 'opp', subcommand: 'move', oppQuery: 'Ana Cruz', oppPipelineHint: 'Growth', fields: { stage: 'Won' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.concrete[0].parsed._, ['move', 'o2']);
});

// ── local (cached-model) lookups: field / calendar / business — no live call ────────────────

test('concretize: field/calendar/business delete resolve locally by name, no HTTP call', async () => {
  const { ctx, getContactCalls } = makeCtx({});
  const steps = [
    { command: 'field', subcommand: 'delete', fieldQuery: 'Lead Source' },
    { command: 'calendar', subcommand: 'delete', calendarQuery: 'Discovery Calls' },
    { command: 'business', subcommand: 'delete', businessQuery: 'Acme Co' },
  ];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.concrete[0].parsed, { _: ['delete', 'fld_1'] });
  assert.deepEqual(r.concrete[1].parsed, { _: ['delete', 'cal_1'] });
  assert.deepEqual(r.concrete[2].parsed, { _: ['delete', 'biz_1'] });
  assert.equal(getContactCalls(), 0);
});

test('concretize: local lookup with duplicate names aborts rather than picking one', async () => {
  const { ctx } = makeCtx({});
  const steps = [{ command: 'field', subcommand: 'delete', fieldQuery: 'Dup' }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /matches 2 items/);
});

test('concretize: local lookup with no match aborts', async () => {
  const { ctx } = makeCtx({});
  const steps = [{ command: 'calendar', subcommand: 'delete', calendarQuery: 'Nonexistent' }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
});

// ── required-field validation before any execution ──────────────────────────────────────────

test('concretize: missing required field aborts the batch before execution, not mid-execution', async () => {
  const { ctx } = makeCtx({ contactsByQuery: { 'Ana Cruz': [{ id: 'c1', firstName: 'Ana', lastName: 'Cruz' }] } });
  const steps = [{ command: 'tag', contactQuery: 'Ana Cruz', fields: {} }]; // no add/remove
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /missing --add or --remove/);
});

test('concretize: no-search direct-field commands (value/field/calendar/business create) need no contact', async () => {
  const { ctx } = makeCtx({});
  const steps = [
    { command: 'value', subcommand: 'create', fields: { name: 'Booking Link', value: 'https://cal.me/x' } },
    { command: 'field', subcommand: 'create', fields: { name: 'Budget', type: 'MONETORY' } },
    { command: 'business', subcommand: 'create', fields: { name: 'New Co' } },
  ];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.concrete[0].parsed, { _: ['create'], name: 'Booking Link', value: 'https://cal.me/x' });
});

// ── non-executable commands (money / scheduling) marked print-only, never auto-fired ────────

test('concretize: invoice/appointment/opp-update are marked executable:false, no builder invoked', async () => {
  const { ctx } = makeCtx({});
  const steps = [{ command: 'invoice', subcommand: 'draft', isWrite: true, fields: { item: 'Consulting:5000' } }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.concrete[0].executable, false);
});

// ── read commands execute immediately, no confirm concept ──────────────────────────────────

test('concretize: read commands (quick-match shape) pass through with their args/fields', async () => {
  const { ctx } = makeCtx({});
  const steps = [{ command: 'list', args: ['forms'], fields: {}, intent: 'list forms' }];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.concrete[0].isWrite, false);
  assert.deepEqual(r.concrete[0].parsed._, ['forms']);
});

// ── executeSteps: real command wiring + hard-stop-on-failure ────────────────────────────────

test('executeSteps: runs real tag.mjs + note.mjs in order via the registry, both succeed', async () => {
  const { ctx } = makeCtx({ confirmed: true });
  const concrete = [
    { command: 'tag', parsed: { _: ['c1'], add: 'VIP' }, isWrite: true, executable: true, describe: 'tag' },
    { command: 'note', parsed: { _: ['c1'], text: 'hi' }, isWrite: true, executable: true, describe: 'note' },
  ];
  const results = await executeSteps(concrete, ctx);
  assert.equal(results.length, 2);
  assert.equal(results[0].code, EXIT.OK);
  assert.equal(results[1].code, EXIT.OK);
});

test('executeSteps: hard-stops on first failure — the second step never runs', async () => {
  let postCalls = 0;
  const { ctx } = makeCtx({
    confirmed: true,
    httpOverrides: { post: async () => { postCalls++; return { code: 403, ok: false, j: {}, txt: 'forbidden' }; } },
  });
  const concrete = [
    { command: 'tag', parsed: { _: ['c1'], add: 'VIP' }, isWrite: true, executable: true, describe: 'tag' },
    { command: 'note', parsed: { _: ['c1'], text: 'hi' }, isWrite: true, executable: true, describe: 'note' },
  ];
  const results = await executeSteps(concrete, ctx);
  assert.equal(results.length, 1, 'the second step must never run after the first fails');
  assert.equal(results[0].code, EXIT.AUTH);
  assert.equal(postCalls, 1);
});

test('executeSteps: a resolve-only (executable:false) step is reported as skipped, not run', async () => {
  const { ctx } = makeCtx({ confirmed: true });
  const concrete = [{ command: 'invoice', executable: false, describe: 'invoice draft' }];
  const results = await executeSteps(concrete, ctx);
  assert.equal(results[0].skipped, true);
});

// ── adversarial-QA fixes ─────────────────────────────────────────────────────────────────────

test('concretize: an unrecognized/hallucinated command name aborts cleanly instead of printing a broken command', async () => {
  const { ctx } = makeCtx({});
  const steps = [{ command: 'contct', subcommand: 'create', fields: { name: 'Oops' } }]; // typo
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /unrecognized command/);
});

test('concretize: same-sentence pronoun prefers the contact JUST resolved in this batch, not stale persisted memory', async () => {
  const dir = tmpDir();
  // Persisted memory holds someone ELSE entirely (from a prior, unrelated ask call).
  saveLastContact(LOC, { id: 'stale-id', name: 'Someone Else' }, NOW - 5000, dir);
  const { ctx } = makeCtx({
    askMemoryDir: dir,
    contactsByQuery: { 'Marco Reyes': [{ id: 'c-marco', firstName: 'Marco', lastName: 'Reyes' }] },
  });
  const steps = [
    { command: 'tag', contactQuery: 'Marco Reyes', fields: { add: 'lead' } },
    { command: 'note', contactQuery: '<recent-contact>', fields: { text: 'called him' } },
  ];
  const r = await concretize(steps, ctx, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.concrete[1].parsed, { _: ['c-marco'], text: 'called him' }, 'must resolve to Marco (this batch), not the stale persisted contact');
});

test('runWithReport (via run): partial-batch failure reports exactly which steps succeeded vs never attempted', async () => {
  const { run } = await import('../../commands/ask.mjs');
  let postCalls = 0;
  const dir = tmpDir();
  const { ctx, getPrinted } = makeCtx({
    confirmed: true,
    askMemoryDir: dir,
    httpOverrides: { post: async () => { postCalls++; return postCalls === 1 ? { code: 200, ok: true, j: {} } : { code: 403, ok: false, j: {}, txt: 'forbidden' }; } },
  });
  // Directly exercise the pending-plan replay path with a pre-built 3-step plan.
  const { savePendingPlan } = await import('../../lib/ask-memory.mjs');
  savePendingPlan(LOC, [
    { command: 'tag', parsed: { _: ['c1'], add: 'VIP' }, isWrite: true, executable: true, describe: 'Tag c1: +VIP' },
    { command: 'note', parsed: { _: ['c1'], text: 'hi' }, isWrite: true, executable: true, describe: 'Note on c1' },
    { command: 'tag', parsed: { _: ['c1'], add: 'second' }, isWrite: true, executable: true, describe: 'Tag c1: +second' },
  ], NOW, ctx._askMemoryDir);
  const code = await run({ _: [] }, ctx);
  const out = getPrinted();
  assert.equal(code, EXIT.AUTH);
  assert.match(out, /✓ Tag c1: \+VIP/, 'first step must be reported as succeeded');
  assert.match(out, /✖ Note on c1/, 'second step must be reported as failed');
  assert.match(out, /1 step\(s\) not attempted/, 'third step must be reported as never attempted, not silently dropped');
});
