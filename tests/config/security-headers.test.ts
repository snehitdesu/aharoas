/**
 * Security headers (src/server/config/securityHeaders.mjs, applied by
 * next.config.mjs): exact production/development policy, and that next.config
 * really serves it on every route.
 */
import { describe, it, expect } from "vitest";
import { contentSecurityPolicy, securityHeaders, PERMISSIONS_POLICY } from "@/server/config/securityHeaders.mjs";
import nextConfig from "../../next.config.mjs";

const asMap = (h: { key: string; value: string }[]) => Object.fromEntries(h.map((x) => [x.key, x.value]));
const directives = (csp: string) => Object.fromEntries(csp.split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k, v]; }));

describe("security headers", () => {
  it("production: the full header set including HSTS", () => {
    const h = asMap(securityHeaders({ dev: false }));
    expect(h).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Permitted-Cross-Domain-Policies": "none",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    });
    expect(h["Permissions-Policy"]).toBe(PERMISSIONS_POLICY);
    for (const f of ["camera", "microphone", "geolocation", "payment", "usb", "serial", "hid"]) expect(h["Permissions-Policy"]).toContain(`${f}=()`);
  });

  it("development: no HSTS (localhost would be pinned to HTTPS)", () => {
    const h = asMap(securityHeaders({ dev: true }));
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toBeTruthy();
  });

  it("production CSP: same-origin only, no eval, no plugins, no framing, no foreign form targets", () => {
    const d = directives(contentSecurityPolicy({ dev: false }));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'", "'unsafe-inline'"]); // Next.js inline hydration scripts; no nonce infrastructure
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
    expect(d["connect-src"]).toEqual(["'self'"]); // no exfiltration via fetch/XHR/WebSocket to other origins
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["font-src"]).toEqual(["'self'", "data:"]); // next/font is self-hosted
    // No wildcard / scheme-wide sources anywhere.
    for (const [k, v] of Object.entries(d)) for (const src of v) expect(src, k).not.toMatch(/^\*|^https?:$|^http:\/\//);
  });

  it("development CSP only adds what `next dev` needs (eval for React Refresh, ws: for HMR)", () => {
    const dev = directives(contentSecurityPolicy({ dev: true }));
    const prod = directives(contentSecurityPolicy({ dev: false }));
    expect(dev["script-src"]).toEqual([...prod["script-src"], "'unsafe-eval'"]);
    expect(dev["connect-src"]).toEqual([...prod["connect-src"], "ws:", "wss:"]);
    const rest = (x: Record<string, string[]>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "script-src" && k !== "connect-src"));
    expect(rest(dev)).toEqual(rest(prod));
  });

  it("next.config serves the headers on every path and no-store on the API", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    expect(asMap(all.headers)["Content-Security-Policy"]).toBe(contentSecurityPolicy({ dev: process.env.NODE_ENV !== "production" }));
    expect(asMap(all.headers)["X-Frame-Options"]).toBe("DENY");
    expect(rules.find((r) => r.source === "/api/:path*")!.headers).toEqual([{ key: "Cache-Control", value: "no-store" }]);
  });

  it("Razorpay Checkout hosts are allowed on the guest order pages only, by exact host", async () => {
    const strict = directives(contentSecurityPolicy({ dev: false }));
    const checkout = directives(contentSecurityPolicy({ dev: false, paymentCheckout: true }));
    expect(checkout["script-src"]).toEqual([...strict["script-src"], "https://checkout.razorpay.com"]);
    expect(checkout["frame-src"]).toEqual(["https://api.razorpay.com", "https://checkout.razorpay.com"]);
    expect(checkout["connect-src"]).toEqual([...strict["connect-src"], "https://api.razorpay.com", "https://lumberjack.razorpay.com"]);
    expect(checkout["frame-ancestors"]).toEqual(["'none'"]); // the guest page itself still cannot be framed
    for (const v of Object.values(checkout)) for (const src of v) expect(src).not.toMatch(/\*/);
    const h = asMap(securityHeaders({ dev: false, paymentCheckout: true }));
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
    expect(h["Permissions-Policy"]).toContain('payment=(self "https://api.razorpay.com")');
    expect(h["Permissions-Policy"]).toContain("camera=()");

    const rules = await nextConfig.headers!();
    const all = rules.findIndex((r) => r.source === "/:path*");
    const guest = rules.findIndex((r) => r.source === "/o/:path*");
    expect(guest).toBeGreaterThan(all); // later rules override the same keys
    expect(asMap(rules[guest].headers)["Content-Security-Policy"]).toBe(contentSecurityPolicy({ dev: process.env.NODE_ENV !== "production", paymentCheckout: true }));
    // The rest of the app (back office, POS, guest menu, API) keeps the strict policy.
    expect(asMap(rules[all].headers)["Content-Security-Policy"]).not.toContain("razorpay");
    expect(rules.filter((r) => JSON.stringify(r.headers).includes("razorpay")).map((r) => r.source)).toEqual(["/o/:path*"]);
  });
});
