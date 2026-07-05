// commands/note.mjs — add a note to a contact.
// Scope required: contacts.write
// NEVER fires without --confirm. No-confirm → exit 5 (CONFIRM) + envelope.
// 401/403 → exit 3 with scope guidance.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'note',
  summary: 'add a note to a contact',
  flags: [
    { name: '--text', type: 'string', desc: 'note body text' },
  ],
  readOnly: false,
};

export async function run(args, ctx) {
  const contactId = args._?.[0];
  if (!contactId) {
    throw new GhlError('usage: sizmo note <contactId> --text "..."', EXIT.USAGE, 'sizmo schema');
  }

  const text = args.text || null;
  if (!text || !text.trim()) {
    throw new GhlError('note requires --text "..."', EXIT.USAGE, 'sizmo note <contactId> --text "your note"');
  }

  const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
  const changes = [`Add note to contact ${contactId}: "${preview}"`];
  const rerunCommand = `sizmo note ${contactId} --text "${text.replace(/"/g, '\\"')}" --confirm`;

  const gate = requireConfirm({ command: 'note', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  // Execute
  const r = await ctx.http.post(`/contacts/${encodeURIComponent(contactId)}/notes`, { body: text });

  if (r.code === 401 || r.code === 403) {
    throw new GhlError(
      `HTTP ${r.code} — your PIT lacks contacts.write — add it in GoHighLevel → Private Integrations`,
      EXIT.AUTH,
      'GoHighLevel → Settings → Private Integrations → edit your PIT → add contacts.write scope'
    );
  }
  if (!r.ok) {
    throw new GhlError(`note write failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
  }

  // GHL wraps the created note under a "note" key — { note: { id, ... }, traceId } — not flat.
  // Verified live 2026-07-05: reading r.j?.id (flat) always returned null even though the note
  // itself wrote correctly; the write worked, only the id echoed back in --json was ever wrong.
  ctx.out.data({ status: 'ok', command: 'note', contactId, noteId: r.j?.note?.id ?? null });
  ctx.out.line(`  note added to contact ${contactId}`);
  return EXIT.OK;
}
