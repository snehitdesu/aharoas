/**
 * Shared E2E helpers. Server state is read through the REAL authenticated API
 * (the browser context's own session cookie) — used to verify what the UI did,
 * never to set up UI state behind its back.
 */
import path from "node:path";
import { expect, type APIRequestContext, type Page, type Locator } from "@playwright/test";

export const PASSWORD = "Demo@12345"; // prisma/seed.ts DEMO_PASSWORD
export const ROLES = {
  manager: "manager@demo.local", // MANAGER @ Hyderabad Central
  cashier: "cashier@demo.local", // CASHIER @ Hyderabad Central
  kitchen: "kitchen@demo.local", // KITCHEN @ Hyderabad Central
  captain: "captain@demo.local", // CAPTAIN @ Hyderabad Central
  owner: "owner@demo.local", // OWNER (org-wide, both outlets)
} as const;
export type Role = keyof typeof ROLES;

export const statePath = (role: Role) => path.join(process.cwd(), "e2e", ".auth", `${role}.json`);

type Envelope<T> = { ok: boolean; data: T; error?: { code: string; message: string } };

/** Call the real API with the page's session. Returns status + parsed envelope. */
export async function apiCall<T = unknown>(req: APIRequestContext, method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = method === "GET" ? await req.get(url, { headers }) : await req.post(url, { data: body ?? {}, headers: { origin: baseOrigin(), ...headers } });
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  return { status: res.status(), body: json };
}
export async function apiData<T>(req: APIRequestContext, url: string): Promise<T> {
  const r = await apiCall<T>(req, "GET", url);
  expect(r.status, `GET ${url} -> ${JSON.stringify(r.body?.error)}`).toBe(200);
  return r.body!.data;
}
const baseOrigin = () => `http://localhost:${process.env.E2E_PORT ?? 3210}`;

export type Outlet = { id: string; code: string; name: string };
export async function outlets(req: APIRequestContext): Promise<Outlet[]> {
  return apiData<Outlet[]>(req, "/api/master/outlets");
}
export async function outletByCode(req: APIRequestContext, code: string): Promise<Outlet> {
  const o = (await outlets(req)).find((x) => x.code === code);
  expect(o, `outlet ${code}`).toBeTruthy();
  return o!;
}

export type OrderDTO = { id: string; status: string; channel: string; tableId: string | null; customerId: string | null; customer?: { id: string; name: string; phone: string | null } | null; total: string; items: Array<{ id: string; name: string; qty: string; lineTotal: string; modifiers: Array<{ name: string }> }>; payments?: Array<{ id: string; method: string; status: string; amount: string }>; kots?: Array<{ id: string; number: number; status: string }> };

export async function activeOrderForTable(req: APIRequestContext, outletId: string, tableId: string) {
  const { items } = await apiData<{ items: Array<{ id: string }> }>(req, `/api/orders?outletId=${outletId}&tableId=${tableId}&active=true&take=10`);
  return items;
}
export async function order(req: APIRequestContext, id: string) {
  return apiData<OrderDTO>(req, `/api/orders/${id}`);
}
export async function tableByCode(req: APIRequestContext, outletId: string, code: string) {
  const tables = await apiData<Array<{ id: string; code: string; status: string }>>(req, `/api/master/tables?outletId=${outletId}`);
  const t = tables.find((x) => x.code === code);
  expect(t, `table ${code}`).toBeTruthy();
  return t!;
}

// ---------------- POS page actions ----------------

export const posCart = (page: Page) => page.getByRole("region", { name: "Current order" });
export const newItems = (page: Page) => page.getByRole("list", { name: "New items" });

export async function openPos(page: Page) {
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Chicken Biryani/ })).toBeVisible();
}
export async function chooseTable(page: Page, code: string) {
  await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose table" });
  await dialog.getByRole("button", { name: new RegExp(`^Table ${code},`) }).click();
  await expect(dialog).toBeHidden();
}
export async function addSimpleItem(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(`^${name},`) }).click();
}
export async function setOrderType(page: Page, label: "Dine-in" | "Takeaway" | "Delivery") {
  await page.getByRole("radio", { name: label }).click();
}
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole("status").filter({ hasText: text }).or(page.getByRole("alert").filter({ hasText: text }));
}

// ---------------- KDS ----------------

export const kdsColumn = (page: Page, title: "New" | "In progress" | "Ready") => page.getByRole("region", { name: new RegExp(`^${title}`) });
export const ticketFor = (scope: Page | Locator, tableCode: string) => scope.getByRole("article", { name: new RegExp(`Table ${tableCode}$`) });

/** App-rendered alerts only (excludes Next.js's empty route announcer, which also has role=alert). */
export const appAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

// ---------------- fixtures / server-state readers ----------------

export const CENTRAL = "HYDCEN";

/** Every order (any status) ever placed on a table — used to prove "exactly one". */
export async function ordersOnTable(req: APIRequestContext, outletId: string, tableId: string) {
  const { items } = await apiData<{ items: Array<{ id: string; status: string }> }>(req, `/api/orders?outletId=${outletId}&tableId=${tableId}&take=100`);
  return items;
}

export async function materialByName(req: APIRequestContext, name: string) {
  const { items } = await apiData<{ items: Array<{ id: string; name: string }> }>(req, `/api/master/materials?search=${encodeURIComponent(name)}&take=50`);
  const m = items.find((x) => x.name === name);
  expect(m, `material ${name}`).toBeTruthy();
  return m!;
}

export async function stockQty(req: APIRequestContext, outletId: string, materialId: string): Promise<number> {
  const rows = await apiData<Array<{ materialId: string; quantity: number }>>(req, `/api/inventory/stock?outletId=${outletId}`);
  return rows.find((r) => r.materialId === materialId)?.quantity ?? 0;
}

export type LedgerRow = { id: string; txnType: string; qty: string | number; sourceRef: string | null; sourceId: string | null };
/** Ledger rows written for one order and material (real InventoryLedger via the API). */
export async function ledgerForOrder(req: APIRequestContext, outletId: string, materialId: string, orderId: string) {
  const rows = await apiData<LedgerRow[]>(req, `/api/inventory/movements?outletId=${outletId}&materialId=${materialId}&take=500`);
  return rows.filter((r) => r.sourceRef?.startsWith(`order:${orderId}:`));
}

/** Cart total as displayed (the "Total" row of a running order). */
export async function cartTotal(page: Page) {
  const row = posCart(page).locator("div.flex.justify-between").filter({ has: page.getByText("Total", { exact: true }) });
  return (await row.locator("span").nth(1).innerText()).trim();
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n: number | string) => inr.format(Number(n));

/** Open a second, independent browser session for another role. */
export async function sessionFor(browser: import("@playwright/test").Browser, role: Role) {
  const context = await browser.newContext({ storageState: statePath(role), viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  return { context, page };
}

/** A real API session for another role (e.g. a manager reading the inventory ledger). */
export async function apiAs(role: Role) {
  const { request } = await import("@playwright/test");
  return request.newContext({ baseURL: baseOrigin(), storageState: statePath(role) });
}

// ---------------- sign-in through the real form ----------------

/** Sign in through the real /login page (never an API shortcut). */
export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/**
 * Direct handle on the isolated E2E database. Used ONLY to simulate the passage
 * of time (e.g. expiring one session) — never to create or mutate business data
 * behind the UI.
 */
export async function e2eDb() {
  const { PrismaClient } = await import("@prisma/client");
  const url = process.env.E2E_DATABASE_URL ?? `file:${path.join(process.cwd(), "prisma", "e2e.db").replace(/\\/g, "/")}`;
  return new PrismaClient({ datasourceUrl: url });
}
