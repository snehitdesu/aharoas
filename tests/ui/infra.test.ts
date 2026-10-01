/**
 * Frontend infrastructure: API client error mapping, poller guarantees, and
 * middleware protection of operator routes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { api, ApiError, buildUrl, describeError } from "@/lib/api/client";
import { createPoller } from "@/lib/polling";
import { middleware } from "@/middleware";
import { PATH_HEADER, SESSION_COOKIE, safeReturnPath } from "@/constants/auth";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("API client", () => {
  it("unwraps success and sends the Idempotency-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true, data: { id: "o1" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await api("/api/orders", { method: "POST", body: { a: 1 }, idempotencyKey: "pos-123456789" })).toEqual({ id: "o1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/orders");
    expect(init.headers["Idempotency-Key"]).toBe("pos-123456789");
    expect(init.credentials).toBe("same-origin");
    expect(buildUrl("/x", { a: 1, b: undefined, c: "" })).toBe("/x?a=1");
  });

  it("maps HTTP failures to typed errors", async () => {
    const cases: Array<[number, string]> = [[401, "unauthorized"], [403, "forbidden"], [409, "conflict"], [422, "validation"], [500, "server"]];
    for (const [status, kind] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status, { ok: false, error: { code: "E", message: "msg", details: { field: 1 } } })));
      const e = await api("/api/x").catch((x: ApiError) => x) as ApiError;
      expect(e).toBeInstanceOf(ApiError);
      expect(e.kind).toBe(kind);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(429, { ok: false, error: { code: "RateLimitError", message: "slow" } }, { "retry-after": "30" })));
    const limited = await api("/api/x").catch((x: ApiError) => x) as ApiError;
    expect(limited.retryAfterSeconds).toBe(30);
    expect(describeError(limited)).toBe("Too many requests. Try again in 30s.");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const offline = await api("/api/x").catch((x: ApiError) => x) as ApiError;
    expect(offline.kind).toBe("network");
    expect(describeError(new ApiError(500, "X", "stack trace leak"))).toBe("Something went wrong on the server. Please try again.");
  });
});

describe("poller", () => {
  it("never overlaps requests, pauses while hidden, and drops stale responses", async () => {
    vi.useFakeTimers();
    let visible = true;
    let visCb: () => void = () => undefined;
    const resolvers: Array<(v: number) => void> = [];
    const fetches = vi.fn(() => new Promise<number>((r) => resolvers.push(r)));
    const onData = vi.fn();
    const p = createPoller({ fetch: fetches, intervalMs: 1000, onData, isVisible: () => visible, onVisibilityChange: (cb) => ((visCb = cb), () => undefined) });

    p.start();
    expect(fetches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // first request still pending: no second request
    expect(fetches).toHaveBeenCalledTimes(1);
    resolvers[0](1);
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenLastCalledWith(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetches).toHaveBeenCalledTimes(2);

    // A refresh while request #2 is in flight: #2's late answer must be ignored.
    const refreshing = p.refresh();
    resolvers[1](2);
    resolvers[2](3);
    await refreshing;
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).not.toHaveBeenCalledWith(2);
    expect(onData).toHaveBeenLastCalledWith(3);

    visible = false;
    visCb();
    const before = fetches.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetches.mock.calls.length).toBe(before); // paused while hidden
    visible = true;
    visCb();
    expect(fetches.mock.calls.length).toBe(before + 1); // immediate refresh on return

    p.stop();
    resolvers.at(-1)!(99);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onData).not.toHaveBeenCalledWith(99);
  });
});

describe("middleware", () => {
  const req = (path: string, cookie?: string) => new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {} });

  it("sends unauthenticated operators to login with a return path", () => {
    for (const path of ["/pos", "/kitchen", "/dashboard"]) {
      const res = middleware(req(path));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`http://localhost/login?next=${encodeURIComponent(path)}`);
    }
    expect(middleware(req("/pos", "token")).headers.get("location")).toBeNull();
  });

  it("forwards the requested path for the server-side session check, overwriting any client value", () => {
    // The request-header override travels as x-middleware-request-<name> on the NextResponse.next() result.
    const spoofed = new NextRequest("http://localhost/finance/expenses", { headers: { cookie: `${SESSION_COOKIE}=stale`, [PATH_HEADER]: "https://evil.example" } });
    const res = middleware(spoofed);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe("/finance/expenses");
  });

  it("post-login return paths never leave the origin (browser URL rules)", () => {
    const bs = String.fromCharCode(92);
    for (const bad of ["//evil.example", `/${bs}evil.example`, `/${bs}${bs}evil.example`, "/	/evil.example", "https://evil.example", "evil.example", "", null, undefined]) {
      expect(safeReturnPath(bad as string | null | undefined), String(bad)).toBe("/dashboard");
    }
    expect(safeReturnPath("/finance/expenses")).toBe("/finance/expenses");
    expect(safeReturnPath("/menu/items/abc?tab=x")).toBe("/menu/items/abc?tab=x");
  });

  it("rejects unauthenticated API calls but leaves auth and webhooks open", async () => {
    const r = middleware(req("/api/orders"));
    expect(r.status).toBe(401);
    expect(middleware(req("/api/auth/login")).status).toBe(200);
    expect(middleware(req("/api/webhooks/pos/mock")).status).toBe(200);
    expect(middleware(req("/api/health")).status).toBe(200); // probes carry no session
  });
});
