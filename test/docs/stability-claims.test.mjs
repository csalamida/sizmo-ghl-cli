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

// The authoritative command list in §2a: the run of backticked names ending at "all emit".
// Both §2a tests read ONLY this, never the surrounding section — see the note in the completeness
// test for why that distinction is load-bearing.
function sectionListSentence() {
  const doc = read('API-STABILITY.md');
  const start = doc.indexOf('### a) Data commands');
  const end = doc.indexOf('#### a2)');
  assert.ok(start >= 0 && end > start, 'API-STABILITY §2a section markers moved — update this test');
  const section = doc.slice(start, end);
  const cut = section.indexOf('all emit');
  assert.ok(cut > 0, 'could not find the "all emit" terminator in §2a — did its wording change?');
  return section.slice(0, cut);
}

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

  // Scope to the LIST SENTENCE, not the whole section.
  //
  // Scoping to the section made this assertion vacuous, and mutation testing is the only reason
  // that surfaced: deleting `transactions` from the list left the test green, because the
  // explanatory note further down the section also names the seven commands. The note written to
  // document the fix defeated the guard meant to detect the regression. A doc guard must read only
  // the authoritative statement, never the prose discussing it.
  const missing = emitters.filter(c => !new RegExp(`\`${c}\``).test(sectionListSentence()));
  assert.deepEqual(missing, [],
    `These read-only commands emit the §2a envelope but are not listed in it: ${missing.join(', ')}. ` +
    `Either add them to the promise, or make them stop emitting the envelope. Silently shipping a ` +
    `stable-looking shape with no stability promise is the worst of both — consumers depend on it ` +
    `anyway and a patch release is free to break them.`);
});

test('API-STABILITY §2a does not list a command that does not exist', () => {
  // The inverse drift: a command gets renamed or removed and the frozen-contract list keeps
  // promising it. Cheaper to catch here than in a user's broken pipeline.
  // A first draft scanned every backticked token in the whole section and reported `--concise` and
  // `data` as phantom commands; the section's prose is full of backticked field and flag names.
  const listed = [...sectionListSentence().matchAll(/`([a-z][a-z-]*)`/g)].map(m => m[1]);
  assert.ok(listed.length > 5, 'could not parse the §2a command list — did its wording change?');
  const real = new Set(commandNames());
  const ghosts = [...new Set(listed.filter(c => !real.has(c)))].sort();
  assert.deepEqual(ghosts, [],
    `API-STABILITY §2a promises a stable envelope for commands that do not exist: ${ghosts.join(', ')}`);
});

// ── 4. INSTALL.md — no stale version strings ─────────────────────────────────

test('INSTALL.md never shows a version string other than the current one', () => {
  // INSTALL.md told every new user that `sizmo --version` prints `0.4.0`. The package was at
  // 2.4.9 — two majors stale. A first-time installer runs the command, sees a different number,
  // and reasonably concludes the install failed or npm served a cached build. That is the worst
  // possible moment to hand someone a contradiction: step one of setup, before any trust exists.
  //
  // The fix removed the number rather than updating it, because a hand-typed version rots by
  // default — it is only correct on release day. This test permits a version string ONLY if it
  // matches package.json, so a future author may write one, but it can never go stale silently.
  const pkgVersion = JSON.parse(read('package.json')).version;
  const stale = [...read('INSTALL.md').matchAll(/\b(\d+\.\d+\.\d+)\b/g)]
    .map(m => m[1])
    .filter(v => v !== pkgVersion);
  assert.deepEqual([...new Set(stale)], [],
    `INSTALL.md hardcodes version(s) ${[...new Set(stale)]} but package.json is at ${pkgVersion}. ` +
    `Either update them or, better, describe the output without a number — a hand-typed version ` +
    `is correct only on release day.`);
});

// ── 5. API-STABILITY §2b — the router-verb shapes ────────────────────────────
//
// §2b freezes a per-verb JSON shape for `auth check`, `config list`, `init` and `open`. All four
// were verified correct on 2026-07-27 by running them for real — nothing was wrong. But nothing
// enforced them either: the table is hand-typed prose, and the verbs' own tests assert behaviour
// (exit codes, lane flags) rather than the documented KEY SET. A renamed or dropped key would break
// every consumer scripting against the frozen contract while the suite stayed green.
//
// This test derives the expected keys FROM THE DOC TABLE, so the doc is the source of truth: change
// the table and the test changes with it; change the code without the table and it fails.

function section2bRows() {
  const doc = read('API-STABILITY.md');
  const start = doc.indexOf('### b) Router verbs');
  const end = doc.indexOf('**Why two shapes:**');
  assert.ok(start >= 0 && end > start, 'API-STABILITY §2b markers moved — update this test');
  const rows = [];
  for (const line of doc.slice(start, end).split('\n')) {
    // | `auth check` | `{ schemaVersion, location, lanes:[{…}], summary, usable }` | `usable` |
    const m = line.match(/^\|\s*`([a-z ]+)`\s*\|\s*`\{(.+?)\}`\s*\|/);
    if (!m) continue;
    const keys = m[2]
      .split(',')                       // top-level split is good enough: nested {} only appear
      .map(s => s.trim())               // inside a value, and we only want the leading key name
      .map(s => s.split(':')[0].trim())
      .map(s => s.replace(/\[.*$/, '').trim())
      .filter(s => /^[a-zA-Z]+$/.test(s));
    rows.push({ verb: m[1].trim(), keys: [...new Set(keys)] });
  }
  return rows;
}

test('API-STABILITY §2b documents exactly the four router verbs, and parses', () => {
  const rows = section2bRows();
  assert.deepEqual(rows.map(r => r.verb).sort(), ['auth check', 'config list', 'init', 'open'],
    'the §2b table should cover auth check, config list, init and open');
  for (const r of rows) {
    assert.ok(r.keys.includes('schemaVersion'),
      `§2b says every router verb carries schemaVersion, but the ${r.verb} row does not list it`);
    assert.ok(r.keys.length >= 3, `${r.verb}'s documented shape parsed to only ${r.keys.length} keys`);
  }
});

test('API-STABILITY §2b: the shapes the code emits match the ones the table promises', async () => {
  // Verified live 2026-07-27 before this test existed:
  //   auth check  → schemaVersion, location, lanes[{name,scope,ok,httpCode}], summary, usable
  //   config list → schemaVersion, profiles[]                    (PIT omitted entirely)
  //   init        → schemaVersion, command, profile, location, pit (masked "pit-…LEAK"),
  //                 created, doctor, doctorExit, ok              (profiles.json written 0600)
  //   open        → schemaVersion, command, kind, id, url, opened (false under --url)
  // This test re-derives the promise from the doc and checks the SOURCE emits those key names, so
  // the frozen contract cannot drift silently in either direction.
  const cliSrc = readFileSync(join(REPO, 'lib', 'cli.mjs'), 'utf8');
  const initSrc = readFileSync(join(REPO, 'commands', 'init.mjs'), 'utf8');
  const haystack = cliSrc + initSrc;

  const missing = [];
  for (const { verb, keys } of section2bRows()) {
    for (const k of keys) {
      // Must appear as an OBJECT KEY (`k:` or shorthand `k,` / `k }`), not merely as a word.
      //
      // A first draft OR'd in a bare-word match as a fallback, which made this vacuous: "location",
      // "command" and "ok" appear all over two large files, so every key passed regardless of
      // whether it was ever emitted. A weak assertion and a correct one look identical until you
      // mutate — this one was caught by removing a real key and watching the test stay green.
      const asKey = new RegExp(`\\b${k}\\s*:`).test(haystack);
      const asShorthand = new RegExp(`[{,]\\s*${k}\\s*[,}]`).test(haystack);
      if (!asKey && !asShorthand) missing.push(`${verb}.${k}`);
    }
  }
  assert.deepEqual(missing, [],
    `API-STABILITY §2b promises these keys but they appear nowhere in the emitting source: ` +
    `${missing.join(', ')}. §2b is a FROZEN contract — either the code dropped a documented key, ` +
    `or the table promises something that was never built.`);
});
