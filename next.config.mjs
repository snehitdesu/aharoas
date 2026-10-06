import { securityHeaders as buildSecurityHeaders } from "./src/server/config/securityHeaders.mjs";

// Development keeps 'unsafe-eval' + ws: (HMR) in the CSP; production adds HSTS.
const securityHeaders = buildSecurityHeaders({ dev: process.env.NODE_ENV !== "production" });
// Guest order pages (/o/<orderId>) run Razorpay Checkout: its hosts are allowed there and nowhere else.
const checkoutHeaders = buildSecurityHeaders({ dev: process.env.NODE_ENV !== "production", paymentCheckout: true });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The desktop build (npm run desktop:build) packages the self-contained server
  // that `output: "standalone"` produces; `next start` / the web build are unchanged.
  // It builds into its own directory so a `next dev` running in the same checkout
  // (which writes to .next) cannot mix its chunks into the packaged server.
  ...(process.env.AHAROS_STANDALONE === "1" ? { output: "standalone", distDir: ".next-desktop" } : {}),
  // The download route reads dist-desktop/ under `next dev` only (src/site/release.ts), but the
  // file tracer follows that path and copied every built installer (1.3 GB incl. win-unpacked)
  // into the standalone server, so each desktop package embedded the previous one. (Next applies
  // this with Windows-separator paths that do not match on Windows; desktop/scripts/build.mjs also
  // strips it and fails the build if an installer artifact remains.)
  outputFileTracingExcludes: { "*": ["dist-desktop/**"] },
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Lint is run explicitly via `npm run lint`; do not fail production build on lint.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Later rules override the same header keys for matching paths.
      { source: "/o/:path*", headers: checkoutHeaders },
      // API responses carry tenant data: never cache them in shared caches.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
