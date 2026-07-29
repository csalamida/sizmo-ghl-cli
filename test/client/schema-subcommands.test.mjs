// test/client/schema-subcommands.test.mjs
//
// `sizmo schema` is documented as the authoritative machine-readable command contract — the thing an
// agent is told to read to discover what it can do. Measured 2026-07-30, it listed 33 top-level
// commands and ZERO subcommands: `contact create`, `opp move`, `invoice draft` and 43 others simply
// did not appear in it. An agent reading the contract could see `opp` existed and had no way to
// learn that `opp move <id> --stage <name>` was the call it wanted.
//
// The fix is only half a fix if the declaration can rot, so this file DERIVES the truth from each
// command's dispatch code and fails when meta disagrees. Hand-typed lists drift; that is the whole
// reason this guard exists rather than a doc note.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from '../../lib/registry.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stripComments = (t) => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// Extract the verbs a command actually dispatches on. Three shapes are in use:
//   if (sub === 'create') return …                     contact, field, value, link, calendar, invoice
//   if (!sub || !['book','update'].includes(sub))       appointment, opp
//   switch (sub) { case 'list': … }                     business
// The `sub` must come from the command's OWN positional argument — `args._[0]` or `parsed._[0]`.
// That anchor matters: ask.mjs also has `const sub = step.subcommand`, where `sub` is some OTHER
// command's verb inside its step builders. Two earlier drafts of this extractor (a whole-file scan,
// then a scan anchored on any `const sub =`) both reported that `ask` dispatches create/delete/move/
// upsert. It does not — it takes a natural-language sentence and has no subcommands of its own.
function dispatchedVerbs(src) {
  const code = stripComments(src);
  const own = code.match(/const sub\s*=\s*(?:args|parsed)\._/);
  if (!own) return null;                            // no subcommand dispatch of its own
  const start = code.indexOf(own[0]);
  const region = code.slice(start);
  const verbs = new Set();
  for (const m of region.matchAll(/\bsub\s*===\s*'([a-z][a-z-]*)'/g)) verbs.add(m[1]);
  for (const m of region.matchAll(/\[([^\]]*?)\]\s*\.includes\(\s*sub\b/g)) {
    for (const q of m[1].matchAll(/'([a-z][a-z-]*)'/g)) verbs.add(q[1]);
  }
  if (/switch\s*\(\s*sub\s*\)/.test(region)) {
    for (const m of region.matchAll(/case\s+'([a-z][a-z-]*)'/g)) verbs.add(m[1]);
  }
  // `const sub = parsed._?.[0] ?? 'list'` — a defaulted verb is still a verb.
  for (const m of region.matchAll(/const sub\s*=[^;\n]*\?\?\s*'([a-z][a-z-]*)'/g)) verbs.add(m[1]);
  return verbs.size ? [...verbs].sort() : null;
}

async function metasWithSource() {
  const out = [];
  for (const [name, loader] of Object.entries(registry)) {
    const mod = await loader();
    let src = null;
    try { src = readFileSync(join(REPO, 'commands', `${name}.mjs`), 'utf8'); } catch { /* not a file-backed command */ }
    if (src) out.push({ name, meta: mod.meta, src });
  }
  return out;
}

test('every command that dispatches subcommands declares them in meta', async () => {
  const missing = [];
  for (const { name, meta, src } of await metasWithSource()) {
    // crm and list validate against a named array rather than inline literals; they are covered by
    // the identity test below, which is stricter.
    if (name === 'crm' || name === 'list') continue;
    const verbs = dispatchedVerbs(src);
    if (verbs && !meta?.subcommands) missing.push(`${name} (dispatches: ${verbs.join(', ')})`);
  }
  assert.deepEqual(missing, [],
    `These commands take subcommands that \`sizmo schema\` does not mention: ${missing.join('; ')}. ` +
    `An agent reading the documented machine contract cannot discover them.`);
});

test('declared subcommands match the ones the code actually dispatches', async () => {
  const drifted = [];
  for (const { name, meta, src } of await metasWithSource()) {
    if (name === 'crm' || name === 'list') continue;
    const verbs = dispatchedVerbs(src);
    if (!verbs || !meta?.subcommands) continue;
    const declared = [...meta.subcommands].sort();
    if (declared.join(',') !== verbs.join(',')) {
      drifted.push(`${name}: meta says [${declared.join(', ')}] but code dispatches [${verbs.join(', ')}]`);
    }
  }
  assert.deepEqual(drifted, [],
    `meta.subcommands has drifted from the dispatch: ${drifted.join(' | ')}. Either the schema ` +
    `advertises a subcommand that will be rejected, or it hides one that works.`);
});

test('crm and list reference their validation array rather than restating it', async () => {
  // These two validate against a named array (VALID_SUBS / ENTITIES). meta must BE that array, not a
  // copy of it — a copy is exactly how the two would drift apart.
  const { registry: reg } = await import('../../lib/registry.mjs');
  for (const [name, arrName] of [['crm', 'VALID_SUBS'], ['list', 'ENTITIES']]) {
    const mod = await reg[name]();
    const src = stripComments(readFileSync(join(REPO, 'commands', `${name}.mjs`), 'utf8'));
    assert.ok(mod.meta?.subcommands?.length, `${name}: meta declares no subcommands`);
    assert.match(src, new RegExp(`subcommands:\\s*${arrName}\\b`),
      `${name}: meta must reference ${arrName} directly, not restate its contents — a second copy ` +
      `is how the schema starts advertising entities the command rejects`);
    // And the array must be declared BEFORE meta, or referencing it throws at module load (TDZ).
    assert.ok(src.indexOf(`const ${arrName} =`) < src.indexOf('export const meta'),
      `${name}: ${arrName} must be declared above meta or the module cannot initialise`);
  }
});

test('sizmo schema exposes the subcommands, not just the top-level commands', async () => {
  // The end-to-end assertion: what an agent actually reads.
  const { buildSchema } = await import('../../lib/schema.mjs');
  const { EXIT } = await import('../../lib/errors.mjs');
  const schema = await buildSchema(registry, EXIT);
  const withSubs = schema.commands.filter(c => c.subcommands?.length);
  assert.ok(withSubs.length >= 11,
    `only ${withSubs.length} commands expose subcommands in the schema`);
  const total = withSubs.reduce((n, c) => n + c.subcommands.length, 0);
  assert.ok(total >= 46, `only ${total} subcommands in the schema`);
  // Spot-check the ones the finding named as invisible.
  const find = (n) => schema.commands.find(c => c.name === n)?.subcommands ?? [];
  assert.ok(find('opp').includes('move'), 'sizmo opp move is still not in the schema');
  assert.ok(find('contact').includes('upsert'), 'sizmo contact upsert is still not in the schema');
  assert.ok(find('invoice').includes('draft'), 'sizmo invoice draft is still not in the schema');
});

test('no command declares a subcommand it does not dispatch — the inverse guard', async () => {
  // Over-declaring is the mirror failure: the schema promises a call that exits 2. Checked against
  // the source rather than by running every verb, since running them would fire writes.
  const bogus = [];
  for (const { name, meta, src } of await metasWithSource()) {
    if (!meta?.subcommands) continue;
    const code = stripComments(src);
    for (const v of meta.subcommands) {
      if (!new RegExp(`'${v}'`).test(code)) bogus.push(`${name}.${v}`);
    }
  }
  assert.deepEqual(bogus, [],
    `These subcommands are declared in meta but appear nowhere in the command source: ${bogus.join(', ')}`);
});
