# Configure a client profile

A profile stores a PIT (Private Integration Token) and Location ID under a name. Use one profile per GoHighLevel location.

## Step 1 — get your PIT

In GoHighLevel: Settings → Integrations → Private Integrations → Create. Grant read-only scopes. Copy the token (starts with `pit-`).

## Step 2 — find your Location ID

In GoHighLevel: Settings → Business Profile. The Location ID is in the URL or displayed in the page. It is a long alphanumeric string.

## Step 3 — save the profile

```sh
echo "pit-yourtoken..." | sizmo config set \
  --profile myclient \
  --loc YOUR_LOCATION_ID \
  --pit-stdin
```

- `--pit-stdin` reads the PIT from stdin — it never touches command-line history or shell logs
- The `--` is optional; any order of flags works
- A `--created` date is set automatically to today (used to track PIT age)

You can also add an optional label:

```sh
echo "pit-yourtoken..." | sizmo config set \
  --profile myclient \
  --loc YOUR_LOCATION_ID \
  --label "Coaching Client - ABC" \
  --pit-stdin
```

## Step 4 — verify

```sh
sizmo auth status --profile myclient
sizmo auth check  --profile myclient
```

`auth status` shows the saved data (source, location, masked PIT, age). `auth check` makes a live API call to confirm the PIT is accepted.

## Update a profile

Re-run `config set` with the same `--profile` name. Fields you specify overwrite; fields you omit are preserved.

```sh
# Update location ID only
sizmo config set --profile myclient --loc NEW_LOC_ID

# Rotate PIT only
echo "pit-newtoken..." | sizmo config set --profile myclient --pit-stdin --created $(date +%Y-%m-%d)
```

## Remove a profile

```sh
sizmo config rm myclient
```

## Using environment variables instead

If you prefer not to use profiles:

```sh
export GHL_PIT=pit-yourtoken...
export GHL_LOCATION_ID=YOUR_LOCATION_ID
sizmo brief
```

Environment variables take precedence over saved profiles. Neither variable is written to disk by sizmo.
