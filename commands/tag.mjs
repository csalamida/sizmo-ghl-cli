// commands/tag.mjs — add or remove a tag on a contact.
// Scope required: contacts.write
// NEVER fires without --confirm. No-confirm → exit 5 (CONFIRM) + envelope.
// 401/403 → exit 3 with scope guidance.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'tag',
  summary: 'add or remove a tag on a contact',
  flags: [
    { name: '--add',    type: 'string', desc: 'tag name to add' },
    { name: '--remove', type: 'string', desc: 'tag name to remove' },
  ],
  readOnly: false,
};

export async function run(args, ctx) {
  const contactId = args._?.[0];
  if (!contactId) {
    throw new GhlError('usage: sizmo tag <contactId> --add <tag> | --remove <tag>', EXIT.USAGE, 'sizmo schema');
  }

  const addTag    = args.add    || null;
  const removeTag = args.remove || null;

  if (!addTag && !removeTag) {
    throw new GhlError('tag requires --add <tag> or --remove <tag>', EXIT.USAGE, 'sizmo tag <contactId> --add <tag>');
  }
  if (addTag && removeTag) {
    throw new GhlError('tag: use either --add or --remove, not both', EXIT.USAGE, 'sizmo tag <contactId> --add <tag>');
  }

  const isAdd = !!addTag;
  const tagName = addTag || removeTag;
  const action = isAdd ? 'Add' : 'Remove';
  const preposition = isAdd ? 'to' : 'from';

  const changes = [`${action} tag '${tagName}' ${preposition} contact ${contactId}`];
  const confirmFlag = isAdd ? `--add "${tagName}"` : `--remove "${tagName}"`;
  const rerunCommand = `sizmo tag ${contactId} ${confirmFlag} --confirm`;

  const gate = requireConfirm({ command: 'tag', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  // Execute
  const path = `/contacts/${contactId}/tags`;
  let r;
  if (isAdd) {
    r = await ctx.http.post(path, { tags: [tagName] });
  } else {
    r = await ctx.http.delete(path, { tags: [tagName] });
  }

  if (r.code === 401 || r.code === 403) {
    throw new GhlError(
      `HTTP ${r.code} — your PIT lacks contacts.write — add it in GoHighLevel → Private Integrations`,
      EXIT.AUTH,
      'GoHighLevel → Settings → Private Integrations → edit your PIT → add contacts.write scope'
    );
  }
  if (!r.ok) {
    throw new GhlError(`tag write failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
  }

  ctx.out.data({ status: 'ok', command: 'tag', action: isAdd ? 'add' : 'remove', tag: tagName, contactId });
  ctx.out.line(`  tag '${tagName}' ${isAdd ? 'added to' : 'removed from'} contact ${contactId}`);
  return EXIT.OK;
}
