/**
 * Tiny table-driven router for thin API route handlers.
 *
 * Each domain exposes one optional catch-all route (`/api/<domain>/[[...path]]`)
 * whose handlers only: authenticate, validate input with Zod, call a service
 * (which enforces RBAC + org/outlet scope), and shape the response. No business
 * logic lives here.
 *
 * - Auth: the session cookie is validated through the same path as everywhere
 *   else (resolveFromToken -> DB-built AccessContext).
 * - Idle timeout: a request flagged as a background poll (x-aharos-background)
 *   is authenticated but does not count as user activity.
 * - Step-up: routes marked `reauth` need a fresh, scoped password confirmation.
 * - CSRF defence-in-depth: state-changing requests with a cross-origin Origin
 *   header are rejected (the cookie is also SameSite=Lax).
 * - Errors are mapped by `fail` (typed domain errors -> status; Zod -> 422;
 *   internals never leak).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { BACKGROUND_HEADER, SESSION_COOKIE, type ReauthScope } from "@/constants/auth";
import { resolveFromToken, type CurrentUser } from "@/server/auth/current-user";
import { requireFreshAuth } from "@/server/auth/reauth";
import { prisma } from "@/server/db/client";
import { type AccessContext, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/server/db/scope";
import { ok, fail } from "@/server/api/respond";
import { clientIp, enforceRateLimit, type RatePolicy } from "@/server/api/rateLimit";
import { applyTimingHeaders, logSlowRequest, newRequestId } from "@/server/observability/timing";
import { withRequestContext, currentRequestContext } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";
import { recordServerError } from "@/server/observability/alerts";
import { beginRequest } from "@/server/ops/lifecycle";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type HandlerArgs = { ctx: AccessContext; user: CurrentUser; params: Record<string, string>; query: Record<string, string>; body: unknown; req: NextRequest };
/**
 * `reauth`: the route is a sensitive action and needs a fresh password
 * confirmation for that scope on the calling session (see server/auth/reauth.ts).
 */
export type Route = { method: Method; path: string; handler: (a: HandlerArgs) => Promise<unknown>; rateLimit?: RatePolicy; reauth?: ReauthScope };

const MAX_BODY = 1_000_000;

// ---------------- shared input schemas ----------------

export const zId = z.string().min(1).max(64);
export const listQuery = z.object({
  outletId: z.string().optional(),
  take: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const outletQuery = z.object({ outletId: z.string().min(1) });
export const dateOf = (v: unknown) => z.coerce.date().parse(v);

function match(segs: string[], pattern: string[]): Record<string, string> | null {
  if (segs.length !== pattern.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = decodeURIComponent(segs[i]);
    else if (pattern[i] !== segs[i]) return null;
  }
  return params;
}

/** Reject browser requests whose Origin is not this host (CSRF defence-in-depth). */
export function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw new ForbiddenError("Cross-origin request rejected");
  } catch (e) {
    if (e instanceof ForbiddenError) throw e;
    throw new ForbiddenError("Invalid Origin header");
  }
}

/** Could some concrete path match both patterns? (Same length; each segment equal or a parameter.) */
function overlaps(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i] || s.startsWith(":") || b[i].startsWith(":"));
}

/**
 * Dispatch takes the FIRST route matching method + path, so a duplicate (or a
 * parameterised pattern placed earlier) would silently shadow a later route —
 * e.g. an unprotected copy of an endpoint that is meant to require step-up
 * re-authentication. Refuse such tables at module load: identical method+path
 * pairs, and overlapping same-method patterns whose protection differs.
 */
export function assertUnambiguousRoutes(routes: Array<Pick<Route, "method" | "path" | "reauth" | "rateLimit">>): void {
  const segs = routes.map((r) => r.path.split("/").filter(Boolean));
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i], b = routes[j];
      if (a.method !== b.method || !overlaps(segs[i], segs[j])) continue;
      const same = segs[i].join("/") === segs[j].join("/");
      if (same || a.reauth !== b.reauth || a.rateLimit !== b.rateLimit) {
        throw new Error(`Ambiguous API routes: ${a.method} "${a.path}" and ${b.method} "${b.path}" can match the same request${same ? "" : " with different protection"}`);
      }
    }
  }
}

export function createRouter(routes: Route[]) {
  assertUnambiguousRoutes(routes);
  const compiled = routes.map((r) => ({ ...r, segs: r.path.split("/").filter(Boolean) }));
  const dispatch = (method: Method) => (req: NextRequest, context: { params: Promise<{ path?: string[] }> }) => {
    const requestId = newRequestId(req.headers.get("x-request-id"));
    return withRequestContext({ requestId, method, path: req.nextUrl.pathname }, () => handle(method, req, context, requestId));
  };
  const handle = async (method: Method, req: NextRequest, context: { params: Promise<{ path?: string[] }> }, requestId: string) => {
    const started = performance.now();
    const path = req.nextUrl.pathname;
    let userId: string | undefined;
    let status = 500;
    // Graceful shutdown: once draining, new requests are refused (the load balancer retries elsewhere).
    const release = beginRequest();
    if (!release) {
      const res = NextResponse.json({ ok: false, error: { code: "ServiceUnavailable", message: "Server is restarting, please retry" } }, { status: 503, headers: { "Retry-After": "5" } });
      applyTimingHeaders(res.headers, requestId, performance.now() - started);
      return res;
    }
    try {
      const segs = (await context.params).path ?? [];
      const candidates = compiled.map((r) => ({ r, params: match(segs, r.segs) })).filter((c) => c.params);
      if (!candidates.length) throw new NotFoundError("Unknown endpoint");
      const hit = candidates.find((c) => c.r.method === method);
      if (!hit) {
        status = 405;
        const res = NextResponse.json({ ok: false, error: { code: "MethodNotAllowed", message: `${method} not allowed` } }, { status: 405, headers: { Allow: [...new Set(candidates.map((c) => c.r.method))].join(", ") } });
        applyTimingHeaders(res.headers, requestId, performance.now() - started);
        return res;
      }

      const background = req.headers.get(BACKGROUND_HEADER) === "1";
      const current = await resolveFromToken(req.cookies.get(SESSION_COOKIE)?.value, { activity: !background });
      if (!current) throw new UnauthorizedError();
      userId = current.user.id;
      const rc = currentRequestContext();
      if (rc) rc.userId = userId;
      if (hit.r.rateLimit) await enforceRateLimit(hit.r.rateLimit, current.user.id);

      let body: unknown = undefined;
      if (method !== "GET") {
        assertSameOrigin(req);
        const text = await req.text();
        if (text.length > MAX_BODY) {
          status = 413;
          const res = NextResponse.json({ ok: false, error: { code: "PayloadTooLarge", message: "Payload too large" } }, { status: 413 });
          applyTimingHeaders(res.headers, requestId, performance.now() - started);
          return res;
        }
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new ValidationError("Request body must be valid JSON");
          }
        }
      }
      // Step-up gate last, immediately before the handler: a request rejected for
      // origin/size/JSON never records a REAUTH_USED for an action that did not run.
      if (hit.r.reauth) {
        await requireFreshAuth(prisma, { session: current.session, organizationId: current.user.organizationId }, hit.r.reauth, { method, path, ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined });
      }
      const query = Object.fromEntries(req.nextUrl.searchParams.entries());
      const result = await hit.r.handler({ ctx: current.ctx, user: current.user, params: hit.params!, query, body: body ?? {}, req });
      const durationMs = performance.now() - started;
      if (result instanceof Response) {
        status = result.status;
        applyTimingHeaders(result.headers, requestId, durationMs);
        logSlowRequest({ requestId, method, path, status, durationMs, userId });
        return result;
      }
      status = 200;
      const res = ok(result);
      applyTimingHeaders(res.headers, requestId, durationMs);
      logSlowRequest({ requestId, method, path, status, durationMs, userId });
      return res;
    } catch (e) {
      const res = fail(e);
      status = res.status;
      const durationMs = performance.now() - started;
      applyTimingHeaders(res.headers, requestId, durationMs);
      logSlowRequest({ requestId, method, path, status, durationMs, userId });
      return res;
    } finally {
      release();
      inc("restora_http_requests_total", { class: `${Math.floor(status / 100)}xx` });
      if (status >= 500) {
        inc("restora_http_5xx_total");
        recordServerError();
      }
    }
  };
  return { GET: dispatch("GET"), POST: dispatch("POST"), PATCH: dispatch("PATCH"), DELETE: dispatch("DELETE") };
}
