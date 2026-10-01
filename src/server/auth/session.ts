/**
 * Session token layer.
 *
 * A session token is a high-entropy random string given to the client (in an
 * httpOnly cookie). We store only its SHA-256 hash in the DB (never the raw
 * token), so a leaked database cannot be used to impersonate users. Tokens are
 * opaque — they carry NO user data — so nothing sensitive lives client-side.
 */
import { randomBytes, createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function sessionTtlSeconds(): number {
  const v = Number(process.env.SESSION_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_SECONDS;
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type CreatedSession = { token: string; sessionId: string; expiresAt: Date };

/** Create a session and return the RAW token (only time it exists un-hashed). */
export async function createSession(
  db: Client,
  userId: string,
  meta: { ip?: string; userAgent?: string } = {}
): Promise<CreatedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + sessionTtlSeconds() * 1000);
  const session = await db.session.create({
    data: { userId, tokenHash: hashToken(token), ip: meta.ip, userAgent: meta.userAgent, expiresAt },
  });
  return { token, sessionId: session.id, expiresAt };
}

/**
 * Validate a raw token. Returns the userId if the session exists, is not
 * revoked, and has not expired; otherwise null.
 */
export async function validateToken(db: Client, token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  return session.userId;
}

/** Revoke a single session by its raw token (logout). Idempotent. */
export async function revokeToken(db: Client, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const res = await db.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

/** Revoke every active session for a user (e.g. password change, "log out everywhere"). */
export async function revokeAllForUser(db: Client, userId: string): Promise<number> {
  const res = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return res.count;
}

/** Best-effort cleanup of expired sessions. */
export async function purgeExpiredSessions(db: Client): Promise<number> {
  const res = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return res.count;
}
