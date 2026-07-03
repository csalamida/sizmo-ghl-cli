// lib/registry.mjs — name → lazy loader. All commands run in-process (v0.6 importable-core).
export const registry = {
  // ── read-only commands ──────────────────────────────────────────────────────
  snapshot: () => import('../commands/snapshot.mjs'),
  triage: () => import('../commands/triage.mjs'),
  pipeline: () => import('../commands/pipeline.mjs'),
  noshow: () => import('../commands/noshow.mjs'),
  segment: () => import('../commands/segment.mjs'),
  receivables: () => import('../commands/receivables.mjs'),
  reconcile: () => import('../commands/reconcile.mjs'),
  'booked-not-paid': () => import('../commands/booked-not-paid.mjs'),
  brief: () => import('../commands/brief.mjs'),
  focus: () => import('../commands/focus.mjs'),
  doctor: () => import('../commands/doctor.mjs'),
  crm: () => import('../commands/crm.mjs'),
  sync: () => import('../commands/sync.mjs'),
  ack: () => import('../commands/ack.mjs'),
  export: () => import('../commands/export.mjs'),
  diff: () => import('../commands/diff.mjs'),
  // ── operational write commands (confirm-gated) ──────────────────────────────
  tag: () => import('../commands/tag.mjs'),
  note: () => import('../commands/note.mjs'),
  opp: () => import('../commands/opp.mjs'),
  appointment: () => import('../commands/appointment.mjs'),
  send: () => import('../commands/send.mjs'),
  // ── build/scaffold write commands (confirm-gated; what the PIT scope allows) ─
  contact: () => import('../commands/contact.mjs'),
  field: () => import('../commands/field.mjs'),
  value: () => import('../commands/value.mjs'),
  calendar: () => import('../commands/calendar.mjs'),
  // ── money (scope-gated; GHL exposes no card-charge endpoint — draft a doc, send a pay-link) ──
  invoice: () => import('../commands/invoice.mjs'),
  transactions: () => import('../commands/transactions.mjs'),
  // ── content & forms ─────────────────────────────────────────────────────────────────────────
  forms: () => import('../commands/forms.mjs'),
  surveys: () => import('../commands/surveys.mjs'),
  // ── B2B company management ───────────────────────────────────────────────────────────────────
  business: () => import('../commands/business.mjs'),
  // ── natural language interface (optional; requires AI key in profile) ──────────────────────
  ask: () => import('../commands/ask.mjs'),
  // ── id lookup — vibecoder-friendly "find the ID I need" ────────────────────────────────────
  list: () => import('../commands/list.mjs'),
};
