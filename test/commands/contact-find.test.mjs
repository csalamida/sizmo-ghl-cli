// test/commands/contact-find.test.mjs
//
// `sizmo contact find` closes a hole in the middle of the product. Every write takes an opaque
// <contactId> — `sizmo tag <contactId>`, `sizmo note <contactId>`, `sizmo opp create --contact <id>` —
// and until 2.5.x there was no first-class way to turn a name into that id. The one working fuzzy
// search lived inside `sizmo ask`, which needs a paid AI key, so the only documented route for
// anyone without one was the raw `sizmo api` escape hatch.
//
// It deliberately reuses the request `ask` has been making in production, including two details that
// were learned the hard way there and are pinned below: the param is `query` (`search` returns 422),
// and `meta.total` is the real match count, which can exceed one page.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/contact.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const PEOPLE = [
  { id: 'ct_aaa111', firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com', phone: '+639170001111', tags: ['vip'] },
  { id: 'ct_bbb222', firstName: 'Ana', lastName: 'Reyes', email: 'anar@example.com', phone: '+639170002222', tags: [] },
];

// Captures the outgoing request so the shape is asserted, not assumed.
function harness({ json = true, contacts = PEOPLE, total = 2, code = 200 } = {}) {
  const { ctx, getPrinted } = makeFakeCtx({ json });
  const seen = [];
  ctx.http.get = async (path, opts = {}) => {
    seen.push({ path, query: opts.query });
    if (code !== 200) return { code, ok: false, txt: 'nope', j: null };
    return { code: 200, ok: true, txt: '{}', j: { contacts, meta: { total } } };
  };
  return { ctx, getPrinted, seen };
}

test('find sends `query`, not `search` — the param name that actually works', async () => {
  // `search=` returns HTTP 422 from GoHighLevel. Verified live and recorded in ask.mjs; this pins it
  // so the working call cannot be "tidied" into the broken one.
  const h = harness();
  await run({ _: ['find', 'ana'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(h.seen.length, 1, 'exactly one request');
  assert.equal(h.seen[0].path, '/contacts/');
  assert.equal(h.seen[0].query.query, 'ana', 'the fuzzy term must travel as `query`');
  assert.ok(!('search' in h.seen[0].query), '`search` is the param name that 422s');
  assert.equal(h.seen[0].query.locationId, 'L-TEST', 'the search must be scoped to the location');
});

test('a multi-word name is one query, not just the first word', async () => {
  // `sizmo contact find ana cruz` arrives as separate positionals. Using only args._[1] would search
  // for "ana" and quietly return the wrong person first.
  const h = harness();
  await run({ _: ['find', 'ana', 'cruz'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(h.seen[0].query.query, 'ana cruz');
});

test('the payload reports GHL\'s total, not just what fitted on the page', async () => {
  // meta.total can exceed items.length. Reporting matches.length as the total would tell a caller it
  // had seen everything when it had seen two of seven.
  const h = harness({ total: 7 });
  await run({ _: ['find', 'ana'] }, h.ctx);
  h.ctx.out.flush();
  const d = JSON.parse(h.getPrinted()).data;
  assert.equal(d.total, 7, 'total must come from meta.total');
  assert.equal(d.shown, 2, 'shown is how many are in this payload');
  assert.equal(d.truncated, true, 'more matches exist than were returned');
  assert.equal(d.matches.length, 2);
});

test('total === shown means NOT truncated — the inverse guard', async () => {
  const h = harness({ total: 2 });
  await run({ _: ['find', 'ana'] }, h.ctx);
  h.ctx.out.flush();
  const d = JSON.parse(h.getPrinted()).data;
  assert.equal(d.truncated, false, 'a complete result must not claim to be truncated');
});

test('every match carries the id a write command needs', async () => {
  // The entire purpose. A match without an id is useless — it cannot be fed to anything.
  const h = harness();
  await run({ _: ['find', 'ana'] }, h.ctx);
  h.ctx.out.flush();
  for (const m of JSON.parse(h.getPrinted()).data.matches) {
    assert.ok(m.id, 'a match with no id cannot be used by any write command');
    assert.ok('name' in m && 'email' in m && 'phone' in m,
      'a human needs enough to tell two people apart before choosing an id');
  }
});

test('the TTY view prints the id and names the next command', async () => {
  const h = harness({ json: false, total: 7 });
  await run({ _: ['find', 'ana'] }, h.ctx);
  h.ctx.out.flush();
  const out = h.getPrinted();
  assert.match(out, /ct_aaa111/, 'the id must be visible to copy');
  assert.match(out, /sizmo tag <id>/, 'a lookup that does not say what to do with the id is half a feature');
  assert.match(out, /5 more/, 'the hidden matches must be counted, not silently dropped');
});

test('no matches is exit 0 with an empty list, not an error', async () => {
  // "This name does not exist here" is a successful answer to the question asked.
  const h = harness({ contacts: [], total: 0, json: true });
  const code = await run({ _: ['find', 'zzzz'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const d = JSON.parse(h.getPrinted()).data;
  assert.deepEqual(d.matches, []);
  assert.equal(d.total, 0);
  assert.equal(d.truncated, false);
});

test('a missing query is a usage error naming an example', async () => {
  const h = harness();
  await assert.rejects(() => run({ _: ['find'] }, h.ctx), (e) => {
    assert.equal(e.name, 'GhlError');
    assert.equal(e.code, EXIT.USAGE);
    assert.match(e.remediation ?? '', /contact find/);
    return true;
  });
  assert.equal(h.seen.length, 0, 'a usage error must not hit the API');
});

test('a bad --limit is refused, never coerced', async () => {
  // The house rule: a malformed flag is REFUSED, never silently turned into something else. A NaN
  // limit would sail into the query string and produce an unpredictable page size.
  for (const bad of [0, -5, 2.5]) {
    const h = harness();
    await assert.rejects(() => run({ _: ['find', 'ana'], limit: bad }, h.ctx),
      (e) => e.code === EXIT.USAGE, `--limit ${bad} was accepted`);
    assert.equal(h.seen.length, 0, `--limit ${bad} reached the API`);
  }
});

test('--limit is forwarded to the API, and defaults to 10', async () => {
  const a = harness();
  await run({ _: ['find', 'ana'] }, a.ctx);
  a.ctx.out.flush();
  assert.equal(a.seen[0].query.limit, 10, 'default page size');

  const b = harness();
  await run({ _: ['find', 'ana'], limit: 25 }, b.ctx);
  b.ctx.out.flush();
  assert.equal(b.seen[0].query.limit, 25, '--limit must reach the request, not just the render');
});

test('a scope failure says which scope, and it is the READ one', async () => {
  // find is read-only. Naming contacts.write here would send someone to grant a permission they do
  // not need for this command.
  const h = harness({ code: 403 });
  await assert.rejects(() => run({ _: ['find', 'ana'] }, h.ctx), (e) => {
    assert.equal(e.code, EXIT.AUTH);
    assert.match(e.remediation ?? '', /contacts\.readonly/);
    assert.ok(!/contacts\.write/.test(e.remediation ?? ''), 'find needs no write scope');
    return true;
  });
});

test('find never sends a write, even with --confirm', async () => {
  // A read subcommand living in a write command file is exactly where a stray confirm gate or POST
  // could creep in. This pins that it stays read-only.
  const h = harness();
  let wrote = 0;
  h.ctx.http.post = async () => { wrote++; return { code: 200, ok: true, j: {} }; };
  h.ctx.http.put = async () => { wrote++; return { code: 200, ok: true, j: {} }; };
  h.ctx.http.delete = async () => { wrote++; return { code: 200, ok: true, j: {} }; };
  h.ctx.confirmed = true;
  const code = await run({ _: ['find', 'ana'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK, 'a read must not return the confirm-required code');
  assert.equal(wrote, 0, 'find issued a write request');
});
