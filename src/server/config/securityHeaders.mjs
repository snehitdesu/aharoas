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

/**
 * The hosts Razorpay Checkout needs (its script, the payment iframe and its
 * API / telemetry calls). Allowed ONLY on the guest order pages (/o/*), where a
 * guest pays online — never on the back office.
 */
export const RAZORPAY_CHECKOUT_HOSTS = {
  script: ["https://checkout.razorpay.com"],
  frame: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
  connect: ["https://api.razorpay.com", "https://lumberjack.razorpay.com"],
  img: ["https://cdn.razorpay.com"],
};

/** @param {{ dev: boolean, paymentCheckout?: boolean }} opts */
export function contentSecurityPolicy({ dev, paymentCheckout = false }) {
  const rzp = paymentCheckout ? RAZORPAY_CHECKOUT_HOSTS : { script: [], frame: [], connect: [], img: [] };
  /** @type {Record<string, string[]>} */
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...rzp.script],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...rzp.img],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(dev ? ["ws:", "wss:"] : []), ...rzp.connect],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'"],
    "frame-src": rzp.frame.length ? rzp.frame : ["'none'"],
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

/** Guest order pages: the Payment Request API is allowed for the gateway's own frame only. */
export const CHECKOUT_PERMISSIONS_POLICY = PERMISSIONS_POLICY.replace("payment=()", 'payment=(self "https://api.razorpay.com")');

/**
 * @param {{ dev: boolean, paymentCheckout?: boolean }} opts
 * paymentCheckout: the guest order pages, where Razorpay Checkout runs. Besides
 * the CSP hosts, the opener policy allows the gateway's popups (UPI / bank 3-D
 * Secure windows report back to the checkout through window.opener).
 * @returns {{ key: string, value: string }[]}
 */
export function securityHeaders({ dev, paymentCheckout = false }) {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: paymentCheckout ? CHECKOUT_PERMISSIONS_POLICY : PERMISSIONS_POLICY },
    { key: "Cross-Origin-Opener-Policy", value: paymentCheckout ? "same-origin-allow-popups" : "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    { key: "Content-Security-Policy", value: contentSecurityPolicy({ dev, paymentCheckout }) },
    ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
  ];
}
