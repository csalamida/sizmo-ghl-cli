// commands/apply.mjs — create what an export file describes and this location is missing.
// Phase 3 of location-as-file: export → diff → apply. CONFIRM-GATED. ADDITIVE ONLY.
//
// WHAT IT WILL NEVER DO
// Delete, rename, or update anything. v1 creates what is missing and nothing else. An apply that
// could delete is a different tool with a different blast radius, and "I ran it against the wrong
// location" has to stay recoverable.
//
// IT CANNOT COPY A LOCATION, AND SAYS SO
// Of the six groups an export carries, three have a create path and three do not — not merely
// unimplemented in sizmo, but ABSENT FROM THE GOHIGHLEVEL API ENTIRELY. There is no create-pipeline
// operation, no location-tag write, and no user operation in the catalogue at all. So this can never
// be "clone a location", and the output says that in both the human card and the payload rather than
// quietly doing three sixths of the job. A silent skip here would be the exact dishonesty the rest of
// this codebase was spent removing.
//
// WHY IT DOES NOT USE diffDocs()
// commands/diff.mjs matches items with `keyOf = item.id ?? item.name`, i.e. BY ID. That is correct
// for diff, which compares one location against itself over time where ids are stable. It is wrong
// here: applying a file into a DIFFERENT location means every id differs, so every item would read
// as missing — including ones that already exist under the same name. Running apply twice would
// duplicate the lot. Idempotence is the whole point of an apply, so this matches on NAME.
//
// Name matching is case-insensitive and trimmed. Creating a duplicate is worse than skipping one:
// this tool cannot delete, so a duplicate it creates is a duplicate the user cleans up by hand.
import { readFileSync } from 'node:fs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { requireConfirm } from '../lib/confirm.mjs';
import { buildExportDoc, SPEC_VERSION } from './export.mjs';
import { registry } from '../lib/registry.mjs';

// The three groups that can actually be created, with the command that does it and what the export
// carries for each. `fidelity` is the honest note — an export does not capture everything a create
// accepts, so an applied resource is not always a faithful copy.
const CREATABLE = {
  customValues: {
    command: 'value',
    label: 'custom values',
    fidelity: 'name and value reproduced exactly',
    // The export carries { id, name, value } — everything `value create` needs.
    toArgs: (x) => ({ _: ['create'], name: x.name, value: x.value ?? '' }),
    describe: (x) => `${x.name} = ${String(x.value ?? '').slice(0, 40)}`,
  },
  customFields: {
    command: 'field',
    label: 'custom fields',
    fidelity: 'name and type reproduced; placeholder, position and picklist options are NOT in the export',
    toArgs: (x) => ({ _: ['create'], name: x.name, ...(x.dataType ? { type: x.dataType } : {}) }),
    describe: (x) => `${x.name} (${x.dataType ?? 'TEXT'})`,
  },
  calendars: {
    command: 'calendar',
    label: 'calendars',
    // Stated plainly because it is the weakest of the three: the export records only { id, name },
    // so an applied calendar is a namesake, not a copy.
    fidelity: 'NAME ONLY — the export does not carry type, slot duration or team members, so the '
            + 'created calendar uses defaults and is not a copy of the original',
    toArgs: (x) => ({ _: ['create'], name: x.name }),
    describe: (x) => x.name,
  },
};

// The three that cannot be created, each with the reason. These are not TODOs.
const NOT_CREATABLE = {
  pipelines: 'GoHighLevel exposes no create-pipeline operation — the API has read only. Build pipelines and stages in the UI.',
  tags: 'location-level tags are not writable through the API. They appear as contacts are tagged.',
  users: 'the API carries no user operations at all. Invite users in the UI.',
};

export const meta = {
  name: 'apply',
  summary: 'create what an export file describes and this location is missing — additive only, never deletes',
  flags: [
    { name: '--only', type: 'string', desc: 'restrict to these groups, comma-separated: customValues,customFields,calendars' },
  ],
  readOnly: false,
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

function loadDoc(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new GhlError(`cannot read ${path}`, EXIT.NOTFOUND, 'create one with: sizmo export --out location.json'); }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { throw new GhlError(`${path} is not valid JSON: ${e.message}`, EXIT.USAGE); }
  if (doc?.specVersion == null) {
    throw new GhlError(`${path} has no specVersion — it is not a sizmo export`, EXIT.USAGE,
      'create one with: sizmo export --out location.json');
  }
  if (doc.specVersion > SPEC_VERSION) {
    throw new GhlError(`${path} was written by a newer sizmo (specVersion ${doc.specVersion} > ${SPEC_VERSION})`,
      EXIT.USAGE, 'upgrade sizmo: npm i -g sizmo@latest');
  }
  return doc;
}

/**
 * classify(fileGroup, liveGroup) → { comparable, create[], present[], differs[] }
 *
 * A marker ({blocked}/{unavailable}) on EITHER side is not comparable, and nothing is created for
 * that group. Guessing a delta against an unreadable source is how an apply invents resources — the
 * export's marker design exists precisely so this cannot be mistaken for "empty".
 */
export function classify(fileGroup, liveGroup) {
  if (!Array.isArray(fileGroup)) {
    return { comparable: false, reason: `the FILE's copy is ${fileGroup?.blocked ? `blocked (${fileGroup.blocked})` : 'unavailable'} — nothing to apply from`, create: [], present: [], differs: [] };
  }
  if (!Array.isArray(liveGroup)) {
    return { comparable: false, reason: `this location's copy is ${liveGroup?.blocked ? `blocked (${liveGroup.blocked})` : 'unavailable'} — refusing to create blind`, create: [], present: [], differs: [] };
  }
  const live = new Map(liveGroup.filter(x => x?.name).map(x => [norm(x.name), x]));
  const create = [], present = [], differs = [];
  for (const x of fileGroup) {
    if (!x?.name) continue;                        // unnameable: cannot be created or matched
    const hit = live.get(norm(x.name));
    if (!hit) { create.push(x); continue; }
    // Compare everything except the id, which is necessarily different across locations.
    const { id: _a, ...fileRest } = x;
    const { id: _b, ...liveRest } = hit;
    if (JSON.stringify(fileRest) === JSON.stringify(liveRest)) present.push(x);
    else differs.push({ name: x.name, file: fileRest, live: liveRest });
  }
  return { comparable: true, create, present, differs };
}

export async function run(args, ctx) {
  const path = args._?.[0];
  if (!path) {
    throw new GhlError('usage: sizmo apply <export.json> [--only customValues,customFields] [--confirm]', EXIT.USAGE,
      'make a file first: sizmo export --out location.json');
  }
  const fileDoc = loadDoc(path);

  let only = null;
  if (args.only) {
    only = String(args.only).split(',').map(s => s.trim()).filter(Boolean);
    const unknown = only.filter(g => !CREATABLE[g]);
    if (unknown.length) {
      throw new GhlError(`--only names groups that cannot be created: ${unknown.join(', ')}`, EXIT.USAGE,
        `creatable groups are: ${Object.keys(CREATABLE).join(', ')}`);
    }
  }

  const { doc: liveDoc } = await buildExportDoc(ctx);

  // A file written from a DEGRADED export is missing resources it never saw. Applying it is still
  // valid — additive — but the user should know the file is a partial picture of its source.
  const fileWasPartial = !!fileDoc.degraded;

  const groups = {};
  const steps = [];
  for (const [name, spec] of Object.entries(CREATABLE)) {
    if (only && !only.includes(name)) { groups[name] = { skipped: 'not in --only' }; continue; }
    const c = classify(fileDoc[name], liveDoc[name]);
    groups[name] = c.comparable
      ? { comparable: true, willCreate: c.create.length, alreadyPresent: c.present.length, differs: c.differs.length,
          items: c.create.map(spec.describe), differingNames: c.differs.map(d => d.name) }
      : { comparable: false, reason: c.reason };
    for (const x of c.create) steps.push({ group: name, command: spec.command, parsed: spec.toArgs(x), describe: `${spec.label}: ${spec.describe(x)}` });
  }

  const notApplicable = {};
  for (const [name, reason] of Object.entries(NOT_CREATABLE)) {
    const fileGroup = fileDoc[name];
    const liveGroup = liveDoc[name];
    const missing = (Array.isArray(fileGroup) && Array.isArray(liveGroup))
      ? classify(fileGroup, liveGroup).create.length
      : null;
    notApplicable[name] = { missing, reason };
  }

  ctx.out.data({
    file: path, location: ctx.cfg.loc,
    fileWasPartial,
    plannedCreates: steps.length,
    groups, notApplicable,
    // Named so a caller cannot mistake a successful apply for a completed copy.
    isFullCopy: false,
  });

  const changes = [];
  for (const [name, spec] of Object.entries(CREATABLE)) {
    const g = groups[name];
    if (!g || g.skipped) continue;
    if (!g.comparable) { changes.push(`${spec.label}: SKIPPED — ${g.reason}`); continue; }
    if (g.willCreate) {
      changes.push(`Create ${g.willCreate} ${spec.label}`);
      for (const it of g.items.slice(0, 8)) changes.push(`  · ${it}`);
      if (g.items.length > 8) changes.push(`  · … +${g.items.length - 8} more`);
      changes.push(`  fidelity: ${spec.fidelity}`);
    }
    // A name that already exists but whose CONTENT differs is left alone — apply is additive and
    // never updates. Saying so matters: the user asked to apply a file, and this is the part of the
    // file that will still not match afterwards. Reporting it only in the JSON payload would leave a
    // terminal user believing the location now agrees with their file.
    if (g.differs) {
      changes.push(`${spec.label}: ${g.differs} already exist by name but DIFFER — left unchanged (apply never updates)`);
      for (const n of g.differingNames.slice(0, 8)) changes.push(`  · ${n}`);
      if (g.differingNames.length > 8) changes.push(`  · … +${g.differingNames.length - 8} more`);
    }
  }
  if (!steps.length) changes.push('Nothing to create — every creatable resource in the file already exists here by name.');

  // The refusal block goes INSIDE the confirm text, not after it. A limit shown only after the user
  // has approved is a limit they approved without reading.
  const naLines = [];
  for (const [name, { missing, reason }] of Object.entries(notApplicable)) {
    if (missing === null) naLines.push(`  ${name}: not comparable · ${reason}`);
    else if (missing > 0) naLines.push(`  ${name}: ${missing} in the file cannot be created · ${reason}`);
  }
  if (naLines.length) {
    changes.push('');
    changes.push('CANNOT BE CREATED — no API operation exists:');
    changes.push(...naLines);
    changes.push('');
    changes.push('⚠ after this runs the location will NOT be a full copy of the file');
  }
  if (fileWasPartial) {
    changes.push('⚠ this export was taken from a DEGRADED read — the file itself is an incomplete picture of its source');
  }

  const rerun = `sizmo apply ${path}${args.only ? ` --only ${args.only}` : ''} --confirm`;
  const gate = requireConfirm({ command: 'apply', changes, rerunCommand: rerun }, ctx);
  if (!gate.proceed) return gate.code;

  if (!steps.length) {
    ctx.out.line('  nothing to create — the location already has every creatable resource in the file');
    return EXIT.OK;
  }

  // Execute through each command's own run(), so validation, scope errors and result-unwrapping stay
  // in one place per resource type. ctx.confirmed is already true, so their gates pass — the batch
  // gate above is IN ADDITION to the per-command ones, never instead of them. Same shape as ask.
  const results = [];
  let failed = false;
  for (const step of steps) {
    if (failed) { results.push({ ...step, attempted: false, skipped: 'a previous step failed' }); continue; }
    let code, error = null;
    try {
      const mod = await registry[step.command]();
      code = await mod.run(step.parsed, ctx);
    } catch (e) {
      code = e?.code ?? EXIT.API;
      error = e?.message ?? String(e);
    }
    const ok = (code ?? EXIT.OK) === EXIT.OK;
    results.push({ group: step.group, describe: step.describe, attempted: true, ok, code, ...(error ? { error } : {}) });
    // Hard stop. Continuing past a failure means a half-applied location whose remaining errors are
    // probably the same one repeated, and the user cannot tell which of the two happened.
    if (!ok) failed = true;
  }

  const created = results.filter(r => r.ok).length;
  const notAttempted = results.filter(r => r.attempted === false).length;
  ctx.out.data({
    file: path, location: ctx.cfg.loc, applied: true,
    planned: steps.length, created, failed: results.filter(r => r.attempted && !r.ok).length, notAttempted,
    results, groups, notApplicable, isFullCopy: false,
  });
  ctx.out.line(`  created ${created}/${steps.length}${notAttempted ? ` · ${notAttempted} not attempted after a failure` : ''}`);
  if (naLines.length) ctx.out.line('  this location is NOT a full copy of the file — see notApplicable');
  return failed ? EXIT.API : EXIT.OK;
}
