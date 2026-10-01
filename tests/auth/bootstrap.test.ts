/**
 * First-owner bootstrap: service + the real CLI, each against its own
 * throwaway SQLite database (never test.db / dev.db), because bootstrap only
 * runs on an EMPTY database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { bootstrapOwner, ALREADY_INITIALIZED, type BootstrapInput } from "@/server/services/bootstrap";
import { verifyPassword } from "@/server/auth/password";
import { loginWithPassword } from "@/server/auth/login";
import { buildAccessContext } from "@/server/auth/context";
import { ConflictError, ValidationError } from "@/server/db/scope";

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
const tsxCli = require.resolve("tsx/cli");
const PASSWORD = "Owner#Strong2026";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aharos-bootstrap-"));
const urlFor = (name: string) => `file:${path.join(dir, name).replace(/\\/g, "/")}`;

function freshDb(name: string): string {
  const url = urlFor(name);
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], { stdio: "ignore", env: { ...process.env, DATABASE_URL: url } });
  return url;
}

const input = (over: Partial<BootstrapInput> = {}): BootstrapInput => ({
  organizationName: "Spice Route Hospitality", outletName: "Indiranagar", outletCode: "BLR01",
  ownerName: "Anita Rao", ownerEmail: "Anita.Rao@spiceroute.example", ownerPassword: PASSWORD, ...over,
});

const pg = process.env.TEST_DATABASE_URL?.startsWith("postgres");
let db: PrismaClient;

async function counts(c: PrismaClient) {
  const [orgs, outlets, users, memberships, audits] = await Promise.all([c.organization.count(), c.outlet.count(), c.user.count(), c.membership.count(), c.auditLog.count()]);
  return { orgs, outlets, users, memberships, audits };
}
const EMPTY = { orgs: 0, outlets: 0, users: 0, memberships: 0, audits: 0 };

async function wipe(c: PrismaClient) {
  await c.auditLog.deleteMany();
  await c.membership.deleteMany();
  await c.session.deleteMany();
  await c.user.deleteMany();
  await c.outlet.deleteMany();
  await c.organization.deleteMany();
}

describe.skipIf(pg)("bootstrapOwner service", () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: freshDb("service.db") } } });
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); });

  it("rejects invalid input and weak passwords without writing anything", async () => {
    await expect(bootstrapOwner(db, input({ ownerPassword: "short" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(bootstrapOwner(db, input({ ownerPassword: "anita.rao2026!" }))).rejects.toBeInstanceOf(ValidationError); // contains email
    await expect(bootstrapOwner(db, input({ timezone: "Mars/Olympus" }))).rejects.toBeInstanceOf(ZodError);
    await expect(bootstrapOwner(db, input({ outletCode: "bad code" }))).rejects.toBeInstanceOf(ZodError);
    await expect(bootstrapOwner(db, input({ ownerEmail: "not-an-email" }))).rejects.toBeInstanceOf(ZodError);
    await expect(bootstrapOwner(db, input({ organizationName: "  " }))).rejects.toBeInstanceOf(ZodError);
    expect(await counts(db)).toEqual(EMPTY);
  });

  it("rolls back everything if any step fails mid-transaction", async () => {
    const failing = db.$extends({ query: { membership: { create: () => { throw new Error("simulated failure"); } } } }) as unknown as PrismaClient;
    await expect(bootstrapOwner(failing, input())).rejects.toThrow("simulated failure");
    expect(await counts(db)).toEqual(EMPTY);
  });

  it("creates organization, outlet and an org-wide OWNER with a bcrypt hash, and audits it", async () => {
    const r = await bootstrapOwner(db, input({ timezone: "Asia/Kolkata", currency: "INR" }));
    expect(await counts(db)).toEqual({ orgs: 1, outlets: 1, users: 1, memberships: 1, audits: 1 });
    const owner = await db.user.findUniqueOrThrow({ where: { id: r.ownerId }, include: { memberships: true } });
    expect(owner.email).toBe("anita.rao@spiceroute.example");
    expect(owner.organizationId).toBe(r.organizationId);
    expect(owner.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(owner.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, owner.passwordHash)).toBe(true);
    expect(owner.memberships).toEqual([expect.objectContaining({ role: "OWNER", outletId: null, active: true, organizationId: r.organizationId })]);
    const outlet = await db.outlet.findUniqueOrThrow({ where: { id: r.outletId } });
    expect(outlet).toMatchObject({ organizationId: r.organizationId, code: "BLR01", timezone: "Asia/Kolkata" });
    const audit = await db.auditLog.findFirstOrThrow();
    expect(audit).toMatchObject({ action: "BOOTSTRAP", organizationId: r.organizationId, entityId: r.organizationId });
    expect(`${audit.after}`).not.toContain(PASSWORD);

    const login = await loginWithPassword(db, { email: "ANITA.RAO@spiceroute.example", password: PASSWORD });
    expect(login.user.id).toBe(r.ownerId);
    const ctx = await buildAccessContext(db, r.ownerId);
    expect(ctx).toMatchObject({ isOrgWide: true, orgRoles: ["OWNER"], outletIds: [r.outletId] });
  });

  it("refuses to run again on an initialized database", async () => {
    const before = await counts(db);
    const e = await bootstrapOwner(db, input({ ownerEmail: "second@spiceroute.example", outletCode: "BLR02" })).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictError);
    expect(e.message).toBe(ALREADY_INITIALIZED);
    expect(await counts(db)).toEqual(before);
  });

  it("also refuses when only a user (or only an organization) exists", async () => {
    await wipe(db);
    await db.organization.create({ data: { name: "Leftover" } });
    await expect(bootstrapOwner(db, input())).rejects.toBeInstanceOf(ConflictError);
    expect((await counts(db)).users).toBe(0);
  });
});

describe.skipIf(pg)("bootstrap-owner CLI", () => {
  let url: string;
  const env = (over: Record<string, string | undefined> = {}) => {
    const e: Record<string, string | undefined> = {
      ...process.env, DATABASE_URL: url, NODE_ENV: "production",
      BOOTSTRAP_ORG_NAME: "CLI Kitchens", BOOTSTRAP_OUTLET_NAME: "Main", BOOTSTRAP_OUTLET_CODE: "MAIN",
      BOOTSTRAP_OWNER_NAME: "Cli Owner", BOOTSTRAP_OWNER_EMAIL: "meera@cli.example", BOOTSTRAP_OWNER_PASSWORD: undefined, ...over,
    };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return e as NodeJS.ProcessEnv;
  };
  const run = (stdin: string, over: Record<string, string | undefined> = {}) => {
    const r = spawnSync(process.execPath, [tsxCli, "scripts/bootstrap-owner.ts", "--password-stdin"], { input: stdin, env: env(over), encoding: "utf8", timeout: 90_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeAll(() => { url = freshDb("cli.db"); }, 120_000);
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("fails clearly on missing configuration", () => {
    const r = run(`${PASSWORD}\n`, { BOOTSTRAP_ORG_NAME: undefined, BOOTSTRAP_OWNER_EMAIL: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing required configuration: BOOTSTRAP_ORG_NAME, BOOTSTRAP_OWNER_EMAIL");
  }, 120_000);

  it("rejects a weak password without echoing it", () => {
    const weak = "letmein123";
    const r = run(`${weak}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("password rejected");
    expect(r.out).not.toContain(weak);
  }, 120_000);

  it("creates the owner once (in production mode), never prints the password, then refuses", async () => {
    const first = run(`${PASSWORD}\n`);
    expect(first.out).not.toContain(PASSWORD);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain("meera@cli.example");
    const c = new PrismaClient({ datasources: { db: { url } } });
    try {
      const owner = await c.user.findUniqueOrThrow({ where: { email: "meera@cli.example" } });
      expect(await verifyPassword(PASSWORD, owner.passwordHash)).toBe(true);
      const second = run(`${PASSWORD}\n`, { BOOTSTRAP_OWNER_EMAIL: "other@cli.example" });
      expect(second.code).toBe(2);
      expect(second.out).toContain(ALREADY_INITIALIZED);
      expect(await c.user.count()).toBe(1);
    } finally {
      await c.$disconnect();
    }
  }, 180_000);
});
