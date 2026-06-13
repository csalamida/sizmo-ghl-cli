# Installation

> Not affiliated with, endorsed by, or supported by HighLevel.

## Requirements

- Node.js 20 or later (`node --version` to check)
- A GoHighLevel Private Integration Token (PIT) with at minimum `contacts.read`, `conversations.read`, `opportunities.read`, `calendars.read`, `invoices.read`, and `payments.read` scopes

## Step 1 — clone and link

```sh
git clone https://github.com/csalamida07-cyber/sizmo-ghl-cli
cd sizmo-ghl-cli
bash install.sh
```

`install.sh` does exactly three things (verified against the actual script):

1. Creates `~/.local/bin` if it does not exist
2. Symlinks `<repo>/bin/sizmo.mjs` → `~/.local/bin/sizmo`
3. `chmod +x`s the bin entry point
4. Warns if `~/.local/bin` is not in `$PATH`

If the PATH warning appears, add to your shell profile:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # zsh
# or
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc  # bash
source ~/.zshrc   # reload
```

Confirm the link works:

```sh
sizmo --version
# 0.4.0
```

## Step 2 — get a PIT from GoHighLevel

1. Open GoHighLevel → Settings → Integrations → Private Integrations
2. Create a new integration — give it a name like "sizmo-read"
3. Grant read-only scopes: `contacts.read`, `conversations.read`, `opportunities.read`, `calendars.read`, `invoices.read`, `payments.read`, `transactions.read`
4. Copy the token (starts with `pit-`)

Never store the PIT in a shell command or history. Always pass via stdin.

## Step 3 — configure a profile

```sh
echo "pit-yourtoken..." | sizmo config set --profile myclient --loc YOUR_LOCATION_ID --pit-stdin
```

- `--profile` — a name for this credential set (e.g. the client's name)
- `--loc` — your GoHighLevel Location ID (found in Settings > Business Profile)
- `--pit-stdin` — reads the PIT from stdin; never from argv

The profile is saved to `~/.config/sizmo/profiles.json` with permissions `0600`.

## Step 4 — verify auth

```sh
sizmo auth status
```

Expected output:

```
auth source   profile
location      your-location-id
PIT           pit-…XXXX  (myclient)
PIT age       day N of 90
```

Then do a live probe:

```sh
sizmo auth check
```

This makes one real API call (`GET /contacts/?limit=1`) to confirm the PIT is accepted for your location. You need a network connection and a valid PIT for this to pass.

## Multi-client setup

Add a second profile for each additional GoHighLevel location:

```sh
echo "pit-secondtoken..." | sizmo config set --profile client2 --loc LOC_B --pit-stdin
sizmo config list         # see all profiles; * marks the default
sizmo config use client2  # switch default
```

Pass `--profile <name>` to any command to target a specific client without switching the default.

## Credential storage

Profiles are stored in `~/.config/sizmo/profiles.json`. The file is created with `chmod 0600` — readable only by your user. PITs are stored in plaintext in that file; protect your home directory accordingly.

To remove a profile:

```sh
sizmo config rm myclient
```

## PIT rotation

PITs expire after 90 days. `sizmo auth status` shows the age — warnings appear at day 80, the expired-zone at day 90.

To rotate:

```sh
echo "pit-newtoken..." | sizmo config set --profile myclient --pit-stdin --created $(date +%Y-%m-%d)
```

`--created` resets the age counter. If omitted, the current date is used automatically when setting a PIT.

## Using environment variables instead of profiles

```sh
export GHL_PIT=pit-yourtoken...
export GHL_LOCATION_ID=your-location-id
sizmo brief
```

Environment variables take precedence over saved profiles.
