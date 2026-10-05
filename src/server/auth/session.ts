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
const DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60; // shared POS terminals
/** Activity is persisted at most this often per session (bounds DB writes). */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

export function sessionTtlSeconds(): number {
  const v = Number(process.env.SESSION_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_SECONDS;
}

/** Idle timeout: a session with no meaningful activity for this long is revoked. */
export function sessionIdleTimeoutSeconds(): number {
  const v = Number(process.env.SESSION_IDLE_TIMEOUT_SECONDS);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_IDLE_TIMEOUT_SECONDS;
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
    data: { userId, tokenHash: hashToken(token), ip: meta.ip, userAgent: meta.userAgent, expiresAt, lastActivityAt: new Date() },
  });
  return { token, sessionId: session.id, expiresAt };
}

/** A live session as seen by the request that presented its token. */
export type ActiveSession = { id: string; userId: string; reauthScope: string | null; reauthExpiresAt: Date | null };

/**
 * Validate a raw token. Returns the session if it exists, is not revoked, has
 * not passed its absolute expiry and has not been idle for longer than the idle
 * timeout; otherwise null. An idle session is revoked here (server-side), so
 * nothing the client does afterwards can revive it.
 *
 * `activity: true` marks the request as meaningful user activity and slides the
 * idle window — persisted at most once per ACTIVITY_WRITE_INTERVAL_MS. Background
 * polling passes `activity: false` and therefore cannot keep a session alive.
 */
export async function validateSession(
  db: Client,
  token: string | undefined | null,
  opts: { activity?: boolean; now?: Date } = {}
): Promise<ActiveSession | null> {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session || session.revokedAt) return null;
  const now = opts.now ?? new Date();
  if (session.expiresAt.getTime() <= now.getTime()) return null;
  const last = (session.lastActivityAt ?? session.createdAt).getTime();
  if (now.getTime() - last >= sessionIdleTimeoutSeconds() * 1000) {
    await expireIdleSession(db, session.id, session.userId, now);
    return null;
  }
  if (opts.activity && now.getTime() - last >= ACTIVITY_WRITE_INTERVAL_MS) {
    await db.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastActivityAt: now } });
  }
  return { id: session.id, userId: session.userId, reauthScope: session.reauthScope, reauthExpiresAt: session.reauthExpiresAt };
}

async function expireIdleSession(db: Client, sessionId: string, userId: string, now: Date) {
  const res = await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now, reauthScope: null, reauthExpiresAt: null } });
  if (res.count !== 1) return; // a concurrent request already expired it
  const user = await db.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
  if (user) {
    await db.auditLog.create({ data: { organizationId: user.organizationId, actorId: userId, action: "SESSION_EXPIRED", entityType: "Session", entityId: sessionId, after: JSON.stringify({ reason: "idle", idleTimeoutSeconds: sessionIdleTimeoutSeconds() }) } });
  }
}

/** Validate a raw token without recording activity. Returns the userId or null. */
export async function validateToken(db: Client, token: string | undefined | null): Promise<string | null> {
  return (await validateSession(db, token))?.userId ?? null;
}

/** Revoke a single session by its raw token (logout). Idempotent. */
export async function revokeToken(db: Client, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const res = await db.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date(), reauthScope: null, reauthExpiresAt: null },
  });
  return res.count > 0;
}

/** Revoke every active session for a user (e.g. password change, "log out everywhere"). */
export async function revokeAllForUser(db: Client, userId: string): Promise<number> {
  const res = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), reauthScope: null, reauthExpiresAt: null } });
  return res.count;
}

/** Best-effort cleanup of expired sessions. */
export async function purgeExpiredSessions(db: Client): Promise<number> {
  const res = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return res.count;
}
