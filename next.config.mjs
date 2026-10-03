import { securityHeaders as buildSecurityHeaders } from "./src/server/config/securityHeaders.mjs";

// Development keeps 'unsafe-eval' + ws: (HMR) in the CSP; production adds HSTS.
const securityHeaders = buildSecurityHeaders({ dev: process.env.NODE_ENV !== "production" });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The desktop build (npm run desktop:build) packages the self-contained server
  // that `output: "standalone"` produces; `next start` / the web build are unchanged.
  ...(process.env.AHAROS_STANDALONE === "1" ? { output: "standalone" } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Lint is run explicitly via `npm run lint`; do not fail production build on lint.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // API responses carry tenant data: never cache them in shared caches.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
