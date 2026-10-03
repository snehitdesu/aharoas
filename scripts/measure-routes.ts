/**
 * Production-style route timing (login cookie + GET pages/APIs).
 *
 * Usage (after `npx next build` and `npx next start -p 3220` with AUTH_SECRET set):
 *   MEASURE_BASE=http://localhost:3220 npx tsx scripts/measure-routes.ts
 *
 * Prints JSON lines: { path, status, durationMs, serverTiming }. Does not log secrets.
 */
const BASE = process.env.MEASURE_BASE ?? "http://localhost:3220";
const EMAIL = process.env.MEASURE_EMAIL ?? "manager@demo.local";
const PASSWORD = process.env.MEASURE_PASSWORD ?? "Demo@12345";

type Row = { path: string; status: number; durationMs: number; serverTiming: string | null };

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE.replace(/\/$/, "") },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const cookie = res.headers.getSetCookie?.().join("; ") ?? res.headers.get("set-cookie");
  if (!res.ok || !cookie) throw new Error(`login failed ${res.status}`);
  return cookie;
}

async function timed(cookie: string, path: string): Promise<Row> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  await res.arrayBuffer();
  return { path, status: res.status, durationMs: Math.round(performance.now() - t0), serverTiming: res.headers.get("server-timing") };
}

async function main() {
  const cookie = await login();
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  const body = (await me.json()) as { data?: { access?: { outletIds?: string[] } } };
  const outletId = body.data?.access?.outletIds?.[0];
  if (!outletId) throw new Error("no outlet on session");
  const paths = [
    "/dashboard",
    "/pos",
    "/tables",
    "/kitchen",
    "/menu",
    "/inventory",
    "/procurement/indents",
    "/staff",
    "/customers",
    "/reservations",
    "/finance",
    "/reports",
    "/exports",
    `/api/menu?outletId=${outletId}&activeOnly=true`,
    `/api/orders?outletId=${outletId}&active=true&take=50`,
    `/api/kitchen/kots?outletId=${outletId}`,
    `/api/master/tables?outletId=${outletId}`,
    `/api/inventory/stock?outletId=${outletId}`,
  ];
  const rows: Row[] = [];
  for (const path of paths) rows.push(await timed(cookie, path));
  rows.sort((a, b) => b.durationMs - a.durationMs);
  console.log(JSON.stringify({ base: BASE, outletId, rows }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
