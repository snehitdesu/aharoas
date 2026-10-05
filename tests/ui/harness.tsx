/**
 * Shared DOM-test harness for back-office screens: a recording fetch mock
 * routed by "METHOD /path", and a render helper that provides the operator
 * shell (outlets + permissions) and toasts. Not a test file itself.
 */
import { vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ShellProvider } from "@/lib/shellContext";
import { ToastProvider } from "@/components/ui/Toast";
import type { ShellData } from "@/lib/auth/shell";
import type { Permission } from "@/server/auth/rbac";

export type Call = { url: string; path: string; query: URLSearchParams; method: string; body: any; headers: Record<string, string> };
export type Routes = Record<string, (c: Call) => unknown>;

export const state: { calls: Call[]; routes: Routes } = { calls: [], routes: {} };

/** Respond with an API error envelope from a route handler. */
export const fail = (status: number, code: string, message: string, details?: unknown) => ({ __status: status, error: { code, message, details } });

export function installFetch() {
  state.calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, "http://localhost");
    const c: Call = { url, path: u.pathname, query: u.searchParams, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
    state.calls.push(c);
    const h = state.routes[`${c.method} ${c.path}`];
    if (!h) return new Response(JSON.stringify({ ok: false, error: { code: "NotFoundError", message: `no mock for ${c.method} ${c.path}` } }), { status: 404 });
    const r = h(c) as { __status?: number; error?: unknown } | undefined;
    if (r && typeof r === "object" && "__status" in r) return new Response(JSON.stringify({ ok: false, error: r.error }), { status: r.__status });
    if (r instanceof Response) return r;
    return new Response(JSON.stringify({ ok: true, data: r }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

export function teardown() {
  cleanup();
  vi.unstubAllGlobals();
}

export const OUT_A = "out-a";
export const OUT_B = "out-b";
export const ME = "u1";

export function shell(permissions: Permission[], outletId = OUT_A, orgWide = false): ShellData {
  return {
    user: { id: ME, name: "Asha", email: "a@x" }, roles: ["MANAGER"], orgWide, permissions, outletId,
    outlets: [{ id: OUT_A, code: "A1", name: "Andheri", timezone: "Asia/Kolkata" }, { id: OUT_B, code: "B1", name: "Bandra", timezone: "Asia/Kolkata" }],
  };
}

export const renderAs = (ui: React.ReactNode, permissions: Permission[], opts: { outletId?: string; orgWide?: boolean } = {}) =>
  render(<ToastProvider><ShellProvider shell={shell(permissions, opts.outletId ?? OUT_A, opts.orgWide)}>{ui}</ShellProvider></ToastProvider>);

export const posts = () => state.calls.filter((c) => c.method !== "GET");
export const gets = (path: string) => state.calls.filter((c) => c.method === "GET" && c.path === path);

/** jsdom drops a trailing "." while typing into type=number inputs; set such values directly. */
export const setValue = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
