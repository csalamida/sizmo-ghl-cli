# Using `sizmo ask` — the natural language interface

`sizmo ask` lets you type a plain-English request instead of remembering flag syntax. Reads run
immediately. Writes preview the exact change first, then fire on a bare `sizmo ask --confirm` —
same confirm-gate every other sizmo write command has, just reached through a sentence instead of
flags.

**This is optional.** If you already drive sizmo with an AI coding agent (Claude Code, Codex,
Cursor), you don't need this at all — point your agent at `SKILL.md` and it drives sizmo's flag
commands directly, at zero extra cost. `sizmo ask` is for when you want the CLI *itself* to
understand plain English, with no agent in the loop. See the main [README](../../README.md#driving-sizmo-with-an-ai-agent-recommended--no-ai-key-needed)
for that comparison.

## Setup

`ask` needs its own AI key — it's not free, and it's opt-in:

```sh
sizmo config set --profile <name> --ai-key "sk-ant-..." --ai-provider anthropic
# or
sizmo config set --profile <name> --ai-key "sk-..." --ai-provider openai
```

Providers: `anthropic` (default model: `claude-haiku-4-5-20251001`) · `openai` (`gpt-4o-mini`).
With no key set, `sizmo ask` still works for **bare command names** ("brief", "list forms") — those
skip the AI call entirely, zero cost, zero setup.

## The mental model — three things to remember

1. **Bare command names skip the AI.** `sizmo ask "brief"` runs `sizmo brief` directly, no LLM call.
2. **Reads run immediately.** `sizmo ask "who hasn't replied in 3 days"` resolves to `triage` and
   shows you real output, right away — no confirm step, reads never change anything.
3. **Writes preview once, then a bare `--confirm` replays the exact plan.** The AI is never asked
   twice. What you saw in the preview is exactly what fires — it can't resolve to something
   different between the preview and the confirm.

```sh
sizmo ask "tag Ana Cruz as follow-up"
# → resolves "Ana Cruz" to a real contact id, shows you the exact change, exits 5 (confirm required)

sizmo ask --confirm
# → fires that EXACT previewed plan — doesn't re-run the resolution, can't drift
```

## Walkthrough — from simple to real usage

**A read, no setup needed:**

```sh
sizmo ask "brief"
sizmo ask "who owes us money"
sizmo ask "show me stuck deals"
```

**A single write:**

```sh
sizmo ask "tag Marco as VIP"
#   Add tag to Marco Reyes: +VIP
#   run: sizmo ask --confirm

sizmo ask --confirm
#   tag added
```

**Multiple steps, one sentence, one confirm:**

```sh
sizmo ask "tag Ana as follow-up and book her Friday at 2pm"
```

This resolves to *two* steps — a tag add and an appointment booking — and shows both in the
preview. `"her"` in the second half refers back to Ana from the first half of the *same sentence*
(not a memory feature — this is same-batch pronoun resolution, see below). One `sizmo ask --confirm`
fires both, in order, and stops immediately if either one fails partway through.

**A pronoun follow-up across two separate calls:**

```sh
sizmo ask "tag Marco as follow-up"
sizmo ask --confirm
sizmo ask "book her for Thursday at 10am"     # "her" — wait, Marco is a "him"?
```

Pronoun resolution only works when it agrees with who was actually last resolved — `ask` doesn't
guess past gender mismatches, it uses whoever was actually resolved most recently. If you're
unsure who a pronoun will resolve to, just name them again — it costs nothing extra.

**Disambiguation — more than one match:**

```sh
sizmo ask "tag John as follow-up"
#   "John" matches 3 contacts — be more specific:
#   c_881  John Reyes
#   c_204  John dela Cruz
#   c_559  John Santos

sizmo ask "tag John Reyes as follow-up"
```

## What fires directly vs. what only prints (and why)

| Fires directly (confirm-gated, same as flags) | Prints the command only — you run it |
|---|---|
| `tag` — add/remove | `opp update <oppId> [--value --status]` |
| `note` — add a note to a contact | `appointment book` / `appointment cancel` |
| `send` — sms or email | `appointment note <apptId> --text "..."` |
| `contact` — create / upsert / delete | `send cancel <messageId> --channel sms\|email` |
| `opp` — create / move / **delete** | `link delete <linkId>` |
| `value` — create | `invoice draft` / `invoice send` |
| `field` — create / delete | |
| `calendar` — create / delete | |
| `business` — create / delete | |
| `link` — create | |

**The pattern in the right column, once you see it, explains all of it:**

- **Needs a bare id, not a name.** `value delete`, `send cancel`, `link delete`, `appointment note`
  all need an id (a value id, a message id, a link id, an appointment id) that was never given a
  human-readable name to resolve *from* — there's nothing for `ask` to search for. Run
  `sizmo list values` / check your terminal history for the id, then run the flag command directly.
- **Money and scheduling stay a deliberate manual step, on purpose.** `invoice draft`/`invoice send`
  and `appointment book`/`appointment cancel` will always resolve-and-print, never auto-fire — even
  though the ids ARE resolvable by name. This is intentional, not a gap: sizmo wants a human's
  actual keystroke on anything that moves money or touches a calendar slot a real person might show
  up to.
- `opp update` is the one exception without an id problem — it's grouped with the manual-step
  bucket above (status changes to `won`/`lost` are consequential enough to want a deliberate command).

## Troubleshooting

**"confidence < 0.7" / asked to rephrase.** The model wasn't sure what you meant. Be more specific
— name the exact contact, the exact pipeline, the exact stage name (must match what's shown in
`sizmo crm pipelines` or `sizmo list calendars` etc. — `ask` never invents a name it hasn't seen).

**A field/calendar/business/pipeline "doesn't exist" right after you created it.** Contact,
opportunity, field, calendar, and business name-resolution inside `ask` is always a live check
against the real account — never the locally-synced cache — so this shouldn't happen for those.
If it does, run `sizmo sync` and try again; the AI's own *context* (which names it's aware of to
suggest) still comes from the synced model, separate from the resolution step itself.

**No AI key configured.** `sizmo ask "<anything that isn't a bare command name>"` fails asking you
to run `sizmo config set --ai-key ...`. Bare command names still work with zero key.

**Nothing sent to the AI provider except structure.** Your typed request text and CRM *structure*
(pipeline/calendar/tag/form/survey/business names + ids) reach your chosen provider — never your
PIT, contacts, conversations, or money data. Pronoun follow-ups resolve from a local cache; the AI
only ever sees a placeholder token, never a real name. Full detail: [`SECURITY.md`](../../SECURITY.md).

## Writing prompts that resolve cleanly

- **Name things exactly as they appear in your CRM.** "the sales pipeline" is ambiguous if you have
  two pipelines with "sales" in the name — "Sales Pipeline" (matching the real name) resolves
  first try.
- **One sentence, multiple actions is fine** — `ask` splits on distinct actions automatically
  ("tag Ana as follow-up and book her Friday at 2pm" → two steps). You don't need to call `ask`
  twice.
- **Don't reference an id in a sentence** — `ask` resolves *names* to ids; if you already have the
  id, just run the flag command directly, it's faster and skips the AI call entirely.
- **Re-run `sizmo sync`** after adding pipelines/stages/calendars if `ask` doesn't seem to know
  about something you just added in the GoHighLevel UI — the AI's own awareness of what exists
  comes from the synced model (separate from the live-resolution step, which is always current).
