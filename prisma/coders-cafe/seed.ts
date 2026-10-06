/**
 * Coders' Cafe dataset: one organization + outlet with the real menu
 * (./menu.ts), ten dine-in tables T01–T10 with stable QR tokens, and one user
 * per operating role. Built through RESTORA's own menu / master-data services
 * (audited, validated), so the dataset is exactly what an operator would create
 * by hand.
 *
 *  - Deterministic: the same tables, tokens, users and menu on every run.
 *  - Additive: it lives in its own organization next to whatever else the
 *    database holds; it never touches another organization's rows.
 *  - Resettable: `reset` deletes ONLY the Coders' Cafe organization (every
 *    org-scoped row, then the organization) and rebuilds it.
 *
 * Demo-only: the users share the public demo password and the QR tokens are
 * derived from public constants. The CLI (prisma/seed-coders-cafe.ts) refuses
 * production; rotate every QR and set real passwords before real use.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { systemContext } from "@/server/auth/context";
import { hashPassword } from "@/server/auth/password";
import { importCodersCafeStarter, STARTER_TABLE_CODES } from "@/server/services/starterMenu";

export const CAFE = {
  orgName: "Coders' Cafe",
  outletCode: "CC01",
  outletName: "Coders' Cafe",
  invoiceSeries: "CC",
  timezone: "Asia/Kolkata",
  currency: "INR",
  tableCodes: STARTER_TABLE_CODES,
  password: "Demo@12345",
  users: [
    { email: "cafe.owner@demo.local", name: "Cafe Owner", role: "OWNER", outlet: false },
    { email: "cafe.manager@demo.local", name: "Cafe Manager", role: "MANAGER", outlet: true },
    { email: "cafe.chef@demo.local", name: "Cafe Chef", role: "KITCHEN", outlet: true },
    { email: "cafe.cashier@demo.local", name: "Cafe Cashier", role: "CASHIER", outlet: true },
  ],
} as const;

/** Stable, URL-safe QR token for a demo table (matches guestOrdering's token format). */
export function cafeTableToken(code: string): string {
  return `cc${createHash("sha256").update(`restora-demo:coders-cafe:table:${code}`).digest("base64url").slice(0, 22)}`;
}

export type CafeSeedResult = {
  organizationId: string;
  outletId: string;
  tables: Array<{ id: string; code: string; token: string }>;
  users: Array<{ email: string; role: string }>;
  categories: number;
  items: number;
};

const SPECIAL: Record<string, (orgId: string) => Record<string, unknown>> = {
  // Models without their own organizationId column: scoped through their parent.
  Session: (orgId) => ({ user: { organizationId: orgId } }),
  KotItem: (orgId) => ({ kot: { organizationId: orgId } }),
  OrderItemModifier: (orgId) => ({ orderItem: { organizationId: orgId } }),
  MenuItemModifierGroup: (orgId) => ({ menuItem: { organizationId: orgId } }),
};

function delegate(db: PrismaClient, model: string) {
  return (db as unknown as Record<string, { deleteMany(args: unknown): Promise<{ count: number }> }>)[model.charAt(0).toLowerCase() + model.slice(1)];
}

/**
 * Delete every row of one organization. Models are deleted in passes: a pass
 * that hits a foreign-key restriction is retried after its dependants are gone,
 * so the order follows the schema without a hand-maintained list.
 */
export async function deleteOrganizationData(db: PrismaClient, organizationId: string): Promise<void> {
  const models = Prisma.dmmf.datamodel.models
    .filter((m) => m.name !== "Organization" && (m.fields.some((f) => f.name === "organizationId") || SPECIAL[m.name]))
    .map((m) => m.name);
  let pending = [...models];
  for (let pass = 0; pending.length && pass < models.length + 1; pass++) {
    const blocked: string[] = [];
    for (const m of pending) {
      const where = SPECIAL[m] ? SPECIAL[m](organizationId) : { organizationId };
      try {
        await delegate(db, m).deleteMany({ where });
      } catch (e) {
        if ((e as { code?: string }).code === "P2003" || /foreign key/i.test(String((e as Error).message))) blocked.push(m);
        else throw e;
      }
    }
    if (blocked.length === pending.length) throw new Error(`Cannot delete organization data; blocked by foreign keys: ${blocked.join(", ")}`);
    pending = blocked;
  }
  await db.organization.delete({ where: { id: organizationId } });
}

export async function findCafe(db: PrismaClient) {
  return db.organization.findFirst({ where: { name: CAFE.orgName, outlets: { some: { code: CAFE.outletCode } } } });
}

/** Create the dataset. With `reset`, an existing Coders' Cafe organization is deleted first; without it, an existing one is an error. */
export async function seedCodersCafe(db: PrismaClient, opts: { reset?: boolean } = {}): Promise<CafeSeedResult> {
  const existing = await findCafe(db);
  if (existing) {
    if (!opts.reset) throw new Error(`${CAFE.orgName} already exists (organization ${existing.id}); pass reset to rebuild it`);
    await deleteOrganizationData(db, existing.id);
  }
  // Tokens are unique across the database: a leftover table elsewhere holding one would collide.
  const clash = await db.restaurantTable.findFirst({ where: { qrToken: { in: CAFE.tableCodes.map(cafeTableToken) } } });
  if (clash) throw new Error(`QR token of a ${CAFE.orgName} demo table is already used by table ${clash.id}`);

  const org = await db.organization.create({ data: { name: CAFE.orgName, currency: CAFE.currency, timezone: CAFE.timezone } });
  const outlet = await db.outlet.create({ data: { organizationId: org.id, code: CAFE.outletCode, name: CAFE.outletName, currency: CAFE.currency, timezone: CAFE.timezone, invoiceSeries: CAFE.invoiceSeries } });
  await db.department.create({ data: { organizationId: org.id, outletId: outlet.id, name: "Kitchen", kind: "KITCHEN" } });
  await db.kitchenStation.create({ data: { organizationId: org.id, outletId: outlet.id, name: "KITCHEN", kind: "KITCHEN" } });

  const passwordHash = await hashPassword(CAFE.password);
  for (const u of CAFE.users) {
    const user = await db.user.create({ data: { organizationId: org.id, email: u.email, name: u.name, passwordHash } });
    await db.membership.create({ data: { organizationId: org.id, userId: user.id, outletId: u.outlet ? outlet.id : null, role: u.role } });
  }

  // The same builder the desktop app uses (src/server/services/starterMenu.ts); demo tables get the fixed, printable tokens.
  const ctx = systemContext(org.id, [outlet.id]);
  const menu = await importCodersCafeStarter(ctx, { outletId: outlet.id, tableToken: cafeTableToken }, db);
  const rows = await db.restaurantTable.findMany({ where: { outletId: outlet.id }, orderBy: { code: "asc" }, select: { id: true, code: true, qrToken: true } });
  const tables: CafeSeedResult["tables"] = rows.map((t) => ({ id: t.id, code: t.code, token: t.qrToken! }));
  return { organizationId: org.id, outletId: outlet.id, tables, users: CAFE.users.map((u) => ({ email: u.email, role: u.role })), categories: menu.categories, items: menu.items };
}
