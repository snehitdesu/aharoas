"use client";

/**
 * Data hooks for back-office screens (thin wrappers over `api`):
 *  - useQuery: one GET, re-run when path/query change, stale responses dropped
 *    (AbortController), explicit reload.
 *  - usePaged: cursor pagination over `{ items, nextCursor }` endpoints with a
 *    cursor stack (prev/next), reset whenever the filters change.
 *  - useAction: run a mutation once at a time, toast success/failure.
 * No business logic lives here; the server stays authoritative.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError, type RequestOptions } from "@/lib/api/client";
import { useToast } from "@/components/ui/Toast";

export type Query = RequestOptions["query"];

export type QueryState<T> = { data: T | undefined; error: unknown; loading: boolean; reload: () => void; setData: (updater: (prev: T | undefined) => T | undefined) => void };

export function useQuery<T>(path: string | null, query?: Query): QueryState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path));
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(query ?? {});

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { query: JSON.parse(key) as Query, signal: ctrl.signal })
      .then((d) => {
        if (!ctrl.signal.aborted) setDataState(d);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && (e as { name?: string })?.name !== "AbortError") setError(e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((updater: (prev: T | undefined) => T | undefined) => setDataState(updater), []);
  return { data, error, loading, reload, setData };
}

export type Page<T> = { items: T[]; nextCursor: string | null };

export type PagedState<T> = {
  items: T[];
  loading: boolean;
  error: unknown;
  page: number;
  hasNext: boolean;
  hasPrev: boolean;
  next: () => void;
  prev: () => void;
  reload: () => void;
};

/**
 * Cursor pagination: page N is fetched with the cursor returned by page N-1.
 * `shape: "array"` supports endpoints that return a bare array paged by
 * `take` + `cursor` (= id of the last row): a full page implies a next page.
 */
export function usePaged<T extends { id?: string }>(path: string | null, query?: Query, take = 25, opts: { shape?: "page" | "array" } = {}): PagedState<T> {
  const key = JSON.stringify(query ?? {});
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  // Filters changed -> back to page 1.
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    if (cursors.length !== 1) setCursors([undefined]);
  }
  const cursor = cursors[cursors.length - 1];
  const q = useQuery<Page<T> | T[]>(path, { ...(JSON.parse(key) as object), take, cursor });
  const page: Page<T> | undefined = Array.isArray(q.data)
    ? { items: q.data, nextCursor: opts.shape === "array" && q.data.length >= take ? (q.data[q.data.length - 1]?.id ?? null) : null }
    : q.data;
  const nextCursor = page?.nextCursor ?? null;
  return {
    items: page?.items ?? [],
    loading: q.loading,
    error: q.error,
    page: cursors.length,
    hasNext: Boolean(nextCursor) && !q.loading,
    hasPrev: cursors.length > 1 && !q.loading,
    next: () => nextCursor && setCursors((c) => [...c, nextCursor]),
    prev: () => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
    reload: q.reload,
  };
}

/**
 * Serialize a mutation: while one runs, further calls are ignored (no double
 * submits). Success/failure are announced via toasts; the thrown error is
 * re-raised so forms can show field errors.
 */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = useCallback(
    async <R,>(fn: () => Promise<R>, opts: { success?: string; rethrow?: boolean } = {}): Promise<R | undefined> => {
      if (running.current) return undefined;
      running.current = true;
      setBusy(true);
      try {
        const r = await fn();
        if (opts.success) toast.show(opts.success, "ok");
        return r;
      } catch (e) {
        if (opts.rethrow) throw e;
        toast.show(describeError(e), "bad");
        return undefined;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [toast]
  );
  return { run, busy };
}

/**
 * Load every page of a `{ items, nextCursor }` endpoint (bounded by `cap`
 * rows) — for pickers / id->name lookups over small master tables. Returns the
 * rows plus a by-id map. `truncated` tells the UI the cap was hit.
 */
export function useAll<T extends { id: string }>(path: string | null, query?: Query, cap = 1000) {
  const [state, setState] = useState<{ items: T[]; loading: boolean; error: unknown; truncated: boolean }>({ items: [], loading: Boolean(path), error: null, truncated: false });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(query ?? {});
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const out: T[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await api<Page<T> | T[]>(path, { query: { ...(JSON.parse(key) as object), take: 200, cursor }, signal: ctrl.signal });
        const rows = Array.isArray(page) ? page : page.items;
        out.push(...rows);
        const next = Array.isArray(page) ? null : page.nextCursor;
        if (!next || out.length >= cap) return { items: out.slice(0, cap), truncated: Boolean(next) };
        cursor = next;
      }
    })()
      .then((r) => !ctrl.signal.aborted && setState({ ...r, loading: false, error: null }))
      .catch((e) => !ctrl.signal.aborted && (e as { name?: string })?.name !== "AbortError" && setState({ items: [], loading: false, error: e, truncated: false }));
    return () => ctrl.abort();
  }, [path, key, cap, tick]);
  const byId = useMemo(() => new Map(state.items.map((r) => [r.id, r])), [state.items]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, byId, reload };
}
