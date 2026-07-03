// commands/surveys.mjs — survey list + submission feed.
// sizmo surveys                  → list all surveys (from model cache)
// sizmo surveys <surveyId>       → recent submissions for that survey
// sizmo surveys <surveyId> --top N

import { EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'surveys',
  summary: 'list surveys or view recent submissions for a specific survey',
  flags: [
    { name: '--top', type: 'number', desc: 'max submissions to show (default 20)' },
  ],
  readOnly: true,
};

const DEFAULT_TOP = 20;
const MAX_TOP     = 100;

export async function run(parsed, ctx) {
  const surveyId = parsed._?.[0];
  const top      = Math.min(Number(parsed.top) || DEFAULT_TOP, MAX_TOP);

  if (!surveyId) return listSurveys(ctx);
  return showSubmissions(surveyId, top, ctx);
}

// ── list all surveys (model cache) ───────────────────────────────────────────

async function listSurveys(ctx) {
  const model = await ctx.ensureModel();
  const ents  = model?.entities ?? {};

  if (ents.surveys?.blocked) {
    ctx.out.line('✖ surveys blocked — needs surveys.readonly scope');
    return EXIT.AUTH;
  }

  const items = ents.surveys?.items ?? [];

  ctx.out.data({ entity: 'surveys', items });

  ctx.out.line('');
  ctx.out.line(`  SURVEYS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(70));
  ctx.out.line(`  ${'Name'.padEnd(36)}  Survey ID`);
  ctx.out.line('  ' + '─'.repeat(70));

  for (const s of items) {
    ctx.out.line(`  ${pad(s.name, 36)}  ${s.id || ''}`);
  }

  ctx.out.line('  ' + '─'.repeat(70));
  ctx.out.line('  Copy Survey ID → sizmo surveys <surveyId>  (recent submissions)\n');
  return EXIT.OK;
}

// ── submission feed ───────────────────────────────────────────────────────────

async function showSubmissions(surveyId, top, ctx) {
  const loc = ctx.cfg.loc;
  let submissions = [];

  try {
    const r = await ctx.http.get(
      `/surveys/submissions?locationId=${encodeURIComponent(loc)}&surveyId=${encodeURIComponent(surveyId)}&limit=${top}`
    );
    if (r.code === 401 || r.code === 403) {
      ctx.out.line('✖ survey submissions blocked — needs surveys/submissions.readonly scope');
      return EXIT.AUTH;
    }
    if (r.code === 404) {
      ctx.out.line(`✖ survey not found: ${surveyId}`);
      return EXIT.NOTFOUND;
    }
    if (!r.ok) {
      ctx.out.line(`✖ API error ${r.code}`);
      return EXIT.API;
    }
    submissions = r.j?.submissions ?? r.j?.data ?? r.j?.results ?? [];
    if (!Array.isArray(submissions)) {
      ctx.out.warn(`unexpected response shape — raw keys: ${Object.keys(r.j ?? {}).join(', ')}`);
      submissions = [];
    }
  } catch (e) {
    ctx.out.warn(`could not fetch survey submissions: ${e.message}`);
    return EXIT.API;
  }

  ctx.out.data({ surveyId, submissions, total: submissions.length });

  ctx.out.line('');
  ctx.out.line(`  SUBMISSIONS — survey ${surveyId}`);
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
