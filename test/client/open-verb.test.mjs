// test/client/open-verb.test.mjs — the `open` router verb.
//
// `open` had no dedicated test. It takes an id and infers the kind from --opp, but the rest of the
// CLI reads `sizmo <command> <kind> <id>` (`sizmo list contacts`, `sizmo business update <id>`),
// so `sizmo open contact cid-1` is a very plausible mistyping. It used to take "contact" as the id,
// silently ignore "cid-1", and emit a well-formed URL to a record that does not exist — exit 0, no
// warning. The user clicks a link that looks right and lands on a 404 inside GoHighLevel.
//
// Found 2026-07-27 while verifying API-STABILITY §2b's documented shape for `open`.
import { test } from 'node:test';
import assert from 'node:assert';
import { route } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

const LOC = 'LOC-TEST-OPEN';

function capture() {
  let out = '', err = '';
  return { io: { write: s => { out += s; }, writeErr: s => { err += s; } },
           get out() { return out; }, get err() { return err; } };
}

const withEnv = async (fn) => {
  const prevPit = process.env.GHL_PIT, prevLoc = process.env.GHL_LOCATION_ID;
  process.env.GHL_PIT = 'pit-TEST-open';
  process.env.GHL_LOCATION_ID = LOC;
  try { return await fn(); }
  finally {
    if (prevPit === undefined) delete process.env.GHL_PIT; else process.env.GHL_PIT = prevPit;
    if (prevLoc === undefined) delete process.env.GHL_LOCATION_ID; else process.env.GHL_LOCATION_ID = prevLoc;
  }
};

test('open <id> --url --json: emits exactly the shape API-STABILITY §2b freezes', async () => {
  await withEnv(async () => {
    const c = capture();
    const code = await route(['open', 'cid-1', '--url', '--json'], c.io);
    assert.equal(code, EXIT.OK);
    const j = JSON.parse(c.out);
    assert.deepEqual(Object.keys(j).sort(),
      ['command', 'id', 'kind', 'opened', 'schemaVersion', 'url'].sort(),
      'the §2b contract is frozen for 1.x — no key may be added, renamed or dropped');
    assert.equal(j.command, 'open');
    assert.equal(j.kind, 'contact');
    assert.equal(j.id, 'cid-1');
    assert.equal(j.opened, false, '§2b: opened is false under --url');
    assert.ok(j.url.includes(`/location/${LOC}/contacts/detail/cid-1`));
  });
});

test('open --opp: kind flips to opportunity and the URL changes with it', async () => {
  await withEnv(async () => {
    const c = capture();
    await route(['open', 'oid-9', '--opp', '--url', '--json'], c.io);
    const j = JSON.parse(c.out);
    assert.equal(j.kind, 'opportunity');
    assert.ok(j.url.includes('opportunities'), 'an opportunity must not link to a contact page');
  });
});

test('open: a SECOND positional is refused, never silently ignored', async () => {
  // The whole point. Previously: id="contact", "cid-1" dropped, exit 0, a URL to a record that
  // does not exist. A silently wrong answer is worse than a refusal.
  await withEnv(async () => {
    const c = capture();
    const code = await route(['open', 'contact', 'cid-1', '--url', '--json'], c.io);
    assert.equal(code, EXIT.USAGE, 'extra positionals must exit USAGE, not 0');
    assert.equal(c.out, '', 'nothing may be written to stdout for a refused command');
    const j = JSON.parse(c.err);
    assert.match(j.error, /exactly one id/);
    assert.match(j.remediation, /cid-1/, 'the fix line should suggest the id they actually meant');
  });
});

test('open: no id at all → USAGE', async () => {
  await withEnv(async () => {
    const c = capture();
    const code = await route(['open', '--url', '--json'], c.io);
    assert.equal(code, EXIT.USAGE);
  });
});

test('open: flags in any position do not count as positionals', async () => {
  // --url before the id must not be mistaken for an extra positional.
  await withEnv(async () => {
    const c = capture();
    const code = await route(['open', '--url', 'cid-1', '--json'], c.io);
    assert.equal(code, EXIT.OK);
    assert.equal(JSON.parse(c.out).id, 'cid-1');
  });
});
