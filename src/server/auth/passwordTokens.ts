/**
 * One-time password tokens (new-staff SETUP and RESET links).
 *
 * Same scheme as sessions: the raw token is 32 random bytes handed out exactly
 * once; only its SHA-256 is stored. A token is bound to one user, expires, and
 * is consumed atomically (a conditional update on `usedAt IS NULL`), so two
 * concurrent uses cannot both succeed. Issuing a new token for a user retires
 * that user's older unused tokens.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { generateToken, hashToken } from "@/server/auth/session";
import { ValidationError } from "@/server/db/scope";

type Client = PrismaClient | Prisma.TransactionClient;

export type PasswordTokenPurpose = "SETUP" | "RESET";

const HOUR = 60 * 60 * 1000;
export const PASSWORD_TOKEN_TTL_MS: Record<PasswordTokenPurpose, number> = {
  SETUP: 72 * HOUR,
  RESET: 1 * HOUR,
};

/** The single message for unknown, expired, used or retired tokens (nothing to distinguish them). */
export const INVALID_TOKEN_MESSAGE = "This link is invalid or has expired. Ask your manager for a new one.";

/** Raw tokens are base64url of 32 bytes (43 chars); anything else is rejected before a DB lookup. */
export const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type IssuedPasswordToken = { token: string; purpose: PasswordTokenPurpose; expiresAt: Date };

export async function issuePasswordToken(
  db: Client,
  input: { organizationId: string; userId: string; purpose: PasswordTokenPurpose; createdById?: string | null },
  now = new Date()
): Promise<IssuedPasswordToken> {
  await retireUserTokens(db, input.userId, now);
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + PASSWORD_TOKEN_TTL_MS[input.purpose]);
  await db.passwordToken.create({
    data: { organizationId: input.organizationId, userId: input.userId, purpose: input.purpose, tokenHash: hashToken(token), expiresAt, createdById: input.createdById ?? null },
  });
  return { token, purpose: input.purpose, expiresAt };
}

/** Mark every unused token of the user as used (superseded / password already changed). */
export async function retireUserTokens(db: Client, userId: string, now = new Date()): Promise<number> {
  const res = await db.passwordToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  return res.count;
}

/** Look up a usable token (not used, not expired, active user). Throws the uniform error otherwise. */
export async function findUsablePasswordToken(db: Client, rawToken: string, now = new Date()) {
  if (!RAW_TOKEN_PATTERN.test(rawToken)) throw new ValidationError(INVALID_TOKEN_MESSAGE);
  const row = await db.passwordToken.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime() || !row.user.active || row.user.organizationId !== row.organizationId) {
    throw new ValidationError(INVALID_TOKEN_MESSAGE);
  }
  return row;
}

/** Atomically consume a token by id. Fails if it was used or expired in the meantime. */
export async function consumePasswordToken(db: Client, tokenId: string, now = new Date()): Promise<void> {
  const res = await db.passwordToken.updateMany({ where: { id: tokenId, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (res.count !== 1) throw new ValidationError(INVALID_TOKEN_MESSAGE);
}
