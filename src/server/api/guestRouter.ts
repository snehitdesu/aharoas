/**
 * Router for the anonymous guest API (/api/qr/*). Same shape and protections
 * as the staff router (server/api/router.ts) minus the session: no cookie is
 * read or set. Guests are identified only by what the services verify — a
 * table QR token, or an order access key (x-order-key header).
 *
 *  - Rate limits per client IP (reads / writes) plus route-specific limits.
 *  - State-changing requests: cross-origin Origin rejected, body capped.
 *  - Errors mapped by `fail` (no internals leak); responses are never cached.
 */
import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError, ValidationError } from "@/server/db/scope";
import { ok, fail } from "@/server/api/respond";
import { assertSameOrigin, assertUnambiguousRoutes } from "@/server/api/router";
import { RATE_POLICIES, clientIp, enforceRateLimit, type RatePolicy } from "@/server/api/rateLimit";
import { applyTimingHeaders, logSlowRequest, newRequestId } from "@/server/observability/timing";

type Method = "GET" | "POST";
export type GuestHandlerArgs = { params: Record<string, string>; query: Record<string, string>; body: unknown; req: NextRequest; ip: string };
export type GuestRoute = { method: Method; path: string; handler: (a: GuestHandlerArgs) => Promise<unknown>; limits?: Array<{ policy: RatePolicy; key: (a: GuestHandlerArgs) => string }> };

const MAX_BODY = 32_000;

function match(segs: string[], pattern: string[]): Record<string, string> | null {
  if (segs.length !== pattern.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = decodeURIComponent(segs[i]);
    else if (pattern[i] !== segs[i]) return null;
  }
  return params;
}

function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function createGuestRouter(routes: GuestRoute[]) {
  assertUnambiguousRoutes(routes);
  const compiled = routes.map((r) => ({ ...r, segs: r.path.split("/").filter(Boolean) }));
  const dispatch = (method: Method) => async (req: NextRequest, context: { params: Promise<{ path?: string[] }> }) => {
    const started = performance.now();
    const requestId = newRequestId(req.headers.get("x-request-id"));
    const path = req.nextUrl.pathname;
    let status = 500;
    let res: Response;
    try {
      const segs = (await context.params).path ?? [];
      const hit = compiled.map((r) => ({ r, params: match(segs, r.segs) })).find((c) => c.params && c.r.method === method);
      if (!hit) throw new NotFoundError("Unknown endpoint");
      const ip = clientIp(req);
      await enforceRateLimit(method === "GET" ? RATE_POLICIES.guestReadPerIp : RATE_POLICIES.guestWritePerIp, ip);

      let body: unknown = {};
      if (method !== "GET") {
        assertSameOrigin(req);
        const text = await req.text();
        if (text.length > MAX_BODY) {
          status = 413;
          res = NextResponse.json({ ok: false, error: { code: "PayloadTooLarge", message: "Payload too large" } }, { status: 413 });
          applyTimingHeaders(res.headers, requestId, performance.now() - started);
          return noStore(res);
        }
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new ValidationError("Request body must be valid JSON");
          }
        }
      }
      const args: GuestHandlerArgs = { params: hit.params!, query: Object.fromEntries(req.nextUrl.searchParams.entries()), body, req, ip };
      for (const l of hit.r.limits ?? []) await enforceRateLimit(l.policy, l.key(args));
      res = ok(await hit.r.handler(args));
      status = 200;
    } catch (e) {
      res = fail(e);
      status = res.status;
    }
    const durationMs = performance.now() - started;
    applyTimingHeaders(res.headers, requestId, durationMs);
    logSlowRequest({ requestId, method, path, status, durationMs });
    return noStore(res);
  };
  return { GET: dispatch("GET"), POST: dispatch("POST") };
}
