/**
 * Login / logout (pure, transport-agnostic so they are unit-testable).
 * HTTP concerns (cookies) live in the route handlers.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { UnauthorizedError } from "@/server/db/scope";
import { verifyPassword } from "@/server/auth/password";
import { createSession, revokeToken, type CreatedSession } from "@/server/auth/session";

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.input<typeof loginSchema>;

export type SafeUser = { id: string; name: string; email: string; organizationId: string; isSuperAdmin: boolean };

export type LoginResult = { session: CreatedSession; user: SafeUser };

/**
 * Valid bcrypt hash (cost 10, same as real password hashes) compared against
 * when the account does not exist, so unknown-email and wrong-password logins
 * take the same time. Precomputed: no hashing at request time. Its plaintext is
 * irrelevant — the result is always rejected because there is no user.
 */
const NONEXISTENT_USER_HASH = "$2a$10$YBd5Bj/nMWBkx6MYoOJi2e4baZLzex5ZEwOVslUAbO6pWVVnnB3wm";

/**
 * Authenticate by email + password. Returns a new session on success.
 * Uses one uniform error for unknown-user and wrong-password (no account
 * enumeration) and rejects inactive users.
 */
export async function loginWithPassword(
  db: PrismaClient,
  input: LoginInput,
  meta: { ip?: string; userAgent?: string } = {}
): Promise<LoginResult> {
  const { email, password } = loginSchema.parse(input);

  const user = await db.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  // Always run a full bcrypt compare (against a real hash) so response time does
  // not reveal whether the account exists.
  const hash = user?.passwordHash ?? NONEXISTENT_USER_HASH;
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) throw new UnauthorizedError("Invalid email or password");
  if (!user.active) throw new UnauthorizedError("Account is inactive");

  const session = await createSession(db, user.id, meta);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await db.auditLog.create({
    data: { organizationId: user.organizationId, actorId: user.id, action: "LOGIN", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent },
  });

  return {
    session,
    user: { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId, isSuperAdmin: user.isSuperAdmin },
  };
}

/** Revoke the given session token (logout). Writes an audit row if we can resolve the user. */
export async function logout(db: PrismaClient, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const { hashToken } = await import("@/server/auth/session");
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  const revoked = await revokeToken(db, token);
  if (revoked && session) {
    await db.auditLog.create({ data: { organizationId: session.user.organizationId, actorId: session.userId, action: "LOGOUT", entityType: "Session", entityId: session.id } });
  }
  return revoked;
}
