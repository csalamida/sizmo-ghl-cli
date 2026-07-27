# Changelog

All notable changes to `sizmo` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Not every heading below is installable.** Some versions were tagged and changelogged during
> development but rolled into the next release instead of being published, so `npm install
> sizmo@<that-version>` will fail. Those headings are marked **(not published — shipped in X)**
> inline, and their changes are real: they reached users inside the release named there. Verify
> what actually exists with `npm view sizmo versions`.

## [Unreleased]

### Fixed — `sizmo brief` exited 0 during a total API outage

Every lane failing with a 500 still reported success, so `sizmo brief && deploy` proceeded while
GoHighLevel was down. This had been recorded in the source as a known limitation needing "a real
refactor" — the sub-collects marking their own lane blocked instead of swallowing the failure into
a well-formed zero. They already did, and had for a while; `brief` simply wasn't reading it.

Exit codes by failure mode now:

| Situation | Exit |
|---|---|
| denied on every lane (401/403) | `3` AUTH |
| every lane down (500/429) | `1` API |
| mixed denial + outage | `3` AUTH — the actionable diagnosis |
| one lane down, others readable | `0` — the report still produced real data |
| everything readable, account empty | `0` — empty is an answer |

### Fixed — a report that was DENIED its data no longer exits 0

Seven reports produced a scrupulously honest envelope and then contradicted it with the exit code:

```
$ sizmo receivables --json
{"blocked": 401, "totalOwed": null, "outstanding": null}   # UNKNOWN, never zero — correct
$ echo $?
0                                                          # "all fine" — wrong
```

So `sizmo receivables && ship-it` proceeded, and an agent checking `$?` read "nothing owed" as fact
when the truth was "your token is not allowed to look at invoices." `brief` was fixed for this
earlier; `receivables`, `booked-not-paid`, `reconcile`, `noshow`, `triage`, `pipeline` and
`segment` had the identical shape and were missed. They now exit `AUTH` (3) when denied.

A **non-auth** failure (500, 429) now exits `API` (1) rather than 0 — an outage is not success. It
is deliberately *not* `AUTH`, because a server outage must never tell you your token is wrong. A
readable-but-empty account still exits 0: empty is a real answer, not a failure.

### Fixed — `sizmo crm` could not tell a missing scope from a broken API

It returned `1` for both, so "your PIT lacks `locations/tags.readonly`" was indistinguishable from
"the API is down." Retrying on `1` is reasonable agent behaviour; retrying a missing scope forever
is not. `crm` now throws — `AUTH` on a scope denial, `API` when a real HTTP status is present —
matching `list` and `surveys`, which already drew this line. That also fixes its `--json` output,
which was previously success-shaped on stdout.

### Fixed — `sizmo open` emitted a wrong URL instead of refusing a typo

`open` takes an id and infers the kind from `--opp`, but the rest of the CLI reads
`sizmo <command> <kind> <id>`, so `sizmo open contact cid-1` is a very plausible mistyping. It took
`contact` as the id, silently ignored `cid-1`, and emitted a well-formed URL to a record that does
not exist — exit 0, no warning:

```
https://app.gohighlevel.com/v2/location/<loc>/contacts/detail/contact
```

You click a link that looks right and land on a 404 inside GoHighLevel. Now exits `USAGE`, and the
fix line names the id you actually meant.

### Fixed — `CONTRIBUTING.md` claimed sizmo never issues an invoice

It does: `invoice draft` creates one and `invoice send` delivers it to a customer. `SECURITY.md`
already said so correctly, so the contribution guide contradicted both the code and another doc —
the most dangerous shape of drift, since that file is what a reviewer reads to learn the project's
boundaries. The no-card-charging half of the claim is true and stays. Two smaller fixes in the same
file: it told contributors to run a bare `node --test` when `package.json` pins
`--test-concurrency=1`, and claimed the README command table "is generated from `sizmo schema`"
when no generator exists.

### Added — API-STABILITY §2b is now enforced

The four router-verb shapes (`auth check`, `config list`, `init`, `open`) were verified live and
are all correct — `init` masks the PIT and writes `profiles.json` at `0600`, confirming §5 too.
Nothing was wrong; nothing enforced it either. The guard derives the expected keys from the doc
table, so the doc stays the source of truth in both directions. §2b's prose also said "auth,
config, and init" while its own table has four rows.

### Fixed — `invoice draft` invented a business name when it could not read one

The location read was unchecked. A `401`, `404` or `500` fell through to the string literal
`'Business'`, and the invoice was then **created and sent anyway** — exit 0, no warning. A paying
customer received a money document naming the vendor "Business". Verified by fixture: all three
statuses produced `businessDetails={"name":"Business"}`.

sizmo already refuses to fabricate *numbers* on a blocked source (a blocked lane reports UNKNOWN,
never zero). This is the same rule applied to a string, with a more visible consequence — the
customer reads it. `invoice draft` now refuses: `AUTH` on 401/403 naming `locations.readonly`,
`API` otherwise, and `API` when the location has no business name set at all. A wrong invoice is
worse than no invoice.

### Fixed — `invoice draft` blamed the wrong scope on a contact-read failure

`GET /contacts/{id}` needs `contacts.readonly`. On 401 it reported *"your PIT lacks
invoices.write"*, sending the user to add a scope they already had while the one actually missing
stayed missing. `invoice draft` touches three scopes; each now names its own.

### Fixed — `sizmo tag` did not URL-encode the contact id

The only command interpolating a user-supplied id into a path segment without
`encodeURIComponent`. `sizmo tag "a/b" --add x` built `POST /contacts/a/b/tags` — a different
endpoint than the confirm preview named, so what the user approved and what was sent did not match.

### Added — request-body assertions for the three write commands that had none

`invoice`, `tag` and `note` tested exit codes and that a call fired, never the payload. A renamed
or dropped field reached the real API silently while the suite stayed green. Now pinned:
`altId`/`altType` rather than `locationId`, item `name`/`amount`/`qty`/`currency` survival,
`contactDetails.phoneNo` (GHL ignores `phone`), absent contact fields omitted rather than null,
`tags: [name]` as an array, and `note`'s 80-char preview elision never leaking into the payload.

## [Unreleased]

### Added — `sizmo business update`

`business` could create and delete but never **edit**. A typo'd company name could only be fixed by
deleting and recreating — which drops the contact associations that make a business record useful
in the first place. `PUT /businesses/{id}` has always existed; sizmo never exposed it.

Follows the same shape as every other update verb: fetch first, so the preview names the real
record and a wrong id `404`s before anything is written, then send only the flags you passed.

```sh
sizmo business update <id> --city "Cebu" --confirm    # only city changes; nothing else is touched
```

### Added — the six `business` fields the API always accepted

`create-business` and `update-business` both accept ten fields. sizmo exposed four. Now also:
`--address`, `--city`, `--state`, `--postal-code`, `--country`, `--description`.

These were never a decision — nothing documented the omission, and `contact` already exposed
exactly this address set, so "address data is in scope" was settled precedent elsewhere in the
codebase.

### Fixed — `business` and `list` printed a success-shaped envelope on usage errors

Four paths did `ctx.out.line(...); return EXIT.USAGE`. A returned code skips the CLI's error
handler, so `--json` printed `{data: null, degraded: false, warnings: []}` on **stdout** while
exiting 2 — an agent parsing stdout saw a clean no-op with no error.

`business` had this exact class fixed for its auth/API paths earlier. It survived because the guard
only matched `return EXIT.(AUTH|API)`. The guard now covers `USAGE` too, and immediately caught a
third occurrence in `business delete` that the manual pass had missed.

## [2.4.10] — 2026-07-27

### Added — seven commands now carry the JSON stability promise

`API-STABILITY.md` §2a froze the `--json` envelope for 13 commands. Twenty emit it. `ack`, `diff`,
`export`, `forms`, `list`, `surveys` and `transactions` have shipped the byte-identical envelope
since they landed while carrying **no** stability promise — verified live:

```
sizmo ack --list --json
→ {"schemaVersion":1,"command":"ack","location":"…","data":{…},"degraded":false,"warnings":[]}
```

Consumers depend on that shape regardless; without the promise a patch release was free to break
them. The promise now matches reality. Nothing about the output changed — only what is guaranteed.

### Fixed — README understated which commands are confirm-gated

The **"Writes require explicit `--confirm`"** bullet — the safety claim an operator reads before
granting this tool write access — named five commands. Twelve are gated. `business`, `calendar`,
`contact`, `field`, `invoice`, `link` and `value` appeared to fire without confirmation.

The gate itself was always correct and `security-claims.test.mjs` already asserted every write
routes through `requireConfirm()`. That is source-vs-source; nothing checked the promise a human
reads. It does now.

### Fixed — `INSTALL.md` told new users `sizmo --version` prints `0.4.0`

Two majors stale. A first-time installer sees a different number at step one and concludes the
install failed. The number is gone rather than updated — a hand-typed version is correct only on
release day.

### Added — a guard for the exit-code table

The table is hand-typed in three documents plus `lib/errors.mjs`. Adding a code to `EXIT` would
have rotted all three with nothing failing. Now checked for numbers **and** wording, so two docs
cannot describe code `4` differently while both matching `EXIT`.

### Fixed — a malformed numeric flag silently blanked the stored value

`Number('abc')` is `NaN`, and `JSON.stringify({ x: NaN })` is `{"x":null}`. On an update verb that
`null` **overwrote real data with a blank**:

```
sizmo opp update <id> --value abc --confirm     →  PUT {"monetaryValue":null}
```

The confirm preview made this worse rather than catching it: it echoed `value: abc` back as though
the input had been understood, so the user approved a destructive write presented as a normal edit.

This is the coercion sibling of the existing rule *"unset flags must be OMITTED, never sent as
null."* That rule covered flags the user never passed; this is the same blanking outcome reached
through a flag the user **did** pass, badly. `invoice.mjs` had guarded `--item` amounts this way
since 2.4.x — the rule existed, it just was not applied anywhere else. Now shared in
`lib/numeric.mjs`.

Flags fixed, all validated before the confirm preview so bad input never reaches an approvable
screen:

| Command | Flag | Rule |
|---|---|---|
| `opp create` / `opp update` | `--value` | number ≥ 0 |
| `calendar create` | `--slot-min` | whole number ≥ 1 |
| `field create` / `field update` | `--position` | whole number ≥ 0 |
| `field create` / `field update` | `--max-files` | whole number ≥ 1 |

`--value 0` and `--position 0` stay legal — a deal can be worth nothing and `position` is a
zero-based index. This deliberately diverges from `invoice --item`, which requires amount > 0
because a zero-amount line item is meaningless.

`field`'s two flags were not found by hand: the manual search that found `opp --value` filtered on
money words, and neither `position` nor `max-files` matches. A source-level guard in the new test
file found them, and now blocks the next command written in the old inline style.

### Fixed — `field update` validated numeric flags after its fetch

`field update <id> --position 2.5` fired a pointless API round-trip and then exited **3 (AUTH)**
instead of **2 (USAGE)** when the token was also bad — blaming the token for a purely local typo.
A local input error must never depend on, or be masked by, a network result.

### Fixed — `opp update` did not map 404

It was the only update verb in the CLI that didn't. `contact`, `field`, `value` and `appointment`
all mapped it, on both their GET and their PUT. A typo'd id exited **1 (API — "the server broke,
retry")** instead of **4 (NOTFOUND — "your id is wrong, do not retry")**. sizmo's primary consumer
is an agent branching on exit codes, and retry-on-1 is a reasonable agent policy; retrying a
permanently-bad id forever is not.

### Fixed — README was excluded from the doc-drift guard

`test/docs/agent-docs-drift.test.mjs` validated `SKILL.md` and `AGENTS.md` but not `README.md` —
which is how README kept claiming "no separate `--subject` flag" for a full iteration after
`--subject` shipped, surviving a green 793-test run. README is the file most humans read first and
the one npm renders on the package page.

README now gets the same mechanical checks: every command documented, every flag in a fenced
example valid *for that command*, every flag in the command table valid for its row, all three doc
surfaces agreeing on which commands exist, plus a pin against the specific `--subject` wording.
`sizmo ack` was missing from README entirely and is now documented.

Deliberately **not** added: a generic "prose contradicts source" detector. It was built, run, and
rejected — it flagged four claims, all false positives ("delete takes one id, there is no `--all`"
is scoped to delete, where it is true; "with no `--ai-key` set" means unset, not nonexistent).
Prose carries scope and mood a regex cannot read.

### Added — `sizmo send --schedule`

sizmo already shipped `send cancel <messageId>`, whose entire purpose is cancelling a **scheduled**
message — while nothing could create one. The CLI could cancel something it was unable to send.

`--schedule <ISO 8601>` queues the message instead of sending now. It must be in the future; a past
timestamp is refused rather than silently sending immediately, which is the opposite of what the
user asked for. The endpoint wants UTC epoch **seconds** (its own example is `1669287863`), so the
parsed milliseconds are divided — passing milliseconds would schedule roughly 50,000 years out and
the message would simply never arrive, with no error to explain why.

Because a scheduled send fires later with nobody watching — unlike every other write in this CLI —
the confirm preview states it does **not** send now, names the exact fire time, and prints the
`send cancel` command needed to call it back.

### Docs — coverage sweep complete: 0 unreviewed, and a new honest category

Every operation in the inventory is now decided. The last seven:

**Tasks (5 ops) — deliberately absent, and it is a design choice rather than a backlog item.** sizmo
*derives* what needs doing from money signals — `focus` ranks by value at stake, `brief` surfaces
what is waiting, `ack` suppresses what you have handled. A GHL task CRUD surface would create a
**second** notion of "what to do today" that sizmo would then have to reconcile with `focus`. Two
answers to one question is worse than one answer.

**`update-estimate` — deliberately absent.** sizmo has no estimates surface at all: no create, no
list. Updating something you can neither create nor read is meaningless. Revisit only if estimates
are ever built.

**`record-invoice` — BLOCKED, not declined.** This needed a category the report did not have.
sizmo can draft and send an invoice but cannot record that it was paid *outside* the system, so
`receivables` **overstates what is owed** for every client who pays by bank transfer, GCash or cash
— which is most of them in this market. The capability is wanted. The blocker is that
`describe_operation` marks `card`, `cheque` **and** `notes` all `required: true` simultaneously (you
would never send both a card and a cheque object), and the `mode` vocabulary is undocumented beyond
the example `"card"`. Resolving that means live-firing a money-recording write against a real
invoice. **Shipping a guessed payload on a money command is worse than shipping nothing.**

So `docs/api-coverage.md` now has three categories, not two. **Blocked on verification** means in
scope, genuinely wanted, and not shipped because doing it correctly needs verification that is not
safe to perform. Calling it "deliberate" would imply we do not want it; leaving it "unreviewed"
would imply nobody looked. Both would be lies. The entry records exactly how to unblock it.

### Added — `sizmo appointment update` (reschedule, and record an outcome)

sizmo could **book** and **cancel** but not **move** a booking — the single most common calendar
action a coach takes was a trip into the GoHighLevel UI.

It also could not record an outcome. `sizmo noshow` *reports* no-shows by reading
`appointmentStatus`, while nothing could set it: you could see who no-showed and had no way to
record that you had seen it. `--status confirmed|showed|noshow|cancelled|invalid` closes that
(`no-show` and `no_show` are accepted too, since sizmo's own reader already handles all three
spellings in real GHL data).

Rescheduling **notifies the contact** — the preview says so, and `--no-notify` suppresses it. Moving
`--start` without `--end` is called out explicitly, because the resulting duration is decided by
GHL rather than preserved.

**Honest limit, recorded in the code:** which no-show spelling GHL accepts on *write* is unverified.
Its read-side data carries all three, and confirming would mean mutating a real booking. If a
no-show write is ever rejected, that normalisation is the first thing to check.

### Docs — 7 coverage decisions recorded, 16 unreviewed → 7

Most were not new decisions. `commands/appointment.mjs` already recorded, back in 2.4.8, that "GHL
supports list/update/delete for both contact AND appointment notes, sizmo deliberately ships neither
surface beyond create. Consistency over completeness." That decision lived only in a code comment,
so the coverage report kept asking a question that had already been answered. Now recorded where the
report can see it, covering all six note operations. `delete-event` is redundant for appointments
(`appointment cancel` uses the appointment-specific route) and otherwise covers block slots, already
a deliberate omission.

### Added — `sizmo opp update --name` and `--assigned-user`

`PUT /opportunities/{id}` accepts `name` and `assignedTo`, but `opp update` sent only
`monetaryValue` and `status`. A deal could be assigned at creation and then **never reassigned**, and
never renamed — handing a deal to someone else meant dropping into the GoHighLevel UI.

### Docs — `update-opportunity-status` is redundant, not missing

Recorded as a deliberate omission rather than left unreviewed. `PUT /opportunities/{id}` accepts
`status` directly, and `opp update --status` already uses it; the dedicated `/status` route is a
convenience alias for the same capability. Implementing it would add a second way to do one thing.

### Added — `sizmo contact update`

`contact` had create, upsert and delete but no way to edit a contact you already hold the id for.
`upsert` is **not** the same verb — it *matches* on email/phone and rewrites whatever it finds.
Every sizmo read hands you contact ids (`segment`, `focus`, `brief`, `triage`), and acting on one
meant knowing that contact's email and routing through upsert instead.

**`--tag` is refused here.** The endpoint's own schema warns that `tags` "overwrites all tags" —
precisely the bug sizmo shipped in upsert and fixed in 2.4.7, where a contact with two existing tags
was left holding only the new one. `sizmo tag` uses the dedicated add/remove endpoints and cannot
erase history, so `contact update` points there rather than re-implementing a merge that could get
it wrong again. A test asserts no `tags` key is ever sent, even when the contact has tags.

`--company` is likewise refused: the update endpoint accepts no `companyName`, though create does.
`--no-dnd` is new and update-only — clearing do-not-disturb is meaningless on a contact that does
not exist yet.

### Added — `sizmo field update`

Same gap `value` had, with worse consequences. `field` shipped create + delete only, so renaming a
field or fixing its placeholder meant delete-then-create — which mints a new field id **and discards
every value already stored in that field on every contact**. The custom-value case lost references;
this one loses data.

`PUT /locations/{id}/customFields/{id}` exists under the same scope. `field update` reads the field
first (its `name` is the endpoint's only required body field, so changing just the placeholder would
otherwise blank it), and supports `--name`, `--placeholder`, `--position`, `--model`, plus the
`FILE_UPLOAD` and `TEXTBOX_LIST` options.

**`--type` is refused, not ignored.** The update endpoint accepts no `dataType` — a field's type
cannot change once values are stored against it. Silently dropping the flag would let someone
believe the type had changed.

### Added — `sizmo value update`

sizmo shipped `value create` and `value delete` only, and the docs stated "create + delete only, no
update" as though it were an API limitation. It was not: `PUT /locations/{id}/customValues/{id}`
exists and requires the same `locations/customValues.write` scope `create` already uses.

This matters more than a missing subcommand. A custom value *is* the thing that changes — a booking
link, a support number, an address — referenced across workflows, funnels and email templates. The
only way to edit one was delete-then-create, which mints a **new id**, breaks anything referencing
the old one, and leaves a window where the value does not exist at all. A destructive workaround for
what should be an edit.

`value update` reads the current value first, so `--value` alone cannot blank the name (the endpoint
requires both fields), the preview shows **before → after** rather than just the new state, and a
no-op edit is called out instead of silently applied.

### Changed — `sizmo field create` refuses types it cannot make work

`--type` advertised 12 data types, but `SINGLE_OPTIONS`, `MULTIPLE_OPTIONS`, `RADIO` and `CHECKBOX`
all need a list of choices, and `POST /locations/{id}/customFields` documents no field to carry one.
Creating them anyway produced a field with **no choices** — visible in GoHighLevel, impossible to
fill in, repairable only by hand in the UI. sizmo now refuses those four with a message pointing at
the UI, rather than shipping a broken field silently. Same shape as the `calendar create --type
round_robin` gap fixed in 2.4.9: a type the CLI let you pick but could not actually make work.

`TEXTBOX_LIST` **is** supported — that endpoint documents `textBoxListOptions` — and now requires
`--textbox-option "A,B,C"`, refusing early rather than creating an empty list.

### Added — `sizmo field create` exposes the rest of the endpoint

The endpoint accepts 9 body fields; sizmo sent 3. Added `--placeholder`, `--position`, and for
`FILE_UPLOAD`: `--accept ".pdf,.docx"`, `--multiple-files`, `--max-files N`. A plain `TEXT` field
still sends exactly the original three keys, so existing scripted calls are unchanged.

### Fixed — read commands emitted a success-shaped envelope on a 401

`forms`, `surveys`, `transactions` and `list` printed a line and *returned* the exit code, which
never reaches the CLI's error handler — so `--json` produced
`{ data: null, degraded: false, warnings: [] }` on a hard 401. No `error`, no `remediation`. An
agent parsing that saw an empty-but-successful result; only the exit code disagreed. They now throw
`GhlError` like every write command, giving `{ error, code, remediation }` naming the exact scope.

`list` got the most leverage: its shared `blockedExit()` helper covers all 12 entities, so one
change fixed every one of them.

Two commands deliberately keep the return style and are documented as such in
`test/docs/error-envelope.test.mjs`: **`doctor`**, whose single return is a summary verdict printed
*after* the diagnostic report — throwing would suppress the report the user ran the command to
read, and a blocked scope is doctor's output rather than its failure — and **`ask`**, an
orchestrator whose error paths run through the pending-plan/confirm mechanism.

### Fixed — `sizmo send --channel email` did not escape the message body

The email body wraps each line in `<p>` and interpolated the message **raw**, so any `&`, `<` or `>`
the user wrote went into the HTML unescaped. An email client parses `<20% off` as an unknown tag and
drops everything to the next `>`, so the sentence a client receives is silently truncated:

    "Your discount is <20% off. Terms & conditions apply."
    → recipient sees: "Your discount is"

A message assembled from untrusted input could also inject markup outright. The `html` part is now
escaped; the plain-text `message` part is deliberately left alone, since escaping it would show a
literal `&amp;` to recipients whose client renders text.

### Added — `sizmo send --subject`

GHL accepts `subject` directly on the message endpoint. sizmo auto-derived it from the first line of
`--message` purely because no flag existed. `--subject` now sets it, falling back to the old
behaviour (first non-blank line) when omitted or blank, and round-trips into the rerun command.

### Fixed — `sizmo business` emitted a SUCCESS-shaped JSON envelope on a 401

`business create --confirm --json` against a hard 401 emitted
`{ data: null, degraded: false, warnings: [] }` — no `error`, no `remediation`. An agent parsing
that saw a clean no-op; only the exit code disagreed. `contact` on the identical failure emits
`{ error, code: 3, remediation }`.

The difference is mechanical: the error envelope comes from the CLI's top-level handler, reached
only when a command **throws** `GhlError`. `business` printed a line and *returned* the exit code,
so it never got there. All 10 error sites now throw, with remediation naming the exact scope. Its
catch blocks were also swallowing the new throws and downgrading them to a generic API error —
they now rethrow `GhlError` and let genuine transport failures throw too.

`test/docs/error-envelope.test.mjs` guards the class: every write command must throw rather than
return on AUTH/API, auth throws must carry remediation, and no new command may adopt return-style.
Six read commands (`forms`, `surveys`, `transactions`, `list`, `doctor`, `ask`) still use it —
listed explicitly and shrink-only, since a failed read cannot be mistaken for a completed mutation.

### Fixed — `sizmo opp create` hardcoded `status: 'open'`, inflating pipeline totals

GHL requires `status` on `POST /opportunities/` and accepts `open|won|lost|abandoned`; sizmo always
sent `open`, and `--status` was wired to `update` only. Importing a client's historical **closed**
deals was therefore impossible — every backfilled opportunity landed OPEN, so `sizmo pipeline`
counted the entire deal history as live pipeline value. `--status` is now honoured on create
(default `open`, unchanged) and validated against the same list `update` uses. A non-open status is
called out in the confirm preview.

Also added **`--assigned-user`** (`assignedTo`) — the last field the endpoint accepts that sizmo did
not expose. Deals had no owner.

### Fixed — `sizmo invoice draft --due` was dropped from the rerun command

The preview printed `due 2026-12-25` and then offered a rerun command with no `--due`, so running
the command you were just handed produced an invoice due **+14 days**. On a document that goes to a
client, that is the difference between the terms they agreed to and different ones — and it breaks
the confirm contract README states directly ("prints the exact change + a rerun command").

`test/docs/confirm-roundtrip.test.mjs` guards the class behaviourally across `invoice`, `contact`,
`tag` and `business`: every flag passed must survive into `confirmCommand`, with a value-level pin
on the due date, since a flag being *present* is not the same as carrying the value the human read.

### Changed — npm package is 84% smaller (1.2 MB → 189 kB)

`examples/demo/*.gif` were 1.1 MB of the 1.2 MB tarball and were displayed nowhere — not in the
README, not linked anywhere; the only mention is `examples/demo/README.md` documenting how to
regenerate them from the `.cast` sources. Excluded from the package, kept in git.


## [2.4.9] — 2026-07-27

### Added — `appointment book` can express a real booking

Diffed the command against `POST /calendars/events/appointments` (via the LeadConnector Anthropic
MCP's `describe_operation`, introspection only). The endpoint accepts 13 body fields; sizmo sent 4.
A booking could not carry a title, a duration, an assignee, or a location — and there was no way to
stop the location's automations from firing.

- **`--title`** — appointment title. Omit and GHL still names it for you (the key is omitted
  entirely rather than sent empty, because GHL only auto-generates when the field is absent).
- **`--end`** — ISO 8601 end time. Omit to keep using the calendar's slot duration. Validated the
  same way `--start` already was, plus a refusal when it lands before `--start`.
- **`--assigned-user <userId>`** — assign the appointment to a specific user (`sizmo list users`).
- **`--address`** — meeting location, e.g. `"Zoom"` or a street address.
- **`--no-notify`** — book **without** firing the location's automations.

### Changed — booking now discloses that it messages the contact

`toNotify` defaults to true server-side, so every `sizmo appointment book` has always been capable
of sending the contact a confirmation SMS/email and kicking off workflows. The confirm preview
listed only calendar, contact and time, which understated what was being approved. It now says so
explicitly, and says the opposite when `--no-notify` is passed. The default is unchanged — sizmo
does not silently suppress a client's confirmations.

### Added — `contact create/upsert` can set provenance, ownership and DND

`POST /contacts/` accepts 23 body fields; sizmo exposed 6. Added `--source`, `--assigned-user`,
`--company`, `--timezone`, `--country` and `--dnd` to **both** create and upsert (via a shared
builder, so the two cannot drift apart).

Two matter beyond convenience. **`--source`**: without it every contact sizmo creates is
indistinguishable from a manual entry, so for an import/migration tool attribution was
unrecoverable after the fact. **`--dnd`**: sizmo can create a contact *and* message it, and GHL
automations fire on creation — importing an opted-out list left those people messageable. Omitting
`--dnd` omits the key entirely rather than sending `dnd: false`, which on upsert would actively
clear a flag an existing contact already carries.

### Fixed — a blocked read reported `0`, not unknown, on every reporting command

README promised this in two places ("a blocked data source is reported as unknown, never as zero")
and it was false across all seven reporting lanes. `receivables` returned `totalOwed: 0` while
holding the HTTP status proving the invoices were never read; `pipeline` reported `0` open value;
`reconcile` reported `0` collected *and* a clean `0 refunds · 0 failed · 0 orphans`; `triage` said
`0` waiting; `noshow`, `segment` and `booked-not-paid` the same. Nothing in the payload separated
"nothing owed" from "not allowed to look", so a consumer summing across locations silently
under-counted real money.

All seven now return `null` for their counts and totals plus a `blocked: <httpStatus>` marker, and
each render says UNKNOWN and states plainly what the empty state does **not** mean.
`test/docs/blocked-is-not-zero.test.mjs` scans every command and fails the build if any starts
returning a hardcoded `0` from a blocked branch again.

### Fixed — `sizmo brief` exited 0 while completely blind

With an invalid PIT, all four brief lanes returned HTTP 401 and `brief` still exited `0`, while
`sizmo transactions` correctly exited `3` on the identical failure. `sizmo brief && deploy` would
proceed, and an agent checking `$?` read a dead token as a healthy account. Root cause: a blocked
lane is not surfaced as an error — the sub-collects swallow a 401 into a well-formed zero, so
`receivables.totalOwed === 0` is shape-identical whether nobody owes anything or the read was
denied. `brief` now exits `AUTH` when every lane came back empty *and* the failures were
permission-shaped, and the human render no longer prints "All clear — nobody waiting, nothing
stuck, nothing owed" while degraded. Known limitation, documented in the code: four lanes failing
for a non-auth reason still exits 0.

`lib/output.mjs` now exposes `out.warnings` (a copy) alongside the existing `out.degraded` — the
JSON envelope already shipped warnings, but nothing in-process could read them.

### Added — the docs now enforce themselves

`SECURITY.md` claimed sizmo makes "exactly two kinds of outbound request"; `lib/llm.mjs` is a third
(the LLM providers, opt-in via `sizmo ask`), so the guarantee table contradicted the document's own
trust-boundary section. Its dependency-audit recipe also pointed at a `package.json` field that
does not exist. Both fixed, plus a full egress audit listing all 7 hosts in shipped code and which
3 are ever contacted.

New test files turn those promises into build failures rather than prose: `test/docs/`
`security-claims` (zero deps, no `--pit` flag, the exact host set, only 3 modules opening sockets,
no charge path, every write routed through `requireConfirm`), `changelog-claims`, and
`agent-docs-drift` (every command present in SKILL.md **and** AGENTS.md, every documented flag
valid *for that command*).

### Added — test coverage for every command

`business`, `surveys`, `transactions`, `list` and `sync` had none. Zero untested commands remain.
`business` was covered first because 2.4.9 changed its confirm behaviour while it was unguarded.

### Fixed — `sizmo business --dry-run` was broken

`business.mjs` hand-rolled a `ctx.confirmed` check instead of calling `requireConfirm()`, so
`--dry-run` exited 5 and printed prose rather than exiting 0 with the JSON envelope — contradicting
README's claim that `--dry-run` works on all writes.

### Fixed — SKILL.md was missing 7 of 34 commands

`ack`, `booked-not-paid`, `crm`, `focus`, `noshow`, `receivables` and `reconcile` were absent from
the file Claude Code loads as its complete command reference — three of them core money surfaces.
`ack` was missing from **both** agent docs, which matters because it is the reason an item can
vanish from `focus`/`brief`: an agent that does not know it exists will diagnose a snoozed contact
as missing CRM data.

### Docs — 8 CHANGELOG versions were never published

Audited against `npm view sizmo versions`. `2.4.1`–`2.4.5`, `1.0.1` and `1.2.0` have full entries
here but do not exist on npm, so `npm install sizmo@2.4.3` fails. They are now marked inline with
the release that actually carries their changes, rather than deleted — the changes are real.

---

**Gap found by using the CLI: `sizmo calendar create --type round_robin` fails at the GHL API
("No team member found") with no remediation path, because the command had no way to pass
team members. Round-robin and collective calendars require at least one assigned user — the
flag was just missing.**

### Added
- **`sizmo calendar create --team-member uid1,uid2`** — comma-separated user IDs to assign as
  team members. Required for `round_robin` and `collective` calendar types; optional (and
  silently omitted) for `event` and `class_booking`. The body sends
  `teamMembers: [{ userId }]` which is what GHL's POST `/calendars/` expects.
- **Early validation for team calendar types** — if `--type round_robin` or `--type collective`
  is passed without `--team-member`, sizmo now throws USAGE immediately with a remediation hint
  (`sizmo list users` to find ids) instead of sending a doomed request and surfacing a raw GHL
  422 with no guidance.
- **"No team member found" hint on 422** — if a `round_robin` request somehow reaches GHL and
  gets a "No team member found" response (e.g. the user supplied an invalid id), the error
  message now carries a remediation hint pointing to `--team-member`.

### Changed
- `README.md` command table and `SKILL.md` cheatsheet updated to show `--team-member` and note
  that it is required for team calendar types.
- `lib/cli.mjs` `COMMAND_EXAMPLES` updated with a round-robin example.

## [2.4.8] — 2026-07-08

**Found via the new HighLevel LeadConnector MCP for Anthropic (`/mcp/anthropic/v2`) — used
strictly for introspection (`search_operations`/`describe_operation`), never `execute_operation`,
to run a real gap audit against sizmo's existing command surface. 3 new commands shipped, all
wired into `sizmo ask` too, plus a real doc-accuracy pass that found SKILL.md had been teaching
wrong CLI syntax.**

### Added
- **`sizmo opp delete <oppId>`** — opportunities could be created, moved, and updated, but never
  deleted. Every `SIZMO-VERIFY-*` test opportunity created during live-fire sweeps had to be left
  behind permanently until now. Single-target, fetch-first, same pattern as every other delete.
- **`sizmo appointment note <apptId> --text "..."`** — appointments had zero note support. Scoped
  to create-only, matching `sizmo note`'s existing contact-note precedent exactly.
- **`sizmo send cancel <messageId> --channel sms|email`** — cancel a scheduled message before it
  goes out. GHL splits this into two endpoints by channel; both verified live.
- **`sizmo link create --name --redirect-to`** / **`sizmo link delete <linkId>`** — trigger links
  were read-only (`sizmo list links`); now full create/delete.
- **`sizmo ask` wired for the above** where it makes sense: `opp delete` and `link create` fire
  directly (same resolution mechanisms already in place — `opp delete` resolves by contact name
  exactly like `opp move` does). `send cancel`, `link delete`, and `appointment note` are
  deliberately print-only — each needs a bare id that isn't resolvable from a natural-language
  query, same reasoning already established for `value delete`.
- **`docs/how-to/ask.md`** — full tutorial for `sizmo ask`: setup, the three-rule mental model,
  walkthrough examples (simple read → single write → multi-step chaining → pronoun follow-ups →
  disambiguation), the complete fires-directly-vs-print-only table with the reasoning behind the
  split, troubleshooting, and prompt-writing tips. No dedicated `ask` tutorial existed before this.

### Fixed
- **`GET /links/id/{id}` requires `locationId` as a query param** — the opposite problem from the
  2.4.7 `/contacts/:id/notes` case, where an auto-injected `locationId` broke things. Confirms
  `locationId` handling is genuinely inconsistent per-endpoint in GHL's API, not guessable from one
  prior example. Caught live during `link delete` verification.
- **`send cancel`'s two endpoints disagree on "not found" status code** — email genuinely 404s,
  SMS/generic 400s with `canonicalCode: CONVERSATIONS_MSG_NOT_FOUND`. Both now correctly classify
  as `NOTFOUND`, not a generic API error.
- **SKILL.md — the file Claude Code loads as its full agent command briefing — had fabricated flag
  syntax that never matched the real CLI:** `tag add`/`note add` (both are flat commands, no
  subcommand exists), `--stage-id`/`--pipeline-id` (real flags take names, not ids), `send email
  <id> --subject` (real: `--channel email --message`, subject auto-generates from the first line),
  `invoice draft --title --amount` (real: `--item "Name:amount"`). Also documented an `invoice
  void` command that has never existed, the wrong PIT storage path, a stale hardcoded version
  number, a stale pre-rename GitHub org name, and pre-2.0 money-safety language. Every replacement
  verified against the actual source file before writing it.
- **README's write-command tables** — updated with all 4 commands above.

588/588 tests green.

## [2.4.7] — 2026-07-06

**A full live-fire sweep of every single command in the CLI — all 16 reads, all 12 `list` entities,
`export`/`diff`, and every write (contact/tag/note/opp/appointment/send/field/value/calendar/
business/invoice) — fired against a real GoHighLevel account, each verified independently (a raw
API read-back, not sizmo's own success message). Found and fixed 4 real bugs.**

### Fixed
- **`sizmo contact upsert --tag X` on an EXISTING contact replaced its entire tag list instead of
  adding to it** — verified live: a contact with 2 existing tags was left with only the new one
  after an upsert. This is the most serious finding in this release: a normal, successful-looking
  command silently erasing a contact's tag/segmentation history. Fixed — `upsert` now looks the
  contact up first (same email/phone key it already matches on) and merges the given tag(s) into
  whatever it already has; the confirm preview now says so explicitly ("merged with N existing
  tag(s) — nothing removed").
- **`sizmo note` always returned `noteId: null`.** The note itself wrote correctly; only the id
  echoed back in `--json` was wrong. GoHighLevel nests the created note under a `note` key
  (`{ note: { id, ... } }`), and the code read a flat `.id`. Fixed.
- **`sizmo appointment book --calendar` and `sizmo opp create/move --pipeline/--stage` failed with
  "unknown calendar/pipeline/stage" on anything created earlier in the same session** — the exact
  same stale-local-cache gap fixed for `sizmo ask` in 2.4.6, just still present in these two direct
  (non-`ask`) commands. Both now fall back to a live fetch on a cache miss, via the same
  `fetchLiveEntity()` helper (moved from `ask.mjs` into `lib/model.mjs` so all three call sites
  share one implementation instead of three copies).
- **`list` overview showed Custom Values as `✖`** (the same glyph used everywhere else for "blocked,
  missing scope") purely because that entity has no precomputed count — it's fetched live, not
  cached, and was never actually blocked. Now shows `·` instead of `✖` for that case.
- **`sizmo api`'s raw escape hatch force-injected `locationId` into every request**, which 422s on
  sub-resource endpoints that don't accept it (e.g. `/contacts/:id/notes`). Added `--no-loc` to skip
  the auto-injection.

556/556 tests green (16 new).

## [2.4.6] — 2026-07-05

**A full live-verification pass on `sizmo ask` — every executable command (tag, note, contact
create/upsert/delete, opp create/move, value create, field/calendar/business create/delete) fired
through the real `concretize()` + `executeSteps()` pipeline against a live account, not just unit
tests.** Found and fixed the one real gap; README repositioned to match how people actually run
this thing.

### Fixed
- **`sizmo ask` resolved custom fields, calendars, and businesses from the periodically-synced
  local model cache instead of a live fetch.** Creating one of these via `ask` and immediately
  referencing it by name in the same session (e.g. "delete the field I just made") failed — the
  cache hadn't caught up. Contacts and opportunities already resolved live; fields/calendars/
  businesses now do too, via a `fetchLiveEntity()` helper that reuses the existing `ENTITY_SPECS`
  fetch/extract logic and is memoized per command-batch (a multi-step chain that references the
  same entity type twice fires one HTTP call, not one per reference).

### Changed
- **README repositioned around how sizmo is actually driven.** Most users already run an AI coding
  agent (Claude Code, Codex, Cursor) — pointing it at `SKILL.md` gets natural-language control over
  sizmo's flag commands with zero extra AI key and zero extra cost. `sizmo ask` (its own opt-in
  `--ai-key` resolver) is now framed as the second path — for when you want the CLI itself to
  understand plain English with no agent in the loop — rather than the only one. The "Claude Skill"
  section is now "Driving sizmo with an AI agent" and documents Codex/Cursor use (`SKILL.md` is
  plain markdown, not Claude-specific).

### Internal
- **Test suite could corrupt a real `~/.config/sizmo/profiles.json`.** Three test files
  (`router-verb`, `config-list-json`, `init`) never redirected `XDG_CONFIG_HOME`, and a
  `try { return fn() } finally { restore() }` helper didn't `await` the async `fn` — the `finally`
  restore ran right after `fn` was called, not after it resolved, racing any write `fn` made. Fixed:
  all three now redirect to an isolated `mkdtempSync` temp dir via `before()`/`after()` hooks for
  the file's whole run, and the helper is `async` with `return await fn()`. No shipped CLI behavior
  changed — this only affected contributors running the test suite.

548/548 tests green (12 new).

## [2.4.5] — 2026-07-05  **(not published — shipped in 2.4.6)**

**A full audit of every hardcoded `limit` in the codebase, prompted directly by "why did you only
check ask.mjs — check the rest."** Fair. Checked all of them live against the real API instead of
assuming.

### Fixed
- **`sizmo sync`'s `forms`/`products`/`businesses` model-cache entities were capped at `limit=50`**
  — GHL's real max for all three is 100 (verified live: accepted). A location with more than 50
  forms, products, or businesses would have silently synced only the first 50, with no warning.
  Bumped to 100.

### Verified clean (no change needed, now documented so nobody "fixes" these by mistake)
- **`surveys`** genuinely caps at 50, not 100 — verified live: `limit=100` is rejected with 422
  "limit must not be greater than 50." The one entity here that's actually different from its
  siblings.
- **`customFields` and `objects`** reject a `limit` param outright (422 "property limit should not
  exist") and always return the complete list regardless — correct as-is, by omission.
- **`customValues`** (used by `export`, `value delete`, `list values`) returns the identical full
  count whether `limit` is omitted, 100, or 200 — already complete, no pagination needed.
- The already-paginated read commands (`booked-not-paid`, `pipeline`, `reconcile`, `receivables`,
  `triage`, `snapshot`, `segment`) page to completion regardless of per-page size — not affected by
  this class of bug regardless of what limit they use per page.

546/546 tests green (6 new).

## [2.4.4] — 2026-07-05  **(not published — shipped in 2.4.6)**

### Fixed
- **`sizmo ask`'s contact/opportunity disambiguation could silently undercount matches.** Both
  searches capped at a low page size (5 for contacts, 25 for opportunities) and reported that
  page's length as the match count — if more actually matched than fit on the page, the "matches N
  contacts" message was wrong. Bumped both to GHL's real max (100 — verified live: 101 gets
  rejected) and now reads the API's own `meta.total` for the count instead of trusting page
  length. The candidate list shown to the user still caps at 10 for readability, with an explicit
  "N more — narrow further" note whenever the real total exceeds what's displayed.

542/542 tests green (4 new).

## [2.4.3] — 2026-07-05  **(not published — shipped in 2.4.6)**

**The scope-vs-API-error conflation from 2.4.2 wasn't unique to `sync`/`list`/`crm`.** A wider grep
turned up the identical pattern in five more places.

### Fixed
- **`sizmo business list`, `sizmo surveys`, `sizmo forms`** — each had its own copy of the same
  bug: any non-2xx response on that entity was reported as "needs `<scope>`" regardless of
  whether it was a real 401/403 or some other API error. Now each distinguishes the two, matching
  the fix already applied to `sync`/`list`/`crm`.
- **`sizmo export`** — a blocked entity's warning always said "blocked (missing scope)"; now says
  "API error `<code>` (not a scope issue)" when that's what actually happened, and the exported
  document's `{blocked}` marker itself now carries `httpCode` when present.
- **`sizmo diff`** — when comparing against an export produced by the fixed `export`, a
  non-scope-blocked side now reports "API error `<code>` — not a scope issue" instead of a bare
  "blocked (`<scope>`)" that could read as a permissions problem.

539/539 tests green (6 new).

## [2.4.2] — 2026-07-05  **(not published — shipped in 2.4.6)**

**`links` was never a scope problem.** A user with the `links.readonly` scope already granted
would still see `sizmo sync`/`sizmo list links` report "needs links.readonly" — because sizmo
itself was sending a `limit` param GoHighLevel's `/links/` endpoint rejects with 422, and *any*
non-2xx response on a synced entity was unconditionally reported as a missing scope, even when
the PIT clearly reached real API logic to get that error.

### Fixed
- **`sizmo sync links` / `sizmo list links` were completely broken for everyone, regardless of
  scopes granted.** `lib/model.mjs`'s `links` entity sent `&limit=50`; GoHighLevel's `/links/`
  endpoint 422s on that param ("property limit should not exist") — it's the one entity here that
  doesn't accept `limit`. Removed. `sizmo list links` now correctly returns real trigger-link data.
- **A non-scope API error on any synced entity was being misreported as "needs `<scope>`."**
  `sync.mjs`'s human display, its `--json` envelope, and `list.mjs`'s `blockedExit()` (12 call
  sites, one per entity) all collapsed "401/403, scope genuinely missing" and "some other error
  (422/404/5xx) reached the PIT just fine" into the identical message and exit code. An operator
  who's already granted the scope would see this and go looking for a permissions problem that
  doesn't exist — the bug is sizmo's, not theirs. Now: a real scope block still says "needs
  `<scope>`" (`EXIT.AUTH`); any other HTTP error says "API error `<code>` (not a scope issue —
  please report this)" (`EXIT.API`), and `--json` surfaces the distinguishing `httpCode` field so
  an agent doesn't draw the wrong conclusion either.

Found via a systematic live-verification sweep across every remaining untested endpoint, prompted
directly by a question about why `links` stayed blocked with all 157 PIT scopes granted.

528/528 tests green (6 new).

## [2.4.1] — 2026-07-05  **(not published — shipped in 2.4.6)**

**A systematic live-verification sweep of every write command that had never been checked against
a real GoHighLevel location — found and fixed 3 completely broken commands.** Prompted by v2.4.0's
live pass catching 2 real bugs in `sizmo ask`: same pattern, wider net. The root cause enabling all
of these: `test/_helpers.mjs`, used by every command's test suite, silently discarded the request
body on every mocked write — a wrong field name could never fail a test, because no test could see
it. Fixed the helper too (`getCalledBodies()`), so this bug class can't recur silently.

### Fixed
- **`sizmo opp create` never worked.** GoHighLevel's create endpoint requires `locationId` in the
  body (422 "locationId can't be undefined" without it) and the stage field is `pipelineStageId`,
  not `stageId` (422 "property stageId should not exist"). Every `opp create` call has failed
  since it shipped.
- **`sizmo opp move` never worked.** Same `stageId` → `pipelineStageId` mistake — GoHighLevel
  returns 422 and the stage change never applies.
- **`sizmo appointment book` never worked.** Missing `locationId` in the body — GoHighLevel
  returns 400 "Location ID is required."
- **`sizmo send --channel email` never worked; `--channel sms` never worked either.** Both were
  missing `locationId` (422). Email additionally needs an `html` field — GoHighLevel accepts
  `message` alone with a misleading 422 ("no message or attachments") that gives no hint `html` is
  what's actually missing. Email now also gets an auto-generated subject line (from the message's
  first non-blank line) since `send` has no separate `--subject` flag.

All four were confirmed working end-to-end against a real location (create → move/read-back →
delete, book → cancel) before merging. Each fix is regression-tested against the exact body shape
that failed live, not just "a write happened."

### Changed
- `test/_helpers.mjs`: `makeFakeCtx` now captures the actual body of every POST/PUT/DELETE call
  (`getCalledBodies()`), not just that a call happened. Every command's test suite can now assert
  on real outgoing field names — this is what should have caught the four bugs above.

## [2.4.0] — 2026-07-05

**`sizmo ask` now runs things — it doesn't just tell you what to type.** Until this release, every
`sizmo ask` call — read or write — only ever printed a suggested command; you still had to copy
it and run it yourself. That's gone. Reads execute immediately. Writes preview once, then a bare
`sizmo ask --confirm` fires them — no retyping, no re-asking the AI.

### Added
- **Reads execute immediately.** `sizmo ask "who hasn't replied in 3 days"` now runs `triage` and
  shows the real output, instead of printing `→ sizmo triage` and stopping.
- **Writes fire on a bare `--confirm`.** The preview resolves every name to a real id once and
  caches that exact plan locally (10 min TTL); `--confirm` replays the cached plan — it never
  re-asks the LLM, so what you previewed is guaranteed to be what fires (a second LLM call on the
  same sentence could in principle resolve differently; caching removes that risk entirely).
- **Multi-step chaining.** `sizmo ask "tag Ana as follow-up and book her Friday at 2pm" --confirm`
  runs both steps in order off one confirm. A batch stops at the first failed step and reports
  exactly which steps already succeeded, which failed, and which were never attempted.
- **Pronoun follow-ups ("her", "that deal") — resolved locally, never sent to the AI.** The LLM
  only ever sees the literal placeholder `<recent-contact>`; the real name/id is substituted back
  in afterward from a short-lived local cache (20 min TTL). Same-sentence references ("tag Marco…
  and note him…") resolve from what was just found in that sentence, not stale cross-call memory.
- **Local fast path for bare command names — zero AI calls, zero cost.** `sizmo ask "brief"`,
  `sizmo ask "list forms"`, `sizmo ask "no show"` and similar exact/near-exact command names
  resolve instantly without touching the LLM at all.
- **`opp move`/`opp create` now resolve a person's open opportunity by name** ("move Ana's deal to
  Proposal Sent"), disambiguating on pipeline name when someone has more than one open deal.
- **`field`/`calendar`/`business` delete resolve by name** from the already-synced local model —
  no id lookup required first.
- `sizmo ask` can now fire `tag`, `note`, `send`, `contact` (create/upsert/delete), `opp`
  (create/move), `value create`, `field` (create/delete), `calendar` (create/delete), and
  `business` (create/delete) directly. `invoice draft/send`, `appointment book/cancel`, and
  `opp update` are deliberately NOT auto-fired — money and scheduling stay a manually-typed step;
  `sizmo ask` still resolves and prints the exact command for those.

### Fixed
- **`sizmo ask`'s contact search never actually worked.** It called `GET /contacts/?search=…` —
  GoHighLevel returns HTTP 422 for that param name (the real one is `query`) — and the failure was
  silently read as `contacts: []`, reported as "no contact found" instead of an API error. Since
  every write in `sizmo ask` (2.3.0/2.3.1) needed a contact resolved first, **this meant no write
  command in `sizmo ask` could ever complete** — caught during this release's live-verification
  pass, not before. Fixed, and now covered by both a mocked regression test and a live check.
- **Opportunity pipeline/stage names were never resolvable.** The `/opportunities/search` response
  carries only `pipelineId`/`pipelineStageId` — no inline name fields — so the old pipeline-hint
  disambiguation (`--pipeline` to pick between two open deals) silently matched nothing, and
  candidate lists showed blank pipeline/stage text. Now resolved from the synced local model.

### Security
- New local-only cache for `sizmo ask`: a last-resolved-contact file (name+id, 20 min TTL) and a
  pending-write-plan file (10 min TTL, can contain write content — a note's text, a tag name, an
  SMS/email body — for that window). Both `0600`, atomic writes, `~/.config/sizmo/ask-memory/`,
  never transmitted anywhere. See `SECURITY.md`.

## [2.3.1] — 2026-07-03

### Changed
- README: v2.3.0 shipped without a README pass — the "What it does" map, Commands table, "Why
  sizmo" differentiators, Safety model, and Honest limitations sections didn't mention `ask`,
  `list`, `forms`, `surveys`, `business`, or `transactions` at all. Caught before this reached npm's
  package page (which only updates on publish). Docs-only patch — no code change.

## [2.3.0] — 2026-07-03

**Natural language + the rest of the readable API surface.** Two things landed together: a
natural-language front door (`sizmo ask`), and six previously-unused PIT scopes turned into real
commands. Both were run through a full adversarial-QA pass and a live-verification pass against a
real location before release — the live pass caught a real bug (below).

### Added
- **`sizmo ask "<intent>"`** — translates a plain-English request into the exact sizmo command.
  Reads show the resolved command directly; writes show a preview and require a separate
  `--confirm` run, same confirm-gate as every other write. Resolves a typed person's name to a
  contact id via a live search (disambiguates on multiple matches, never guesses). Needs an AI key
  in your profile — `sizmo config set --ai-key <key> --ai-provider anthropic|openai` — sizmo makes
  zero LLM calls without one. **New trust boundary, see `SECURITY.md`:** your request text and a
  structural excerpt of your CRM (pipeline/calendar/tag/form/survey/business **names and ids only —
  never contacts, conversations, or money data**) are sent to whichever provider you configure.
  `lib/llm.mjs` adds zero new runtime dependencies (raw `fetch`, Node 22+).
- **6 new readable entities**, synced into the same local model cache as the original 6:
  `forms`, `surveys`, `products`, `links`, `businesses`, `objects`. Cache extracts are deliberately
  slim (id + name, occasionally one more display field) — the cache is a lookup table for command
  resolution, not a content mirror.
- **`sizmo list`** — now surfaces all 12 entities in three groups (CRM / Content & Commerce / B2B &
  Structure), plus per-entity subcommands (`list forms`, `list businesses`, …). A never-synced
  entity now says so explicitly instead of showing `(0)` indistinguishably from "synced but empty."
- **`sizmo forms`** / **`sizmo surveys`** — list from cache; `sizmo forms <id>` / `sizmo surveys
  <id>` fetch that form/survey's recent submissions live (`--top`, default 20, max 100). Verified
  live against a real location (correct response key, clean zero-submissions render).
- **`sizmo business list|create|delete`** — B2B company records. `create`/`delete` confirm-gated;
  `businesses.write`. Live-verified full create→delete round trip.
- **`sizmo transactions`** — read-only payment transaction history (`--top`, `--type`). Uses GHL's
  `altId`/`altType` payments convention, not `locationId`.

### Fixed
- **`sizmo list products` showed a blank Product ID for every row.** GHL's `/products/` endpoint is
  the one entity here that returns Mongo-style `_id` instead of `id` — every sibling entity
  (forms/surveys/businesses/objects) uses `id`. Caught during live verification (mocks all used a
  synthetic `id` field, so this was invisible to the test suite); fixed, and now regression-tested
  against the real response shape.
- `sizmo list businesses` pointed to a `business update` subcommand that was never built (only
  `list`/`create`/`delete` exist) — corrected the hint.
- Transaction amount formatting no longer guesses currency units from magnitude. The old
  `>1000 = cents` heuristic misformatted a real ₱1,500 transaction as `PHP 15.00`; GHL's payments
  API already returns floats in currency units, so the raw value is shown directly.
- A form/survey submissions response in an unrecognized shape now surfaces a visible warning with
  the actual response keys, instead of silently rendering as "no submissions."

## [2.2.0] — 2026-07-02

**Builder completions.** Two confirm-gated writes that finish the "scaffold a location" story,
each verified live against a real location.

### Added
- **`sizmo contact upsert`** — create-or-update a contact, de-duped on `--email` / `--phone`. Matches
  an existing contact and updates it, or creates one if none matches — so a **retrying agent can't
  spawn duplicate people** (the whole point). Reports created vs updated. Confirm-gated;
  `contacts.write`. Live-verified: same email twice → same id, no duplicate.
- **`sizmo calendar create`** — create a calendar with just `--name` (GHL fills sensible defaults;
  `--type` / `--slot-min` optional). Confirm-gated; `calendars.write`.
- **`sizmo calendar delete <id>`** — single-target, accident-proof delete (same pattern as contact/
  field/value delete: fetch-and-name-in-preview, `NOTFOUND` on a wrong id, one-record `DELETE`, never
  bulk). Confirm-gated. Live create→delete round-trip verified.

### Notes
- **Pipeline create/delete is NOT shipped — GoHighLevel's public API blocks it.** With
  `opportunities.write` on the token, `POST /opportunities/` validates (scope live) but
  `POST /opportunities/pipelines` returns **401 "not authorized for this scope"** — it needs a scope
  the Private Integration Token catalog doesn't offer. This is a platform gap, not a sizmo
  limitation; the CLI won't pretend to a capability the API won't grant.

## [2.1.0] — 2026-07-02

**Location-as-file.** Your GoHighLevel location becomes a file you can save, read, and diff. Two
read-only commands, zero writes — the foundation for seeing exactly what changed (and, later,
`apply`).

### Added
- **`sizmo export`** (Phase 1 of location-as-file) — dump a location's structure (pipelines+stages,
  calendars, custom fields, custom values, tags, users, location settings) to one **deterministic,
  diffable JSON document** (`--out <file>` or stdout). No timestamps → two exports of an unchanged
  location are byte-identical (the basis for `sizmo diff`). Blocked/unreachable resources are
  written as `{ blocked: <scope> }` markers **inside** the document, never as empty lists — so a
  later `apply` can't mistake "blocked" for "empty". Secret-free (ids/names/structure only; user
  API keys never exported). Read-only. Verified live.
- **`sizmo diff`** (Phase 2 of location-as-file) — `sizmo diff <file>` compares a saved export
  against the **live** location; `sizmo diff <a> <b>` compares two exports. Reports added / removed
  / changed per resource with field-level detail, plus a stable `--json` envelope. Answers the one
  question a snapshot structurally can't: **"what actually changed?"** Both sides are canonicalized
  before comparing, so key order is never mistaken for a change. A resource that's `blocked` on
  either side is reported `not comparable` — the diff never invents a delta on data it couldn't
  read. Read-only. Verified live against a real location (self-diff = identical; a mutated file
  correctly surfaces every add/remove/change).

### Fixed
- The cache-age note (`· cached Ns ago`) now prints to **stderr**, not stdout — it's a diagnostic,
  not data, so it no longer corrupts a redirected/piped document (e.g. `sizmo export > loc.json`).

## [2.0.2] — 2026-07-02

### Changed
- Repo moved to `github.com/csalamida/sizmo-ghl-cli` (owner renamed from `csalamida07-cyber`).
  Updated the `repository`/`bugs`/`homepage` URLs, README badges + clone commands, and CHANGELOG
  links. Old links still redirect; this makes the npm metadata point at the canonical URL. No code
  change.

## [2.0.1] — 2026-06-28

### Changed
- README: added a **"What it does"** capability map (See / Act / Build / Delete / Bill / Operate) so
  the full 2.x shape reads at a glance, refreshed the positioning, and fixed a stale update-notifier
  example + the contract reference. Docs-only patch — published so npm's package page reflects it
  (npm READMEs only update on publish). No code change.

## [2.0.0] — 2026-06-27

**Breaking (security posture, not the API contract).** The "**money never moves**" guarantee is
removed. sizmo now follows **scope-is-the-gate**: it exposes whatever your PIT's scopes + GoHighLevel's
*public* API allow — including money-side writes (draft/send an invoice). It still **cannot charge a
card** (GHL exposes no public endpoint for that). The CLI contract — exit codes, the `--json`
envelope, command/flag names — is **unchanged and backward-compatible**; the major bump signals that
`SECURITY.md` no longer promises money can't move. Grant money scopes deliberately.

### Added
- **`sizmo invoice draft --contact <id> --item "Name:amount[:qty]"`** — create a **draft** invoice
  (a document — not sent, no charge). Pulls the contact + business name to assemble the body.
  **Verified live.** Scope: `invoices.write`.
- **`sizmo invoice send <invoiceId>`** — send an invoice; delivers a **pay-link / text-to-pay** the
  customer acts on (not a card charge). Scope: `invoices.write`.

### Changed
- **Money policy → scope-is-the-gate** (the breaking note above). `init`'s scope copy-block and
  `auth check` now include `invoices.write`. SECURITY.md + README rewritten accordingly.
- `sizmo crm <fields|tags|calendars|pipelines|users>` shows each item's **id inline** in the human
  listing (was only in `--json`) — completes the loop: `crm fields` → copy id → `field delete <id>`.

## [1.4.0] — 2026-06-27

### Added
- **Single-target delete** — `sizmo contact delete <id>`, `sizmo field delete <id>`,
  `sizmo value delete <id>`. Deliberately designed against the "I deleted one custom field and it
  wiped them all" accident: takes **exactly one id** (no `--all`, no wildcard, no batch); **fetches
  the resource and shows its name** in the confirm preview first; a wrong/nonexistent id →
  `NOTFOUND` with nothing touched; then deletes that **one** resource by its id path. Confirm-gated
  like every write. Verified live (deleted a real field/value/contact by id, confirm-gate intact).

## [1.3.0] — 2026-06-27

Builder/scaffold minor — sizmo grows from "see + nudge" into "see + nudge + scaffold." Additive;
the frozen 1.x contract is unchanged. Ships everything since 1.1.0 (includes the 1.2.0 convenience
round below).

### Added
- **Build/scaffold writes** — stand up a GHL location from the terminal instead of clicking:
  `sizmo contact create`, `sizmo field create` (custom field), `sizmo value create` (custom value).
  All confirm-gated like the other writes. Design principle: **the PIT scope is the gate** — if the
  token carries the write scope the command works, otherwise it fails with `AUTH` + the exact scope
  to add. `init`'s scope copy-block + `auth check` now include `locations/customFields.write` and
  `locations/customValues.write`.
  > Verified live against a real GoHighLevel location — contact/field/value create all returned ids,
  > and the confirm-gate previews then fires correctly.

### Fixed
- The profiles-config path is now resolved lazily (at call time, not import time), so a machine that
  has a saved default profile no longer fails `npm test` / `npm publish` — the three "no creds"
  tests now isolate to a temp config dir instead of depending on a pristine `~/.config/sizmo`.

## [1.2.0] — 2026-06-26  **(not published — shipped in 1.3.0)**

Convenience minor — make sizmo nicer to use day-to-day. Additive only; the frozen 1.x contract is
unchanged. No new capability (still reads the same CRM, money never moves) — purely usability.

### Added
- **`sizmo open <id>`** — open a contact (or `--opp` for their opportunities) in the GoHighLevel web
  app from the terminal; `--url` just prints the link. No API call, no write — a convenience bridge
  from "found it in the terminal" to "act on it in GHL". White-label host via `SIZMO_APP_URL`.
- **`sizmo completions zsh|bash`** — tab-completion for commands + flags, generated from the live
  schema so it never goes stale. Install: `eval "$(sizmo completions zsh)"` in your shell rc.
- **`sizmo help <command>`** (and `sizmo <command> --help`) — per-command help with real, runnable
  examples, not just a flag list. `<command> --help` no longer errors as an unknown flag.
- **Per-row next-step commands** on the people-recipes (`receivables`, `triage`, `noshow`,
  `booked-not-paid`) — each row prints the ready-to-run `sizmo send …` / `sizmo open …` line with the
  real contact id, so you act without retyping. (Writes still require `--confirm`; money never moves.)

### Fixed
- Ranker hardening (found by an adversarial sweep of the money core): a non-finite money value
  (e.g. `Infinity` from bad upstream data) no longer ranks #1 or turns the headline total into `—`
  — it's treated as value-unknown, consistent with how `money.mjs` renders non-finite amounts. The
  sort tie-break now guards a `NaN`/undefined age so an equal-money tie can never drop an item via a
  non-deterministic comparator. Both are edge-only — no change to normal output.

## [1.1.0] — 2026-06-26

First feature minor since 1.0. Additive only — the frozen 1.x contract (exit codes, the `--json`
envelope, command/flag names) is unchanged. Includes everything from 1.0.1 below.

### Added
- **`--ndjson`** — streamed machine output: a leading meta line (carrying `command`, `location`,
  `degraded`, `warnings`, `count`, and every non-list field) then one JSON object per list item.
  Lets an agent process large lists line-by-line without buffering, and — unlike a bare CSV — the
  meta line means a blocked/`degraded` source is never silently dropped. No-list payloads (e.g.
  `doctor`) emit a single envelope line. Honors `--fields`. Shape frozen for `1.x` (see
  `API-STABILITY.md`).
- **`SIZMO_PROFILE` env var** — select a saved profile without `--profile` on every call
  (precedence: `--profile` flag > `SIZMO_PROFILE` > saved default). Mirrors `AWS_PROFILE`.

### Fixed
- **`--fields` now actually projects `brief` and `pipeline`.** Their list keys (`actions`, `stuck`)
  were missing from the projection set, so `--fields` silently did nothing on them. Now covered,
  plus a guard test that fails if any list-bearing recipe's key drifts out of the set (so the
  silent no-op can't return).

## [1.0.1] — 2026-06-26  **(not published — shipped in 1.1.0)**

### Fixed
- **`auth check` no longer reports "all green" while offline.** The shared scope probe treated a
  transport error (could-not-reach, `code:0`) the same as a real `200` — so on a dropped/flaky
  connection `auth check` printed "6/6 lanes readable · usable" and exited 0, while `doctor` (which
  patched around the same probe) correctly said "OFFLINE". The probe now treats `code:0` as
  unverifiable (not granted) at the source, and `auth check` reports "could not reach GoHighLevel"
  + exits non-zero when every lane is unreachable. Both commands now agree. (Pass-3 fake-green.)
- **Dates/times now render in the location's own timezone, not a hardcoded `Asia/Manila`.**
  `brief`, `snapshot`, `noshow`, and `booked-not-paid` showed every date in Manila time regardless
  of where the GoHighLevel location actually is — so a US/UK/AU client could see the wrong day in
  the `brief` header and Manila-shifted appointment times. The timezone now comes from the synced
  CRM model's location (it was already stored); when no model/timezone is available it still falls
  back to `Asia/Manila`, so existing PH users are unchanged. (Human output only — no contract change.)
- CHANGELOG: the 1.0.0 entry said CI runs on "Node 20 + 22" in one line and "22 + 24" in another;
  the real matrix is 22 + 24.

### Documentation
- Documented the already-shipped token-lean flags `--fields` (project list items to named keys, on
  every list-bearing recipe) and `--concise` (leaner `brief` payload) in the README + API-STABILITY,
  and froze them under `1.x`. No code change — these shipped earlier but were undocumented; they're
  the lowest-token way for an agent to consume sizmo.

### Security
- Completed the URL-encoding hardening started in 0.9.0: `encodeURIComponent` is now applied to
  every user-supplied id interpolated into a request path — `appointment cancel <apptId>`,
  `note <contactId>`, `opp move/update <oppId>`, and the `triage` conversation fetch. 0.9.0 had only
  covered location ids; a malformed/hand-edited id can no longer alter a request's path or query.

## [1.0.0] — 2026-06-17

First stable release. 1.0 is a **trust + stability commitment**, not new features — the public
contract is now frozen under semver (see `API-STABILITY.md`). Everything below is the trust
scaffolding that makes the existing CLI dependable.

### Added
- `SECURITY.md` — security policy, threat model, and verifiable guarantees (zero-deps,
  PIT-never-in-argv, money-never-moves, no-telemetry), each with a self-audit recipe.
- `CHANGELOG.md` — this file; release history backfilled from 0.4.0.
- `scripts/prepublish-gate.mjs` — wired into `prepublishOnly`; **aborts `npm publish`** unless the
  git tree is clean and HEAD is tagged `vX.Y.Z` matching `package.json`. Closes the loophole that
  let 0.7.0–0.9.0 ship while git was stuck at 0.6.0. No bypass flag.
- `CONTRIBUTING.md` — documented the release ritual; corrected the stale "never writes" claim
  (confirm-gated operational writes exist since 0.6.0; money still never moves).
- CI — GitHub Actions (`.github/workflows/ci.yml`): runs `node --test` on Node 22 + 24 on every
  push/PR, plus a generic gitleaks secret scan. CI / npm / zero-deps badges in the README.
- `API-STABILITY.md` — the frozen public contract for 1.x: exit codes, the two JSON contracts
  (data-command envelope + per-verb router shapes), `schemaVersion` policy, flag/command stability,
  and an explicit list of what is NOT covered (human output, stderr, internal modules).
- `docs/maintainers/api-versions.md` — where the GHL API date-version pins live, the deprecation
  watch, the bump procedure, and the Node-floor policy.

### Changed
- **Node floor raised to `>=22`** (current Active LTS; Node 20 reached end-of-life). `engines` is
  advisory — a user on an older Node gets an npm warning, not a failure. CI matrix is now 22 + 24.
- README now opens with a **"Why sizmo"** section (vs the GHL web UI / the official MCP server /
  Zapier-style automation) — the reason-to-choose, not just a feature list.

### Fixed
- **brief no longer fakes "all clear" on a wrong/expired PIT.** When a data source is blocked, the
  headline reads `No leaks in readable data · ⚠ partial` (not a falsely-complete "No leaks found")
  and the footnotes point to `sizmo doctor`. Found via a 1.0 unhappy-path review.

## [0.9.0] — 2026-06-15

### Added
- Zero-dependency **update notifier**: a once-a-day npm-registry check that prints a one-line
  "newer version available" nudge to stderr. Cached 24h, fail-silent/offline-safe, never under
  `--json` or when piped. Opt out with `--no-update-check`, `NO_UPDATE_NOTIFIER`, or
  `SIZMO_NO_UPDATE_CHECK`. No telemetry — a plain GET that sends nothing about you.
- `sizmo doctor` now reports a **CLI VERSION** line (cache-read-only; never gates health).
- `lib/money.mjs` — single source of truth for currency symbols + money formatting.

### Changed
- Currency formatting unified across all 7 commands that render money (previously duplicated).

### Fixed
- Currency symbol drift: an AUD/CAD amount rendered `A$`/`C$` in the brief headline but `AUD `/`CAD `
  in the ranked line — both now resolve from one symbol table.
- Removed dead never-billed code in `brief` (was never collected and could never rank).

### Security
- `encodeURIComponent` applied to every location-id URL interpolation in `lib/model.mjs`
  (defense-in-depth against a malformed/hand-edited location id corrupting a request).

## [0.8.0] — 2026-06-15

### Fixed
- **Currency honesty:** the `brief` headline summed an amount but labelled it with the *model's*
  currency symbol — a ₱ figure could display as `$`. The headline symbol now follows the amount's
  own currency.
- **Exit-code consistency:** `sizmo doctor` now treats a blocked `contacts` scope as a usability
  floor and exits `AUTH`, matching `sizmo auth check`.

### Security
- Profile file (`profiles.json`, holds the PIT) is now written **atomically at mode 0600** —
  temp file created owner-only then renamed, removing a brief window where it was world-readable
  and preventing a half-written file on crash.
- `encodeURIComponent` on location id in the scope-probe and doctor connectivity check.

### Changed
- Tightened several tests that were too weak to catch a regression (fake-green guard).

## [0.7.0] — 2026-06-14

### Added
- `sizmo init` — guided activation: prints the GHL path + exact scope copy-block, takes the token
  from stdin only, writes the profile, and auto-runs `doctor`. Agent-drivable non-interactively.
- `sizmo doctor` — one-shot health diagnosis (scopes, location reachability, CRM-model freshness),
  with an exact fix line per blocked scope. Never reports green when a lane is blocked.
- Share-worthy `brief`: an honest headline (`<currency>X found · N need you today`) plus
  `--format slack|md`. The `--json` envelope is unchanged — human render only.

## [0.6.0] — 2026-06-14

### Added
- **Operational writes** — `tag`, `note`, `opp`, `appointment`, `send`. Every write requires
  `--confirm`; without it the CLI prints the exact change + a rerun command and exits 5. Money
  endpoints (charge/collect/refund/invoice-issue) are deliberately excluded.
- Per-profile **memory**: "what changed vs last run" deltas, plus `ack`/`snooze` to hide handled
  items. All local — no GHL writes.
- Token-lean flags: global `--concise` and `--fields` projection.

### Changed
- `brief --json` payload trimmed ~87% (use `--verbose` to restore the raw sources blob).

## [0.5.0] — 2026-06-13

### Added
- Local **CRM model** — `sizmo sync` caches slow-changing structure (pipelines/stages, calendars,
  tags, custom fields, users, location) under `~/.config/sizmo/`.
- `sizmo crm` query surface (counts, lists, per-entity staleness).
- An id→name resolver that never fabricates: a cache miss renders `<unknown:id — run sizmo sync>`.

### Changed
- Recipes read structure from the local model instead of re-fetching it every run; currency comes
  from the location, not a hardcoded value.

## [0.4.1] — 2026-06-13

### Fixed
- Post-launch patch fixes following the initial public release.

## [0.4.0] — 2026-06-13

### Added
- Initial public release. Read-only GoHighLevel recipes: `brief`, `snapshot`, `triage`, `pipeline`,
  `noshow`, `receivables`, `reconcile`, `booked-not-paid`, `focus`, `segment`.
- Private Integration Token (PIT) auth via stdin/env (never argv); multi-profile config.
- Stable `--json` envelope (`schemaVersion: 1`); `sizmo auth status` / `auth check` / `schema`.

[Unreleased]: https://github.com/csalamida/sizmo-ghl-cli/compare/v2.4.5...HEAD
[2.4.5]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.4.5
[2.4.4]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.4.4
[2.4.3]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.4.3
[2.4.2]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.4.2
[2.4.1]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.4.1
[2.4.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.4.0
[2.3.1]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.3.1
[2.3.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.3.0
[2.2.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.2.0
[2.1.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.1.0
[2.0.2]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.0.2
[2.0.1]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.0.1
[2.0.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v2.0.0
[1.4.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v1.4.0
[1.3.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v1.3.0
[1.2.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v1.2.0
[1.1.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v1.1.0
[1.0.1]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v1.0.1
[1.0.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v1.0.0
[0.9.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v0.9.0
[0.8.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v0.8.0
[0.7.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v0.7.0
[0.6.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v0.6.0
[0.5.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v0.5.0
[0.4.1]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v0.4.1
[0.4.0]: https://github.com/csalamida/sizmo-ghl-cli/releases/tag/v0.4.0
