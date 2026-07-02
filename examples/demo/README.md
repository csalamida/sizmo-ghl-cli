# Demo — "I diffed a GoHighLevel location"

The thing GHL snapshots structurally cannot do: **show you exactly what changed.**

`before.json` and `after.json` are two `sizmo export` documents of the same fictional location
(*Bright Coaching Co* — entirely synthetic, no real CRM data). Between them a teammate:

- added a **Renewals** pipeline and a **Negotiation** stage to Sales,
- renamed the **Coaching Goal** field → **Primary Coaching Goal**,
- changed the **Booking Link** custom value,
- removed the **cold-lead** tag.

Run the diff yourself:

```bash
sizmo diff before.json after.json
```

```
  1 added · 1 removed · 3 changed

  pipelines  (+1 −0 ~1)
    + Renewals  pl_renew
    ~ Sales
        stages: … "Proposal Sent","Won" → "Proposal Sent","Negotiation","Won"

  customFields  (+0 −0 ~1)
    ~ Primary Coaching Goal
        name: "Coaching Goal" → "Primary Coaching Goal"

  customValues  (+0 −0 ~1)
    ~ Booking Link
        value: "…/intro" → "…/book"

  tags  (+0 −1 ~0)
    − cold-lead  tg_cold
```

In real use the "after" side is **live** — `sizmo diff location.json` compares your saved file
against the location as it is right now, so you can see (or review) a change before it bites you.

## Recording

`diff-demo.cast` is an [asciinema](https://asciinema.org) recording. Replay it:

```bash
asciinema play diff-demo.cast
```

To turn it into a GIF for social/README embedding, install [`agg`](https://github.com/asciinema/agg)
and run:

```bash
agg diff-demo.cast diff-demo.gif
```
