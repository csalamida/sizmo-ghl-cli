// commands/calendar.mjs — create OR delete a calendar.
// Scope required: calendars.write
// delete is SINGLE-TARGET ONLY: resolves the exact calendar by id, names it in the preview, and
// DELETEs that one record — it can never bulk-delete.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'calendar',
  summary: 'create or delete a calendar (delete is single-target, never bulk)',
  flags: [
    { name: '--name',        type: 'string', desc: 'calendar name (create)' },
    { name: '--type',        type: 'string', desc: 'calendar type (create) — default event' },
    { name: '--slot-min',    type: 'number', desc: 'slot duration in minutes (create) — default 30' },
    { name: '--team-member', type: 'string', desc: 'comma-separated user IDs to assign (create) — required for round_robin/collective types' },
  ],
  readOnly: false,
};

const SCOPE_FIX = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add calendars.write scope';

export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'create') return createCalendar(args, ctx);
  if (sub === 'delete') return deleteCalendar(args, ctx);
  throw new GhlError('usage: sizmo calendar create --name "…" | sizmo calendar delete <calendarId>', EXIT.USAGE, 'sizmo calendar --help');
}

async function createCalendar(args, ctx) {
  const name = args.name;
  if (!name || !String(name).trim()) {
    throw new GhlError('calendar create needs --name', EXIT.USAGE, 'sizmo calendar create --name "Discovery Calls"');
  }

  const teamMemberArg = args['team-member'];
  const teamMemberIds = teamMemberArg
    ? String(teamMemberArg).split(',').map(s => s.trim()).filter(Boolean)
    : [];

  if (teamMemberIds.length === 0 && args.type && /round.robin|collective/i.test(String(args.type))) {
    throw new GhlError(
      `calendar type "${args.type}" requires at least one team member`,
      EXIT.USAGE,
      'sizmo list users  # find user ids, then add: --team-member uid1,uid2',
    );
  }

  const body = {
    locationId: ctx.cfg.loc,
    name: String(name),
    ...(args.type ? { calendarType: String(args.type) } : {}),
    ...(args['slot-min'] != null ? { slotDuration: Number(args['slot-min']), slotDurationUnit: 'mins' } : {}),
    ...(teamMemberIds.length > 0 ? { teamMembers: teamMemberIds.map(userId => ({ userId })) } : {}),
  };

  const changes = [
    `Create calendar "${name}"`,
    ...(args.type ? [`  type: ${args.type}`] : []),
    ...(args['slot-min'] != null ? [`  slot: ${args['slot-min']} mins`] : []),
    ...(teamMemberIds.length > 0 ? [`  team members: ${teamMemberIds.join(', ')}`] : []),
  ];
  const parts = ['sizmo calendar create', `--name "${String(name).replace(/"/g, '\\"')}"`];
  if (args.type) parts.push(`--type "${args.type}"`);
  if (args['slot-min'] != null) parts.push(`--slot-min ${args['slot-min']}`);
  if (teamMemberIds.length > 0) parts.push(`--team-member "${teamMemberIds.join(',')}"`);
  const rerunCommand = parts.join(' ') + ' --confirm';

  const gate = requireConfirm({ command: 'calendar create', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post('/calendars/', body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks calendars.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) {
    const body = (r.txt || '').slice(0, 300).replace(/\s+/g, ' ');
    const teamHint = /team member/i.test(body)
      ? 'sizmo list users  # find user ids, then add: --team-member uid1,uid2'
      : undefined;
    throw new GhlError(`calendar create failed — HTTP ${r.code}: ${body}`, EXIT.API, teamHint);
  }

  const created = r.j?.calendar ?? r.j ?? {};
  const id = created.id || created._id || null;
  ctx.out.data({ status: 'ok', command: 'calendar create', calendarId: id, name: created.name ?? String(name) });
  ctx.out.line(`  calendar "${created.name ?? name}" created · id ${id ?? '(see response)'}`);
  return EXIT.OK;
}

async function deleteCalendar(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo calendar delete <calendarId> — exactly one id, never bulk', EXIT.USAGE, 'sizmo crm calendars  # to find the id');
  }
  // SAFETY: fetch the single calendar first so the preview names what you're deleting, and a wrong
  // id 404s here (nothing deleted) instead of touching anything.
  const got = await ctx.http.get(`/calendars/${encodeURIComponent(id)}`);
  if (got.code === 401 || got.code === 403) throw new GhlError(`HTTP ${got.code} — your PIT lacks calendars.write`, EXIT.AUTH, SCOPE_FIX);
  if (got.code === 404) throw new GhlError(`no calendar with id ${id} — nothing deleted`, EXIT.NOTFOUND);
  if (!got.ok) throw new GhlError(`calendar delete: could not read calendar ${id} — HTTP ${got.code}`, EXIT.API);
  const cal = got.j?.calendar ?? got.j ?? {};
  const who = cal.name || '(unnamed)';

  const changes = [
    `Delete calendar "${who}" (id ${id})`,
    '  ⚠ removes THIS ONE calendar only — sizmo deletes a single record by id, never in bulk',
  ];
  const rerunCommand = `sizmo calendar delete ${id} --confirm`;
  const gate = requireConfirm({ command: 'calendar delete', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.delete(`/calendars/${encodeURIComponent(id)}`);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks calendars.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`calendar delete failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'calendar delete', calendarId: id, name: who });
  ctx.out.line(`  calendar "${who}" (id ${id}) deleted`);
  return EXIT.OK;
}
