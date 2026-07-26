// test/docs/security-claims.test.mjs
// SECURITY.md makes falsifiable promises and tells readers how to check them. This file RUNS
// those checks, so the doc is enforced rather than aspirational.
//
// WHY THIS EXISTS: on 2026-07-26 the doc claimed sizmo "makes exactly two kinds of outbound
// request." True when written; false once `sizmo ask` shipped a third (the LLM providers). It
// went unnoticed because nothing executed the claim — the doc and the code drifted silently for
// releases. The 2026-07-15 loop run found a second one: an audit recipe pointing at a
// package.json field that does not exist. Both are the same failure: a security doc whose
// promises nobody verifies is worse than no doc, because it manufactures confidence.
//
// So: a PR that adds a dependency, opens a new egress host, or introduces a --pit flag now FAILS
// THE BUILD instead of waiting for someone to re-read the markdown.
//
// When one of these fails, the fix is a judgment call, not a rubber stamp: either the change is
// wrong, or the change is right and SECURITY.md must be updated in the same commit. Do not widen
// an assertion to make it pass without editing the doc — that is how the drift started.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const SECURITY_MD = readFileSync(join(REPO, 'SECURITY.md'), 'utf8');

// Walk the dirs that actually ship (package.json "files"), not test/ or scripts/ — a fixture
// URL in a test is not egress, and asserting over them would produce noise, not signal.
const SHIPPED_DIRS = ['bin', 'lib', 'commands'];

function shippedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.mjs')) out.push(p);
    }
  };
  for (const d of SHIPPED_DIRS) walk(join(REPO, d));
  return out;
}

const sources = shippedFiles().map(p => ({ path: p, text: readFileSync(p, 'utf8') }));
const allSource = sources.map(s => s.text).join('\n');

// ── "Zero runtime dependencies" ───────────────────────────────────────────────

test('CLAIM: zero runtime dependencies', () => {
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(deps, [],
    `SECURITY.md promises zero runtime dependencies but package.json declares: ${deps.join(', ')}. ` +
    `Adding a runtime dep is a supply-chain change the security doc explicitly rules out — ` +
    `either drop it, or update SECURITY.md in this same commit.`);
});

test('CLAIM: the doc does not resurrect the broken `"dependencies": {}` grep recipe', () => {
  // The old recipe told readers to look for a field that is absent, so it could never confirm
  // anything. Fixed 2026-07-26; this keeps it from being pasted back in.
  const hasBrokenRecipe = /cat package\.json[^\n]*\n?[^\n]*"dependencies":\s*\{\}/.test(SECURITY_MD)
    || /`cat package\.json`\s*→\s*`?"dependencies":\s*\{\}`?/.test(SECURITY_MD);
  assert.equal(hasBrokenRecipe, false,
    'SECURITY.md must not tell readers to grep package.json for `"dependencies": {}` — the field ' +
    'does not exist, so the check can never pass or fail meaningfully. Use `npm ls --omit=dev`.');
});

// ── "The PIT is read from stdin or env only — never argv" ─────────────────────

test('CLAIM: no bare --pit flag exists (PIT never lands in argv/shell history/ps)', () => {
  const offenders = sources
    .filter(s => /['"`]--pit['"`]/.test(s.text))
    .map(s => s.path.replace(REPO + '/', ''));
  assert.deepEqual(offenders, [],
    `SECURITY.md promises there is no --pit flag so tokens never reach argv, ps, or shell ` +
    `history. Found one in: ${offenders.join(', ')}. Use --pit-stdin or --pit-env.`);
});

test('CLAIM: the stdin/env intake paths still exist', () => {
  // Guards the inverse failure: the flag being removed entirely would also make the doc wrong,
  // and would silently break every documented setup instruction.
  assert.ok(/--pit-stdin/.test(allSource), '--pit-stdin must exist — SECURITY.md documents it as the intake path');
  assert.ok(/--pit-env/.test(allSource) || /GHL_PIT/.test(allSource), 'an env intake path must exist');
});

// ── "Outbound traffic goes to exactly three places" ───────────────────────────

// Every literal host in shipped code. Four are never fetched (see SECURITY.md); they are listed
// here so that ADDING a new one — fetched or not — trips this test and forces a decision.
const KNOWN_HOSTS = [
  'https://acme.com',                    // --help example string
  'https://api.anthropic.com',           // EGRESS: sizmo ask, opt-in only
  'https://api.openai.com',              // EGRESS: sizmo ask, opt-in only
  'https://app.gohighlevel.com',         // deep links printed to terminal — never fetched
  'https://cal.me',                      // --help example string
  'https://registry.npmjs.org',          // EGRESS: update check
  'https://services.leadconnectorhq.com',// EGRESS: the GoHighLevel API
];

test('CLAIM: no unlisted network host appears in shipped code', () => {
  const found = [...new Set(
    (allSource.match(/https:\/\/[a-z0-9.-]+/gi) ?? []).map(h => h.toLowerCase())
  )].sort();
  assert.deepEqual(found, [...KNOWN_HOSTS].sort(),
    'The set of hosts in shipped code changed. SECURITY.md enumerates every host and states which ' +
    'three are contacted — a new one means the "no telemetry / three destinations" guarantee needs ' +
    're-stating, and KNOWN_HOSTS here needs updating deliberately, not reflexively.');
});

test('CLAIM: only three modules originate a network request', () => {
  // Every command reaches the network through ctx.http -> lib/http.mjs. If a command starts
  // calling fetch directly, the egress story in SECURITY.md stops being auditable the documented
  // way, even if the destination happens to be one of the known hosts.
  const originators = sources
    .filter(s => /\bawait\s+fetch\(|\bawait\s+fetchImpl\(/.test(s.text))
    .map(s => s.path.replace(REPO + '/', ''))
    .sort();
  assert.deepEqual(originators, ['lib/http.mjs', 'lib/llm.mjs', 'lib/update-notify.mjs'],
    'SECURITY.md tells auditors exactly three modules open sockets. Anything else calling fetch ' +
    'directly (especially in commands/) breaks that promise.');
});

test('CLAIM: nothing in commands/ opens a socket directly', () => {
  const offenders = sources
    .filter(s => s.path.includes('/commands/') && /\bfetch\(/.test(s.text))
    .map(s => s.path.replace(REPO + '/', ''));
  assert.deepEqual(offenders, [],
    `commands/ must go through ctx.http. Direct fetch in: ${offenders.join(', ')}`);
});

// ── "There is no card-charging path" ──────────────────────────────────────────

test('CLAIM: no charge/capture/refund write path exists', () => {
  // Money-side POST/PUT/DELETE targets. Draft-invoice and send-invoice are documented and allowed
  // (a pay LINK, not a charge); anything that would pull funds is not.
  const CHARGE_WRITE = /\b(?:post|put|delete)\s*\(\s*[`'"][^`'"]*(?:charge|capture|refund|collect-?payment)/i;
  const offenders = sources
    .filter(s => CHARGE_WRITE.test(s.text))
    .map(s => s.path.replace(REPO + '/', ''));
  assert.deepEqual(offenders, [],
    `SECURITY.md promises sizmo cannot pull money off a card. Found a charge-shaped write in: ` +
    `${offenders.join(', ')}. This is the single highest-trust claim in the doc — do not relax ` +
    `this test to make a feature pass.`);
});

// ── "Every write requires --confirm" ──────────────────────────────────────────

test('CLAIM: every command performing a write routes through requireConfirm', () => {
  // business.mjs violated this until 2026-07-26 — it hand-rolled a ctx.confirmed check, which is
  // how --dry-run silently broke on it while README claimed --dry-run worked on all writes.
  const WRITE_CALL = /ctx\.http\.(post|put|delete)\s*\(/;
  const offenders = sources
    .filter(s => s.path.includes('/commands/'))
    .filter(s => WRITE_CALL.test(s.text))
    .filter(s => !/requireConfirm\s*\(/.test(s.text))
    // ask.mjs orchestrates other commands rather than writing on its own behalf; its gate is the
    // pending-plan replay mechanism, covered by its own tests.
    .filter(s => !s.path.endsWith('/ask.mjs'))
    .map(s => s.path.replace(REPO + '/', ''))
    .sort();
  assert.deepEqual(offenders, [],
    `These commands issue writes without importing the shared confirm gate: ${offenders.join(', ')}. ` +
    `A hand-rolled ctx.confirmed check is what broke --dry-run on business.mjs — it exits 5 instead ` +
    `of 0 and skips the JSON envelope. Use requireConfirm() from lib/confirm.mjs.`);
});

// ── doc/code consistency ──────────────────────────────────────────────────────

test('CLAIM: SECURITY.md still documents the update-check opt-outs the code implements', () => {
  const notify = readFileSync(join(REPO, 'lib', 'update-notify.mjs'), 'utf8');
  for (const optOut of ['NO_UPDATE_NOTIFIER', '--no-update-check']) {
    assert.ok(notify.includes(optOut.replace('--', '')) || allSource.includes(optOut),
      `${optOut} must exist in code`);
    assert.ok(SECURITY_MD.includes(optOut),
      `SECURITY.md must document the ${optOut} opt-out it promises`);
  }
});

test('CLAIM: the LLM egress is disclosed, not just implied', () => {
  // The specific regression this file was written for: the doc must never again describe egress
  // as two destinations while lib/llm.mjs exists.
  assert.ok(!/exactly two kinds of outbound request/i.test(SECURITY_MD),
    'SECURITY.md says "exactly two kinds of outbound request" but lib/llm.mjs is a third. ' +
    'This exact sentence was the 2026-07-26 false guarantee.');
  assert.ok(/anthropic|openai|LLM provider/i.test(SECURITY_MD),
    'SECURITY.md must disclose the LLM provider egress that lib/llm.mjs performs.');
});
