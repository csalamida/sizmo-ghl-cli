// test/docs/error-envelope.test.mjs
// A command that hits a hard 401 must produce a real ERROR envelope, not a success-shaped one.
//
// WHY: found 2026-07-27 by running every write command against the live API with an invalid PIT.
// `sizmo business create --confirm --json` on a 401 emitted:
//     { schemaVersion: 1, command: "business", data: null, degraded: false, warnings: [] }
// No `error`, no `remediation`, degraded:false. An agent parsing that sees a clean no-op — only the
// exit code disagreed. `contact` on the identical failure emitted:
//     { error: "HTTP 401 — your PIT lacks contacts.write", code: 3, remediation: "GoHighLevel → …" }
//
// The difference is mechanical: the error envelope is produced by the CLI's top-level handler when
// a command THROWS GhlError. A command that prints a line and RETURNS the exit code never reaches
// that handler, so the envelope stays success-shaped.
//
// business was the sharpest case because it is a write command, and it is the third distinct way
// that file has been wrong in one day (hand-rolled confirm broke --dry-run; hand-rolled errors
// broke the envelope). Both had the same root cause: bypassing a shared helper.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CMD_DIR = join(REPO, 'commands');

const sourceOf = (cmd) => readFileSync(join(CMD_DIR, `${cmd}.mjs`), 'utf8');
const stripComments = (t) => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// Commands that perform writes. These are the ones where a silently-successful-looking envelope is
// most dangerous: an agent may conclude the write landed.
const WRITE_COMMANDS = ['contact', 'opp', 'tag', 'note', 'field', 'value', 'calendar', 'business',
                        'link', 'appointment', 'send', 'invoice'];

// READ commands still using return-style errors, as of 2026-07-27. Lower stakes than writes (a
// failed read cannot be mistaken for a completed mutation) but the envelope is still dishonest:
// degraded:false with no error on a hard 401.
//
// This list may only SHRINK. Adding to it means shipping a new dishonest envelope.
// forms, surveys, transactions and list were converted 2026-07-27 — they now throw GhlError, so a
// 401 produces {error, code, remediation} instead of a success-shaped envelope.
//
// The two that REMAIN are deliberate, not leftovers:
//   doctor — its single return is a SUMMARY verdict printed after the full diagnostic report.
//            Throwing would suppress the report the user ran the command to read. A blocked scope
//            is doctor's OUTPUT, not doctor's failure.
//   ask    — an orchestrator that dispatches other commands; its own error paths are covered by
//            the pending-plan/confirm mechanism rather than a direct envelope.
const KNOWN_RETURN_STYLE_READS = new Set(['doctor', 'ask']);

function returnsAuthOrApi(src) {
  return /return\s+EXIT\.(AUTH|API)\b/.test(stripComments(src));
}

// USAGE was NOT in the regex above, and that omission let the identical bug survive in a file that
// had already been fixed once. business.mjs threw correctly on AUTH/API but still did
//     ctx.out.line('--name required'); return EXIT.USAGE;
// so `sizmo business create --json` with no --name printed a success-shaped envelope
// (data:null, degraded:false, no error) on STDOUT while exiting 2. Same for its unknown-subcommand
// branch and for list.mjs's unknown-entity branch — a leftover from list's own AUTH/API conversion.
//
// A returned USAGE is less dangerous than a returned AUTH on a write (nothing was attempted), but
// the envelope is equally dishonest: an agent parsing stdout sees a clean no-op with no error.
//
// `ask` is the one deliberate exception, for the reason recorded below.
function returnsUsage(src) {
  return /return\s+EXIT\.USAGE\b/.test(stripComments(src));
}

test('every WRITE command surfaces auth/API failures by throwing GhlError', () => {
  const offenders = WRITE_COMMANDS
    .filter(cmd => returnsAuthOrApi(sourceOf(cmd)))
    .sort();
  assert.deepEqual(offenders, [],
    `These write commands return EXIT.AUTH/EXIT.API instead of throwing GhlError: ${offenders.join(', ')}. ` +
    `Returning skips the CLI's error handler, so --json emits a success-shaped envelope ` +
    `(degraded:false, no error, no remediation) on a hard 401 — an agent reads it as a clean no-op. ` +
    `Throw new GhlError(msg, EXIT.AUTH, remediation) instead.`);
});

test('write commands that throw also carry a remediation line', () => {
  // An exit code alone does not tell a user or an agent what to DO. Every auth throw should name
  // the scope and where to add it.
  const missing = WRITE_COMMANDS
    .filter(cmd => {
      const src = sourceOf(cmd);
      if (!/throw new GhlError/.test(src)) return false;       // no throws at all → other test covers it
      if (!/EXIT\.AUTH/.test(src)) return false;                // no auth path to remediate
      return !/Private Integrations/.test(src);                 // auth throw with no fix line
    })
    .sort();
  assert.deepEqual(missing, [],
    `These commands throw an AUTH error without a remediation pointing at GoHighLevel → Private ` +
    `Integrations: ${missing.join(', ')}. The exit code says something broke; remediation says how to fix it.`);
});

test('business specifically: no return-style error paths remain', () => {
  // Pinned by name because it regressed three separate ways in one day, each time by hand-rolling
  // something a shared helper already did.
  const src = sourceOf('business');
  assert.equal(returnsAuthOrApi(src), false, 'business.mjs must throw, not return, on AUTH/API');
  assert.ok(/import \{ GhlError/.test(src), 'business.mjs must import GhlError');
  // COUNT, not presence. A first draft asserted only that a rethrow existed somewhere, and a
  // mutation removing ONE of the three passed cleanly — the swallow bug would have returned on
  // that single path invisibly. Every catch must rethrow, so the counts have to match.
  const catches   = (src.match(/\}\s*catch\s*\(/g)   || []).length;
  const rethrows  = (src.match(/instanceof GhlError\)\s*throw e/g) || []).length;
  assert.equal(rethrows, catches,
    `business.mjs has ${catches} catch block(s) but only ${rethrows} rethrow GhlError. Any catch ` +
    `that does not rethrow swallows a deliberate 401-with-remediation and downgrades it to a ` +
    `generic API error, losing both the exit code and the fix line.`);
  assert.ok(catches > 0, 'expected business.mjs to still have transport-error catches');
});

test('the return-style read list only shrinks', () => {
  const stale = [...KNOWN_RETURN_STYLE_READS]
    .filter(cmd => !returnsAuthOrApi(sourceOf(cmd)))
    .sort();
  assert.deepEqual(stale, [],
    `These are listed as return-style but no longer are: ${stale.join(', ')}. Remove them from ` +
    `KNOWN_RETURN_STYLE_READS — the list must only shrink.`);
});

test('no NEW command adopts return-style error handling', () => {
  const known = new Set([...KNOWN_RETURN_STYLE_READS]);
  const all = readdirSync(CMD_DIR).filter(f => f.endsWith('.mjs')).map(f => f.replace('.mjs', ''));
  const offenders = all
    .filter(cmd => returnsAuthOrApi(sourceOf(cmd)))
    .filter(cmd => !known.has(cmd))
    .sort();
  assert.deepEqual(offenders, [],
    `New return-style error handling in: ${offenders.join(', ')}. Throw GhlError so --json gets a ` +
    `real error envelope instead of a success-shaped one.`);
});

// `ask` returns EXIT.USAGE by design: it is an orchestrator whose usage errors are part of the
// pending-plan/confirm conversation, not a terminal failure. Every other command must throw.
const KNOWN_RETURN_STYLE_USAGE = new Set(['ask']);

test('no command RETURNS EXIT.USAGE instead of throwing', () => {
  const all = readdirSync(CMD_DIR).filter(f => f.endsWith('.mjs')).map(f => f.replace('.mjs', ''));
  const offenders = all
    .filter(cmd => returnsUsage(sourceOf(cmd)))
    .filter(cmd => !KNOWN_RETURN_STYLE_USAGE.has(cmd))
    .sort();
  assert.deepEqual(offenders, [],
    `These return EXIT.USAGE instead of throwing GhlError: ${offenders.join(', ')}. ` +
    `A returned code skips the CLI's error handler, so --json prints a success-shaped envelope ` +
    `(data:null, degraded:false, no error) on STDOUT while the process exits 2. Throw ` +
    `new GhlError(msg, EXIT.USAGE, hint) so the envelope carries {error, code, remediation} on stderr.`);
});

test('the return-style USAGE exception list only shrinks', () => {
  const stale = [...KNOWN_RETURN_STYLE_USAGE]
    .filter(cmd => !returnsUsage(sourceOf(cmd)))
    .sort();
  assert.deepEqual(stale, [],
    `These are listed as return-style USAGE but no longer are: ${stale.join(', ')}. Remove them.`);
});
