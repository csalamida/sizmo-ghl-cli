// commands/doctor.mjs — one-shot health diagnosis. PURE ASSEMBLY of existing engines:
//   · profile + masked PIT + rotation age   (lib/config.mjs mask/pitAgeDays)
//   · per-scope grant report                (lib/diagnose.mjs probeLanes — same probe as `auth check`)
//   · location reachability + latency       (one timed GET to /locations/{loc})
//   · CRM model freshness                    (lib/model.mjs loadModel/isStale/ageMs)
//   · rate headroom                          (OMITTED — the http client surfaces no rate headers; never faked)
//
// HONESTY: never reports green when a lane is blocked. Offline degrades loudly (AUTH exit),
// never crashes, never fabricates a green. Every degraded item traces to a named cause + exact fix.
// READ-ONLY. No writes to GoHighLevel.
import { readFileSync } from 'node:fs';
import { mask, pitAgeDays } from '../lib/config.mjs';
import { probeLanes } from '../lib/diagnose.mjs';
import { loadModel, isStale, ENTITY_SPECS, DEFAULT_MODEL_DIR } from '../lib/model.mjs';
import { readCachedLatest, isNewer } from '../lib/update-notify.mjs';
import { EXIT } from '../lib/errors.mjs';

// Current CLI version (for the version-freshness line). Read once at module load.
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return null; }
})();

export const meta = {
  name: 'doctor',
  summary: 'one-shot health diagnosis — scopes, location, model, in one screen',
  flags: [],
  readOnly: true,
};

function fmtAge(ms) {
  if (ms == null || ms < 0) return '?';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export async function run(args, ctx) {
  const loc = ctx.cfg.loc;
  const nowMs = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const modelDir = ctx._modelDir ?? DEFAULT_MODEL_DIR;

  // ── 1. Location reachability + latency — one timed lightweight GET ───────────
  // This doubles as the "can we reach GHL at all" probe. A code:0 (transport error)
  // means we could not reach GHL — that's an AUTH-class failure, surfaced loudly.
  let location = { reachable: false, latencyMs: null };
  let locUnreachable = false;
  try {
    const wall0 = Date.now();
    const r = await ctx.http.get(`/locations/${encodeURIComponent(loc)}`);
    const latencyMs = Date.now() - wall0;
    if (r.code === 0) {
      // transport failure — could not reach GHL
      locUnreachable = true;
      location = { reachable: false, latencyMs: null };
    } else {
      // any HTTP response (even 401/403/404) means we reached GHL. reachable = transport-ok.
      // The scope probe below tells us whether the PIT can actually READ the location.
      location = { reachable: true, latencyMs, httpCode: r.code };
    }
  } catch {
    locUnreachable = true;
    location = { reachable: false, latencyMs: null };
  }

  // ── 2. Per-scope grant report — same probe as `auth check` ───────────────────
  let lanes = [];
  try {
    lanes = await probeLanes(ctx.http, loc);
  } catch {
    lanes = [];
  }
  // If every lane is a transport error (code 0), GHL is unreachable too.
  const allLanesTransportError = lanes.length > 0 && lanes.every(l => l.code === 0);
  // HONESTY: a transport error (code 0) means we could NOT verify the scope — never report it
  // as granted. Only a real HTTP response (not 401/403) proves the scope is present.
  // (probeLanes maps code:0 → ok:true since 0 isn't 401/403; doctor corrects that here so the
  //  scope report never shows a fake-green while offline.)
  for (const l of lanes) { if (l.code === 0) l.ok = false; }

  // ── 3. CRM model freshness — loadModel + per-entity isStale ──────────────────
  const model = loadModel(loc, modelDir);
  let modelMeta;
  if (!model) {
    modelMeta = { syncedAt: null, ageMs: null, stale: true, present: false };
  } else {
    let anyStale = false;
    // Iterate the EXPECTED entity set, not just what's present — a partial sync that
    // dropped an entity entirely must read as not-fresh, never silently green.
    for (const spec of ENTITY_SPECS) {
      const ent = (model.entities || {})[spec.name];
      if (!ent) { anyStale = true; continue; }
      if (!ent.blocked && !ent.networkError && isStale(ent, nowMs, spec.ttlMs)) anyStale = true;
    }
    modelMeta = {
      syncedAt: model.syncedAt,
      ageMs: nowMs - model.syncedAt,
      stale: anyStale,
      offline: !!model.offline,
      present: true,
    };
  }

  // ── 4. Assemble verdict ───────────────────────────────────────────────────────
  const unreachable = locUnreachable || allLanesTransportError;
  const missingScopes = lanes.filter(l => !l.ok);
  const scopesOk = missingScopes.length === 0 && lanes.length > 0;
  // The contacts lane is the usability FLOOR (same rule as `auth check`): if it's blocked,
  // the tool can't do its core job → that's an auth failure, not a mere degrade.
  const contactsLane = lanes.find(l => l.name === 'contacts');
  const contactsBlocked = !!contactsLane && !contactsLane.ok;
  const modelOk = modelMeta.present && !modelMeta.stale && !modelMeta.offline;
  // ok:true only when reachable AND all scopes granted AND model fresh. Any blocked lane → ok:false.
  // CLI version freshness does NOT gate ok — a stale CLI still works; it's a nudge, not a fault.
  const ok = !unreachable && scopesOk && modelOk;

  // ── CLI version freshness — cache-READ-only (never fetches; the bin notifier does that) ──
  const cachedLatest = readCachedLatest(ctx._updateCacheFile ? { cacheFile: ctx._updateCacheFile, now: () => nowMs } : { now: () => nowMs });
  const cli = {
    current: VERSION,
    latest: cachedLatest, // null when no fresh cache yet (check is pending, not an error)
    updateAvailable: cachedLatest ? isNewer(cachedLatest, VERSION) : false,
  };

  // ── JSON payload (frozen shape per spec; `cli` is additive) ─────────────────
  ctx.out.data({
    profile: ctx.cfg.profileName ?? null,
    location: {
      reachable: location.reachable && !unreachable,
      latencyMs: location.latencyMs,
    },
    scopes: lanes.map(l => ({ scope: l.scope, granted: l.ok, affects: l.affects })),
    model: {
      syncedAt: modelMeta.syncedAt,
      ageMs: modelMeta.ageMs,
      stale: modelMeta.stale,
    },
    rate: { remaining: null }, // OMITTED honestly — http client exposes no rate headers
    cli,
    ok,
  });

  // ── Human render — ✓/⚠/✖ per lane, every degraded item traced to cause + fix ──
  ctx.out.card(() => {
    const W = 64;
    const bar = (ch = '─') => ch.repeat(W);
    ctx.out.line('\n╔' + bar('═') + '╗');
    ctx.out.line('║  SIZMO DOCTOR — health diagnosis' + ' '.repeat(W - 33) + '║');
    ctx.out.line('╚' + bar('═') + '╝');

    // — Profile + PIT —
    ctx.out.line('');
    ctx.out.line(`  profile     ${ctx.cfg.profileName ?? '(env / none)'}`);
    ctx.out.line(`  location    ${loc}`);
    ctx.out.line(`  PIT         ${mask(ctx.cfg.pit)}${ctx.cfg.label ? `  (${ctx.cfg.label})` : ''}`);
    const age = pitAgeDays(ctx.cfg.createdAt);
    if (age !== null) {
      const note = age >= 90 ? '✖ EXPIRED-ZONE — rotate NOW (90d limit)'
        : age >= 80 ? `⚠ rotate soon — day ${age} of 90`
        : `✓ day ${age} of 90`;
      ctx.out.line(`  PIT age     ${note}`);
    } else {
      ctx.out.line(`  PIT age     ⚠ unknown — set: sizmo config set --profile <name> --created YYYY-MM-DD`);
    }

    // — Connectivity —
    ctx.out.line('');
    ctx.out.line('  CONNECTIVITY');
    ctx.out.line('  ' + bar());
    if (unreachable) {
      ctx.out.line(`  ✖ location ${loc} — can't reach GoHighLevel`);
      ctx.out.line(`     → check your connection; rerun \`sizmo doctor\` when online`);
    } else if (location.reachable) {
      ctx.out.line(`  ✓ location ${loc} reachable · ${location.latencyMs}ms`);
    }

    // — Scopes —
    ctx.out.line('');
    ctx.out.line('  SCOPES');
    ctx.out.line('  ' + bar());
    if (lanes.length === 0) {
      // lanes is empty only when probeLanes threw entirely. Distinguish from "reachable but
      // probe failed" vs "never reached GHL at all" to avoid contradicting the connectivity
      // section above (which may have shown ✓ location reachable).
      const why = locUnreachable ? 'GoHighLevel unreachable' : 'scope probe error — rerun or check connectivity';
      ctx.out.line(`  ⚠ could not probe scopes (${why})`);
    } else {
      for (const l of lanes) {
        if (l.ok) {
          ctx.out.line(`  ✓ ${l.scope}`);
        } else {
          // Trace every blocked lane to a named consequence + exact fix.
          const affected = (l.affects || []).join(', ');
          ctx.out.line(`  ✖ ${l.scope} → ${affected} shows ⚠`);
          ctx.out.line(`     → add it in GHL > Settings > Integrations > Private Integrations`);
        }
      }
    }

    // — Model —
    ctx.out.line('');
    ctx.out.line('  CRM MODEL');
    ctx.out.line('  ' + bar());
    if (!modelMeta.present) {
      ctx.out.line('  ⚠ no local model yet → run `sizmo sync` to build it');
    } else if (modelMeta.offline) {
      ctx.out.line(`  ⚠ model from offline cache (${fmtAge(modelMeta.ageMs)} old) → run \`sizmo sync\` when online`);
    } else if (modelMeta.stale) {
      ctx.out.line(`  ⚠ model is stale (${fmtAge(modelMeta.ageMs)} old) → run \`sizmo sync\` to refresh`);
    } else {
      ctx.out.line(`  ✓ model fresh (synced ${fmtAge(modelMeta.ageMs)} ago)`);
    }

    // — Rate headroom: omitted honestly —
    ctx.out.line('');
    ctx.out.line('  RATE HEADROOM');
    ctx.out.line('  ' + bar());
    ctx.out.line('  · not reported (GoHighLevel rate headers not surfaced by this client)');

    // — CLI version (cache-read-only; never gates ok) —
    ctx.out.line('');
    ctx.out.line('  CLI VERSION');
    ctx.out.line('  ' + bar());
    const cur = cli.current || '(unknown)';
    if (cli.updateAvailable) {
      ctx.out.line(`  ⚠ sizmo ${cli.latest} available (you have ${cur}) → npm i -g sizmo@latest`);
    } else if (cli.latest) {
      ctx.out.line(`  ✓ sizmo ${cur} (latest)`);
    } else {
      ctx.out.line(`  · sizmo ${cur} (update check pending — runs once a day)`);
    }

    // — Verdict —
    ctx.out.line('');
    ctx.out.line('  ' + bar('═'));
    if (ok) {
      ctx.out.line('  ✓ ALL GREEN — sizmo is fully operational.');
    } else if (unreachable) {
      ctx.out.line('  ✖ OFFLINE — cannot reach GoHighLevel. Fix connectivity, then rerun.');
    } else {
      const reasons = [];
      if (missingScopes.length) reasons.push(`${missingScopes.length} scope(s) missing`);
      if (!modelMeta.present) reasons.push('no CRM model');
      else if (modelMeta.stale || modelMeta.offline) reasons.push('CRM model stale');
      ctx.out.line(`  ⚠ DEGRADED — ${reasons.join(' · ')}. See fixes above.`);
    }
    ctx.out.line('');
  });

  // ── Exit code (reuse EXIT map — invent nothing) ─────────────────────────────
  // Contract aligned with `auth check`: unreachable OR contacts-scope blocked → AUTH(3);
  // degraded-but-usable (missing non-floor scope / stale model) → 0 with ok:false; all-ok → 0.
  if (unreachable || contactsBlocked) return EXIT.AUTH;
  return EXIT.OK;
}
