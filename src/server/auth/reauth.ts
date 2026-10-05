/**
 * Step-up re-authentication for sensitive actions (refunds, voids, staff and
 * role changes, restaurant/security settings, restore).
 *
 * The user re-enters their password; on success the CURRENT session receives a
 * grant for exactly one scope that expires after REAUTH_TTL_SECONDS (default 5
 * minutes). The grant lives server-side on the session row — nothing is handed
 * to the client — so it dies with the session (logout, idle expiry, password
 * reset) and cannot be replayed from another session. A grant only proves who
 * is at the terminal: RBAC is still enforced by the services, so re-auth never
 * adds a permission.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { REAUTH_SCOPES, isReauthScope, type ReauthScope } from "@/constants/auth";
import { verifyPassword } from "@/server/auth/password";
import type { ActiveSession } from "@/server/auth/session";
import { UnauthorizedError, ValidationError } from "@/server/db/scope";

type Client = PrismaClient | Prisma.TransactionClient;
type Meta = { ip?: string; userAgent?: string };

const DEFAULT_REAUTH_TTL_SECONDS = 5 * 60;

export function reauthTtlSeconds(): number {
  const v = Number(process.env.REAUTH_TTL_SECONDS);
  return Number.isInteger(v) && v > 0 && v <= 3600 ? v : DEFAULT_REAUTH_TTL_SECONDS;
}

/** 403 with a machine-readable scope: the client asks for the password and retries. */
export class ReauthRequiredError extends Error {
  status = 403;
  details: { scope: ReauthScope };
  constructor(scope: ReauthScope) {
    super(`Confirm your password to ${REAUTH_SCOPES[scope]}`);
    this.name = "ReauthRequiredError";
    this.details = { scope };
  }
}

export const reauthSchema = z.object({
  password: z.string().min(1).max(200),
  scope: z.string().refine(isReauthScope, "Unknown re-authentication scope"),
});

export const REAUTH_FAILED_MESSAGE = "Password is incorrect";

/** Verify the session user's password and grant `scope` to this session only. */
export async function grantReauth(
  db: Client,
  session: Pick<ActiveSession, "id" | "userId">,
  input: z.input<typeof reauthSchema>,
  meta: Meta = {},
  now = new Date()
): Promise<{ scope: ReauthScope; expiresAt: Date }> {
  const { password, scope } = reauthSchema.parse(input) as { password: string; scope: ReauthScope };
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.active) throw new UnauthorizedError();
  const audit = (action: string, after: unknown) =>
    db.auditLog.create({ data: { organizationId: user.organizationId, actorId: user.id, action, entityType: "Session", entityId: session.id, after: JSON.stringify(after), ip: meta.ip, userAgent: meta.userAgent } });
  if (!(await verifyPassword(password, user.passwordHash))) {
    await audit("REAUTH_FAILED", { scope });
    throw new ValidationError(REAUTH_FAILED_MESSAGE, { fieldErrors: { password: [REAUTH_FAILED_MESSAGE] } });
  }
  const expiresAt = new Date(now.getTime() + reauthTtlSeconds() * 1000);
  const res = await db.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { reauthScope: scope, reauthExpiresAt: expiresAt, lastActivityAt: now } });
  if (res.count !== 1) throw new UnauthorizedError();
  await audit("REAUTH_SUCCEEDED", { scope, expiresAt });
  return { scope, expiresAt };
}

export function hasFreshAuth(session: Pick<ActiveSession, "reauthScope" | "reauthExpiresAt">, scope: ReauthScope, now = new Date()): boolean {
  return session.reauthScope === scope && !!session.reauthExpiresAt && session.reauthExpiresAt.getTime() > now.getTime();
}

/**
 * Gate a privileged action on a fresh grant for `scope`. Missing/expired/other
 * scope → ReauthRequiredError. The privileged use is audited (the action's own
 * audit row records what was done).
 */
export async function requireFreshAuth(
  db: Client,
  current: { session: ActiveSession; organizationId: string },
  scope: ReauthScope,
  meta: Meta & { method?: string; path?: string } = {}
): Promise<void> {
  if (!hasFreshAuth(current.session, scope)) throw new ReauthRequiredError(scope);
  await db.auditLog.create({
    data: {
      organizationId: current.organizationId, actorId: current.session.userId, action: "REAUTH_USED", entityType: "Session", entityId: current.session.id,
      after: JSON.stringify({ scope, method: meta.method, path: meta.path }), ip: meta.ip, userAgent: meta.userAgent,
    },
  });
}
