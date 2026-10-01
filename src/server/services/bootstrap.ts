/**
 * First-run provisioning: creates the organization, its first outlet and the
 * OWNER account in one transaction. Production-safe and unrelated to the demo
 * seed: it never deletes anything and refuses to run once ANY organization or
 * user exists, so it can only ever initialize an empty database.
 *
 * Invoked by `npm run bootstrap:owner` (scripts/bootstrap-owner.ts); there is
 * deliberately no HTTP endpoint for it.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PASSWORD_MAX_BYTES } from "@/constants/password";
import { isValidTimeZone } from "@/domain/time";
import { hashPassword } from "@/server/auth/password";
import { assertPasswordPolicy } from "@/server/auth/account";
import { ConflictError } from "@/server/db/scope";
import { runInTx } from "@/server/services/_workflow";

export const bootstrapSchema = z.object({
  organizationName: z.string().trim().min(1).max(120),
  outletName: z.string().trim().min(1).max(120),
  outletCode: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, "Outlet code: 1-20 of A-Z, 0-9, _ or -, starting with a letter or digit"),
  timezone: z.string().trim().refine(isValidTimeZone, "Unknown IANA timezone").default("Asia/Kolkata"),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO code").default("INR"),
  ownerName: z.string().trim().min(1).max(120),
  ownerEmail: z.string().trim().email().max(200),
  ownerPassword: z.string().max(PASSWORD_MAX_BYTES * 4),
});
export type BootstrapInput = z.input<typeof bootstrapSchema>;

export const ALREADY_INITIALIZED = "Database is already initialized (an organization or user exists); bootstrap refuses to run";

async function assertEmpty(db: Pick<PrismaClient, "organization" | "user">) {
  const [orgs, users] = await Promise.all([db.organization.count(), db.user.count()]);
  if (orgs > 0 || users > 0) throw new ConflictError(ALREADY_INITIALIZED);
}

export async function bootstrapOwner(db: PrismaClient, input: BootstrapInput) {
  const data = bootstrapSchema.parse(input);
  const email = data.ownerEmail.toLowerCase();
  assertPasswordPolicy(data.ownerPassword, { email, name: data.ownerName });
  await assertEmpty(db); // fail fast before the (slow) hash
  const passwordHash = await hashPassword(data.ownerPassword);
  return runInTx(db, async (tx) => {
    await assertEmpty(tx); // authoritative re-check inside the serializable transaction
    const org = await tx.organization.create({ data: { name: data.organizationName, currency: data.currency, timezone: data.timezone } });
    const outlet = await tx.outlet.create({ data: { organizationId: org.id, code: data.outletCode, name: data.outletName, currency: data.currency, timezone: data.timezone } });
    const owner = await tx.user.create({ data: { organizationId: org.id, email, name: data.ownerName, passwordHash, active: true } });
    await tx.membership.create({ data: { organizationId: org.id, userId: owner.id, outletId: null, role: "OWNER" } });
    await tx.auditLog.create({
      data: {
        organizationId: org.id, actorId: null, action: "BOOTSTRAP", entityType: "Organization", entityId: org.id,
        after: JSON.stringify({ outletId: outlet.id, outletCode: outlet.code, ownerId: owner.id, ownerEmail: email }),
      },
    });
    return { organizationId: org.id, outletId: outlet.id, ownerId: owner.id, ownerEmail: email };
  });
}
