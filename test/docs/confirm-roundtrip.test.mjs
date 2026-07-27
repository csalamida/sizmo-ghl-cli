// test/docs/confirm-roundtrip.test.mjs
// The confirm gate's promise, from README: without --confirm the CLI "prints the exact change + a
// rerun command". If a flag you passed is missing from that rerun command, running the offered
// command produces a DIFFERENT write than the one you approved.
//
// WHY: found 2026-07-27. `sizmo invoice draft --due 2026-12-25` previewed "due 2026-12-25" but
// offered a rerun command with no --due, so running it produced an invoice due +14 days. On a
// money document that is the difference between the terms a client agreed to and different ones.
//
// This guard is BEHAVIOURAL, not textual. A first pass grepped the source for flag names inside
// the rerun-building region and produced three false positives (contact, opp, tag all build their
// flags in helpers or ternaries declared above the region) while finding the one real case. Source
// scanning cannot tell "assembled elsewhere" from "dropped". Running the command and reading the
// envelope can.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeFakeCtx } from '../_helpers.mjs';

// Each case: the command module, args to pass, fixtures needed to reach the confirm gate, and the
// flags that MUST appear in the offered rerun command. Only flags whose value changes the write.
const CASES = [
  {
    name: 'invoice draft',
    mod: '../../commands/invoice.mjs',
    args: { _: ['draft'], contact: 'cid-x', item: 'Coaching:5000', currency: 'PHP', name: 'Xmas', due: '2026-12-25' },
    fixture: {
      'GET /contacts/cid-x': { status: 200, j: { contact: { id: 'cid-x', firstName: 'Ana' } } },
      'GET /locations/L-TEST': { status: 200, j: { location: { name: 'Test Co' } } },
    },
    mustCarry: ['--contact', '--item', '--currency', '--name', '--due'],
  },
  {
    name: 'contact create',
    mod: '../../commands/contact.mjs',
    args: { _: ['create'], email: 'a@b.com', name: 'Ana', source: 'webinar', 'assigned-user': 'usr-1',
            company: 'Acme', timezone: 'Asia/Manila', country: 'PH', dnd: true, tag: 'lead' },
    fixture: {},
    mustCarry: ['--email', '--name', '--source', '--assigned-user', '--company', '--timezone', '--country', '--dnd', '--tag'],
  },
  {
    name: 'tag add',
    mod: '../../commands/tag.mjs',
    args: { _: ['cid-x'], add: 'vip' },
    fixture: { 'GET /contacts/cid-x': { status: 200, j: { contact: { id: 'cid-x', firstName: 'Ana', tags: [] } } } },
    mustCarry: ['--add'],
  },
  {
    name: 'tag remove',
    mod: '../../commands/tag.mjs',
    args: { _: ['cid-x'], remove: 'cold' },
    fixture: { 'GET /contacts/cid-x': { status: 200, j: { contact: { id: 'cid-x', firstName: 'Ana', tags: ['cold'] } } } },
    mustCarry: ['--remove'],
  },
  {
    name: 'business create',
    mod: '../../commands/business.mjs',
    args: { _: ['create'], name: 'Acme', email: 'hi@acme.com', phone: '+15550101', website: 'https://acme.com' },
    fixture: {},
    mustCarry: ['--name', '--email', '--phone', '--website'],
  },
];

for (const c of CASES) {
  test(`${c.name}: every flag passed survives into the rerun command`, async () => {
    const { run } = await import(c.mod);
    const { ctx, getPrinted } = makeFakeCtx({ fixture: c.fixture });
    await run(c.args, ctx);          // no --confirm → confirm envelope
    ctx.out.flush();
    const data = JSON.parse(getPrinted()).data;
    assert.equal(data.status, 'confirmation_required', `${c.name} did not reach the confirm gate`);
    const cmd = data.confirmCommand;
    const missing = c.mustCarry.filter(f => !cmd.includes(f));
    assert.deepEqual(missing, [],
      `${c.name} previewed a change but its rerun command drops ${missing.join(', ')}. ` +
      `Running the offered command would fire a DIFFERENT write than the one previewed. ` +
      `Got: ${cmd}`);
    assert.ok(cmd.endsWith('--confirm'), `rerun command must end with --confirm — got: ${cmd}`);
  });
}

test('invoice draft: the previewed due date is the one the rerun command reproduces', async () => {
  // The specific regression, pinned by value rather than by flag presence: it is not enough for
  // --due to appear, it must carry the date the human just read.
  const { run } = await import('../../commands/invoice.mjs');
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: {
      'GET /contacts/cid-x': { status: 200, j: { contact: { id: 'cid-x', firstName: 'Ana' } } },
      'GET /locations/L-TEST': { status: 200, j: { location: { name: 'Test Co' } } },
    },
  });
  await run({ _: ['draft'], contact: 'cid-x', item: 'Coaching:5000', due: '2026-12-25' }, ctx);
  ctx.out.flush();
  const data = JSON.parse(getPrinted()).data;
  const previewed = data.changes.join(' ').match(/due (\d{4}-\d{2}-\d{2})/)?.[1];
  assert.equal(previewed, '2026-12-25', 'preview should show the requested due date');
  assert.ok(data.confirmCommand.includes('--due 2026-12-25'),
    `rerun must reproduce the previewed due date, not fall back to the +14d default. ` +
    `Got: ${data.confirmCommand}`);
});
