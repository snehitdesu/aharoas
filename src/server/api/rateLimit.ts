/**
 * Rate limiting for security-sensitive and expensive endpoints.
 *
 * Fixed-window counters behind a `RateLimitStore` interface:
 *  - MemoryRateLimitStore (default): per-process. Correct for local development
 *    and single-instance deployments.
 *  - A shared store (e.g. Redis INCR + PEXPIRE) is REQUIRED when running more
 *    than one instance; it is NOT implemented here (see PROJECT_STATUS.md) —
 *    selecting RATE_LIMIT_STORE=redis fails loudly instead of silently
 *    degrading to per-process limits.
 *
 * Env: RATE_LIMIT_DISABLED=true turns limiting off (e.g. load tests);
 *      RATE_LIMIT_STORE=memory|redis.
 *
 * Client IP comes from X-Forwarded-For, which is only trustworthy behind a
 * reverse proxy. Proxies APPEND the address they saw, so the client controls
 * every entry left of the ones added by our own proxies: the IP is read
 * TRUSTED_PROXY_HOPS entries from the RIGHT (default 1 = one proxy / load
 * balancer in front of the app). Taking the leftmost entry (as before) let a
 * client pick a fresh "IP" per request, defeating the per-IP login limit and
 * flooding the store. Login is ALSO limited per email.
 */
import type { NextRequest } from "next/server";

export class RateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Too many requests") {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitStore {
  /** Count one hit for `key` in the current window; returns the new count and window end (ms epoch). */
  hit(key: string, windowMs: number, now?: number): Promise<{ count: number; resetAt: number }>;
  reset(key?: string): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxKeys = 50_000) {}

  async hit(key: string, windowMs: number, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, resetAt: w.resetAt };
  }

  async reset(key?: string) {
    if (key) this.windows.delete(key);
    else this.windows.clear();
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    // Still full (a flood of distinct keys): drop the oldest half rather than grow without bound.
    if (this.windows.size >= this.maxKeys) [...this.windows.keys()].slice(0, Math.floor(this.maxKeys / 2)).forEach((k) => this.windows.delete(k));
  }
}

let store: RateLimitStore | null = null;
export function getRateLimitStore(): RateLimitStore {
  if (store) return store;
  const kind = (process.env.RATE_LIMIT_STORE ?? "memory").toLowerCase();
  if (kind !== "memory") throw new Error(`RATE_LIMIT_STORE=${kind} is not implemented; use "memory" (single instance) or implement a shared store`);
  store = new MemoryRateLimitStore();
  return store;
}

export type RatePolicy = { name: string; limit: number; windowMs: number };

export const RATE_POLICIES = {
  loginPerEmail: { name: "login-email", limit: 10, windowMs: 15 * 60_000 },
  loginPerIp: { name: "login-ip", limit: 50, windowMs: 60_000 },
  passwordResetPerEmail: { name: "pwreset-email", limit: 5, windowMs: 60 * 60_000 },
  passwordResetPerIp: { name: "pwreset-ip", limit: 20, windowMs: 15 * 60_000 },
  passwordCompletePerIp: { name: "pwcomplete-ip", limit: 20, windowMs: 15 * 60_000 },
  passwordChangePerUser: { name: "pwchange-user", limit: 10, windowMs: 15 * 60_000 },
  reauthPerUser: { name: "reauth-user", limit: 30, windowMs: 15 * 60_000 },
  webhook: { name: "webhook", limit: 600, windowMs: 60_000 },
  export: { name: "export", limit: 20, windowMs: 60_000 },
  report: { name: "report", limit: 120, windowMs: 60_000 },
  // Calls that reach an external provider or device (test connection / test print / test message).
  integrationAction: { name: "integration-action", limit: 30, windowMs: 60_000 },
  // Guest QR ordering (anonymous). Guests behind restaurant Wi-Fi share one IP,
  // so per-IP limits are generous; order placement is also capped per table.
  guestReadPerIp: { name: "guest-read-ip", limit: 600, windowMs: 60_000 },
  guestWritePerIp: { name: "guest-write-ip", limit: 60, windowMs: 60_000 },
  guestOrderPerTable: { name: "guest-order-table", limit: 20, windowMs: 10 * 60_000 },
} satisfies Record<string, RatePolicy>;

export function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

export function clientIp(req: NextRequest | Request, hops = trustedProxyHops()): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // The entry added by the outermost trusted proxy; if the chain is shorter than
  // expected (misconfigured / no proxy), fall back to its first entry.
  const ip = chain.length ? chain[Math.max(0, chain.length - hops)] : req.headers.get("x-real-ip")?.trim();
  return (ip || "unknown").slice(0, 64);
}

/** Count a hit and throw RateLimitError (429 + Retry-After) when over the limit. */
export async function enforceRateLimit(policy: RatePolicy, key: string, now = Date.now()): Promise<void> {
  if (process.env.RATE_LIMIT_DISABLED === "true") return;
  const { count, resetAt } = await getRateLimitStore().hit(`${policy.name}:${key}`, policy.windowMs, now);
  if (count > policy.limit) throw new RateLimitError(Math.max(1, Math.ceil((resetAt - now) / 1000)));
}
