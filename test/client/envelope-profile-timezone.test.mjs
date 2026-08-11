// test/client/envelope-profile-timezone.test.mjs
//
// The JSON envelope carried `location` but never the location's TIMEZONE or which PROFILE produced
// the run. Both matter the moment a report is re-rendered anywhere other than the terminal that
// produced it: "Tue 3pm" is a different appointment in Manila and New York, and an agency operator
// reading a payload has no way to tell which client account it describes beyond an opaque id.
//
// Both ride on the ENVELOPE rather than in each command's `data`, because they describe the RUN and
// the LOCATION, not the answer. And both are wired centrally — context.mjs passes the profile and
// calls noteTimezone from ensureModel — so a newly added report inherits them without its author
// having to know they exist.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOut } from '../../lib/output.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function capture(opts = {}) {
  let buf = '';
  const out = makeOut({
    command: 'brief', location: 'L-TEST',
    write: (s) => { buf += s; }, writeErr: () => {},
    ...opts,
  });
  return { out, read: () => buf };
}

test('the envelope is UNCHANGED when there is no profile and no timezone', () => {
  // The inverse guard, and the one that matters most: this is a published, documented contract
  // (API-STABILITY.md). Adding optional fields must not alter the shape for a run that has neither.
  const c = capture({ json: true });
  c.out.data({ x: 1 });
  c.out.flush();
  const env = JSON.parse(c.read());
  assert.deepEqual(Object.keys(env), ['schemaVersion', 'command', 'location', 'data', 'degraded', 'warnings']);
  assert.ok(!('profile' in env), 'profile must be absent, not null, when unknown');
  assert.ok(!('timezone' in env), 'timezone must be absent, not null, when unknown');
});

test('profile and timezone appear once known', () => {
  const c = capture({ json: true, profile: 'c2e4' });
  c.out.noteTimezone('Asia/Manila');
  c.out.data({ x: 1 });
  c.out.flush();
  const env = JSON.parse(c.read());
  assert.equal(env.profile, 'c2e4');
  assert.equal(env.timezone, 'Asia/Manila');
  assert.equal(env.schemaVersion, 1, 'adding optional fields is not a schema break');
});

test('the ndjson META line carries them too — the site that gets forgotten', () => {
  // The envelope is emitted from three places. Before this change each was a separate literal, so
  // a new field could land in two of three and nobody would notice until an ndjson consumer asked.
  const c = capture({ ndjson: true, profile: 'c2e4' });
  c.out.noteTimezone('Asia/Manila');
  c.out.data({ totalOwed: 5000, list: [{ id: 'i1' }, { id: 'i2' }] });
  c.out.flush();
  const [metaLine, ...rows] = c.read().trim().split('\n');
  const meta = JSON.parse(metaLine);
  assert.equal(meta._meta, true);
  assert.equal(meta.profile, 'c2e4', 'ndjson meta line lost the profile');
  assert.equal(meta.timezone, 'Asia/Manila', 'ndjson meta line lost the timezone');
  assert.equal(meta.listKey, 'list', 'the per-site fields must survive the shared builder');
  assert.equal(meta.count, 2);
  assert.equal(rows.length, 2, 'rows still stream after the meta line');
});

test('the ndjson NO-LIST branch carries them as well', () => {
  const c = capture({ ndjson: true, profile: 'c2e4' });
  c.out.noteTimezone('Asia/Manila');
  c.out.data({ metrics: 'not-an-array-key-in-LIST_KEYS' });
  c.out.flush();
  const env = JSON.parse(c.read().trim());
  assert.equal(env.profile, 'c2e4');
  assert.equal(env.timezone, 'Asia/Manila');
});

test('the first timezone written wins', () => {
  // The model's timezone is the location's; a later caller cannot know better. Last-writer-wins
  // would let an incidental call overwrite the authoritative one.
  const c = capture({ json: true });
  c.out.noteTimezone('Asia/Manila');
  c.out.noteTimezone('America/New_York');
  c.out.data({});
  c.out.flush();
  assert.equal(JSON.parse(c.read()).timezone, 'Asia/Manila');
});

test('a falsy timezone never lands in the envelope', () => {
  // timezoneFromModel is called with a null fallback, so an unsynced location yields null. That must
  // read as "unknown" (absent), never as an empty string a consumer might try to use.
  for (const bad of [null, undefined, '']) {
    const c = capture({ json: true });
    c.out.noteTimezone(bad);
    c.out.data({});
    c.out.flush();
    assert.ok(!('timezone' in JSON.parse(c.read())), `noteTimezone(${JSON.stringify(bad)}) leaked into the envelope`);
  }
});

test('the envelope is built in ONE place, not three', () => {
  // The regression this guards is structural: three literal envelope objects, so a new field gets
  // added to some of them. Source-level because that is where the drift lives.
  const src = readFileSync(join(REPO, 'lib', 'output.mjs'), 'utf8');
  const code = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // CODE only
  assert.match(code, /const envelopeOf = \(extra\) =>/, 'the shared envelope builder is gone');
  const literals = (code.match(/schemaVersion: 1/g) || []).length;
  assert.equal(literals, 1,
    `found ${literals} \`schemaVersion: 1\` literals in code — the envelope must be constructed once`);
});

test('context wires both centrally, so a new report inherits them', () => {
  // If this moves into individual commands, the next report added will silently lack a timezone.
  const src = readFileSync(join(REPO, 'lib', 'context.mjs'), 'utf8');
  const code = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(code, /profile: creds\.profileName/,
    'buildCtx must pass the resolved profile name into makeOut');
  assert.match(code, /out\.noteTimezone\(timezoneFromModel\(_model/,
    'ensureModel must publish the timezone — a per-command call is a step someone will forget');
});
