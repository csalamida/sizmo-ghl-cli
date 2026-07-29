// test/client/agent-envelope.test.mjs
//
// Four ways `--json` told an agent nothing, all measured 2026-07-30. The shared root cause of three
// of them: ctx.out.line is suppressed under --json, and RETURNING an exit code (rather than
// throwing) never reaches cli.mjs's handler that builds the error envelope. Net effect — the
// failure printed nothing and the envelope looked like success.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../../lib/errors.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 1. `sizmo list --json` had a null payload ────────────────────────────────────────────────
// Measured: { data: null, degraded: false, warnings: [] } exit 0, while the TTY printed twelve
// entities with counts and the exact command for each. Both agent docs tell an agent to run
// `sizmo list` first, so the command written to orient an agent was the one that told it nothing.

const ENTS = () => ({
  pipelines:    { items: [{ id: 'p1', name: 'Sales' }], fetchedAt: 1 },
  calendars:    { items: [], fetchedAt: 1 },
  tags:         { blocked: true, scope: 'contacts.readonly' },
  customFields: { items: [{ id: 'f1' }, { id: 'f2' }], fetchedAt: 1 },
  users:        { items: [{ id: 'u1' }], fetchedAt: 1 },
  forms:        { items: [], fetchedAt: 1 },
  surveys:      { items: [], fetchedAt: 1 },
  products:     { items: [], fetchedAt: 1 },
  links:        { items: [], fetchedAt: 1 },
  businesses:   { items: [], fetchedAt: 1 },
  objects:      { items: [], fetchedAt: 1 },
});

async function runList(args = {}) {
  const { run } = await import('../../commands/list.mjs');
  const { ctx, getPrinted } = makeFakeCtx({ json: true });
  ctx.ensureModel = async () => ({ entities: ENTS() });
  const code = await run({ _: [], ...args }, ctx);
  ctx.out.flush();
  return { code, env: JSON.parse(getPrinted()) };
}

test('list --json carries the entity index, not null', async () => {
  const { code, env } = await runList();
  assert.equal(code, EXIT.OK);
  assert.ok(env.data, 'data is null — the agent-orientation command returned no payload');
  assert.equal(env.data.entities.length, 12, 'all twelve entities must be listed');
});

test('every index row names the command to run next', async () => {
  // Discoverability is the whole point: an agent should not have to guess the subcommand.
  const { env } = await runList();
  for (const r of env.data.entities) {
    assert.match(r.command, /^sizmo list \S+/, `row ${r.entity} has no runnable command`);
    assert.ok(r.label, `row ${r.entity} has no human label`);
  }
});

test('a blocked entity reports UNKNOWN, never a count of zero', async () => {
  // "0 tags" and "cannot see tags" are different facts. Reporting the first for the second is the
  // fabricated-zero failure this codebase treats as a hard rule.
  const { env } = await runList();
  const tags = env.data.entities.find(e => e.entity === 'tags');
  assert.equal(tags.blocked, true);
  assert.strictEqual(tags.count, null,
    `blocked entity reported count ${tags.count} — a source that cannot be read is UNKNOWN, not 0`);
  assert.equal(tags.scope, 'contacts.readonly', 'a blocked row must name the scope it needs');
  assert.equal(env.degraded, true, 'an index missing an entity is degraded');
  assert.ok(env.warnings.some(w => /tags/i.test(w)), 'the blocked entity must be named in warnings');
});

test('a readable but genuinely empty entity reports 0, not UNKNOWN — the inverse guard', async () => {
  const { env } = await runList();
  const cals = env.data.entities.find(e => e.entity === 'calendars');
  assert.equal(cals.blocked, false);
  assert.strictEqual(cals.count, 0,
    'an entity that is readable and empty must report 0 — collapsing it to null would hide real data');
  const pipes = env.data.entities.find(e => e.entity === 'pipelines');
  assert.strictEqual(pipes.count, 1);
});

// ── 2. `truncated` meant opposite things in two commands ────────────────────────────────────
// crm sent `items: shown` (the 20-item display subset) with truncated:true. list has always sent
// complete items. The codebase-wide meaning — paginate, pipeline, snapshot, noshow — is "the DATA is
// incomplete, treat it as a floor". crm.test.mjs had NO assertion about truncation, which is why a
// JSON caller silently receiving 20 of N tags survived.

// crm reads its model from disk (ctx._modelDir), not via ensureModel, so this builds a real one by
// running `sync` against an injected http that returns 50 tags — the same approach crm's own tests
// use. A first draft stubbed ctx.ensureModel and got data:null for every crm case.
function crmHttp(tagCount) {
  const map = {
    '/opportunities/pipelines': { pipelines: [{ id: 'p1', name: 'Sales', stages: [{ id: 's1', name: 'Lead', position: 0 }] }] },
    '/calendars/': { calendars: [{ id: 'c1', name: 'Intro', calendarType: 'event', isActive: true }] },
    '/tags': { tags: Array.from({ length: tagCount }, (_, i) => ({ id: 't' + i, name: 'tag' + i })) },
    '/customFields': { customFields: [{ id: 'f1', name: 'Goal', fieldKey: 'goal', dataType: 'TEXT', model: 'contact' }] },
    '/users/': { users: [{ id: 'u1', firstName: 'Jane', lastName: 'D', email: 'j@t.com' }] },
    '/locations/': { location: { id: 'L-TEST', name: 'Biz', timezone: 'Asia/Manila', business: { currency: 'PHP' }, country: 'PH' } },
  };
  return { get: async (path) => {
    const k = Object.keys(map).find(x => path.includes(x));
    return k ? { code: 200, ok: true, j: map[k] } : { code: 404, ok: false, j: null };
  } };
}

const NOW_CRM = 1_700_000_000_000;
async function runCrm(entity, args = {}, tagCount = 50) {
  const { run: runSync } = await import('../../commands/sync.mjs');
  const { run } = await import('../../commands/crm.mjs');
  const { makeOut } = await import('../../lib/output.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'agent-env-crm-'));
  const http = crmHttp(tagCount);
  const mk = () => {
    let printed = '';
    const out = makeOut({ json: true, tty: false, command: 'crm', location: 'L-TEST',
                          write: (s) => printed += s, writeErr: () => {} });
    return { ctx: { http, cfg: { loc: 'L-TEST' }, out, now: NOW_CRM, _modelDir: dir },
             getPrinted: () => printed };
  };
  await runSync({ _: [] }, mk().ctx);
  const { ctx, getPrinted } = mk();
  const code = await run({ _: [entity], ...args }, ctx);
  ctx.out.flush();
  return { code, env: JSON.parse(getPrinted()) };
}

test('crm --json returns EVERY item, not the display subset', async () => {
  const { env } = await runCrm('tags');
  assert.equal(env.data.total, 50);
  assert.equal(env.data.items.length, 50,
    `crm returned ${env.data.items.length} of ${env.data.total} items. A JSON caller that does not ` +
    `pass --all silently received a partial list.`);
});

test('truncated means "the data is incomplete" — so it is false when everything is present', async () => {
  // One meaning tool-wide. It is not a report about how the terminal rendered.
  for (const args of [{}, { all: true }]) {
    const { env } = await runCrm('tags', args);
    assert.equal(env.data.truncated, false,
      `truncated:true while items (${env.data.items.length}) already holds all ${env.data.total} ` +
      `records. Everywhere else in this tool truncated:true means "treat this as a floor", so an ` +
      `agent would re-request data it already had, or worse, distrust a complete answer.`);
  }
});

test('items and total never contradict each other', async () => {
  // The self-consistency check that catches this bug from either side, on BOTH commands.
  const { run: runL } = await import('../../commands/list.mjs');
  const cases = [];
  cases.push(['crm', (await runCrm('tags')).env]);
  {
    const { ctx, getPrinted } = makeFakeCtx({ json: true });
    const many = Array.from({ length: 50 }, (_, i) => ({ id: 't' + i, name: 'tag' + i }));
    ctx.ensureModel = async () => ({ entities: { ...ENTS(), tags: { items: many, fetchedAt: 1 } } });
    await runL({ _: ['tags'] }, ctx);
    ctx.out.flush();
    cases.push(['list', JSON.parse(getPrinted())]);
  }
  for (const [label, env] of cases) {
    const d = env.data;
    assert.ok(d, `${label}: data is null`);
    assert.equal(d.items.length, d.total, `${label}: items.length ${d.items.length} != total ${d.total}`);
    assert.equal(d.truncated, d.items.length < d.total,
      `${label}: truncated (${d.truncated}) disagrees with items (${d.items.length}) vs total (${d.total})`);
  }
});

// ── 3. ask's error paths were invisible under --json ─────────────────────────────────────────
// With no AI key: {data:null, degraded:false, warnings:[]}, exit 3, and NOTHING on stderr.

test('ask surfaces a missing AI key as a real error with a remediation', async () => {
  const { run } = await import('../../commands/ask.mjs');
  const { ctx } = makeFakeCtx({ json: true });
  ctx.cfg = { ...ctx.cfg, aiKey: null };
  await assert.rejects(
    () => run({ _: ['book something vague nobody can match'] }, ctx),
    (e) => {
      assert.equal(e.name, 'GhlError', 'must throw so the CLI can build an error envelope');
      assert.equal(e.code, EXIT.AUTH);
      assert.match(e.remediation ?? '', /--ai-key/,
        'an exit code alone does not tell an agent what to do');
      return true;
    });
});

test('no command signals failure by returning a code with human-only output', () => {
  // The structural guard. ctx.out.line writes nothing under --json, so a path that only calls
  // out.line and then RETURNS an error code produces a success-shaped envelope and a bare exit
  // code. Scanned across every command; `doctor` is the one deliberate exception, because its
  // return is a summary verdict printed after the report the user ran it to read.
  const ALLOWED = new Set(['doctor']);
  const RET = /return\s+EXIT\.(AUTH|API|USAGE|NOTFOUND)\s*;/;
  const LINE = new RegExp('out\\.line\\(');
  const DATA = new RegExp('out\\.data\\(');
  const offenders = [];
  for (const f of readdirSync(join(REPO, 'commands')).filter(f => f.endsWith('.mjs'))) {
    const cmd = f.replace(/\.mjs$/, '');
    if (ALLOWED.has(cmd)) continue;
    const lines = readFileSync(join(REPO, 'commands', f), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, ''));       // CODE only
    for (let i = 0; i < lines.length; i++) {
      if (!RET.test(lines[i])) continue;
      let sawLine = false;
      for (let j = i - 1; j >= Math.max(0, i - 14); j--) {
        if (DATA.test(lines[j])) break;                       // it emitted a payload: fine
        if (LINE.test(lines[j])) sawLine = true;
      }
      if (sawLine) offenders.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [],
    `These return an error code having written only human output: ${offenders.join(', ')}. Under ` +
    `--json the human lines are suppressed and a returned code skips the error handler, so the ` +
    `caller gets {data:null, degraded:false} with a bare non-zero exit and no explanation on ` +
    `either stream. Throw GhlError instead.`);
});

// ── 4. an internal error emitted no envelope at all ──────────────────────────────────────────
// Induced on `sizmo crm tags --json`: exit 1, stdout EMPTY, stderr a bare unstructured line —
// while a deliberate GhlError produces {error, code, remediation}. Same class of failure, two
// different shapes, and the unexpected one was the unparseable one.

test('an unexpected internal error still produces a JSON error envelope', async () => {
  const { route } = await import('../../lib/cli.mjs');
  let err = '';
  const code = await route(['__definitely_not_a_command__', '--json'], {
    write: () => {}, writeErr: (s) => { err += s; },
  });
  // An unknown command is a GhlError; this pins the shape both branches must share.
  const parsed = JSON.parse(err);
  assert.equal(typeof parsed.error, 'string');
  assert.equal(parsed.code, code);
  assert.ok(parsed.remediation, 'an error envelope without a remediation leaves the caller stuck');
});

test('the internal-error branch is marked internal and blames sizmo, not the account', () => {
  // Asserted on source: inducing a genuine TypeError inside a command from a unit test would mean
  // shipping broken code to trigger it. What matters is that the branch exists, emits JSON under
  // --json, and does not send the user chasing a permissions or token problem for a sizmo bug.
  const src = readFileSync(join(REPO, 'lib', 'cli.mjs'), 'utf8')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // CODE only
  const tail = src.slice(src.indexOf('if (e instanceof GhlError)'));
  assert.match(tail, /internal: true/, 'the internal-error envelope must be distinguishable');
  assert.match(tail, /internal error:/, 'the message must say it is internal');
  assert.ok(/JSON\.stringify\([\s\S]{0,400}internal/.test(tail),
    'the internal branch must emit JSON under --json, not a bare line');
});
