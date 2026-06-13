# Multi-client workflow

`sizmo` supports multiple GoHighLevel locations via named profiles. Each profile holds one PIT and one Location ID.

## Setup — one profile per client

```sh
echo "pit-clientA..." | sizmo config set --profile clientA --loc LOC_A --pit-stdin
echo "pit-clientB..." | sizmo config set --profile clientB --loc LOC_B --pit-stdin
echo "pit-clientC..." | sizmo config set --profile clientC --loc LOC_C --pit-stdin
```

## Check all profiles

```sh
sizmo config list
```

Output (verified format from `lib/cli.mjs`):

```
* clientA         loc LOC_A   pit-…AAAA  day 12/90
  clientB         loc LOC_B   pit-…BBBB  day 8/90
  clientC         loc LOC_C   pit-…CCCC  day 45/90
```

`*` marks the default profile (used when `--profile` is not passed).

## Switch default

```sh
sizmo config use clientB
```

## Run a command against a specific client

Pass `--profile` to any command:

```sh
sizmo brief --profile clientA
sizmo brief --profile clientB
sizmo receivables --profile clientC --top 10
```

## Morning sweep across all clients

There is no built-in "run all profiles" command. Use a shell loop:

```sh
for p in clientA clientB clientC; do
  echo "=== $p ===";
  sizmo brief --profile $p --json;
done
```

Or with `--json` piped to a processor:

```sh
for p in clientA clientB clientC; do
  sizmo snapshot --profile $p --json
done
```

## PIT rotation per client

Each PIT expires at 90 days. `sizmo config list` shows `day N/90` for each. Rotate before day 80:

```sh
echo "pit-newtoken..." | sizmo config set --profile clientA --pit-stdin --created $(date +%Y-%m-%d)
sizmo auth check --profile clientA
```

## JSON output for automation

Every command supports `--json --profile <name>`. The envelope includes `"location"` so you can route results by location ID in your processing code:

```json
{
  "schemaVersion": 1,
  "command": "snapshot",
  "location": "LOC_A",
  "data": { ... },
  "degraded": false,
  "warnings": []
}
```
