// commands/init.mjs — guided activation. Walks a cold user from zero to a green `doctor`
// in one run: confirm-or-create profile → print the GHL path + exact scope copy-block →
// capture the PIT via STDIN ONLY (never argv, never logged) → prompt/accept location →
// write the profile (0600, atomic, via lib/config.mjs) → auto-run `doctor`.
//
// Agent-drivable: in non-TTY / piped mode it reads the token from stdin and skips all prompts.
// HARD RULE: the PIT is read from stdin only. It is NEVER accepted as an argv flag and never
// echoed back — only the masked form (mask()) is ever printed.
import { readFileSync } from 'node:fs';
import { loadProfiles, saveProfiles, resolve, mask } from '../lib/config.mjs';
import { buildCtx } from '../lib/context.mjs';
import { registry } from '../lib/registry.mjs';
import { READ_SCOPES, WRITE_SCOPES } from '../lib/diagnose.mjs';
import { EXIT } from '../lib/errors.mjs';

const GHL_PATH = 'Settings → Integrations → Private Integrations → Create';

/**
 * runInit(args, io) — router-verb entry. io: { profile, json, tty, write, writeErr, readStdin }
 *   args: raw argv tail (flags parsed locally — same convention as routerVerb).
 * Flags: --profile <name> (also via io.profile), --loc <id>, --force (overwrite in TTY), --json.
 */
export async function runInit(args, io) {
  const { json = false, tty = false, write, writeErr, readStdin } = io;

  // local flag parse (mirror config set's flag(n) helper) — NOTE: no --pit flag exists by design.
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? null) : null; };
  const has = (n) => args.indexOf(n) >= 0;

  function emit(result, code) {
    if (json) write(JSON.stringify({ schemaVersion: 1, ...result }) + '\n');
    return code;
  }
  function die(msg, code = EXIT.USAGE, remediation = null) {
    if (json) writeErr(JSON.stringify({ error: msg, code, ...(remediation && { remediation }) }) + '\n');
    else writeErr(msg + (remediation ? `\n  fix: ${remediation}` : '') + '\n');
    return code;
  }

  const name = flag('--profile') ?? io.profile ?? 'default';
  const loc = flag('--loc');
  const force = has('--force');

  // ── 1. Detect existing profile → confirm before overwrite ───────────────────
  const db = loadProfiles();
  const existing = db.profiles?.[name];
  if (existing) {
    // Never clobber silently. In TTY mode require --force (we can't both prompt and read the
    // PIT from the same stdin). In non-TTY mode, re-writing the SAME named profile is the
    // idempotent re-init path (same key → no duplicate) and is allowed.
    if (tty && !force) {
      return die(
        `profile "${name}" already exists — re-running init will overwrite it`,
        EXIT.USAGE,
        `rerun with --force to overwrite, or pick a new name: sizmo init --profile <other>`
      );
    }
  }

  // ── 2 + 3. Print the GHL path + exact scope copy-block (human mode only) ─────
  if (!json) {
    write('\nSIZMO INIT — guided activation\n');
    write('──────────────────────────────────────────────────────────────\n');
    write('1. Create a Private Integration Token in GoHighLevel:\n');
    write(`     ${GHL_PATH}\n\n`);
    write('2. Grant these scopes (paste this block — read scopes for the full brief):\n\n');
    write('     ' + READ_SCOPES.join(' · ') + '\n\n');
    write('   For the write commands (tag, note, opp, appointment, send), also add:\n\n');
    write('     ' + WRITE_SCOPES.join(' · ') + '\n\n');
    write('3. Paste the token. Pipe it via stdin — never as an argument:\n');
    write('     echo "pit-…" | sizmo init --profile ' + name + ' --loc <LOCATION_ID>\n\n');
  }

  // ── 4. Capture the PIT via STDIN ONLY (never argv) ──────────────────────────
  let tok;
  try {
    if (readStdin) {
      tok = (readStdin() ?? '').trim();
    } else {
      tok = readFileSync(0, 'utf8').trim();
    }
  } catch {
    tok = '';
  }
  if (!tok) {
    return die('no token on stdin — pipe your PIT: echo "pit-…" | sizmo init --loc <id>', EXIT.USAGE,
      'a PIT is required; it is read from stdin only, never as an argument');
  }
  if (!tok.startsWith('pit-')) {
    return die('stdin did not look like a PIT (expected pit-…)', EXIT.USAGE);
  }

  // ── location id: --loc flag, else env, else first stdin line already consumed → require ──
  const locationId = loc || process.env.GHL_LOCATION_ID || null;
  if (!locationId) {
    return die('no location id — pass --loc <LOCATION_ID>', EXIT.USAGE,
      'find it in GHL > Settings > Business Profile, or the URL after /location/');
  }
  // Validate the loc shape at write time — a stray space / & / ? / path char would be
  // interpolated raw into request URLs later and silently corrupt every call. Fail loud now.
  if (!/^[A-Za-z0-9_-]{3,}$/.test(locationId)) {
    return die(`location id "${locationId}" has an unexpected format`, EXIT.USAGE,
      'a GHL location id is letters, digits, - and _ only — check GHL > Settings > Business Profile');
  }

  // ── 5. Write the profile (0600, atomic — reuse config.mjs writer) ───────────
  db.profiles ??= {};
  const prev = db.profiles[name] ?? {};
  const profileRec = {
    ...prev,
    pit: tok,
    locationId,
    createdAt: prev.createdAt ?? new Date().toISOString().slice(0, 10),
  };
  db.profiles[name] = profileRec;
  db.default ??= name;
  saveProfiles(db);

  if (!json) {
    write(`saved profile "${name}" — loc ${locationId} · ${mask(tok)} · created ${profileRec.createdAt}\n`);
    write('\nRunning doctor to verify...\n');
  }

  // ── 6. Auto-run doctor and render its result ────────────────────────────────
  // Build a ctx exactly as route() does, then run the doctor command in-process.
  let doctorCode = EXIT.OK;
  let doctorData = null;
  try {
    const creds = resolve(name);
    // Route doctor's human output through init's own write/writeErr (so callers/tests that
    // captured init's io also see the doctor render). In --json mode we suppress doctor's
    // own envelope (we embed its payload in init's result) by giving it a sink writer.
    const ctx = buildCtx({
      creds,
      globals: { json, tty, command: 'doctor' },
      write: json ? () => {} : write,
      writeErr: json ? () => {} : writeErr,
    });
    // Capture doctor's machine payload so init's --json can embed it.
    const origData = ctx.out.data.bind(ctx.out);
    ctx.out.data = (obj) => { doctorData = obj; origData(obj); };
    const mod = await registry.doctor();
    doctorCode = await mod.run({ _: [] }, ctx);
    ctx.out.flush();
  } catch (e) {
    // buildCtx throws AUTH if creds somehow didn't resolve — surface honestly, never fake green.
    doctorCode = e?.code ?? EXIT.AUTH;
    if (!json) writeErr(`doctor could not run — ${e?.message ?? 'error'}\n`);
  }

  // init's own JSON result (structured, agent-friendly). PIT never included — masked only.
  // JSON CONTRACT: init is a router VERB (like `auth` and `config`), not a registry command.
  // Router verbs emit a purpose-specific JSON object — they do NOT use the makeOut data-envelope
  // ({command,location,data,degraded,warnings}) that registry commands (brief/doctor/snapshot/…)
  // emit. This is the established router-verb convention (cf. `auth check` → {lanes,usable},
  // `config list` → {profiles}). Agents parse the documented per-verb shape. `ok` is the success
  // signal; `doctor` carries the embedded diagnosis payload for branching.
  if (json) {
    return emit({
      command: 'init',
      profile: name,
      location: locationId,
      pit: mask(tok),
      created: profileRec.createdAt,
      doctor: doctorData,
      doctorExit: doctorCode,
      ok: doctorCode === EXIT.OK && !!(doctorData && doctorData.ok),
    }, doctorCode === EXIT.AUTH ? EXIT.AUTH : EXIT.OK);
  }

  // Human mode: init succeeds (profile written) even if doctor reports degraded.
  // Surface doctor's exit honestly but don't fail init for a degraded-but-reachable state.
  return doctorCode === EXIT.AUTH ? EXIT.AUTH : EXIT.OK;
}
