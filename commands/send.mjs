// commands/send.mjs — send an SMS or email to a contact, or cancel a scheduled one.
// Scope required: conversations/message.write
// HIGHEST BLAST COMMAND — reaches a real lead. The confirm preview MUST show:
//   - exact recipient contact id
//   - channel (sms/email)
//   - full message body (never truncated in the confirmation stage)
// NEVER fires without --confirm. No-confirm → exit 5 (CONFIRM) + envelope.
// 401/403 → exit 3 with scope guidance.
//
// `cancel` added 2026-07-08 — found via search_operations: GHL has separate cancel-scheduled
// endpoints for SMS/email (DELETE .../messages/{id}/schedule vs .../messages/email/{id}/schedule)
// but sizmo had no way to stop a scheduled send at all. 'cancel' is sniffed as the first
// positional arg rather than a real contactId — GHL contact/message ids are never the literal
// string "cancel".
import { requireConfirm } from '../lib/confirm.mjs';

// The email body is built by wrapping each line in <p>. The message was interpolated RAW, so any
// &, < or > the user wrote went into the HTML unescaped. An email client parses "<20% off" as an
// unknown tag and drops everything until the next ">", silently truncating the sentence a client
// receives — and a message assembled from untrusted input could inject markup outright.
// Verified: "Your discount is <20% off. Terms & conditions apply." rendered as "Your discount is".
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'send',
  summary: 'send an SMS or email message to a contact, or cancel a scheduled one',
  flags: [
    { name: '--channel', type: 'string', desc: 'sms or email' },
    { name: '--message', type: 'string', desc: 'message body' },
    { name: '--subject', type: 'string', desc: 'email subject (email only) — defaults to the first line of --message' },
    { name: '--schedule', type: 'string', desc: 'ISO 8601 datetime to send at instead of now, e.g. 2026-08-01T09:00:00Z' },
  ],
  readOnly: false,
};

const CHANNEL_TYPE = { sms: 'SMS', email: 'Email' };

export async function run(args, ctx) {
  if (args._?.[0] === 'cancel') return cancelScheduled(args, ctx);

  const contactId = args._?.[0];
  if (!contactId) {
    throw new GhlError('usage: sizmo send <contactId> --channel sms|email --message "..."\n       sizmo send cancel <messageId> --channel sms|email', EXIT.USAGE, 'sizmo schema');
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

  // Scheduling. sizmo already shipped `send cancel <messageId>`, whose entire purpose is
  // cancelling a SCHEDULED message — but nothing could create one. The CLI could cancel something
  // it was unable to send.
  //
  // The endpoint wants UTC epoch SECONDS (its own example is 1669287863). Date.parse gives
  // milliseconds, so this divides — passing ms would schedule roughly 50,000 years out and the
  // message would simply never arrive, with no error to explain why.
  let scheduledAt = null;
  if (args.schedule != null) {
    const ms = Date.parse(args.schedule);
    if (isNaN(ms)) {
      throw new GhlError(
        `send: invalid --schedule '${args.schedule}' — must be ISO 8601, e.g. 2026-08-01T09:00:00Z`,
        EXIT.USAGE);
    }
    const nowMs = typeof ctx.now === 'function' ? ctx.now() : (ctx.now ?? Date.now());
    if (ms <= nowMs) {
      throw new GhlError(
        `send: --schedule '${args.schedule}' is in the past — a past timestamp sends immediately, ` +
        `which is not what scheduling means`,
        EXIT.USAGE,
        'pass a future ISO 8601 datetime, or drop --schedule to send now');
    }
    scheduledAt = Math.floor(ms / 1000);
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
  if (scheduledAt) {
    // Stated loudly and FIRST-class in the preview: unlike every other write in this CLI, a
    // scheduled send fires later with nobody watching. The human approving it will not be present
    // when it goes out, so the time has to be unmissable rather than a trailing detail.
    changes.splice(1, 0,
      `  ⏱ SCHEDULED — does NOT send now. Fires at ${new Date(scheduledAt * 1000).toISOString()}`,
      `     Cancel before then with: sizmo send cancel <messageId> --channel ${channel}`);
  }
  const subjectPart  = args.subject ? ` --subject "${String(args.subject).replace(/"/g, '\\"')}"` : '';
  const schedulePart = args.schedule ? ` --schedule "${String(args.schedule).replace(/"/g, '\\"')}"` : '';
  const rerunCommand = `sizmo send ${contactId} --channel ${channel} --message "${message.replace(/"/g, '\\"')}"${subjectPart}${schedulePart} --confirm`;

  const gate = requireConfirm({ command: 'send', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  // Execute
  // GHL requires locationId in the body (verified live: without it, SMS 422s and email 422s
  // with a misleading "no message or attachments" error). Email additionally requires `html` —
  // `message` alone 422s with that same misleading error even though a message was sent; GHL
  // only reads `message` for SMS. Subject defaults from the message's first line since send.mjs
  // has no separate --subject flag (verified live: message+html+subject → 201 "Email queued").
  const body = { type: CHANNEL_TYPE[channel], contactId, locationId: ctx.cfg.loc, message };
  if (scheduledAt) body.scheduledTimestamp = scheduledAt;
  if (channel === 'email') {
    // `message` stays the plain-text alternative (unescaped, correct there). Only the HTML part
    // is escaped — escaping the plain-text copy would show literal &amp; to the recipient.
    body.html = message.split('\n').map(l => `<p>${escapeHtml(l)}</p>`).join('');
    // --subject when given; otherwise the first non-blank line, never empty (a leading blank line
    // in the message would otherwise produce an empty subject). GHL accepts `subject` directly —
    // auto-deriving was a workaround for a flag that simply did not exist.
    body.subject = (args.subject?.trim()
      || message.split('\n').find(l => l.trim())
      || 'Message').trim().slice(0, 78);
  }
  const r = await ctx.http.post('/conversations/messages', body);

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

async function cancelScheduled(args, ctx) {
  const messageId = args._?.[1];
  const channel = args.channel?.toLowerCase() ?? null;
  if (!messageId) throw new GhlError('usage: sizmo send cancel <messageId> --channel sms|email', EXIT.USAGE);
  if (!channel) throw new GhlError('send cancel requires --channel sms|email', EXIT.USAGE);
  if (!CHANNEL_TYPE[channel]) throw new GhlError(`send cancel: unknown channel '${channel}' — must be sms or email`, EXIT.USAGE);

  const changes = [`Cancel scheduled ${channel.toUpperCase()} message ${messageId}`];
  const rerunCommand = `sizmo send cancel ${messageId} --channel ${channel} --confirm`;

  const gate = requireConfirm({ command: 'send cancel', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  // GHL splits this into two endpoints by channel — verified via describe_operation, not
  // guessed: SMS/generic messages use /messages/{id}/schedule, email uses the separate
  // /messages/email/{id}/schedule path.
  const path = channel === 'email'
    ? `/conversations/messages/email/${encodeURIComponent(messageId)}/schedule`
    : `/conversations/messages/${encodeURIComponent(messageId)}/schedule`;
  const r = await ctx.http.delete(path);

  if (r.code === 401 || r.code === 403) {
    throw new GhlError(
      `HTTP ${r.code} — your PIT lacks conversations/message.write — add it in GoHighLevel → Private Integrations`,
      EXIT.AUTH,
      'GoHighLevel → Settings → Private Integrations → edit your PIT → add conversations/message.write scope'
    );
  }
  // GHL's two schedule-cancel endpoints disagree on status code for "doesn't exist" — verified
  // live 2026-07-08: email genuinely 404s, SMS/generic 400s with canonicalCode
  // CONVERSATIONS_MSG_NOT_FOUND instead. Treat both as NOTFOUND, not a generic API error.
  const notFound = r.code === 404 || (r.j?.canonicalCode === 'CONVERSATIONS_MSG_NOT_FOUND');
  if (notFound) throw new GhlError(`no scheduled ${channel} message with id ${messageId} — nothing cancelled`, EXIT.NOTFOUND);
  if (!r.ok) throw new GhlError(`send cancel failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'send cancel', messageId, channel });
  ctx.out.line(`  scheduled ${channel.toUpperCase()} message ${messageId} cancelled`);
  return EXIT.OK;
}
