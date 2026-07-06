# Daily Loop — Correctness Sweep
**Date:** 2026-07-06
**Branch:** daily-loop/2026-07-06-correctness
**Version:** 2.4.7
**Result: ALL CLEAN — no bugs found, no fixes applied**

---

## Commands Tested

Picked based on recency of fixes (CHANGELOG 2.4.7/2.4.1) and coverage gaps. Each verified via an
independent read-back method — never trusting sizmo's own success message alone.

---

### Test 1 — `sizmo note`: noteId correctness (2.4.7 fix)

**What 2.4.7 fixed:** `noteId` in `--json` was always `null` because code read `r.j?.id` (flat)
instead of `r.j?.note?.id` (GHL's nested envelope).

**Command run:**
```
sizmo note 1nCua6LUkJZyHcGpleBs --text "SIZMO-VERIFY daily-loop correctness 2026-07-06" --confirm --json
```

**Output:**
```json
{ "status": "ok", "command": "note", "contactId": "1nCua6LUkJZyHcGpleBs", "noteId": "l8wVljjIdiYmNyHYXmnt" }
```

**Independent verification** (raw API read-back via `sizmo api --no-loc`):
```
sizmo api "/contacts/1nCua6LUkJZyHcGpleBs/notes" --no-loc --json
```
Response: `notes[0].id = "l8wVljjIdiYmNyHYXmnt"` — matches exactly.

**Result: PASS.** `noteId` is non-null and matches the real GHL record id.

---

### Test 2 — `sizmo contact upsert --tag`: tag merge not replace (2.4.7 fix)

**What 2.4.7 fixed:** Upserting an existing contact with `--tag X` replaced its entire tag list
with just `[X]` — verified live as data-loss. Fixed: upsert now looks up existing tags and merges.

**Setup:** Contact created with tags `verify-tag-A, verify-tag-B`.

**Command run:**
```
sizmo contact upsert --email "sizmo-verify-correctness-07-06@test.invalid" --tag "verify-tag-C" --confirm --json
```

**Output:**
```json
{ "status": "ok", "command": "contact upsert", "contactId": "1nCua6LUkJZyHcGpleBs", "created": false, "updated": true }
```

**Independent verification** (raw API read-back):
```
sizmo api "/contacts/1nCua6LUkJZyHcGpleBs" --no-loc --json
```
Response: `"tags": ["verify-tag-a", "verify-tag-b", "verify-tag-c"]` — 3 tags, all 3 preserved.

**Result: PASS.** Tag merge works. Pre-fix behavior (replace with 1 tag) is gone.

---

### Test 3 — `sizmo api --no-loc`: locationId injection suppression (2.4.7 feature)

**What 2.4.7 added:** `--no-loc` flag prevents auto-injection of `locationId` query param, which
causes 422 on sub-resource endpoints that reject unknown params.

**Without `--no-loc`** (control — confirms the problem):
```
sizmo api "/contacts/1nCua6LUkJZyHcGpleBs/notes" --json
```
Response: `HTTP 422 — {"message":["property locationId should not exist"],"error":"Unprocessable Entity"}`

**With `--no-loc`:**
```
sizmo api "/contacts/1nCua6LUkJZyHcGpleBs/notes" --no-loc --json
```
Response: `{ "notes": [{ "id": "l8wVljjIdiYmNyHYXmnt", ... }] }` — 200 OK.

**Result: PASS.** `--no-loc` correctly suppresses injection; without it, 422 confirms injection
happens by default on paths without `locationId`.

---

### Test 4 — `sizmo opp create` + `sizmo opp move` (2.4.1 + 2.4.7 fix area)

**What 2.4.1 fixed:** Both commands never worked — wrong field name `stageId` (GHL requires
`pipelineStageId`) and missing `locationId` in body.
**What 2.4.7 added:** stale-cache fallback for pipeline/stage resolution.

**Command run (create):**
```
sizmo opp create --name "DAILY-LOOP-verify-2026-07-06" --pipeline "Sizmo Sales Pipeline" --stage "New Lead" --contact 1nCua6LUkJZyHcGpleBs --value 1 --confirm --json
```
Output: `opportunityId: "9US6Wc5S4kok1I8oy72x"`

**Independent verification (create):**
```
sizmo api "/opportunities/9US6Wc5S4kok1I8oy72x" --no-loc --json
```
Response:
- `pipelineId: "N8PQjl7SGeCbfKofmoZR"` = Sizmo Sales Pipeline ✓
- `pipelineStageId: "51bd76e1-8cf2-431d-8768-86dec0e6e575"` = New Lead ✓
- `monetaryValue: 1` ✓
- `contactId: "1nCua6LUkJZyHcGpleBs"` ✓

**Command run (move):**
```
sizmo opp move 9US6Wc5S4kok1I8oy72x --stage "Engaged/Replied" --confirm --json
```
Output: `stageId: "1620876c-dd59-4057-9cdb-785f6ed200f7"`

**Independent verification (move):**
```
sizmo api "/opportunities/9US6Wc5S4kok1I8oy72x" --no-loc --json
```
Response: `pipelineStageId: "1620876c-dd59-4057-9cdb-785f6ed200f7"` = Engaged/Replied ✓

**Result: PASS.** Both create and move work end-to-end; stage change reflected in GHL.

*Note: Opportunity `9US6Wc5S4kok1I8oy72x` ("DAILY-LOOP-verify-2026-07-06") left in Sizmo Sales
Pipeline — no delete command exists for opportunities.*

---

### Test 5 — `sizmo list` custom values display (2.4.7 fix)

**What 2.4.7 fixed:** Custom Values showed `✖` (the "missing scope" glyph) because it's fetched
live (not cached), not because scope was missing. Fixed to show `·`.

**Command run:**
```
sizmo list
```

**Output (relevant line):**
```
Custom Values      ·    sizmo list values  (live)
```

**Result: PASS.** Shows `·`, not `✖`.

---

## Cleanup

- Contact `1nCua6LUkJZyHcGpleBs` (SIZMO-VERIFY-correctness-07-06) — **deleted**
- Opportunity `9US6Wc5S4kok1I8oy72x` (DAILY-LOOP-verify-2026-07-06) — **left in place** (no delete
  command; clearly prefixed for identification)

---

## Summary

5 commands tested, 5 PASS. All 2.4.7 and 2.4.1 fixes confirmed working against a real GoHighLevel
account. No regressions detected, no new bugs found. No code changes this run.
