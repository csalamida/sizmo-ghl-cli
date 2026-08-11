// lib/render.mjs — shareable renderings of a report: markdown and Slack mrkdwn.
//
// WHY THIS EXISTS
// `brief` shipped `--format pretty|slack|md` and it earned its keep — a report you can paste into
// Slack or an email is a report a non-terminal person can actually receive. Four more commands
// wanted the same thing, and the obvious move was to copy brief's renderSlack/renderMd into each.
// That is precisely the drift this codebase has spent its time removing: four copies of a format,
// diverging the first time someone fixes a heading in one of them.
//
// So the FORMAT lives here once and each command supplies a description of its report rather than a
// rendering of it. A command says "here is a title, some stats, a table"; this file decides what a
// heading looks like in markdown versus Slack.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH
// The existing `pretty` card of every command. Those are hand-tuned, tested, and the default anyone
// sees; re-deriving them through a generic renderer would change spacing and wording for no gain and
// real risk. `pretty` stays exactly where it is. This file only adds the two shareable formats.
//
// HONESTY CARRIES ACROSS FORMATS
// `notes` is not decoration. A report that says "this is a floor, a source was blocked" in the
// terminal and drops that line when pasted into Slack is worse than one that never said it — the
// reader has no way to know the caveat existed. Every renderer here emits notes, and a spec with
// notes cannot render without them.

export const FORMATS = ['pretty', 'slack', 'md'];

/**
 * resolveFormat(args, ctx) → 'pretty' | 'slack' | 'md'
 *
 * An unknown value WARNS and falls back to pretty rather than failing the command. brief silently
 * fell through to pretty on a typo, so `--format markdwon` produced a terminal card and the user
 * never learned why their markdown was missing. A report is not worth failing over, but a silent
 * fallback on a flag the user explicitly set is how someone concludes the feature is broken.
 */
export function resolveFormat(args = {}, ctx = null) {
  const raw = args.format;
  if (raw == null || raw === '') return 'pretty';
  const f = String(raw).trim().toLowerCase();
  if (f === 'markdown') return 'md';
  if (FORMATS.includes(f)) return f;
  ctx?.out?.warn(`unknown --format "${raw}" — rendering as pretty. Valid: ${FORMATS.join(', ')}`);
  return 'pretty';
}

const esc = (s) => String(s ?? '');
// A pipe inside a cell ends the column in markdown, so a contact called "A|B" would silently shift
// every value after it into the wrong header.
const mdCell = (s) => esc(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const slackCell = (s) => esc(s).replace(/\n+/g, ' ');

/**
 * renderShareable(ctx, fmt, spec) — emit a report as markdown or Slack mrkdwn.
 *
 * spec = {
 *   title:  string                       required
 *   meta:   string                       optional — location, window, profile
 *   stats:  [[label, value], …]          optional — the headline numbers
 *   table:  { columns: [], rows: [[]] }  optional — the primary list
 *   notes:  [string]                     optional — caveats, floors, blocked sources
 *   footer: string                       optional
 * }
 *
 * Returns nothing; writes through ctx.out.line so it obeys the same machine-mode suppression as
 * every other human render.
 */
export function renderShareable(ctx, fmt, spec) {
  const { title, meta, stats = [], table = null, notes = [], footer = null } = spec ?? {};
  if (!title) throw new Error('renderShareable: a report must have a title');
  const L = (s = '') => ctx.out.line(s);

  if (fmt === 'slack') {
    L(`*${esc(title)}*`);
    if (meta) L(`_${esc(meta)}_`);
    if (stats.length) {
      L('');
      for (const [k, v] of stats) L(`• ${esc(k)}: *${esc(v)}*`);
    }
    if (table?.rows?.length) {
      L('');
      // Slack has no table syntax that survives a paste, so a fixed-width code block is the only
      // rendering that keeps columns aligned in the client.
      L('```');
      const w = table.columns.map((c, i) =>
        Math.max(esc(c).length, ...table.rows.map(r => slackCell(r[i]).length)));
      L(table.columns.map((c, i) => esc(c).padEnd(w[i])).join('  '));
      for (const r of table.rows) L(r.map((c, i) => slackCell(c).padEnd(w[i])).join('  '));
      L('```');
    }
    for (const n of notes) L(`⚠ ${esc(n)}`);
    if (footer) L(`_${esc(footer)}_`);
    return;
  }

  // markdown
  L(`## ${esc(title)}`);
  if (meta) { L(''); L(`_${esc(meta)}_`); }
  if (stats.length) {
    L('');
    for (const [k, v] of stats) L(`- **${esc(k)}:** ${esc(v)}`);
  }
  if (table?.rows?.length) {
    L('');
    L(`| ${table.columns.map(mdCell).join(' | ')} |`);
    L(`|${table.columns.map(() => '---').join('|')}|`);
    for (const r of table.rows) L(`| ${r.map(mdCell).join(' | ')} |`);
  }
  if (notes.length) {
    L('');
    for (const n of notes) L(`> ⚠ ${esc(n)}`);
  }
  if (footer) { L(''); L(`_${esc(footer)}_`); }
}
