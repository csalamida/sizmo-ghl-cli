// test/docs/stability-claims.test.mjs
// API-STABILITY.md is a CONTRACT — "depend on this and a patch release will not move it." Nothing
// enforced it. Every promise in it was hand-typed prose checked by nobody.
//
// The existing doc guards cover a different axis and deliberately are not extended here:
//   agent-docs-drift.test.mjs — does every COMMAND appear in SKILL/AGENTS/README
//   security-claims.test.mjs  — does SECURITY.md's threat model match the code
//   changelog-claims.test.mjs — is CHANGELOG internally consistent with package.json
// None of them read API-STABILITY.md, INSTALL.md or CONTRIBUTING.md at all, and none check the
// exit-code tables, which are hand-typed in THREE documents plus lib/errors.mjs — one fact, four
// places. Add a code to EXIT and three tables silently rot with nothing failing.
//
// Found 2026-07-27 by lens-2 claim verification.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../../lib/errors.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CMD_DIR = join(REPO, 'commands');
const read = (f) => readFileSync(join(REPO, f), 'utf8');
const commandNames = () => readdirSync(CMD_DIR).filter(f => f.endsWith('.mjs')).map(f => f.replace('.mjs', ''));
const sourceOf = (c) => readFileSync(join(CMD_DIR, `${c}.mjs`), 'utf8');

// ── 1. the exit-code table, hand-typed in three documents ────────────────────

// Every doc that publishes an exit-code table. A table row looks like `| 3 | Auth error / ... |`.
const DOCS_WITH_EXIT_TABLES = ['API-STABILITY.md', 'AGENTS.md', 'README.md'];

function exitTableOf(doc) {
  const rows = {};
  for (const line of read(doc).split('\n')) {
    // Only a leading-pipe row whose first cell is a bare integer. Anything else (prose mentioning
    // "exit 5", a flag table) must not be picked up.
    const m = line.match(/^\|\s*`?(\d+)`?\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) rows[Number(m[1])] = m[2];
  }
  return rows;
}

for (const doc of DOCS_WITH_EXIT_TABLES) {
  test(`${doc}: the exit-code table matches lib/errors.mjs exactly`, () => {
    const table = exitTableOf(doc);
    const documented = Object.keys(table).map(Number).sort((a, b) => a - b);
    const actual = Object.values(EXIT).sort((a, b) => a - b);

    assert.ok(documented.length > 0, `${doc} has no parseable exit-code table — did the format change?`);
    assert.deepEqual(documented, actual,
      `${doc} documents exit codes [${documented}] but lib/errors.mjs defines [${actual}]. ` +
      `This table is hand-typed in ${DOCS_WITH_EXIT_TABLES.length} documents; adding a code to EXIT ` +
      `means updating all of them. API-STABILITY.md calls these codes FROZEN, so a mismatch is a ` +
      `broken promise, not a typo.`);
  });
}

test('the three exit-code tables agree with each other on meaning, not just numbers', () => {
  // Two docs could each match EXIT numerically while describing code 4 differently. A consumer
  // reading one doc and scripting against the other would branch wrongly.
  const [ref, ...rest] = DOCS_WITH_EXIT_TABLES;
  const refTable = exitTableOf(ref);
  for (const doc of rest) {
    const t = exitTableOf(doc);
    for (const code of Object.keys(refTable)) {
      const a = refTable[code].replace(/\s+to execute$/, '').trim();
      const b = (t[code] ?? '').replace(/\s+to execute$/, '').trim();
      assert.equal(b, a,
        `exit code ${code} is described as "${a}" in ${ref} but "${b}" in ${doc}. ` +
        `Same number, different contract — pick one wording.`);
    }
  }
});

// ── 2. README's confirm-gate claim ───────────────────────────────────────────

test('README names EVERY confirm-gated command, not a sample of them', () => {
  // README's "Writes require explicit --confirm" bullet is the safety claim an agent operator
  // reads before granting this tool write access. It shipped naming five commands while twelve
  // were gated — so `contact delete`, `field update` and five others looked ungated in the one
  // paragraph a reader consults to decide whether the tool is safe to point at production.
  //
  // security-claims.test.mjs already asserts every write ROUTES through requireConfirm. That is
  // source-vs-source. This is doc-vs-source: the promise a human reads must match it.
  const gated = commandNames().filter(c => /requireConfirm/.test(sourceOf(c))).sort();

  const bullet = read('README.md')
    .split('\n')
    .find(l => /Writes require explicit/.test(l));
  assert.ok(bullet, 'README lost its "Writes require explicit --confirm" bullet');

  const missing = gated.filter(c => !new RegExp(`\\b${c}\\b`, 'i').test(bullet));
  assert.deepEqual(missing, [],
    `README's confirm-gate bullet does not name these gated commands: ${missing.join(', ')}. ` +
    `Under-listing a safety guarantee makes the guarantee look narrower than it is — a reader ` +
    `concludes those commands fire without --confirm. Bullet text was: "${bullet.trim()}"`);
});

// ── 3. API-STABILITY §2a — the envelope promise ──────────────────────────────

test('API-STABILITY §2a promises the envelope for every command that emits one', () => {
  // §2a lists the commands whose JSON envelope is frozen for 1.x. Seven read-only commands
  // (ack, diff, export, forms, list, surveys, transactions) emitted the byte-identical envelope
  // while carrying no stability promise — verified live 2026-07-27:
  //     sizmo ack --list --json
  //     → {schemaVersion, command, location, data, degraded, warnings}
  // A consumer scripting `sizmo transactions --json` had no way to know whether that shape was
  // contractual or incidental. It is contractual; the doc simply never said so.
  const emitters = commandNames()
    .filter(c => {
      const src = sourceOf(c);
      return /readOnly:\s*true/.test(src) && /out\.data\(/.test(src);
    })
    .sort();

  const doc = read('API-STABILITY.md');
  const section = doc.slice(doc.indexOf('### a) Data commands'), doc.indexOf('#### a2)'));
  assert.ok(section.length > 0, 'API-STABILITY §2a section markers moved — update this test');

  const missing = emitters.filter(c => !new RegExp(`\`${c}\``).test(section));
  assert.deepEqual(missing, [],
    `These read-only commands emit the §2a envelope but are not listed in it: ${missing.join(', ')}. ` +
    `Either add them to the promise, or make them stop emitting the envelope. Silently shipping a ` +
    `stable-looking shape with no stability promise is the worst of both — consumers depend on it ` +
    `anyway and a patch release is free to break them.`);
});

test('API-STABILITY §2a does not list a command that does not exist', () => {
  // The inverse drift: a command gets renamed or removed and the frozen-contract list keeps
  // promising it. Cheaper to catch here than in a user's broken pipeline.
  const doc = read('API-STABILITY.md');
  const section = doc.slice(doc.indexOf('### a) Data commands'), doc.indexOf('#### a2)'));
  // Scope to the command list itself — the run of backticked names ending at "all emit". A first
  // draft scanned every backticked token in the section and reported `--concise` and `data` as
  // phantom commands; the section's prose is full of backticked field and flag names.
  const listSentence = section.slice(0, section.indexOf('all emit'));
  const listed = [...listSentence.matchAll(/`([a-z][a-z-]*)`/g)].map(m => m[1]);
  assert.ok(listed.length > 5, 'could not parse the §2a command list — did its wording change?');
  const real = new Set(commandNames());
  const ghosts = [...new Set(listed.filter(c => !real.has(c)))].sort();
  assert.deepEqual(ghosts, [],
    `API-STABILITY §2a promises a stable envelope for commands that do not exist: ${ghosts.join(', ')}`);
});
