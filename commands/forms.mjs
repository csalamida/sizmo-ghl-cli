// commands/forms.mjs — form list + submission feed.
// sizmo forms                  → list all forms (from model cache)
// sizmo forms <formId>         → recent submissions for that form
// sizmo forms <formId> --top N → limit to N rows (default 20)

import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'forms',
  summary: 'list forms or view recent submissions for a specific form',
  flags: [
    { name: '--top', type: 'number', desc: 'max submissions to show (default 20)' },
  ],
  readOnly: true,
};

const DEFAULT_TOP = 20;
const MAX_TOP     = 100;

export async function run(parsed, ctx) {
  const formId = parsed._?.[0];
  const top    = Math.min(Number(parsed.top) || DEFAULT_TOP, MAX_TOP);

  if (!formId) return listForms(ctx);
  return showSubmissions(formId, top, ctx);
}

// ── list all forms (model cache) ─────────────────────────────────────────────

async function listForms(ctx) {
  const model = await ctx.ensureModel();
  const ents  = model?.entities ?? {};

  if (ents.forms?.blocked) {
    // Throws so --json gets a real error envelope. Returning skipped the CLI's error handler and
    // emitted degraded:false with no error, which reads as an empty-but-successful result.
    if (ents.forms.httpCode) {
      throw new GhlError(
        `forms — API error ${ents.forms.httpCode} (not a scope issue — please report this)`, EXIT.API);
    }
    throw new GhlError(
      `forms blocked — your PIT lacks forms.readonly`, EXIT.AUTH,
      'GoHighLevel → Settings → Private Integrations → edit your PIT → add forms.readonly scope');
  }

  const items = ents.forms?.items ?? [];

  ctx.out.data({ entity: 'forms', items });

  ctx.out.line('');
  ctx.out.line(`  FORMS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(70));
  ctx.out.line(`  ${'Name'.padEnd(36)}  Form ID`);
  ctx.out.line('  ' + '─'.repeat(70));

  for (const f of items) {
    ctx.out.line(`  ${pad(f.name, 36)}  ${f.id || ''}`);
  }

  ctx.out.line('  ' + '─'.repeat(70));
  ctx.out.line('  Copy Form ID → sizmo forms <formId>  (recent submissions)\n');
  return EXIT.OK;
}

// ── submission feed ───────────────────────────────────────────────────────────

async function showSubmissions(formId, top, ctx) {
  const loc = ctx.cfg.loc;
  let submissions = [];

  try {
    const r = await ctx.http.get(
      `/forms/submissions?locationId=${encodeURIComponent(loc)}&formId=${encodeURIComponent(formId)}&limit=${top}`
    );
    if (r.code === 401 || r.code === 403) {
      throw new GhlError(
        `HTTP ${r.code} — your PIT lacks forms/submissions.readonly`, EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add forms/submissions.readonly scope');
    }
    if (r.code === 404) {
      throw new GhlError(`no form with id ${formId}`, EXIT.NOTFOUND);
    }
    if (!r.ok) {
      throw new GhlError(`form submissions failed — HTTP ${r.code}`, EXIT.API);
    }
    submissions = r.j?.submissions ?? r.j?.data ?? r.j?.results ?? [];
    if (!Array.isArray(submissions)) {
      ctx.out.warn(`unexpected response shape — raw keys: ${Object.keys(r.j ?? {}).join(', ')}`);
      submissions = [];
    }
  } catch (e) {
    // Deliberate GhlErrors raised above must pass through — swallowing them here would downgrade a
    // precise 401-with-remediation into a generic API error, the exact bug business.mjs had.
    if (e instanceof GhlError) throw e;
    throw new GhlError(`could not fetch form submissions: ${e.message}`, EXIT.API);
  }

  ctx.out.data({ formId, submissions, total: submissions.length });

  ctx.out.line('');
  ctx.out.line(`  SUBMISSIONS — form ${formId}`);
  ctx.out.line(`  Showing last ${Math.min(top, submissions.length)} of up to ${top} requested`);
  ctx.out.line('  ' + '─'.repeat(80));
  ctx.out.line(`  ${'Contact'.padEnd(28)}  ${'Email'.padEnd(28)}  Submitted`);
  ctx.out.line('  ' + '─'.repeat(80));

  for (const s of submissions) {
    const name  = pad(s.contactAttributes?.full_name || s.name || '—', 28);
    const email = pad(s.contactAttributes?.email || s.email || '—', 28);
    const date  = s.createdAt ? s.createdAt.slice(0, 10) : '—';
    ctx.out.line(`  ${name}  ${email}  ${date}`);
  }

  if (submissions.length === 0) ctx.out.line('  (no submissions yet)');
  ctx.out.line('  ' + '─'.repeat(80));
  ctx.out.line('  Contact ID in data → sizmo contact search --email <email>\n');
  return EXIT.OK;
}

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n); }
