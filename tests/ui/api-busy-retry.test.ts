/**
 * Client resilience (Phase 9): an HTTP 503 (transaction conflict that outlived
 * the server's retries, or an instance draining) is retried automatically —
 * but only for requests that are safe to repeat: reads, and writes carrying an
 * Idempotency-Key. A write without a key is never repeated by the client.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { request, ApiError } from "@/lib/api/client";

const busy = () => new Response(JSON.stringify({ ok: false, error: { code: "Busy", message: "Busy" } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } });
const ok = () => new Response(JSON.stringify({ ok: true, data: { done: true } }), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(responses: Array<() => Response>) {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    return (responses[calls.length - 1] ?? responses[responses.length - 1])();
  }));
  return calls;
}

describe("busy (503) retries", () => {
  it("retries an idempotency-keyed write with the SAME key, then succeeds", async () => {
    vi.useFakeTimers();
    const calls = stubFetch([busy, busy, ok]);
    const p = request<{ done: boolean }>("/api/orders/x/rounds", { method: "POST", idempotencyKey: "round-key-0001", body: { items: [] } });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ done: true });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => (c.headers as Record<string, string>)["Idempotency-Key"] === "round-key-0001")).toBe(true);
  });

  it("gives up after 2 retries and surfaces the 503", async () => {
    vi.useFakeTimers();
    const calls = stubFetch([busy]);
    const p = request("/api/orders", { method: "GET" }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("never repeats a write without an Idempotency-Key", async () => {
    const calls = stubFetch([busy, ok]);
    await expect(request("/api/finance/expenses", { method: "POST", body: { amount: 1 } })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });
});
