/**
 * Authentication + session tests (against the test DB).
 * Covers login success/failure, session lifecycle, revocation, expiry, and the
 * server-side authorization path (resolveFromToken -> AccessContext -> RBAC).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { hashPassword } from "@/server/auth/password";
import { loginWithPassword, logout } from "@/server/auth/login";
import { createSession, validateToken, revokeToken } from "@/server/auth/session";
import { resolveFromToken } from "@/server/auth/current-user";
import { can } from "@/server/auth/rbac";
import { UnauthorizedError } from "@/server/db/scope";

const RUN = Date.now().toString(36);
const PASSWORD = "Secret@123";
let orgId: string, outletA: string, outletB: string;
let activeUserId: string, inactiveUserId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `Auth Org ${RUN}` } });
  orgId = org.id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AB${RUN}`, name: "B" } })).id;
  const hash = await hashPassword(PASSWORD);
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `active-${RUN}@demo.local`, name: "Active", passwordHash: hash } });
  activeUserId = u.id;
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId: outletA, role: "MANAGER" } });
  const inactive = await prisma.user.create({ data: { organizationId: orgId, email: `inactive-${RUN}@demo.local`, name: "Inactive", passwordHash: hash, active: false } });
  inactiveUserId = inactive.id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("login", () => {
  it("succeeds with valid credentials and creates a session", async () => {
    const res = await loginWithPassword(prisma, { email: `active-${RUN}@demo.local`, password: PASSWORD });
    expect(res.user.id).toBe(activeUserId);
    expect((res.user as any).passwordHash).toBeUndefined();
    expect(res.session.token).toBeTruthy();
    expect(await validateToken(prisma, res.session.token)).toBe(activeUserId);
  });

  it("rejects a wrong password", async () => {
    await expect(loginWithPassword(prisma, { email: `active-${RUN}@demo.local`, password: "wrong" })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects an unknown user (no account enumeration)", async () => {
    await expect(loginWithPassword(prisma, { email: `nobody-${RUN}@demo.local`, password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects an inactive user", async () => {
    await expect(loginWithPassword(prisma, { email: `inactive-${RUN}@demo.local`, password: PASSWORD })).rejects.toThrow(/inactive/i);
    void inactiveUserId;
  });

  it("rejects malformed input", async () => {
    await expect(loginWithPassword(prisma, { email: "notanemail", password: "" })).rejects.toBeTruthy();
  });
});

describe("session lifecycle", () => {
  it("validates a fresh session and rejects an invalid token", async () => {
    const s = await createSession(prisma, activeUserId);
    expect(await validateToken(prisma, s.token)).toBe(activeUserId);
    expect(await validateToken(prisma, "not-a-real-token")).toBeNull();
    expect(await validateToken(prisma, undefined)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const s = await createSession(prisma, activeUserId);
    await prisma.session.updateMany({ where: { tokenHash: (await import("@/server/auth/session")).hashToken(s.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateToken(prisma, s.token)).toBeNull();
  });

  it("rejects a revoked session (logout)", async () => {
    const s = await createSession(prisma, activeUserId);
    expect(await validateToken(prisma, s.token)).toBe(activeUserId);
    expect(await revokeToken(prisma, s.token)).toBe(true);
    expect(await validateToken(prisma, s.token)).toBeNull();
  });

  it("logout() revokes the token and is idempotent", async () => {
    const s = await createSession(prisma, activeUserId);
    expect(await logout(prisma, s.token)).toBe(true);
    expect(await logout(prisma, s.token)).toBe(false); // already revoked
    expect(await validateToken(prisma, s.token)).toBeNull();
  });
});

describe("protected access (resolveFromToken -> RBAC)", () => {
  it("returns null without a valid session (protected request unauthenticated)", async () => {
    expect(await resolveFromToken(undefined)).toBeNull();
    expect(await resolveFromToken("bogus")).toBeNull();
  });

  it("returns an AccessContext for an authenticated user", async () => {
    const s = await createSession(prisma, activeUserId);
    const resolved = await resolveFromToken(s.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.ctx.userId).toBe(activeUserId);
    expect(resolved!.ctx.outletIds).toContain(outletA);
  });

  it("enforces permissions and outlet/org scope", async () => {
    const s = await createSession(prisma, activeUserId);
    const { ctx } = (await resolveFromToken(s.token))!;
    // MANAGER at outlet A can take payments there...
    expect(can(ctx, "payment.take", outletA)).toBe(true);
    // ...but has no access to outlet B (cross-outlet rejection).
    expect(can(ctx, "payment.take", outletB)).toBe(false);
    // MANAGER cannot manage the organization.
    expect(can(ctx, "org.manage", outletA)).toBe(false);
  });
});
