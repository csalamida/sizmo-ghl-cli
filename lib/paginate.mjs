// lib/paginate.mjs — strategy-driven, fetch-to-completion. The structural fix for shallow
// single-page reads.
//
// WHY `stats` EXISTS
// The generator used to have exactly one way to finish — `return` — so a caller could not tell
// these two apart:
//   · the server ran out of data                        (the result is COMPLETE)
//   · `maxPages` was reached with more still available  (the result is TRUNCATED)
// Verified 2026-07-28 against a server with unlimited pages and `maxPages: 20`:
//     yielded 2000 items, caller told: nothing
// commands/pipeline.mjs and snapshot's pipelineValue both cap at 20 pages of 100, so an account
// with 2,500 open deals reported the value of 2,000 of them as if that were the whole pipeline —
// a 20% understatement of a money figure, with nothing in the output to hint at it.
//
// `stats` is opt-in so existing callers are unaffected. Pass an object and it is populated:
//     { pages: number, truncated: boolean }
// `truncated: true` means MORE DATA EXISTS and was not fetched. Treat the result as a floor, not
// a total, and say so in the output — this codebase's standing rule is that an incomplete answer
// must never render as a complete one.
export async function* paginate({ fetchPage, getItems, nextCursor, maxPages = 100, startCursor, stats } = {}) {
  let cursor = startCursor, pages = 0;
  if (stats) { stats.pages = 0; stats.truncated = false; }
  while (pages < maxPages) {
    const resp = await fetchPage(cursor);
    pages++;
    if (stats) stats.pages = pages;
    const items = getItems(resp) || [];
    for (const it of items) yield it;
    const next = nextCursor(resp, items, cursor);
    // A null cursor is the honest end of the data — NOT a truncation.
    if (next == null) return;
    cursor = next;
  }
  // Fell out of the loop with a live cursor still in hand: the cap stopped us, not the data.
  if (stats) stats.truncated = true;
}
