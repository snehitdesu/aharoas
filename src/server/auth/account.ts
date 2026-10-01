/**
 * Password lifecycle: complete a setup/reset link, request a reset, change a
 * password. Transport-agnostic (route handlers add origin checks, body caps and
 * rate limits). Raw passwords and raw tokens are never logged or audited.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { passwordProblems, PASSWORD_MAX_BYTES } from "@/constants/password";
import { ValidationError, UnauthorizedError } from "@/server/db/scope";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/session";
import { runInTx, type Tx } from "@/server/services/_workflow";
import { issuePasswordToken, retireUserTokens, findUsablePasswordToken, consumePasswordToken, INVALID_TOKEN_MESSAGE } from "@/server/auth/passwordTokens";

type Meta = { ip?: string; userAgent?: string };

// Generous upper bound so the policy (not zod) reports over-long passwords with a clear message.
const passwordField = z.string().max(PASSWORD_MAX_BYTES * 4);

/** Throws a 422 listing every policy problem. */
export function assertPasswordPolicy(password: string, ctx: { email?: string; name?: string } = {}): void {
  const problems = passwordProblems(password, ctx);
  if (problems.length) throw new ValidationError(problems[0], { fieldErrors: { password: problems } });
}

async function audit(tx: Tx, row: { organizationId: string; actorId: string | null; action: string; entityId: string; after?: unknown } & Meta) {
  await tx.auditLog.create({
    data: {
      organizationId: row.organizationId, actorId: row.actorId, action: row.action, entityType: "User", entityId: row.entityId,
      after: row.after === undefined ? null : JSON.stringify(row.after), ip: row.ip, userAgent: row.userAgent,
    },
  });
}

// ---------------- Complete a setup / reset link ----------------

export const completeSchema = z.object({ token: z.string().min(1).max(200), password: passwordField });

/**
 * Set the password for the token's user. The policy is checked BEFORE the token
 * is consumed, so a rejected password does not burn the link. On success the
 * token (and every other outstanding token of the user) is spent and all of the
 * user's sessions are revoked. The user then signs in normally.
 */
export async function completePasswordToken(db: PrismaClient, input: z.input<typeof completeSchema>, meta: Meta = {}) {
  const { token, password } = completeSchema.parse(input);
  const row = await findUsablePasswordToken(db, token);
  assertPasswordPolicy(password, { email: row.user.email, name: row.user.name });
  const passwordHash = await hashPassword(password);
  return runInTx(db, async (tx) => {
    const now = new Date();
    await consumePasswordToken(tx, row.id, now);
    const updated = await tx.user.updateMany({ where: { id: row.userId, active: true }, data: { passwordHash } });
    if (updated.count !== 1) throw new ValidationError(INVALID_TOKEN_MESSAGE);
    await retireUserTokens(tx, row.userId, now);
    const revoked = await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
    await audit(tx, { organizationId: row.organizationId, actorId: row.userId, action: "PASSWORD_SET", entityId: row.userId, after: { purpose: row.purpose, sessionsRevoked: revoked.count }, ...meta });
    return { email: row.user.email, purpose: row.purpose as "SETUP" | "RESET" };
  });
}

// ---------------- Self-service reset request ----------------

export const resetRequestSchema = z.object({ email: z.string().email().max(200) });

/** The public response, identical for existing, unknown and inactive accounts (no account enumeration). */
export const RESET_ACCEPTED_MESSAGE =
  "If an active account exists for that email, a reset link will be sent to it. If nothing arrives, ask your manager to issue a password link.";

/**
 * Out-of-band delivery of a reset link (email/SMS). No provider is integrated
 * yet; until one is registered the request is recorded (audit) and NO token is
 * created — a link nobody can receive would only widen the attack surface.
 * Staff can always get a link from a manager (staff `password-link`).
 */
export type PasswordLinkDelivery = (msg: { to: string; name: string; token: string; expiresAt: Date }) => Promise<void>;
let delivery: PasswordLinkDelivery | null = null;
export function setPasswordLinkDelivery(fn: PasswordLinkDelivery | null): void {
  delivery = fn;
}
export function passwordLinkDeliveryConfigured(): boolean {
  return delivery !== null;
}

/**
 * Always resolves the same way whether or not the account exists (no account
 * enumeration). Delivery failures are logged without the token.
 */
export async function requestPasswordReset(db: PrismaClient, input: z.input<typeof resetRequestSchema>, meta: Meta = {}): Promise<void> {
  const email = resetRequestSchema.parse(input).email.toLowerCase().trim();
  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.active) return;
  const send = delivery;
  const issued = await runInTx(db, async (tx) => {
    const t = send ? await issuePasswordToken(tx, { organizationId: user.organizationId, userId: user.id, purpose: "RESET", createdById: null }) : null;
    await audit(tx, { organizationId: user.organizationId, actorId: null, action: "PASSWORD_RESET_REQUEST", entityId: user.id, after: { delivered: Boolean(t), expiresAt: t?.expiresAt }, ...meta });
    return t;
  });
  if (!issued || !send) return;
  try {
    await send({ to: user.email, name: user.name, token: issued.token, expiresAt: issued.expiresAt });
  } catch (e) {
    console.error("[auth] password reset delivery failed for user", user.id, (e as Error)?.message ?? "unknown error");
  }
}

// ---------------- Authenticated change ----------------

export const changeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordField });

/**
 * Change the caller's password. Requires the current password; the new one
 * must satisfy the policy and differ from the current one. Every OTHER session
 * of the user is revoked; the session making the request stays signed in.
 */
export async function changePassword(
  db: PrismaClient,
  caller: { userId: string; sessionToken: string },
  input: z.input<typeof changeSchema>,
  meta: Meta = {}
): Promise<{ sessionsRevoked: number }> {
  const { currentPassword, newPassword } = changeSchema.parse(input);
  const user = await db.user.findUnique({ where: { id: caller.userId } });
  if (!user || !user.active) throw new UnauthorizedError();
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new ValidationError("Current password is incorrect", { fieldErrors: { currentPassword: ["Current password is incorrect"] } });
  if (newPassword === currentPassword) throw new ValidationError("The new password must be different from the current one", { fieldErrors: { newPassword: ["Must differ from the current password"] } });
  assertPasswordPolicy(newPassword, { email: user.email, name: user.name });
  const passwordHash = await hashPassword(newPassword);
  const keep = hashToken(caller.sessionToken);
  return runInTx(db, async (tx) => {
    const now = new Date();
    // Optimistic guard: fails if the password changed since it was verified above.
    const updated = await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash } });
    if (updated.count !== 1) throw new ValidationError("Your password was changed elsewhere. Sign in again and retry.");
    const revoked = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null, tokenHash: { not: keep } }, data: { revokedAt: now } });
    await retireUserTokens(tx, user.id, now);
    await audit(tx, { organizationId: user.organizationId, actorId: user.id, action: "PASSWORD_CHANGE", entityId: user.id, after: { sessionsRevoked: revoked.count }, ...meta });
    return { sessionsRevoked: revoked.count };
  });
}
