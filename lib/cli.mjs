// lib/cli.mjs — global-flag parse → route → ctx → run → exit-code map. All commands run
// in-process via registry (importable core). READ-ONLY router; never writes to GoHighLevel.
import { fileURLToPath } from 'node:url';
import { registry } from './registry.mjs';
import { resolve, loadProfiles, saveProfiles, validateToken, mask, pitAgeDays } from './config.mjs';
import { makeHttp } from './http.mjs';
import { mapLimit } from './pool.mjs';
import { buildCtx } from './context.mjs';
import { buildSchema } from './schema.mjs';
import { GhlError, EXIT } from './errors.mjs';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export async function route(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  // pull global --profile + --json + --fresh/--no-cache + --concise + --fields + --confirm + --dry-run
  let profile = null, json = false, fresh = false, concise = false, fields = null;
  let confirmed = false, dryRun = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' && argv[i + 1]) { profile = argv[++i]; continue; }
    if (argv[i] === '--json') { json = true; rest.push(argv[i]); continue; }
    if (argv[i] === '--fresh' || argv[i] === '--no-cache') { fresh = true; continue; }
    if (argv[i] === '--concise') { concise = true; continue; }
    if (argv[i] === '--fields' && argv[i + 1] && !argv[i + 1].startsWith('--')) { fields = argv[++i]; continue; }
    if (argv[i] === '--confirm') { confirmed = true; continue; }
    if (argv[i] === '--dry-run') { dryRun = true; continue; }
    rest.push(argv[i]);
  }
  const [cmd, ...args] = rest;

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') { write(helpText(VERSION)); return cmd ? EXIT.OK : EXIT.USAGE; }
  if (cmd === 'version' || cmd === '--version' || cmd === '-V') { write(VERSION + '\n'); return EXIT.OK; }
  if (cmd === 'schema') { write(JSON.stringify(await buildSchema(registry, EXIT), null, 2) + '\n'); return EXIT.OK; }

  // router-level verbs: auth, config, api
  if (cmd === 'auth' || cmd === 'config') return routerVerb(cmd, args, { profile, json, write, writeErr, readStdin: io.readStdin });
  if (cmd === 'api') return apiVerb(args, { profile, json, write, writeErr });

  // recipe commands: all run in-process via registry
  const name = cmd === 'recipes' ? args.shift() : cmd;
  try {
    if (registry[name]) {
      const creds = resolve(profile);
      const tty = !!(io.tty ?? process.stdout.isTTY);
      const ctx = buildCtx({ creds, globals: { json, tty, command: name, fresh, concise, fields }, confirmed, dryRun });
      const mod = await registry[name]();
      const parsed = parseArgs(args, mod.meta);          // validates against meta.flags; throws GhlError USAGE
      const code = await mod.run(parsed, ctx);
      ctx.out.flush();
      return code ?? EXIT.OK;
    }
    throw new GhlError(`unknown command "${name ?? cmd}"`, EXIT.USAGE, 'sizmo help');
  } catch (e) {
    if (e instanceof GhlError) {
      if (json) writeErr(JSON.stringify({ error: e.message, code: e.code, remediation: e.remediation }) + '\n');
      else writeErr(e.message + (e.remediation ? `\n  fix: ${e.remediation}` : '') + '\n');
      return e.code;
    }
    writeErr((e?.message || 'error') + '\n');
    return EXIT.API;
  }
}
export const run = route;

export function parseArgs(args, meta) {
  const out = { _: [] };
  const flags = new Map((meta?.flags || []).map(f => [f.name, f]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const f = flags.get(a);
      if (!f) { if (a === '--json') { out.json = true; continue; } throw new GhlError(`unknown flag ${a}`, EXIT.USAGE, `sizmo schema`); }
      if (f.type === 'bool') out[a.slice(2)] = true;
      else {
        if (i + 1 >= args.length) throw new GhlError(`flag ${a} needs a value`, EXIT.USAGE, 'sizmo schema');
        out[a.slice(2)] = f.type === 'int' ? Number(args[++i]) : args[++i];
      }
    } else out._.push(a);
  }
  return out;
}
function helpText(v) { return `sizmo ${v} — GoHighLevel read-only CLI (money always human-triggered)\n  sizmo <command> [--json] [--profile name] [--fresh]\n  commands: see  sizmo schema\n  sizmo auth status · sizmo config list|use|set|rm\n  --fresh / --no-cache  bypass 60s read cache (always re-fetches live data)\n  cacheAgeMs in JSON envelope shows how old the data is when served from cache\n`; }

// routerVerb — auth + config local verbs.
// io.readStdin seam lets tests inject stdin content without actually reading fd 0.
async function routerVerb(cmd, args, io) {
  const { profile = null, json = false, write, writeErr, readStdin } = io;
  const [verb, ...rest] = args;

  function die(msg, code = EXIT.API, remediation = null) {
    if (json) writeErr(JSON.stringify({ error: msg, code, ...(remediation && { remediation }) }) + '\n');
    else writeErr(msg + (remediation ? `\n  fix: ${remediation}` : '') + '\n');
    return code;
  }

  // ── auth ────────────────────────────────────────────────────────────────────
  if (cmd === 'auth') {
    if (verb === 'check') {
      // auth check: per-lane scope diagnostic — probes all fleet read lanes concurrently.
      // Rule: 401/403 = scope MISSING; 200 or 4xx param error (400/422) = scope PRESENT.
      // Exit 0 if contacts lane is readable (tool is usable); per-lane ✖ lines guide the user.
      const creds = resolve(profile);
      if (!creds.pit) return die('no credentials found', EXIT.AUTH, 'set GHL_PIT, or: sizmo config set --profile <name> --pit-stdin');
      if (!creds.loc) return die('no location resolved', EXIT.AUTH, 'pass --profile <name>, or set GHL_LOCATION_ID');

      const loc = creds.loc;
      const LANES = [
        { name: 'contacts',      scope: 'contacts.readonly',             path: `/contacts/?locationId=${loc}&limit=1` },
        { name: 'conversations', scope: 'conversations.readonly',        path: `/conversations/search?locationId=${loc}&limit=1` },
        { name: 'opportunities', scope: 'opportunities.readonly',        path: `/opportunities/search?location_id=${loc}&limit=1` },
        { name: 'calendars',     scope: 'calendars.readonly',            path: `/calendars/?locationId=${loc}` },
        { name: 'invoices',      scope: 'invoices.readonly',             path: `/invoices/?altId=${loc}&altType=location&limit=1` },
        { name: 'payments',      scope: 'payments/transactions.readonly', path: `/payments/transactions?altId=${loc}&altType=location&limit=1` },
      ];

      if (!json) write(`auth check: probing ${LANES.length} GoHighLevel API scopes...\n`);

      let lanes;
      try {
        const http = makeHttp({ pit: creds.pit });
        lanes = await mapLimit(LANES, 5, async (lane) => {
          try {
            const r = await http.get(lane.path);
            // 401/403 = scope blocked; 200 or param-error (400/422) = authorized
            const ok = r.code !== 401 && r.code !== 403;
            return { name: lane.name, scope: lane.scope, ok, code: r.code };
          } catch (e) {
            return { name: lane.name, scope: lane.scope, ok: false, code: 0, error: e?.message ?? 'error' };
          }
        });
      } catch (e) {
        writeErr(`auth check: could not reach GoHighLevel (${e?.message ?? 'error'})\n`);
        return EXIT.API;
      }

      const okCount = lanes.filter(l => l.ok).length;
      const total = lanes.length;

      if (json) {
        const contactsOk = lanes.find(l => l.name === 'contacts')?.ok ?? false;
        write(JSON.stringify({
          schemaVersion: 1,
          location: loc,
          lanes: lanes.map(l => ({ name: l.name, scope: l.scope, ok: l.ok, httpCode: l.code })),
          summary: `${okCount}/${total} lanes readable`,
          usable: contactsOk,
        }) + '\n');
        return contactsOk ? EXIT.OK : EXIT.AUTH;
      }

      // human output — per-lane lines then summary
      for (const l of lanes) {
        if (l.ok) {
          write(`  ✅ ${l.name}\n`);
        } else {
          writeErr(`  ✖ ${l.name} — add scope ${l.scope}\n`);
        }
      }

      const missing = lanes.filter(l => !l.ok).map(l => l.scope);
      if (missing.length === 0) {
        write(`\n${okCount}/${total} lanes readable — full brief available\n`);
      } else {
        const missingNames = lanes.filter(l => !l.ok).map(l => l.name).join(', ');
        writeErr(`\n${okCount}/${total} lanes readable — \`brief\` will show ⚠ on ${missingNames} until you add: ${missing.join(', ')}\n`);
      }

      const contactsOk = lanes.find(l => l.name === 'contacts')?.ok ?? false;
      return contactsOk ? EXIT.OK : EXIT.AUTH;
    }
    if (verb !== 'status') return die('usage: sizmo auth status|check', EXIT.USAGE);

    // auth status — source, loc, masked PIT, age
    const creds = resolve(profile);
    write(`auth source   ${creds.source ?? 'NONE'}\n`);
    write(`location      ${creds.loc ?? '(none resolved)'}\n`);
    write(`PIT           ${mask(creds.pit)}${creds.label ? `  (${creds.label})` : ''}\n`);
    const age = pitAgeDays(creds.createdAt);
    if (age !== null) {
      const note = age >= 90 ? '✖ EXPIRED-ZONE — rotate NOW (90d limit, 7d dual-token overlap)'
        : age >= 80 ? `⚠ rotate soon — day ${age} of 90`
        : `✅ day ${age} of 90`;
      write(`PIT age       ${note}\n`);
    } else {
      write(`PIT age       unknown — set with: sizmo config set --profile <name> --created YYYY-MM-DD\n`);
    }
    if (!creds.pit) return die('no credentials found', EXIT.AUTH, 'set GHL_PIT, or: sizmo config set --profile <name> --pit-stdin');
    return EXIT.OK;
  }

  // ── config ──────────────────────────────────────────────────────────────────
  if (cmd === 'config') {
    const db = loadProfiles();

    if (verb === 'list') {
      const names = Object.keys(db.profiles ?? {});
      if (json) {
        // Machine output — PIT never emitted (omitted entirely, not masked).
        const profiles = names.map(n => {
          const p = db.profiles[n];
          return {
            name: n,
            locationId: p.locationId ?? null,
            label: p.label ?? null,
            default: n === db.default,
            pitAgeDays: pitAgeDays(p.createdAt),
          };
        });
        write(JSON.stringify({ schemaVersion: 1, profiles }) + '\n');
        return EXIT.OK;
      }
      if (!names.length) {
        write('no profiles yet (GHL_PIT env var in effect if set). sizmo config set --profile <name> ...\n');
      }
      for (const n of names) {
        const p = db.profiles[n];
        const age = pitAgeDays(p.createdAt);
        write(`${n === db.default ? '*' : ' '} ${n.padEnd(16)} loc ${p.locationId ?? '—'}  ${mask(p.pit)}  ${age !== null ? `day ${age}/90` : ''}  ${p.label ?? ''}\n`);
      }
      return EXIT.OK;
    }

    if (verb === 'use') {
      const name = rest[0];
      if (!db.profiles?.[name]) return die(`no profile "${name}"`, EXIT.NOTFOUND, 'sizmo config list');
      db.default = name;
      saveProfiles(db);
      write(`default → ${name}\n`);
      return EXIT.OK;
    }

    if (verb === 'rm') {
      const name = rest[0];
      if (!db.profiles?.[name]) return die(`no profile "${name}"`, EXIT.NOTFOUND, 'sizmo config list');
      delete db.profiles[name];
      if (db.default === name) db.default = null;
      saveProfiles(db);
      write(`removed ${name}\n`);
      return EXIT.OK;
    }

    if (verb === 'set') {
      // flag(n): returns the value string when present, null when absent.
      // Distinguish "flag absent" from "flag present with empty string" — reject empty strings.
      const flagRaw = (n) => { const i = rest.indexOf(n); return i >= 0 ? (rest[i + 1] ?? null) : null; };
      const flagPresent = (n) => rest.indexOf(n) >= 0;
      const flag = (n) => { const v = flagRaw(n); return (v && v !== '') ? v : null; };
      // Reject explicitly-passed empty strings for --loc, --label, --created
      for (const f of ['--loc', '--label', '--created']) {
        if (flagPresent(f) && !flagRaw(f)) return die(`${f} requires a non-empty value`, EXIT.USAGE, `sizmo config set --profile <name> ${f} <value>`);
      }
      const name = flag('--profile') ?? profile;
      if (!name) return die('need --profile <name>', EXIT.USAGE);
      db.profiles ??= {};
      const p = db.profiles[name] ?? {};
      if (flag('--loc')) p.locationId = flag('--loc');
      if (flag('--label')) p.label = flag('--label');
      if (flag('--created')) p.createdAt = flag('--created');

      if (rest.includes('--pit-stdin')) {
        let tok;
        if (readStdin) {
          tok = readStdin().trim();
        } else {
          tok = readFileSync(0, 'utf8').trim();
        }
        if (!tok.startsWith('pit-')) return die('stdin did not look like a PIT (expected pit-…)', EXIT.USAGE);
        p.pit = tok;
        p.createdAt ??= new Date().toISOString().slice(0, 10);
      } else if (flag('--pit-env')) {
        const envVar = flag('--pit-env');
        const tok = process.env[envVar];
        if (!tok?.startsWith('pit-')) return die(`env ${envVar} empty or not a PIT`, EXIT.USAGE);
        p.pit = tok;
        p.createdAt ??= new Date().toISOString().slice(0, 10);
      }

      db.profiles[name] = p;
      db.default ??= name;
      saveProfiles(db);
      write(`saved ${name} — loc ${p.locationId ?? '—'} · ${mask(p.pit)} · ${p.createdAt ? 'created ' + p.createdAt : 'no created date'}\n`);

      // validate PIT→loc after save (warn only — don't hard-fail the save)
      if (p.pit && p.locationId) {
        try {
          const http = makeHttp({ pit: p.pit });
          const result = await validateToken(http, p.locationId);
          if (!result.ok) {
            writeErr(`WARN: token validation failed — ${result.reason}\n  The profile was saved. Double-check PIT and loc before using.\n`);
          }
        } catch (e) {
          writeErr(`WARN: could not reach GoHighLevel to validate token (${e?.message ?? 'error'}) — profile saved anyway\n`);
        }
      }

      return EXIT.OK;
    }

    return die('usage: sizmo config list|use <name>|set --profile <name> ...|rm <name>', EXIT.USAGE);
  }

  return EXIT.OK;
}

// apiVerb — GET-only raw escape hatch.
// Structural read-only: no method flag exists. Uses makeHttp instead of raw fetch.
async function apiVerb(args, { profile, json, write, writeErr }) {
  const [path, ...rest] = args;
  function die(msg, code = EXIT.API, remediation = null) {
    if (json) writeErr(JSON.stringify({ error: msg, code, ...(remediation && { remediation }) }) + '\n');
    else writeErr(msg + (remediation ? `\n  fix: ${remediation}` : '') + '\n');
    return code;
  }

  if (!path || !path.startsWith('/'))
    return die('usage: sizmo api </path?query> [--paginate] [--max-pages N]', EXIT.USAGE, 'example: sizmo api "/contacts/?limit=5"');

  const creds = resolve(profile);
  if (!creds.pit)
    return die('no PIT available', EXIT.AUTH, 'set GHL_PIT, or: sizmo config set --profile <name> --pit-stdin');

  const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 && rest[i + 1] ? rest[i + 1] : d; };
  const paginate = rest.includes('--paginate');
  const rawMaxPages = flag('--max-pages', null);
  const maxPages = rawMaxPages !== null ? Number(rawMaxPages) : 10;
  // validate --max-pages when --paginate is set — NaN or <=0 produces empty output
  if (paginate && rawMaxPages !== null && !(Number.isInteger(maxPages) && maxPages >= 1))
    return die(`--max-pages must be a positive integer (got ${JSON.stringify(rawMaxPages)})`, EXIT.USAGE, 'example: sizmo api "/contacts/?limit=5" --paginate --max-pages 5');

  const http = makeHttp({ pit: creds.pit });

  // auto-fill locationId when absent
  const LOC = creds.loc;
  let urlPath = path;
  if (LOC && !/locationId=|location_id=|altId=/.test(urlPath))
    urlPath += (urlPath.includes('?') ? '&' : '?') + 'locationId=' + LOC;

  const pages = [];
  const BASE = 'https://services.leadconnectorhq.com';
  let currentPath = urlPath;

  for (let p = 0; p < (paginate ? maxPages : 1); p++) {
    // For paginated next URLs, strip the base if present
    const reqPath = currentPath.startsWith('http')
      ? currentPath.replace(BASE, '')
      : currentPath;
    const r = await http.get(reqPath);
    if (r.code === 401 || r.code === 403)
      return die(`HTTP ${r.code} — PIT lacks scope for ${path}`, EXIT.AUTH, 'sizmo auth check shows which lanes this PIT can see');
    if (r.code === 404)
      return die(`HTTP 404 — ${path}`, EXIT.NOTFOUND, (r.txt || '').slice(0, 120).replace(/\s+/g, ' '));
    if (!r.ok)
      return die(`HTTP ${r.code} — ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

    // If response isn't JSON (no j), write raw text and stop
    if (r.j === null) { write(r.txt + '\n'); return EXIT.OK; }
    pages.push(r.j);

    const next = r.j?.meta?.nextPageUrl;
    if (!paginate || !next) break;
    currentPath = next;
  }

  write(JSON.stringify(pages.length === 1 ? pages[0] : pages, null, 2) + '\n');
  if (paginate && pages.length === maxPages)
    writeErr(`note: stopped at --max-pages ${maxPages}; more may exist\n`);
  return EXIT.OK;
}
