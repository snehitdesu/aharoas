/**
 * Password lifecycle: policy, one-time setup/reset links, self-service reset
 * (no enumeration), authenticated change, and the HTTP routes. Actors are real
 * users whose AccessContext comes from their DB memberships.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, hashToken, validateToken } from "@/server/auth/session";
import { loginWithPassword } from "@/server/auth/login";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError, UnauthorizedError } from "@/server/db/scope";
import { passwordProblems, PASSWORD_MIN_LENGTH } from "@/constants/password";
import { createStaff, issuePasswordLink, setUserActive } from "@/server/services/staff";
import { issuePasswordToken, INVALID_TOKEN_MESSAGE, PASSWORD_TOKEN_TTL_MS } from "@/server/auth/passwordTokens";
import { completePasswordToken, requestPasswordReset, changePassword, setPasswordLinkDelivery, RESET_ACCEPTED_MESSAGE } from "@/server/auth/account";
import { SESSION_COOKIE } from "@/constants/auth";
import { POST as resetRoute } from "@/app/api/auth/password/reset/route";
import { POST as completeRoute } from "@/app/api/auth/password/complete/route";
import { POST as changeRoute } from "@/app/api/auth/password/change/route";
import * as StaffApi from "@/app/api/staff/[[...path]]/route";

const RUN = Date.now().toString(36);
const GOOD = "Kitchen#Pass42";
const GOOD2 = "Tandoor!Night77";
let orgId: string, outletA: string, outletB: string;
let owner: AccessContext, mgrA: AccessContext, mgrB: AccessContext, cashierA: AccessContext, org2Owner: AccessContext;
let ownerId: string, mgrAId: string;

async function user(org: string, tag: string, memberships: Array<{ role: string; outletId: string | null }>, password = "x") {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${tag}-${RUN}@pw.test`, name: tag, passwordHash: password === "x" ? "x" : await hashPassword(password) } });
  for (const m of memberships) await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: m.outletId, role: m.role } });
  return u.id;
}

const ip = () => `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
function req(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "x-forwarded-for": ip(), ...headers } });
}
async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `PW Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PB${RUN}`, name: "B" } })).id;
  ownerId = await user(orgId, "owner", [{ role: "OWNER", outletId: null }]);
  mgrAId = await user(orgId, "mgra", [{ role: "MANAGER", outletId: outletA }]);
  const mgrBId = await user(orgId, "mgrb", [{ role: "MANAGER", outletId: outletB }]);
  const cashierAId = await user(orgId, "cashiera", [{ role: "CASHIER", outletId: outletA }]);
  owner = await buildAccessContext(prisma, ownerId);
  mgrA = await buildAccessContext(prisma, mgrAId);
  mgrB = await buildAccessContext(prisma, mgrBId);
  cashierA = await buildAccessContext(prisma, cashierAId);
  const org2 = (await prisma.organization.create({ data: { name: `PW Org2 ${RUN}` } })).id;
  org2Owner = await buildAccessContext(prisma, await user(org2, "owner2", [{ role: "OWNER", outletId: null }]));
});

afterEach(() => setPasswordLinkDelivery(null));
afterAll(async () => { await prisma.$disconnect(); });

describe("password policy", () => {
  it("enforces length, character mix, bcrypt's 72-byte limit and obvious choices", () => {
    expect(passwordProblems(GOOD)).toEqual([]);
    expect(passwordProblems("Short1!")[0]).toMatch(String(PASSWORD_MIN_LENGTH));
    expect(passwordProblems("onlyletterslong").length).toBeGreaterThan(0);
    expect(passwordProblems("1234567890").length).toBeGreaterThan(0);
    expect(passwordProblems("aaaaaaaaaaaa").length).toBeGreaterThan(0);
    expect(passwordProblems("password123")).toContain("This password is too common");
    expect(passwordProblems(`A1${"x".repeat(80)}`).some((p) => p.includes("72"))).toBe(true);
    expect(passwordProblems("é".repeat(37) + "1").some((p) => p.includes("72"))).toBe(true); // 75 bytes
    expect(passwordProblems(" Leading1space")).toContain("Do not start or end with a space");
    expect(passwordProblems("ravi.kumar2024!", { email: "ravi.kumar@x.test" })).toContain("Do not use your email address");
    expect(passwordProblems("SunitaSharma#1", { name: "Sunita Sharma" })).toContain("Do not use your name");
  });
});

describe("staff setup link", () => {
  it("createStaff issues a hashed, single-use, expiring SETUP token tied to the new user", async () => {
    const created = await createStaff(mgrA, { email: `new1-${RUN}@pw.test`, name: "New Cashier", role: "CASHIER", outletId: outletA });
    expect(created.setup.purpose).toBe("SETUP");
    expect(created.setup.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await prisma.passwordToken.findMany({ where: { userId: created.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(created.setup.token));
    expect(rows[0].tokenHash).not.toContain(created.setup.token);
    expect(rows[0].organizationId).toBe(orgId);
    expect(rows[0].createdById).toBe(mgrAId);
    const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(Math.abs(ttl - PASSWORD_TOKEN_TTL_MS.SETUP)).toBeLessThan(5_000);

    // The placeholder hash is unusable until the link is used.
    await expect(loginWithPassword(prisma, { email: created.email, password: GOOD })).rejects.toBeInstanceOf(UnauthorizedError);

    // The raw token never reaches the audit log.
    const audits = await prisma.auditLog.findMany({ where: { entityId: created.id } });
    expect(audits.map((a) => a.action).sort()).toEqual(["CREATE", "PASSWORD_LINK"]);
    for (const a of audits) expect(`${a.before}${a.after}`).not.toContain(created.setup.token);
  });

  it("a rejected password does not burn the link; a good one sets it, revokes sessions, and the link is then dead", async () => {
    const created = await createStaff(owner, { email: `new2-${RUN}@pw.test`, name: "Second Hire", role: "CAPTAIN", outletId: outletA });
    const { token } = created.setup;
    await expect(completePasswordToken(prisma, { token, password: "short" })).rejects.toBeInstanceOf(ValidationError);
    await expect(completePasswordToken(prisma, { token, password: `new2-${RUN}xx!` })).rejects.toBeInstanceOf(ValidationError); // contains email
    const stale = await createSession(prisma, created.id);

    const done = await completePasswordToken(prisma, { token, password: GOOD }, { ip: "1.2.3.4" });
    expect(done).toEqual({ email: created.email, purpose: "SETUP" });
    expect(await validateToken(prisma, stale.token)).toBeNull();
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.passwordHash).not.toContain(GOOD);
    expect(await verifyPassword(GOOD, stored.passwordHash)).toBe(true);
    await loginWithPassword(prisma, { email: created.email, password: GOOD });

    const reuse = await completePasswordToken(prisma, { token, password: GOOD2 }).catch((e) => e);
    expect(reuse).toBeInstanceOf(ValidationError);
    expect(reuse.message).toBe(INVALID_TOKEN_MESSAGE);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: created.id, action: "PASSWORD_SET" } });
    expect(audit.actorId).toBe(created.id);
    expect(audit.ip).toBe("1.2.3.4");
    expect(`${audit.after}`).not.toContain(GOOD);
  });

  it("rejects unknown, malformed, expired, superseded and deactivated-user tokens with one message", async () => {
    const created = await createStaff(owner, { email: `new3-${RUN}@pw.test`, name: "Third Hire", role: "KITCHEN", outletId: outletA });
    const bad = async (token: string) => {
      const e = await completePasswordToken(prisma, { token, password: GOOD }).catch((x) => x);
      expect(e).toBeInstanceOf(ValidationError);
      expect(e.message).toBe(INVALID_TOKEN_MESSAGE);
    };
    await bad("not-a-token");
    await bad("A".repeat(43));
    const expired = await issuePasswordToken(prisma, { organizationId: orgId, userId: created.id, purpose: "SETUP" }, new Date(Date.now() - PASSWORD_TOKEN_TTL_MS.SETUP - 60_000));
    await bad(expired.token);

    // A new link retires the previous one.
    const first = await issuePasswordLink(owner, created.id);
    const second = await issuePasswordLink(owner, created.id);
    await bad(first.token);

    // Deactivation retires outstanding links, and reactivation does not revive them.
    await setUserActive(owner, created.id, false);
    await bad(second.token);
    await setUserActive(owner, created.id, true);
    await bad(second.token);
  });

  it("only one of two concurrent uses of the same link succeeds", async () => {
    const created = await createStaff(owner, { email: `new4-${RUN}@pw.test`, name: "Fourth Hire", role: "CASHIER", outletId: outletA });
    const results = await Promise.allSettled([
      completePasswordToken(prisma, { token: created.setup.token, password: GOOD }),
      completePasswordToken(prisma, { token: created.setup.token, password: GOOD2 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.passwordToken.count({ where: { userId: created.id, usedAt: null } })).toBe(0);
  });

  it("password links follow staff RBAC and organization/outlet scope", async () => {
    const target = await createStaff(owner, { email: `new5-${RUN}@pw.test`, name: "Fifth Hire", role: "CASHIER", outletId: outletA });
    await expect(issuePasswordLink(cashierA, target.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(issuePasswordLink(mgrB, target.id)).rejects.toBeInstanceOf(ForbiddenError); // other outlet
    await expect(issuePasswordLink(org2Owner, target.id)).rejects.toBeInstanceOf(NotFoundError); // other org
    await expect(issuePasswordLink(mgrA, mgrAId)).rejects.toBeInstanceOf(ForbiddenError); // self
    await expect(issuePasswordLink(mgrA, ownerId)).rejects.toBeInstanceOf(ForbiddenError); // higher rank
    const link = await issuePasswordLink(mgrA, target.id);
    expect(link.purpose).toBe("SETUP");
    await prisma.user.update({ where: { id: target.id }, data: { lastLoginAt: new Date() } });
    expect((await issuePasswordLink(mgrA, target.id)).purpose).toBe("RESET");
    expect(await prisma.auditLog.count({ where: { entityId: target.id, action: "PASSWORD_LINK", actorId: mgrAId } })).toBe(2);
  });

  it("is exposed as POST /api/staff/users/:id/password-link behind the session + RBAC router", async () => {
    const target = await createStaff(owner, { email: `new6-${RUN}@pw.test`, name: "Sixth Hire", role: "CASHIER", outletId: outletA });
    const mgrToken = (await createSession(prisma, mgrAId)).token;
    const cashToken = (await createSession(prisma, cashierA.userId)).token;
    const call = (token: string | null) =>
      StaffApi.POST(
        new NextRequest(`http://localhost/api/staff/users/${target.id}/password-link`, { method: "POST", headers: { host: "localhost", ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) } }),
        { params: Promise.resolve({ path: ["users", target.id, "password-link"] }) }
      );
    expect((await call(null)).status).toBe(401);
    expect((await call(cashToken)).status).toBe(403);
    const ok = await json(await call(mgrToken));
    expect(ok.status).toBe(200);
    expect(ok.body.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ok.body.data.email).toBe(target.email);
  });
});

describe("self-service reset", () => {
  it("does not reveal whether an account exists and creates no token without a delivery channel", async () => {
    const id = await user(orgId, "resetnodeliv", [{ role: "CASHIER", outletId: outletA }], GOOD);
    await expect(requestPasswordReset(prisma, { email: `nobody-${RUN}@pw.test` })).resolves.toBeUndefined();
    await expect(requestPasswordReset(prisma, { email: `resetnodeliv-${RUN}@pw.test` })).resolves.toBeUndefined();
    expect(await prisma.passwordToken.count({ where: { userId: id } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: "PASSWORD_RESET_REQUEST" } });
    expect(JSON.parse(audit.after!)).toMatchObject({ delivered: false });
  });

  it("with a delivery channel: link is delivered, resets the password, revokes all sessions, and is single-use", async () => {
    const sent: Array<{ to: string; token: string }> = [];
    setPasswordLinkDelivery(async (m) => { sent.push({ to: m.to, token: m.token }); });
    const id = await user(orgId, "resetme", [{ role: "CASHIER", outletId: outletA }], GOOD);
    const s1 = await createSession(prisma, id);
    await requestPasswordReset(prisma, { email: `RESETME-${RUN}@pw.test` });
    await requestPasswordReset(prisma, { email: `nobody2-${RUN}@pw.test` });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(`resetme-${RUN}@pw.test`);
    const row = await prisma.passwordToken.findUniqueOrThrow({ where: { tokenHash: hashToken(sent[0].token) } });
    expect(row.purpose).toBe("RESET");
    expect(Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - PASSWORD_TOKEN_TTL_MS.RESET)).toBeLessThan(5_000);

    await completePasswordToken(prisma, { token: sent[0].token, password: GOOD2 });
    expect(await validateToken(prisma, s1.token)).toBeNull();
    await expect(loginWithPassword(prisma, { email: `resetme-${RUN}@pw.test`, password: GOOD })).rejects.toBeInstanceOf(UnauthorizedError);
    await loginWithPassword(prisma, { email: `resetme-${RUN}@pw.test`, password: GOOD2 });
    await expect(completePasswordToken(prisma, { token: sent[0].token, password: GOOD })).rejects.toBeInstanceOf(ValidationError);
  });

  it("inactive accounts get nothing", async () => {
    const sent: string[] = [];
    setPasswordLinkDelivery(async (m) => { sent.push(m.token); });
    const id = await user(orgId, "inactive", [{ role: "CASHIER", outletId: outletA }], GOOD);
    await prisma.user.update({ where: { id }, data: { active: false } });
    await requestPasswordReset(prisma, { email: `inactive-${RUN}@pw.test` });
    expect(sent).toHaveLength(0);
    expect(await prisma.passwordToken.count({ where: { userId: id } })).toBe(0);
  });
});

describe("authenticated change", () => {
  it("requires the current password, a different policy-compliant new one, keeps this session and revokes the others", async () => {
    const id = await user(orgId, "changer", [{ role: "CASHIER", outletId: outletA }], GOOD);
    const current = await createSession(prisma, id);
    const other1 = await createSession(prisma, id);
    const other2 = await createSession(prisma, id);
    const pending = await issuePasswordToken(prisma, { organizationId: orgId, userId: id, purpose: "RESET" });
    const caller = { userId: id, sessionToken: current.token };

    await expect(changePassword(prisma, caller, { currentPassword: "Wrong#Pass99", newPassword: GOOD2 })).rejects.toThrow("Current password is incorrect");
    await expect(changePassword(prisma, caller, { currentPassword: GOOD, newPassword: GOOD })).rejects.toBeInstanceOf(ValidationError);
    await expect(changePassword(prisma, caller, { currentPassword: GOOD, newPassword: "weak" })).rejects.toBeInstanceOf(ValidationError);
    expect(await validateToken(prisma, other1.token)).toBe(id); // failures change nothing

    const res = await changePassword(prisma, caller, { currentPassword: GOOD, newPassword: GOOD2 });
    expect(res.sessionsRevoked).toBe(2);
    expect(await validateToken(prisma, current.token)).toBe(id);
    expect(await validateToken(prisma, other1.token)).toBeNull();
    expect(await validateToken(prisma, other2.token)).toBeNull();
    await expect(completePasswordToken(prisma, { token: pending.token, password: "Another#Pass55" })).rejects.toBeInstanceOf(ValidationError);
    await expect(loginWithPassword(prisma, { email: `changer-${RUN}@pw.test`, password: GOOD })).rejects.toBeInstanceOf(UnauthorizedError);
    await loginWithPassword(prisma, { email: `changer-${RUN}@pw.test`, password: GOOD2 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: "PASSWORD_CHANGE" } });
    expect(`${audit.after}`).not.toContain(GOOD2);
  });
});

describe("password routes", () => {
  it("reset: identical response for existing and unknown accounts; Origin-checked; rate limited per email", async () => {
    await user(orgId, "routereset", [{ role: "CASHIER", outletId: outletA }], GOOD);
    const known = await json(await resetRoute(req("/api/auth/password/reset", { email: `routereset-${RUN}@pw.test` })));
    const unknown = await json(await resetRoute(req("/api/auth/password/reset", { email: `ghost-${RUN}@pw.test` })));
    expect(known).toEqual(unknown);
    expect(known.status).toBe(202);
    expect(known.body.data.message).toBe(RESET_ACCEPTED_MESSAGE);
    expect((await resetRoute(req("/api/auth/password/reset", { email: `ghost-${RUN}@pw.test` }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await resetRoute(req("/api/auth/password/reset", { email: "not-an-email" }))).status).toBe(422);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await resetRoute(req("/api/auth/password/reset", { email: `flood-${RUN}@pw.test` }))).status);
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("complete: sets the password from a link; bad tokens get the uniform 422", async () => {
    const created = await createStaff(owner, { email: `route7-${RUN}@pw.test`, name: "Route Hire", role: "CASHIER", outletId: outletA });
    const bad = await json(await completeRoute(req("/api/auth/password/complete", { token: "A".repeat(43), password: GOOD })));
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe(INVALID_TOKEN_MESSAGE);
    const weak = await json(await completeRoute(req("/api/auth/password/complete", { token: created.setup.token, password: "weak" })));
    expect(weak.status).toBe(422);
    expect(weak.body.error.details.fieldErrors.password.length).toBeGreaterThan(0);
    const ok = await json(await completeRoute(req("/api/auth/password/complete", { token: created.setup.token, password: GOOD })));
    expect(ok).toEqual({ status: 200, body: { ok: true, data: { email: created.email, purpose: "SETUP" } } });
    expect((await completeRoute(req("/api/auth/password/complete", { token: created.setup.token, password: GOOD }, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("change: needs a valid session cookie and keeps it valid", async () => {
    const id = await user(orgId, "routechange", [{ role: "CASHIER", outletId: outletA }], GOOD);
    const s = await createSession(prisma, id);
    const cookie = { cookie: `${SESSION_COOKIE}=${s.token}` };
    expect((await changeRoute(req("/api/auth/password/change", { currentPassword: GOOD, newPassword: GOOD2 }))).status).toBe(401);
    expect((await changeRoute(req("/api/auth/password/change", { currentPassword: GOOD, newPassword: GOOD2 }, { cookie: `${SESSION_COOKIE}=forged` }))).status).toBe(401);
    expect((await changeRoute(req("/api/auth/password/change", { currentPassword: GOOD, newPassword: GOOD2 }, { ...cookie, origin: "https://evil.example" }))).status).toBe(403);
    const wrong = await json(await changeRoute(req("/api/auth/password/change", { currentPassword: "Nope#Nope11", newPassword: GOOD2 }, cookie)));
    expect(wrong.status).toBe(422);
    const ok = await json(await changeRoute(req("/api/auth/password/change", { currentPassword: GOOD, newPassword: GOOD2 }, cookie)));
    expect(ok.status).toBe(200);
    expect(await validateToken(prisma, s.token)).toBe(id);
  });

  it("never writes raw tokens or passwords to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    try {
      setPasswordLinkDelivery(async () => { throw new Error("smtp down"); });
      await user(orgId, "logcheck", [{ role: "CASHIER", outletId: outletA }], GOOD);
      await resetRoute(req("/api/auth/password/reset", { email: `logcheck-${RUN}@pw.test` }));
      const created = await createStaff(owner, { email: `log2-${RUN}@pw.test`, name: "Log Hire", role: "CASHIER", outletId: outletA });
      await completeRoute(req("/api/auth/password/complete", { token: created.setup.token, password: GOOD2 }));
      const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
      expect(logged).not.toContain(created.setup.token);
      expect(logged).not.toContain(GOOD2);
      expect(logged).not.toContain(GOOD);
      const raw = await prisma.passwordToken.findFirstOrThrow({ where: { user: { email: `logcheck-${RUN}@pw.test` } } });
      expect(logged).not.toContain(raw.tokenHash);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
