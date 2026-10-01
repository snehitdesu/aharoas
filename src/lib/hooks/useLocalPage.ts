"use client";

import { useEffect, useState } from "react";

/**
 * Page through rows already on the client (endpoints that return one bounded
 * list, e.g. the org menu). Same shape as usePaged so <Pager> works unchanged;
 * returns to page 1 whenever `resetKey` (the filters) changes.
 */
export function useLocalPage<T>(rows: T[], size = 50, resetKey = "") {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages);
  return {
    items: rows.slice((current - 1) * size, current * size),
    page: current,
    hasPrev: current > 1,
    hasNext: current < pages,
    prev: () => setPage((p) => Math.max(1, p - 1)),
    next: () => setPage((p) => Math.min(pages, p + 1)),
  };
}
