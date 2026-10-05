/**
 * DECIMAL precision (H5). prisma/schema.prisma is SQLite; scripts/pg-schema.mjs
 * emits the PostgreSQL variant with an explicit precision class per Decimal
 * field, and prisma/postgres/migrations is its committed history.
 *  - generator: every Decimal is classified; the two schemas differ ONLY by
 *    provider + @db.Decimal; the committed migrations carry the same precision.
 *  - both engines: in-class values round-trip exactly and serialize alike.
 *  - PostgreSQL only: catalog precision, maximum values, rounding (= money()/qty()),
 *    overflow (SQLSTATE 22003; Prisma P2020 elsewhere) → HTTP 422, and no drift between the deployed database
 *    and the generated schema.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import { fail } from "@/server/api/respond";
import { money, qty } from "@/domain/money";
import * as Finance from "@/app/api/finance/[[...path]]/route";
import { DECIMAL_CLASSES, DECIMAL_FIELDS, toPostgresSchema } from "../../scripts/pg-schema.mjs";

const pg = !!process.env.TEST_DATABASE_URL?.startsWith("postgres");
const RUN = Date.now().toString(36);
const source = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
const MIGRATIONS = path.join(process.cwd(), "prisma", "postgres", "migrations");
type Cls = keyof typeof DECIMAL_CLASSES;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/** Model.field → class, read from the SOURCE schema (not from the generator). */
function decimalFieldsOf(schema: string): string[] {
  const out: string[] = [];
  let model: string | null = null;
  for (const line of schema.split(/\r?\n/)) {
    const m = /^model (\w+) \{/.exec(line);
    if (m) model = m[1];
    else if (line.startsWith("}")) model = null;
    const f = model && /^\s+(\w+)\s+Decimal\??(\s|$)/.exec(line);
    if (f) out.push(`${model}.${f[1]}`);
  }
  return out;
}
const classOf = (key: string): Cls => {
  const [m, f] = key.split(".");
  return (DECIMAL_FIELDS as Record<string, Record<string, Cls>>)[m][f];
};

describe("PostgreSQL schema generator", () => {
  const fields = decimalFieldsOf(source);
  const generated = toPostgresSchema(source);

  it("classifies every Decimal field of prisma/schema.prisma (100 today) and annotates each one", () => {
    expect(fields.length).toBe(100);
    for (const key of fields) expect(Object.keys(DECIMAL_CLASSES)).toContain(classOf(key));
    const listed = Object.entries(DECIMAL_FIELDS).flatMap(([m, fs]) => Object.keys(fs).map((f) => `${m}.${f}`));
    expect(listed.sort()).toEqual([...fields].sort());
    // No Decimal reaches PostgreSQL without an explicit precision (would be numeric(65,30)).
    expect(generated.match(/@db\.Decimal\(\d+, \d+\)/g)).toHaveLength(100);
    for (const line of generated.split("\n")) if (/^\s+\w+\s+Decimal\??(\s|$)/.test(line)) expect(line).toMatch(/@db\.Decimal\(\d+, \d+\)/);
  });

  it("rejects an unclassified Decimal and a stale classification", () => {
    const added = source.replace(/(model Payment \{\r?\n)/, "$1  surcharge Decimal @default(0)\n");
    expect(() => toPostgresSchema(added)).toThrow(/Unclassified Decimal field Payment\.surcharge/);
    const removed = source.replace(/^\s+factor\s+Decimal.*$/m, "  factor String");
    expect(() => toPostgresSchema(removed)).toThrow(/UnitConversion\.factor, which is not a Decimal field/);
    expect(() => toPostgresSchema(source.replace(/provider\s*=\s*"sqlite"/, 'provider = "mysql"'))).toThrow(/sqlite provider/);
  });

  it("differs from the SQLite schema only by provider and @db.Decimal (structural alignment)", () => {
    const back = generated
      .replace(/^\/\/ GENERATED.*\n/, "")
      .replace('provider = "postgresql"', 'provider = "sqlite"')
      .replace(/ @db\.Decimal\(\d+, \d+\)/g, "");
    expect(back).toBe(source.replace(/\r\n/g, "\n"));
  });

  it("class bounds hold the largest values the services produce, with headroom", () => {
    // money() = 2 dp, qty() = 4 dp (src/domain/money.ts); rates are stored unrounded.
    expect(DECIMAL_CLASSES.MONEY[1]).toBe(2);
    expect(DECIMAL_CLASSES.QTY[1]).toBeGreaterThanOrEqual(4);
    expect(DECIMAL_CLASSES.RATE[1]).toBeGreaterThanOrEqual(4);
    // Integer digits: ₹10^12 per money row, 10^12 base units per quantity row,
    // factor ≤ 1,000,000 (masterData conversionSchema), percentages < 1000.
    const intDigits = (c: Cls) => DECIMAL_CLASSES[c][0] - DECIMAL_CLASSES[c][1];
    expect(intDigits("MONEY")).toBeGreaterThanOrEqual(12);
    expect(intDigits("QTY")).toBeGreaterThanOrEqual(12);
    expect(intDigits("FACTOR")).toBeGreaterThanOrEqual(7);
    expect(intDigits("PCT")).toBe(3);
  });

  it("the committed PostgreSQL migrations declare exactly the generated precision (no drift)", () => {
    const dirs = fs.readdirSync(MIGRATIONS).filter((d) => fs.statSync(path.join(MIGRATIONS, d)).isDirectory()).sort();
    expect(dirs.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(MIGRATIONS, "migration_lock.toml"), "utf8")).toMatch(/provider = "postgresql"/);
    // Latest declared type per Table.column across the whole history.
    const declared = new Map<string, string>();
    for (const d of dirs) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, d, "migration.sql"), "utf8");
      expect(sql).not.toMatch(/DECIMAL\(65,30\)/);
      for (const t of sql.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g))
        for (const c of t[2].matchAll(/^\s+"(\w+)" DECIMAL\((\d+),(\d+)\)/gm)) declared.set(`${t[1]}.${c[1]}`, `${c[2]},${c[3]}`);
      // Prisma emits one ALTER TABLE per table with comma-separated, space-padded
      // clauses (`ADD COLUMN     "a" TEXT, ADD COLUMN     "b" DECIMAL(16,4)`): read every clause.
      for (const stmt of sql.matchAll(/ALTER TABLE "(\w+)"([\s\S]*?);/g))
        for (const c of stmt[2].matchAll(/(?:ADD|ALTER)\s+COLUMN\s+"(\w+)"\s+(?:SET\s+DATA\s+)?(?:TYPE\s+)?DECIMAL\((\d+),(\d+)\)/g)) declared.set(`${stmt[1]}.${c[1]}`, `${c[2]},${c[3]}`);
    }
    const expected = new Map(fields.map((k) => [k, DECIMAL_CLASSES[classOf(k)].join(",")]));
    expect(Object.fromEntries(declared)).toEqual(Object.fromEntries(expected));
    // Every model has a table in the history.
    const tables = new Set(dirs.flatMap((d) => [...fs.readFileSync(path.join(MIGRATIONS, d, "migration.sql"), "utf8").matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])));
    for (const m of source.matchAll(/^model (\w+) \{/gm)) expect(tables).toContain(m[1]);
  });
});

describe("numeric out of range → 422", () => {
  const safe = { ok: false, error: { code: "ValidationError", message: "A numeric value is out of range" } };
  // The exact shape Prisma 6 raises for a PostgreSQL DECIMAL overflow (observed on PG 16.14).
  const pg22003 = () => new Prisma.PrismaClientUnknownRequestError(
    'Invalid `prisma.expense.create()` invocation:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "22003", message: "numeric field overflow", severity: "ERROR", detail: Some("A field with precision 14, scale 2 must round to an absolute value less than 10^12."), column: None, hint: None }), transient: false })',
    { clientVersion: Prisma.prismaVersion.client });

  it("maps PostgreSQL SQLSTATE 22003 (unknown request error) and Prisma P2020 to a safe 422", async () => {
    const p2020 = new Prisma.PrismaClientKnownRequestError("Value out of range for the type. column amount", { code: "P2020", clientVersion: Prisma.prismaVersion.client });
    for (const err of [pg22003(), p2020]) {
      const res = fail(err);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body).toEqual(safe);
      expect(JSON.stringify(body)).not.toMatch(/column|overflow|precision|amount|prisma/i);
    }
  });

  it("does not widen: other Prisma/unknown errors and look-alike objects stay 500", async () => {
    const other = new Prisma.PrismaClientUnknownRequestError('PostgresError { code: "40001", message: "could not serialize access" }', { clientVersion: Prisma.prismaVersion.client });
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: Prisma.prismaVersion.client });
    for (const err of [other, p2002, { code: "P2020", clientVersion: "x" }, new Error('code: "22003"')]) expect(fail(err).status).toBe(500);
  });
});

// ---- database-backed (runs on SQLite by default, PostgreSQL under test:pg) ----

let orgId: string, outletId: string, unitG: string, unitKg: string, materialId: string, ownerToken: string;
let seq = 0;
const ledger = (data: { qty: Prisma.Decimal.Value; rate: Prisma.Decimal.Value; amount: Prisma.Decimal.Value }) =>
  prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId, materialId, unitId: unitG, txnType: "OTHER_ADJUSTMENT", sourceRef: `dec-${RUN}-${++seq}`, ...data } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Decimal Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `DEC${RUN}`, name: "Decimal Outlet" } })).id;
  unitG = (await prisma.unit.create({ data: { organizationId: orgId, code: `g${RUN}`, name: "Gram", kind: "WEIGHT" } })).id;
  unitKg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "Kilogram", kind: "WEIGHT" } })).id;
  materialId = (await prisma.material.create({ data: { organizationId: orgId, sku: `SALT-${RUN}`, name: "Salt", baseUnitId: unitG, taxPct: 18 } })).id;
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `owner-${RUN}@dec.test`, name: "Owner", passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId: null, role: "OWNER" } });
  ownerToken = (await createSession(prisma, u.id)).token;
});
afterAll(async () => { await prisma.$disconnect(); });

async function postExpense(amount: number) {
  const req = new NextRequest("http://localhost/api/finance/expenses", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", cookie: `${SESSION_COOKIE}=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ outletId, category: "MISC", amount }),
  });
  const res = await (Finance as unknown as Record<string, (r: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>).POST(req, { params: Promise.resolve({ path: ["expenses"] }) });
  return { status: res.status, json: await res.json() };
}

describe("Decimal round-trip (current engine)", () => {
  it("stores realistic in-class values exactly: money, per-gram rate, fractional qty, factor, percent", async () => {
    const row = await ledger({ qty: "-0.125", rate: "0.035", amount: money(D("-0.125").times("0.035")) });
    expect(row.qty.toString()).toBe("-0.125");
    expect(row.rate.toString()).toBe("0.035");
    expect(row.amount.isZero()).toBe(true); // -0.004375 → 0.00 (money rounds before the write)
    const big = await ledger({ qty: "250000.5", rate: "1234.567891", amount: "308643.17" });
    expect([big.qty.toString(), big.rate.toString(), big.amount.toString()]).toEqual(["250000.5", "1234.567891", "308643.17"]);
    const conv = await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: unitG, toUnitId: unitKg, factor: "0.001" } });
    expect(conv.factor.toString()).toBe("0.001");
    const mat = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
    expect(mat.taxPct.toString()).toBe("18");
  });

  it("serializes identically on both engines: no trailing zeros from a fixed-scale column", async () => {
    const row = await ledger({ qty: "10", rate: "12.5", amount: "125.10" });
    const read = await prisma.inventoryLedger.findUniqueOrThrow({ where: { id: row.id } });
    expect(read.amount.toString()).toBe("125.1");
    expect(read.rate.toString()).toBe("12.5");
    expect(JSON.parse(JSON.stringify({ a: read.amount }))).toEqual({ a: "125.1" });
    expect(read.amount.equals(money(125.1))).toBe(true);
  });

  it("aggregates money exactly (Payment-style SUM of 2-dp amounts)", async () => {
    for (let i = 0; i < 10; i++) await ledger({ qty: "1", rate: "0.1", amount: "0.10" });
    const sum = await prisma.inventoryLedger.aggregate({ where: { organizationId: orgId, rate: "0.1" }, _sum: { amount: true } });
    expect(D(sum._sum.amount ?? 0).toDecimalPlaces(2).toString()).toBe("1");
  });
});


describe.skipIf(!pg)("PostgreSQL DECIMAL behaviour (real server)", () => {
  it("the deployed catalog has the class precision/scale for every Decimal column", async () => {
    const cols = await prisma.$queryRaw<Array<{ t: string; c: string; p: number; s: number }>>`
      SELECT table_name AS t, column_name AS c, numeric_precision::int AS p, numeric_scale::int AS s
      FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'numeric'`;
    const got = Object.fromEntries(cols.map((r) => [`${r.t}.${r.c}`, `${r.p},${r.s}`]));
    const want = Object.fromEntries(decimalFieldsOf(source).map((k) => [k, DECIMAL_CLASSES[classOf(k)].join(",")]));
    expect(got).toEqual(want);
  });

  it("holds the maximum value of every class exactly", async () => {
    const row = await ledger({ qty: "999999999999.9999", rate: "9999999999.999999", amount: "999999999999.99" });
    expect([row.qty.toString(), row.rate.toString(), row.amount.toString()]).toEqual(["999999999999.9999", "9999999999.999999", "999999999999.99"]);
    const neg = await ledger({ qty: "-999999999999.9999", rate: "0", amount: "-999999999999.99" });
    expect([neg.qty.toString(), neg.amount.toString()]).toEqual(["-999999999999.9999", "-999999999999.99"]);
    const conv = await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: unitKg, toUnitId: unitG, factor: "9999999999.9999999999" } });
    expect(conv.factor.toString()).toBe("9999999999.9999999999");
    const m = await prisma.material.update({ where: { id: materialId }, data: { taxPct: "999.9999" } });
    expect(m.taxPct.toString()).toBe("999.9999");
  });

  it("rounds excess scale half away from zero — the same as money()/qty() — for positive and negative values", async () => {
    for (const [q, r, a] of [["0.33335", "0.1234565", "2.345"], ["-0.33335", "-0.1234565", "-2.345"], ["1.00004", "7.0000004", "0.004"]]) {
      const row = await ledger({ qty: q, rate: r, amount: a });
      expect(row.qty.equals(qty(q))).toBe(true);
      expect(row.amount.equals(money(a))).toBe(true);
      expect(row.rate.equals(D(r).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP))).toBe(true);
    }
    const row = await ledger({ qty: "-0.33335", rate: "0", amount: "-2.345" });
    expect([row.qty.toString(), row.amount.toString()]).toEqual(["-0.3334", "-2.35"]);
  });

  it("rejects values beyond a class's integer digits (SQLSTATE 22003, never silently truncated) and fail() maps each to 422", async () => {
    const overflow = async (p: Promise<unknown>) => {
      const err = await p.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect(String((err as Error).message)).toMatch(/code: "22003"/);
      expect(fail(err).status).toBe(422);
    };
    await overflow(ledger({ qty: "1", rate: "1", amount: "1000000000000" }));
    await overflow(ledger({ qty: "1000000000000", rate: "1", amount: "1" }));
    await overflow(ledger({ qty: "1", rate: "10000000000", amount: "1" }));
    await overflow(prisma.material.update({ where: { id: materialId }, data: { taxPct: 1000 } }));
    await overflow(prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: unitKg, toUnitId: unitG, factor: "10000000000" } }));
    // rounding up INTO overflow is also rejected
    await overflow(ledger({ qty: "1", rate: "1", amount: "999999999999.995" }));
  });

  it("an out-of-range amount through a real API route is a 422, not a 500, and writes nothing", async () => {
    const before = await prisma.expense.count({ where: { organizationId: orgId } });
    const res = await postExpense(1e13);
    expect(res.status).toBe(422);
    // Phase 4: the application's money bound (≤ ₹100,000,000,000, stricter than the
    // MONEY column) refuses it before PostgreSQL would; DB overflow mapping is covered above.
    expect(res.json.error.code).toBe("ValidationError");
    expect(JSON.stringify(res.json.error.details)).toMatch(/amount/);
    expect(await prisma.expense.count({ where: { organizationId: orgId } })).toBe(before);
    const ok = await postExpense(1234.56);
    expect(ok.status).toBeLessThan(300);
    expect(String(ok.json.data.amount)).toBe("1234.56");
  });

  it("the migrated database has no drift from the generated schema (prisma migrate diff --exit-code)", () => {
    const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
    const url = process.env.TEST_DATABASE_URL!;
    // Read-only: compares the live catalog with the datamodel; exit 2 = drift.
    const out = execFileSync(process.execPath, [prismaCli, "migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/postgres/schema.prisma", "--exit-code"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
    expect(out).toMatch(/No difference detected/);
  });
});

describe.skipIf(pg)("SQLite engine (dev/test/desktop) is unchanged", () => {
  it("an out-of-range expense is refused by the application before it reaches either engine (Phase 4 money bound)", async () => {
    const res = await postExpense(1e13);
    expect(res.status).toBe(422);
  });
});
