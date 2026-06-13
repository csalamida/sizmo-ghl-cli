# segment — find contacts by criteria

## What it answers

"Which contacts match this combination of criteria?" Filters your contact list by tag, phone presence, creation date, or tag absence. Returns a sample of matching contacts and a total count.

## Command

```sh
sizmo segment --tag "vip"
sizmo segment --no-phone
sizmo segment --tag "lead" --created-days 7
sizmo segment --without-tag "contacted" --has-phone
sizmo segment --no-tags
sizmo segment --top 50 --json
sizmo segment --profile myclient
```

Flags (verified from `meta` in `commands/segment.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--tag` | str | — | Must have this tag (case-insensitive) |
| `--without-tag` | str | — | Must NOT have this tag (case-insensitive) |
| `--no-tags` | bool | false | Contacts with zero tags |
| `--created-days` | int | — | Created within N days |
| `--has-phone` | bool | false | Must have phone number |
| `--no-phone` | bool | false | Must NOT have phone number |
| `--top` | int | 20 | Max rows to show in sample |

Flags can be combined. All criteria are ANDed.

## How it works

Paginates all contacts to completion before applying filters. Tag matching is case-insensitive. The result includes a total match count plus a sample capped at `--top`.

## Sample output shape (example — no live creds in this context)

```
  SEGMENT: tag=vip, no-phone
  Total matching: 8

  1. Maria Santos       (no phone)    tags: vip, inquiry
  2. Juan dela Cruz     (no phone)    tags: vip
  3. Carlo Reyes        (no phone)    tags: vip, paid
```

*Sample shape only.*

## Notes

- The CLI never writes a tag or modifies a contact. Read-only.
- `--no-tags` and `--tag` are mutually exclusive in practical use — a contact with zero tags cannot also have a specific tag.
- Pagination exhausts all contacts before filtering. For large locations (10k+ contacts) this may take a few seconds.
- `--top N` caps the display sample, not the total count. The total count in the output reflects all matching contacts.
