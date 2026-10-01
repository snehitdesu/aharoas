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
 * - CSRF defence-in-depth: state-changing requests with a cross-origin Origin
 *   header are rejected (the cookie is also SameSite=Lax).
 * - Errors are mapped by `fail` (typed domain errors -> status; Zod -> 422;
 *   internals never leak).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE } from "@/constants/auth";
import { resolveFromToken, type CurrentUser } from "@/server/auth/current-user";
import { type AccessContext, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/server/db/scope";
import { ok, fail } from "@/server/api/respond";
import { enforceRateLimit, type RatePolicy } from "@/server/api/rateLimit";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type HandlerArgs = { ctx: AccessContext; user: CurrentUser; params: Record<string, string>; query: Record<string, string>; body: unknown; req: NextRequest };
export type Route = { method: Method; path: string; handler: (a: HandlerArgs) => Promise<unknown>; rateLimit?: RatePolicy };

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

export function createRouter(routes: Route[]) {
  const compiled = routes.map((r) => ({ ...r, segs: r.path.split("/").filter(Boolean) }));
  const dispatch = (method: Method) => async (req: NextRequest, context: { params: Promise<{ path?: string[] }> }) => {
    try {
      const segs = (await context.params).path ?? [];
      const candidates = compiled.map((r) => ({ r, params: match(segs, r.segs) })).filter((c) => c.params);
      if (!candidates.length) throw new NotFoundError("Unknown endpoint");
      const hit = candidates.find((c) => c.r.method === method);
      if (!hit) return NextResponse.json({ ok: false, error: { code: "MethodNotAllowed", message: `${method} not allowed` } }, { status: 405, headers: { Allow: [...new Set(candidates.map((c) => c.r.method))].join(", ") } });

      const current = await resolveFromToken(req.cookies.get(SESSION_COOKIE)?.value);
      if (!current) throw new UnauthorizedError();
      if (hit.r.rateLimit) await enforceRateLimit(hit.r.rateLimit, current.user.id);

      let body: unknown = undefined;
      if (method !== "GET") {
        assertSameOrigin(req);
        const text = await req.text();
        if (text.length > MAX_BODY) return NextResponse.json({ ok: false, error: { code: "PayloadTooLarge", message: "Payload too large" } }, { status: 413 });
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new ValidationError("Request body must be valid JSON");
          }
        }
      }
      const query = Object.fromEntries(req.nextUrl.searchParams.entries());
      const result = await hit.r.handler({ ctx: current.ctx, user: current.user, params: hit.params!, query, body: body ?? {}, req });
      if (result instanceof Response) return result;
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  };
  return { GET: dispatch("GET"), POST: dispatch("POST"), PATCH: dispatch("PATCH"), DELETE: dispatch("DELETE") };
}
