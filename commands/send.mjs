// commands/send.mjs — send an SMS or email to a contact.
// Scope required: conversations/message.write
// HIGHEST BLAST COMMAND — reaches a real lead. The confirm preview MUST show:
//   - exact recipient contact id
//   - channel (sms/email)
//   - full message body (never truncated in the confirmation stage)
// NEVER fires without --confirm. No-confirm → exit 5 (CONFIRM) + envelope.
// 401/403 → exit 3 with scope guidance.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'send',
  summary: 'send an SMS or email message to a contact',
  flags: [
    { name: '--channel', type: 'string', desc: 'sms or email' },
    { name: '--message', type: 'string', desc: 'message body' },
  ],
  readOnly: false,
};

const CHANNEL_TYPE = { sms: 'SMS', email: 'Email' };

export async function run(args, ctx) {
  const contactId = args._?.[0];
  if (!contactId) {
    throw new GhlError('usage: sizmo send <contactId> --channel sms|email --message "..."', EXIT.USAGE, 'sizmo schema');
  }

  const channel = args.channel?.toLowerCase() ?? null;
  const message = args.message ?? null;

  if (!channel) {
    throw new GhlError('send requires --channel sms|email', EXIT.USAGE);
  }
  if (!CHANNEL_TYPE[channel]) {
    throw new GhlError(`send: unknown channel '${channel}' — must be sms or email`, EXIT.USAGE);
  }
  if (!message || !message.trim()) {
    throw new GhlError('send requires --message "..."', EXIT.USAGE);
  }

  // HIGHEST BLAST — full body always shown, never truncated in confirm preview
  const changes = [
    `SEND ${channel.toUpperCase()} to contact ${contactId}`,
    `  recipient: ${contactId}`,
    `  channel:   ${channel.toUpperCase()}`,
    `  message:`,
    // Indent each line of the body so multi-line messages render cleanly
    ...message.split('\n').map(l => `    ${l}`),
  ];
  const rerunCommand = `sizmo send ${contactId} --channel ${channel} --message "${message.replace(/"/g, '\\"')}" --confirm`;

  const gate = requireConfirm({ command: 'send', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  // Execute
  const r = await ctx.http.post('/conversations/messages', {
    type: CHANNEL_TYPE[channel],
    contactId,
    message,
  });

  if (r.code === 401 || r.code === 403) {
    throw new GhlError(
      `HTTP ${r.code} — your PIT lacks conversations/message.write — add it in GoHighLevel → Private Integrations`,
      EXIT.AUTH,
      'GoHighLevel → Settings → Private Integrations → edit your PIT → add conversations/message.write scope'
    );
  }
  if (!r.ok) {
    throw new GhlError(`send failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
  }

  ctx.out.data({ status: 'ok', command: 'send', contactId, channel, messageId: r.j?.messageId ?? r.j?.id ?? null });
  ctx.out.line(`  ${channel.toUpperCase()} sent to contact ${contactId}`);
  return EXIT.OK;
}
