/**
 * HTTP security headers for every response (applied by next.config.mjs).
 *
 * Plain .mjs so next.config.mjs can import it before TypeScript is available;
 * unit-tested in tests/config/security-headers.test.ts.
 *
 * Content-Security-Policy trade-off: Next.js App Router hydration uses inline
 * <script> tags, so without per-request nonces (which would force middleware onto
 * every route) script-src must allow 'unsafe-inline'. The policy still blocks the
 * high-value things: scripts, styles, fonts and connections to any other origin
 * (no third-party script loading or data exfiltration via fetch/XHR/WebSocket),
 * plugins, <base> hijacking, framing, and form posts to other origins.
 *
 * Environment-aware:
 *  - development: 'unsafe-eval' (React Refresh / webpack eval) and ws: (HMR);
 *  - production: no eval, plus HSTS. The Electron desktop app serves the
 *    production build over http://localhost, where browsers ignore HSTS, and
 *    every resource it loads is same-origin, so the same policy applies there.
 */

/** @param {{ dev: boolean }} opts */
export function contentSecurityPolicy({ dev }) {
  /** @type {Record<string, string[]>} */
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(dev ? ["ws:", "wss:"] : [])],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'"],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/**
 * Hardware/browser features the web UI never uses. Printers, scanners and cash
 * drawers are reached through the desktop main process (IPC), not WebUSB/serial.
 */
export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "bluetooth=()",
  "midi=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "browsing-topics=()",
].join(", ");

/** @param {{ dev: boolean }} opts @returns {{ key: string, value: string }[]} */
export function securityHeaders({ dev }) {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    { key: "Content-Security-Policy", value: contentSecurityPolicy({ dev }) },
    ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
  ];
}
