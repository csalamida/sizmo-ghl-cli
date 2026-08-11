// test/client/render-formats.test.mjs
//
// `brief` shipped --format pretty|slack|md and it earned its keep: a report you can paste into Slack
// or an email is a report a non-terminal person can receive. Four more commands wanted it, and the
// obvious move — copy brief's renderSlack/renderMd into each — is the drift this codebase has spent
// its time removing. So the FORMAT lives in lib/render.mjs once and each command supplies a
// description of its report rather than a rendering of it.
//
// The property that matters most here is the one that is easy to lose: HONESTY MUST SURVIVE THE
// FORMAT. A report that says "this is a floor, a source was blocked" in the terminal and drops that
// line when pasted into Slack is worse than one that never said it — the reader cannot know the
// caveat existed.
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveFormat, renderShareable, FORMATS } from '../../lib/render.mjs';

function cap() {
  const lines = [];
  const warnings = [];
  return {
    lines, warnings,
    ctx: { out: { line: (s = '') => lines.push(s), warn: (s) => warnings.push(s) } },
    text: () => lines.join('\n'),
  };
}

const SPEC = {
  title: 'Receivables',
  meta: 'loc L-TEST · profile c2e4',
  stats: [['Outstanding', '₱57,500'], ['Invoices', '2']],
  table: { columns: ['Invoice', 'Client', 'Amount'], rows: [['#1043', 'Ana Cruz', '₱45,000']] },
  notes: ['A page failed mid-scan — this is a FLOOR, not a total.'],
  footer: 'Read-only.',
};

test('resolveFormat accepts the documented set and normalises markdown', () => {
  assert.equal(resolveFormat({}), 'pretty', 'no flag means pretty');
  assert.equal(resolveFormat({ format: '' }), 'pretty');
  assert.equal(resolveFormat({ format: 'MD' }), 'md', 'case must not matter');
  assert.equal(resolveFormat({ format: ' slack ' }), 'slack', 'stray whitespace must not matter');
  assert.equal(resolveFormat({ format: 'markdown' }), 'md', 'the long spelling is an alias');
  for (const f of FORMATS) assert.equal(resolveFormat({ format: f }), f);
});

test('an unknown --format WARNS rather than silently rendering pretty', () => {
  // brief fell through silently, so `--format markdwon` produced a terminal card and the user never
  // learned why their markdown was missing. A report is not worth failing over, but a silent
  // fallback on a flag someone explicitly set is how they conclude the feature is broken.
  const c = cap();
  assert.equal(resolveFormat({ format: 'markdwon' }, c.ctx), 'pretty');
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /unknown --format "markdwon"/);
  assert.match(c.warnings[0], /pretty, slack, md/, 'the warning must name the valid values');
});

test('markdown renders a real table', () => {
  const c = cap();
  renderShareable(c.ctx, 'md', SPEC);
  const t = c.text();
  assert.match(t, /^## Receivables$/m);
  assert.match(t, /^\| Invoice \| Client \| Amount \|$/m);
  assert.match(t, /^\|---\|---\|---\|$/m, 'a markdown table needs its separator row or it is not a table');
  assert.match(t, /^\| #1043 \| Ana Cruz \| ₱45,000 \|$/m);
  assert.match(t, /\*\*Outstanding:\*\* ₱57,500/);
});

test('slack uses a code block so columns survive the paste', () => {
  // Slack has no table syntax that survives a paste. A fixed-width block is the only rendering that
  // keeps columns aligned in the client.
  const c = cap();
  renderShareable(c.ctx, 'slack', SPEC);
  const t = c.text();
  assert.match(t, /^\*Receivables\*$/m, 'slack bold is single asterisks, not markdown double');
  assert.equal((t.match(/```/g) || []).length, 2, 'the table must be fenced, opened and closed');
  assert.match(t, /• Outstanding: \*₱57,500\*/);
  assert.ok(!/\|---\|/.test(t), 'markdown separator rows must not leak into slack');
});

test('slack columns are padded to a consistent width', () => {
  const c = cap();
  renderShareable(c.ctx, 'slack', {
    ...SPEC,
    table: { columns: ['A', 'B'], rows: [['short', 'x'], ['a-much-longer-value', 'y']] },
  });
  const block = c.text().split('```')[1].trim().split('\n');
  const widths = new Set(block.map(l => l.length));
  assert.equal(widths.size, 1, `rows are not padded to one width: ${[...widths].join(', ')}`);
});

test('NOTES survive every format — the honesty carry-over', () => {
  // The whole point. A floor caveat that appears in the terminal and vanishes in Slack leaves the
  // reader with a number they think is a total.
  for (const fmt of ['md', 'slack']) {
    const c = cap();
    renderShareable(c.ctx, fmt, SPEC);
    assert.match(c.text(), /FLOOR, not a total/,
      `the '${fmt}' rendering dropped a caveat that the pretty card shows`);
  }
});

test('a pipe in a cell cannot break the markdown table', () => {
  // A contact called "A|B" would otherwise end the column early and shift every later value under
  // the wrong header — silently, since the table still renders.
  const c = cap();
  renderShareable(c.ctx, 'md', {
    ...SPEC,
    table: { columns: ['Client', 'Amount'], rows: [['A|B Corp', '₱1']] },
  });
  const row = c.text().split('\n').find(l => l.includes('A'));
  assert.match(c.text(), /A\\\|B Corp/, 'a literal pipe must be escaped');
  assert.equal((row.match(/(?<!\\)\|/g) || []).length, 3, 'the row must still have exactly 2 columns');
});

test('a newline in a cell cannot forge extra rows', () => {
  // Same class as the confirm-preview forging fixed earlier: server-controlled text must not be able
  // to invent structure in a rendering.
  for (const fmt of ['md', 'slack']) {
    const c = cap();
    renderShareable(c.ctx, fmt, {
      ...SPEC,
      table: { columns: ['Client', 'Amount'], rows: [['Ana\n| FAKE | ROW |', '₱1']] },
    });
    assert.ok(!/FAKE \| ROW/.test(c.text().split('\n').filter(l => !l.includes('Ana')).join('\n')),
      `${fmt}: a newline in a cell created a row of its own`);
  }
});

test('optional sections are omitted, not rendered empty', () => {
  const c = cap();
  renderShareable(c.ctx, 'md', { title: 'Bare' });
  const t = c.text();
  assert.match(t, /## Bare/);
  assert.ok(!/\|---\|/.test(t), 'no table was supplied, so no table separator should appear');
  assert.ok(!/^> ⚠/m.test(t), 'no notes were supplied, so no warning block should appear');
});

test('a report without a title is refused', () => {
  // A shareable report with no heading is unusable once pasted — there is nothing saying what it is.
  const c = cap();
  assert.throws(() => renderShareable(c.ctx, 'md', { stats: [['a', 'b']] }), /must have a title/);
});

test('an empty table is skipped rather than rendering headers over nothing', () => {
  const c = cap();
  renderShareable(c.ctx, 'md', { title: 'T', table: { columns: ['A', 'B'], rows: [] } });
  assert.ok(!/\| A \| B \|/.test(c.text()), 'headers with no rows read as a broken table');
});

// ── the four commands actually route through it ─────────────────────────────
// A shared renderer nobody calls is worse than no renderer: it reads as coverage. These assert the
// wiring, and that --format never leaks into the machine envelope.

const FIXTURES = {
  receivables: (p) => p.includes('/invoices')
    ? { code: 200, ok: true, txt: '{}', j: { invoices: [{
        _id: 'i1', invoiceNumber: '1', contactDetails: { name: 'A' }, total: 100, amountPaid: 0,
        currency: 'PHP', status: 'sent', dueDate: new Date(Date.parse('2026-08-10T12:00:00Z')).toISOString() }] } }
    : { code: 200, ok: true, txt: '{}', j: {} },
  reconcile: () => ({ code: 200, ok: true, txt: '{}', j: { data: [] } }),
  pipeline:  () => ({ code: 200, ok: true, txt: '{}', j: { opportunities: [], pipelines: [] } }),
  focus:     () => ({ code: 200, ok: true, txt: '{}', j: {} }),
};

for (const [name, fixture] of Object.entries(FIXTURES)) {
  test(`${name} renders markdown through the shared renderer`, async () => {
    const { makeFakeCtx } = await import('../_helpers.mjs');
    const { run } = await import(`../../commands/${name}.mjs`);
    const h = makeFakeCtx({ json: false, now: Date.parse('2026-08-11T12:00:00Z') });
    h.ctx.ensureModel = async () => ({ entities: {} });
    h.ctx.http.get = async (p) => fixture(p);
    await run({ format: 'md' }, h.ctx);
    h.ctx.out.flush();
    assert.match(h.getPrinted(), /^## /m,
      `${name} --format md produced no markdown heading — it is not routed through renderShareable`);
  });

  test(`${name}: --format never leaks into --json`, async () => {
    // The flag is a HUMAN render choice. If it reached the envelope it would break every consumer
    // that pinned the JSON shape.
    const { makeFakeCtx } = await import('../_helpers.mjs');
    const { run } = await import(`../../commands/${name}.mjs`);
    const h = makeFakeCtx({ json: true, now: Date.parse('2026-08-11T12:00:00Z') });
    h.ctx.ensureModel = async () => ({ entities: {} });
    h.ctx.http.get = async (p) => fixture(p);
    await run({ format: 'md' }, h.ctx);
    h.ctx.out.flush();
    const env = JSON.parse(h.getPrinted());
    assert.equal(env.schemaVersion, 1, `${name} --json emitted something other than the envelope`);
    assert.ok(!/^## /m.test(h.getPrinted()), 'markdown leaked into the machine payload');
  });
}
