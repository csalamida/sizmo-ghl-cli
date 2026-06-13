// lib/paginate.mjs — strategy-driven, fetch-to-completion. The structural fix for shallow single-page reads.
export async function* paginate({ fetchPage, getItems, nextCursor, maxPages = 100, startCursor } = {}) {
  let cursor = startCursor, pages = 0;
  while (pages < maxPages) {
    const resp = await fetchPage(cursor);
    pages++;
    const items = getItems(resp) || [];
    for (const it of items) yield it;
    const next = nextCursor(resp, items, cursor);
    if (next == null) return;
    cursor = next;
  }
}
