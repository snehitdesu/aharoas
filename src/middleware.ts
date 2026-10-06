/**
 * Edge middleware: a cheap first line of defense. It only checks for the
 * presence of the session cookie on protected paths — full validation (DB
 * lookup, expiry, RBAC) happens in the route handlers / server components,
 * which is the authoritative check. This keeps the edge free of DB access while
 * still blocking obviously-unauthenticated traffic early.
 */
import { NextResponse, type NextRequest } from "next/server";
import { PATH_HEADER, SESSION_COOKIE } from "@/constants/auth";

// Paths that require a session. Auth + webhook endpoints are intentionally open;
// /api/qr is the anonymous guest-ordering API (table token / order key checked by its services).
const OPEN_API_PREFIXES = ["/api/auth", "/api/webhooks", "/api/health", "/api/qr/"];
// Operator pages that need a session (the page itself validates it server-side).
export const PROTECTED_PAGES = [
  "/dashboard", "/pos", "/kitchen",
  // Phase 6 phone apps
  "/captain", "/manager",
  // back office
  "/reservations", "/tables", "/menu", "/recipes", "/inventory", "/procurement", "/master", "/customers",
  "/staff", "/finance", "/analytics", "/reports", "/exports", "/anomalies", "/notifications", "/settings", "/audit",
  "/account",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname.startsWith("/api/")) {
    if (OPEN_API_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
    if (!hasSession) {
      return NextResponse.json({ ok: false, error: { code: "UnauthorizedError", message: "Authentication required" } }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (PROTECTED_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (!hasSession) {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    // A cookie is present but may be expired / revoked: the server components
    // decide, and need the requested path to send the user back after sign-in.
    // Always overwritten here, so a client-supplied value is never trusted.
    const headers = new Headers(req.headers);
    headers.set(PATH_HEADER, pathname);
    return NextResponse.next({ request: { headers } });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Must cover every PROTECTED_PAGES entry (tests/api/middleware-matcher.test.ts).
    "/api/:path*", "/dashboard/:path*", "/pos/:path*", "/kitchen/:path*", "/captain/:path*", "/manager/:path*",
    "/reservations/:path*", "/tables/:path*", "/menu/:path*", "/recipes/:path*", "/inventory/:path*", "/procurement/:path*", "/master/:path*", "/customers/:path*",
    "/staff/:path*", "/finance/:path*", "/analytics/:path*", "/reports/:path*", "/exports/:path*", "/anomalies/:path*", "/notifications/:path*", "/settings/:path*", "/audit/:path*",
    "/account/:path*",
  ],
};
